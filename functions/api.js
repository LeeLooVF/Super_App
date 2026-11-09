// functions/api.js
const PUBLIC_R2_URL = "https://pub-06317316428d44fe94ff17808d4763df.r2.dev";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const bucket = env.MY_BUCKET;
  if (!bucket) {
    return new Response(
      JSON.stringify({ ok: false, error: "Binding R2 MY_BUCKET non configuré dans Cloudflare Pages > Settings > Functions." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // 1. LISTER LES FICHIERS PARTAGÉS (GET /api?folder=...)
    if (request.method === "GET") {
      const folder = url.searchParams.get("folder") || "";
      const listed = await bucket.list({
        prefix: folder ? `${folder}/` : undefined,
        include: ["customMetadata", "httpMetadata"]
      });

      const files = listed.objects
        .filter(obj => !obj.key.endsWith("_thumb.png"))
        .map(obj => {
          const meta = obj.customMetadata || {};
          const encodedKey = obj.key.split("/").map(encodeURIComponent).join("/");
          const encodedThumb = meta.thumbKey
            ? meta.thumbKey.split("/").map(encodeURIComponent).join("/")
            : encodedKey;

          return {
            key: obj.key,
            label: meta.label || obj.key.split("/").pop(),
            fileName: meta.fileName || obj.key.split("/").pop(),
            fileType: meta.fileType || "IMAGE",
            folder: obj.key.split("/")[0],
            uploaded: new Date(obj.uploaded).getTime(),
            url: `${PUBLIC_R2_URL}/${encodedKey}`,
            thumbUrl: `${PUBLIC_R2_URL}/${encodedThumb}`
          };
        })
        .sort((a, b) => b.uploaded - a.uploaded);

      return new Response(JSON.stringify({ ok: true, files }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 2. ENREGISTRER UN NOUVEAU FICHIER PARTAGÉ (POST /api)
    if (request.method === "POST") {
      const body = await request.json();
      const { folder, label, fileName, fileType, dataUrl, previewDataUrl } = body;

      const safeFolder = folder || "left_4";
      const cleanFileName = (fileName || "fichier.png").replace(/[^a-zA-Z0-9._-]/g, "_");
      const timestamp = Date.now();
      const mainKey = `${safeFolder}/${timestamp}_${cleanFileName}`;

      const decodeDataUrl = (dUrl) => {
        const parts = dUrl.split(",");
        const mime = (parts[0].match(/:(.*?);/) || [null, "application/octet-stream"])[1];
        const bstr = atob(parts[1]);
        const u8 = new Uint8Array(bstr.length);
        for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
        return { u8, mime };
      };

      let thumbKey = "";
      if (previewDataUrl && previewDataUrl !== dataUrl) {
        thumbKey = `${mainKey}_thumb.png`;
        const thumbDecoded = decodeDataUrl(previewDataUrl);
        await bucket.put(thumbKey, thumbDecoded.u8, {
          httpMetadata: { contentType: "image/png" }
        });
      }

      const mainDecoded = decodeDataUrl(dataUrl);
      await bucket.put(mainKey, mainDecoded.u8, {
        httpMetadata: { contentType: mainDecoded.mime },
        customMetadata: {
          label: label || cleanFileName,
          fileName: fileName || cleanFileName,
          fileType: fileType || "IMAGE",
          thumbKey: thumbKey
        }
      });

      const encodedKey = mainKey.split("/").map(encodeURIComponent).join("/");
      const encodedThumb = thumbKey
        ? thumbKey.split("/").map(encodeURIComponent).join("/")
        : encodedKey;

      return new Response(JSON.stringify({
        ok: true,
        file: {
          key: mainKey,
          label: label || cleanFileName,
          fileName: fileName || cleanFileName,
          fileType: fileType || "IMAGE",
          folder: safeFolder,
          uploaded: timestamp,
          url: `${PUBLIC_R2_URL}/${encodedKey}`,
          thumbUrl: `${PUBLIC_R2_URL}/${encodedThumb}`
        }
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 3. SUPPRIMER UN FICHIER PARTAGÉ (DELETE /api?key=...&thumbKey=...)
    if (request.method === "DELETE") {
      const key = url.searchParams.get("key");
      const thumbKey = url.searchParams.get("thumbKey");
      if (key) await bucket.delete(key);
      if (thumbKey) await bucket.delete(thumbKey);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ ok: false, error: "Méthode non supportée" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}