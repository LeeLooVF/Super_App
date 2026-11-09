// functions/api.js
const PUBLIC_R2_URL = "https://pub-06317316428d44fe94ff17808d4763df.r2.dev";
const DELETE_PASSCODE = "Bonesink124!";

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
      JSON.stringify({ ok: false, error: "Binding R2 MY_BUCKET non configuré." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    // 1. LISTER TOUS LES FICHIERS, DOSSIERS ET SOUS-DOSSIERS SUR R2 (GET /api)
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
            thumbKey: meta.thumbKey || "",
            label: meta.label || obj.key.split("/").pop(),
            fileName: meta.fileName || obj.key.split("/").pop(),
            fileType: meta.fileType || "IMAGE",
            folder: meta.folder || obj.key.split("/")[0],
            subFolder: meta.subFolder || "Général",
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

    // 2. UPLOADER UN FICHIER OU CRÉER UN DOSSIER / SOUS-DOSSIER (POST /api)
    if (request.method === "POST") {
      const body = await request.json();

      // Création d'un dossier ou sous-dossier (ex: "Noël" ou "Noël/Chocolats")
      if (body.action === "create_folder") {
        const safeFolder = body.folder || "ready_deposited";
        const safeSub = (body.subFolder || "Nouveau_Dossier")
          .split("/")
          .map(part => part.trim())
          .filter(Boolean)
          .join("/");

        const markerKey = `${safeFolder}/__folder__${Date.now()}_${safeSub.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        await bucket.put(markerKey, new Uint8Array(0), {
          customMetadata: {
            label: safeSub,
            fileName: ".folder",
            fileType: "FOLDER",
            folder: safeFolder,
            subFolder: safeSub
          }
        });
        return new Response(JSON.stringify({ ok: true, subFolder: safeSub }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const { folder, subFolder, label, fileName, fileType, dataUrl, previewDataUrl } = body;
      const safeFolder = folder || "left_4";
      const safeSubFolder = (subFolder || "Général")
        .split("/")
        .map(part => part.trim())
        .filter(Boolean)
        .join("/");

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
          folder: safeFolder,
          subFolder: safeSubFolder,
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
          thumbKey: thumbKey,
          label: label || cleanFileName,
          fileName: fileName || cleanFileName,
          fileType: fileType || "IMAGE",
          folder: safeFolder,
          subFolder: safeSubFolder,
          uploaded: timestamp,
          url: `${PUBLIC_R2_URL}/${encodedKey}`,
          thumbUrl: `${PUBLIC_R2_URL}/${encodedThumb}`
        }
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 3. SUPPRIMER UN FICHIER OU UN DOSSIER/SOUS-DOSSIER COMPLET AVEC LE CODE Bonesink124! (DELETE /api)
    if (request.method === "DELETE") {
      const code = url.searchParams.get("code") || "";
      if (code !== DELETE_PASSCODE) {
        return new Response(
          JSON.stringify({ ok: false, error: "Code de suppression incorrect." }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const action = url.searchParams.get("action") || "delete_file";

      // Suppression complète d'un dossier, de ses sous-dossiers et de tous leurs fichiers
      if (action === "delete_folder") {
        const targetFolder = url.searchParams.get("folder") || "ready_deposited";
        const targetSubFolder = url.searchParams.get("subFolder") || "";

        if (!targetSubFolder || targetSubFolder === "Général") {
          return new Response(
            JSON.stringify({ ok: false, error: "Le dossier principal Général ne peut pas être supprimé." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const listed = await bucket.list({ include: ["customMetadata"] });
        let deletedCount = 0;

        for (const obj of listed.objects) {
          const meta = obj.customMetadata || {};
          const objFolder = meta.folder || obj.key.split("/")[0];
          const isMatchingTab =
            objFolder === targetFolder ||
            (targetFolder === "ready_deposited" && objFolder === "ready_docs");

          const objSub = meta.subFolder || "";
          const isInsideTargetSub =
            objSub === targetSubFolder || objSub.startsWith(targetSubFolder + "/");

          if (isMatchingTab && isInsideTargetSub) {
            await bucket.delete(obj.key);
            if (meta.thumbKey) {
              await bucket.delete(meta.thumbKey);
            }
            deletedCount++;
          }
        }

        return new Response(JSON.stringify({ ok: true, deletedCount }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Suppression d'un fichier individuel
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