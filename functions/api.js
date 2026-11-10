// functions/api.js
const PUBLIC_R2_URL = "https://pub-06317316428d44fe94ff17808d4763df.r2.dev";
const DELETE_PASSCODE = "Bonesink124!";
const DELETED_STATIC_KEY = "__system__/deleted_static_files.json";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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

  // Fonction utilitaire : lister tous les objets R2 avec pagination complète (> 1000 fichiers)
  async function listAllObjects(prefix = "") {
    let allObjects = [];
    let cursor = undefined;
    do {
      const listed = await bucket.list({
        prefix: prefix || undefined,
        cursor,
        include: ["customMetadata", "httpMetadata"]
      });
      allObjects = allObjects.concat(listed.objects || []);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return allObjects;
  }

  // Fonction utilitaire : récupérer la liste partagée des images GitHub masquées
  async function getDeletedStaticFiles() {
    try {
      const obj = await bucket.get(DELETED_STATIC_KEY);
      if (!obj) return [];
      const text = await obj.text();
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  try {
    // 1. LISTER TOUS LES FICHIERS, DOSSIERS ET LA LISTE NOIRE GITHUB SUR R2 (GET /api)
    if (request.method === "GET") {
      const folder = url.searchParams.get("folder") || "";
      const [objects, deletedStaticFiles] = await Promise.all([
        listAllObjects(folder ? `${folder}/` : ""),
        getDeletedStaticFiles()
      ]);

      const files = objects
        .filter(obj => !obj.key.endsWith("_thumb.png") && !obj.key.endsWith("_thumb.webp") && !obj.key.startsWith("__system__/"))
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

      return new Response(JSON.stringify({ ok: true, files, deletedStaticFiles }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 2. UPLOADER, CRÉER DOSSIER, DÉPLACER/RENOMMER OU SYNCHRONISER SUPPRESSION GITHUB (POST /api)
    if (request.method === "POST") {
      const body = await request.json();

      // A. Création d'un dossier ou sous-dossier
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

      // B. Masquer une image GitHub ("Images Gauche" / "Images A4") pour tout le monde sur R2
      if (body.action === "hide_static_file") {
        if (body.code !== DELETE_PASSCODE) {
          return new Response(
            JSON.stringify({ ok: false, error: "Code de suppression incorrect." }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const currentList = await getDeletedStaticFiles();
        if (body.filePath && !currentList.includes(body.filePath)) {
          currentList.push(body.filePath);
          await bucket.put(DELETED_STATIC_KEY, JSON.stringify(currentList), {
            httpMetadata: { contentType: "application/json" }
          });
        }
        return new Response(JSON.stringify({ ok: true, deletedStaticFiles: currentList }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // C. Renommer et/ou déplacer un fichier vers un autre dossier/sous-dossier (Code Bonesink124!)
      if (body.action === "update_file_meta") {
        if (body.code !== DELETE_PASSCODE) {
          return new Response(
            JSON.stringify({ ok: false, error: "Code incorrect." }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const existingObj = await bucket.get(body.key);
        if (!existingObj) {
          return new Response(
            JSON.stringify({ ok: false, error: "Fichier introuvable sur R2." }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const oldMeta = existingObj.customMetadata || {};
        const newLabel = (body.newLabel || oldMeta.label || "").trim();
        const newSubFolder = (body.newSubFolder || oldMeta.subFolder || "Général")
          .split("/")
          .map(p => p.trim())
          .filter(Boolean)
          .join("/");
        const newFolder = body.newFolder || oldMeta.folder || body.key.split("/")[0];

        const dataBuffer = await existingObj.arrayBuffer();
        await bucket.put(body.key, dataBuffer, {
          httpMetadata: existingObj.httpMetadata,
          customMetadata: {
            ...oldMeta,
            label: newLabel,
            folder: newFolder,
            subFolder: newSubFolder
          }
        });

        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // D. Renommer ou déplacer un dossier / sous-dossier entier (et tout son contenu)
      if (body.action === "rename_folder") {
        if (body.code !== DELETE_PASSCODE) {
          return new Response(
            JSON.stringify({ ok: false, error: "Code incorrect." }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const targetFolder = body.folder || "ready_deposited";
        const oldSub = (body.oldSubFolder || "").trim();
        const newSub = (body.newSubFolder || "")
          .split("/")
          .map(p => p.trim())
          .filter(Boolean)
          .join("/");

        if (!oldSub || oldSub === "Général" || !newSub) {
          return new Response(
            JSON.stringify({ ok: false, error: "Chemin de dossier non valide." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const allObjects = await listAllObjects();
        let updatedCount = 0;

        for (const item of allObjects) {
          const meta = item.customMetadata || {};
          const itemFolder = meta.folder || item.key.split("/")[0];
          const isMatchTab =
            itemFolder === targetFolder ||
            (targetFolder === "ready_deposited" && itemFolder === "ready_docs");
          const itemSub = meta.subFolder || "";

          if (isMatchTab && (itemSub === oldSub || itemSub.startsWith(oldSub + "/"))) {
            const updatedSub = newSub + itemSub.slice(oldSub.length);
            const fullObj = await bucket.get(item.key);
            if (fullObj) {
              const buf = await fullObj.arrayBuffer();
              await bucket.put(item.key, buf, {
                httpMetadata: fullObj.httpMetadata,
                customMetadata: {
                  ...meta,
                  label: meta.fileType === "FOLDER" ? updatedSub : (meta.label || ""),
                  folder: targetFolder,
                  subFolder: updatedSub
                }
              });
              updatedCount++;
            }
          }
        }

        return new Response(JSON.stringify({ ok: true, updatedCount, newSubFolder: newSub }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // E. Upload standard d'un fichier (déjà converti en WebP côté client si c'est une image)
      const { folder, subFolder, label, fileName, fileType, dataUrl, previewDataUrl } = body;
      const safeFolder = folder || "left_4";
      const safeSubFolder = (subFolder || "Général")
        .split("/")
        .map(part => part.trim())
        .filter(Boolean)
        .join("/");

      const cleanFileName = (fileName || "fichier.webp").replace(/[^a-zA-Z0-9._-]/g, "_");
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
        const thumbDecoded = decodeDataUrl(previewDataUrl);
        const thumbExt = thumbDecoded.mime.includes("webp") ? "webp" : "png";
        thumbKey = `${mainKey}_thumb.${thumbExt}`;
        await bucket.put(thumbKey, thumbDecoded.u8, {
          httpMetadata: { contentType: thumbDecoded.mime }
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

      if (action === "delete_folder") {
        const targetFolder = url.searchParams.get("folder") || "ready_deposited";
        const targetSubFolder = url.searchParams.get("subFolder") || "";

        if (!targetSubFolder || targetSubFolder === "Général") {
          return new Response(
            JSON.stringify({ ok: false, error: "Le dossier principal Général ne peut pas être supprimé." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const allObjects = await listAllObjects();
        let deletedCount = 0;

        for (const obj of allObjects) {
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