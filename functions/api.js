// Liste exacte avec gemini-3.8-flash demandé par Google AI Studio en 1er
        let candidateModels = [
          "gemini-3.8-flash",
          "gemini-3.8-flash-preview",
          "gemini-3-flash",
          "gemini-3.5-flash",
          "gemini-flash-latest"
        ];

        // Récupère aussi dynamiquement la liste des modèles autorisés par ta clé
        try {
          const listRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
          );
          if (listRes.ok) {
            const listData = await listRes.json();
            const available = (listData.models || [])
              .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
              .map(m => m.name.replace(/^models\//, ""))
              .filter(name => /gemini/i.test(name) && !/2\.0|2\.5|1\.5|embedding|imagen|veo|tts|audio/i.test(name));
            if (available.length > 0) {
              candidateModels = [...new Set(["gemini-3.8-flash", ...available, ...candidateModels])];
            }
          }
        } catch (e) {}

        let geminiJson = null;
        let errorsLog = [];

        for (const modelName of candidateModels) {
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
            errorsLog.push(`[${modelName}]: ${data.error?.message || geminiRes.status}`);
          }
        }

        if (!geminiJson) {
          return new Response(
            JSON.stringify({ ok: false, error: `[API v4] ` + errorsLog.join(" | ") }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
