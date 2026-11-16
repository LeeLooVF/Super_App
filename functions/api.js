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

    // 2. ACTIONS POST (EXTRACTION IA GEMINI 3.0 FLASH, DOSSIERS, UPLOAD R2, MODIFICATIONS)
    if (request.method === "POST") {
      const body = await request.json();

      // =========================================================================
      // EXTRACTION ULTRA-PRÉCISE DES ÉTIQUETTES VIA GEMINI 3.0 FLASH VISION API
      // =========================================================================
      if (body.action === "extract_labels_gemini") {
        const apiKey = body.apiKey || env.GEMINI_API_KEY;
        if (!apiKey) {
          return new Response(
            JSON.stringify({ ok: false, error: "MISSING_API_KEY", message: "Clé GEMINI_API_KEY manquante." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const dataUrl = body.imageDataUrl || "";
        const parts = dataUrl.split(",");
        const mimeType = (parts[0].match(/:(.*?);/) || [null, "image/jpeg"])[1];
        const base64Image = parts[1];

        const systemPrompt = `Tu es un expert en lecture de planches d'étiquettes de prix de supermarché Super U (souvent organisées en grille de 3 colonnes sur 7 lignes, soit jusqu'à 21 étiquettes par page, ou une étiquette unique).
Lis TOUTES les étiquettes présentes sur l'image dans l'ordre de lecture (de gauche à droite, et de haut en bas, sans jamais oublier la dernière ligne tout en bas).

Pour CHAQUE étiquette, extrais avec une précision absolue :
- "productName" : Le libellé complet du produit situé tout en haut de l'étiquette (en MAJUSCULES).
- "oldPrice" : Le prix principal TTC du produit en euros (nombre décimal, ex: 2.31). S'il y a un prix barré et un prix remisé, mets le prix barré (prix avant remise) dans oldPrice. Attention : sur certaines étiquettes Super U, le symbole € est écrit à gauche ou au milieu sans virgule (ex: "€ 2,31" ou "2€31"). Ne confonds JAMAIS le prix du produit avec le prix au kg/litre !
- "promoMainPrice" : Si l'étiquette affiche un prix réduit en plus du prix barré, indique ce nouveau prix réduit (ex: 1.85), sinon mets null.
- "baseUnitPrice" : Le prix au kilo, au litre ou à la pièce indiqué après "Prix kg :", "Prix l :" ou "Prix pièce :" (nombre décimal, ex: 23.10).
- "unitType" : Uniquement "kg", "l" ou "pièce" selon l'unité du prix unitaire.
- "contenanceText" : La contenance lisible du produit convertie proprement (ex: si "cont : 0.100 kg", écris "100 g" ; si "cont : 0.750 l", écris "75 cl" ou "750 ml" ; si "cont : 1.500 l", écris "1,5 L" ; si "1 pièce", écris "1 pièce").
- "gencode" : Le code-barres EAN officiel (13 chiffres ou 8 chiffres) situé TOUT EN BAS À GAUCHE sous les barres verticales du code-barres (ex: "3616305242723" ou "5056585804187"). INTERDICTION ABSOLUE de prendre le code interne magasin situé au milieu de l'étiquette qui commence par "00001", "90527" ou qui contient un slash "/" (ex: ignore "00001 4015276/1" ou "90527 028335070"). Renvoie uniquement les chiffres attachés sans espaces.
- "hasPromo" : true UNIQUEMENT si une promotion explicite est écrite sur l'étiquette (ex: "-34%", "2+1", "1+1", "-50% sur le 2ème", ou présence d'un prix barré), sinon false. Ne confonds jamais "30% MG" (matière grasse) ou "12% vol" (alcool) avec une promotion !
- "promoDiscount" : Si hasPromo est true, la valeur courte à mettre dans le cercle rouge (ex: "-34%", "2+1", "1+1", "-50%"), sinon "".
- "promoText" : Si hasPromo est true, le texte complémentaire (ex: "DE REMISE|IMMÉDIATE", "OFFERT", "GRATUIT", "SUR LE 2ÈME|PRODUIT"), sinon "".
- "promoPresetKey" : Si hasPromo est true, choisis parmi "remise_imm", "2_plus_1", "1_plus_1", "2eme_50", "remise_euros", sinon "".

Ignore les blocs techniques d'en-tête ou de pied de page qui ne sont pas des étiquettes produits (ex: "FICHIER PORTABLE", "COMMENTAIRES :", "Super U TALANGE").`;

        const geminiPayload = {
          contents: [
            {
              parts: [
                { text: systemPrompt },
                { inline_data: { mime_type: mimeType, data: base64Image } }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                labels: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      productName: { type: "STRING" },
                      oldPrice: { type: "NUMBER" },
                      promoMainPrice: { type: "NUMBER", nullable: true },
                      baseUnitPrice: { type: "NUMBER" },
                      unitType: { type: "STRING" },
                      contenanceText: { type: "STRING" },
                      gencode: { type: "STRING" },
                      hasPromo: { type: "BOOLEAN" },
                      promoDiscount: { type: "STRING" },
                      promoText: { type: "STRING" },
                      promoPresetKey: { type: "STRING" }
                    },
                    required: ["productName", "oldPrice", "baseUnitPrice", "unitType", "contenanceText", "gencode", "hasPromo"]
                  }
                }
              },
              required: ["labels"]
            }
          }
        };

        // Modèle mis à jour vers gemini-3.0-flash (avec fallback automatique vers gemini-2.0-flash si besoin)
        const modelsToTry = ["gemini-3.0-flash", "gemini-2.5-flash-preview-09-2025", "gemini-2.0-flash"];
        let geminiJson = null;
        let lastError = "Erreur Gemini API";

        for (const modelName of modelsToTry) {
          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(geminiPayload)
            }
          );
          const data = await geminiRes.json();
          if (geminiRes.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
            geminiJson = data;
            break;
          } else {
            lastError = data.error?.message || `Erreur sur ${modelName}`;
          }
        }

        if (!geminiJson) {
          return new Response(
            JSON.stringify({ ok: false, error: lastError }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const rawText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || '{"labels":[]}';
        const parsedData = JSON.parse(rawText);

        return new Response(JSON.stringify({ ok: true, labels: parsedData.labels || [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

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

      // C. Renommer et/ou déplacer un fichier vers un autre dossier/sous-dossier
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

      // D. Renommer ou déplacer un dossier / sous-dossier entier
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

      // E. Upload standard d'un fichier sur R2
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

    // 3. SUPPRIMER UN FICHIER OU UN DOSSIER/SOUS-DOSSIER COMPLET (DELETE /api)
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
