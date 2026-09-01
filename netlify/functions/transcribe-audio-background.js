// Selve arbeidet bak "🎙️ Lydopptak"-fanen i "+ Ny sak": transkriberer et
// opplastet lydopptak (lib/transcribe.js — håndterer deling av lange opptak
// selv) og genererer et redaksjonelt førsteutkast fra det
// (lib/manuscript.js sin generateManuscriptFromTranscript).
//
// Background Function (samme begrunnelse som source-gate-background.js og
// web-search-background.js — transkribering + manusgenerering av et 30-45
// min opptak tar for lang tid for en vanlig 30-sekunders funksjon).
//
// Saken selv opprettes RASKT og SYNKRONT av frontend (public/index.html,
// submitNewCaseFromAudio) FØR denne funksjonen kalles — brukeren havner rett
// inne i saken med en gang, og ser resultatet dukke opp live via Supabase
// Realtime når denne bakgrunnsjobben er ferdig (samme mønster appen allerede
// bruker for alt annet). IKKE kall denne direkte fra frontend uten at saken
// allerede finnes — kun caseId + lagringsstier sendes med, ikke selve
// lydfilen (unngår Netlify sin grense for forespørsels-størrelse; filen er
// allerede lastet opp direkte til Supabase Storage av nettleseren).

const { createClient } = require("@supabase/supabase-js");
const { transcribeAudio } = require("./lib/transcribe.js");
const { generateManuscriptFromTranscript } = require("./lib/manuscript.js");
const { isAuthorizedUser } = require("./lib/authCheck.js");

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Mangler SUPABASE_URL og/eller SUPABASE_SERVICE_ROLE_KEY som miljøvariabler i Netlify.");
  return createClient(url, key);
}

async function recordFailure(supabase, caseId, message) {
  try {
    var current = await supabase.from("cases").select("historikk").eq("id", caseId).maybeSingle();
    var historikk = (current.data && current.data.historikk) || [];
    await supabase.from("cases").update({
      historikk: [{ ts: new Date().toISOString(), text: "❌ Lydopptak → manus feilet: " + message }].concat(historikk)
    }).eq("id", caseId);
  } catch (err) {
    console.error("Klarte ikke engang å skrive feilmelding til saken:", err);
  }
}

exports.handler = async function (event) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!(await isAuthorizedUser(event))) return { statusCode: 401, body: "" };

  var body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "" }; }

  var caseId = body.caseId;
  var audioPath = body.audioPath;
  var imagePaths = body.imagePaths || [];
  var aiNotat = body.aiNotat || "";

  if (!caseId || !audioPath) return { statusCode: 400, body: "" };

  var supabase = getSupabase();
  if (!openaiKey) { await recordFailure(supabase, caseId, "OPENAI_API_KEY er ikke satt i Netlify ennå."); return { statusCode: 200, body: "" }; }

  try {
    var dl = await supabase.storage.from("manus").download(audioPath);
    if (dl.error || !dl.data) throw new Error("Kunne ikke laste ned lydfilen fra lagringen: " + (dl.error ? dl.error.message : "ukjent feil"));
    var buffer = Buffer.from(await dl.data.arrayBuffer());
    var extMatch = audioPath.match(/\.[a-zA-Z0-9]+$/);
    var ext = extMatch ? extMatch[0] : ".m4a";

    console.log("transcribe-audio-background: transkriberer " + audioPath + " (" + (buffer.length / 1024 / 1024).toFixed(1) + " MB)");
    var transcription = await transcribeAudio(openaiKey, buffer, ext);
    if (!transcription.text || !transcription.text.trim()) {
      throw new Error("Fant ingen tale i opptaket — sjekk at filen faktisk inneholder lyd/tale.");
    }

    var imageUrls = [];
    for (var i = 0; i < imagePaths.length; i++) {
      var signed = await supabase.storage.from("manus").createSignedUrl(imagePaths[i], 60 * 60 * 24 * 365);
      if (signed.data && signed.data.signedUrl) imageUrls.push(signed.data.signedUrl);
    }

    // Signert lenke til selve lydopptaket (1 år) — lagres som saken sin
    // kilde, slik at noen faktisk kan spille det av igjen for å dobbeltsjekke
    // et sitat senere (se ensureAudioQuoteCheckpoint-kontrollpunktet under).
    var audioUrlRes = await supabase.storage.from("manus").createSignedUrl(audioPath, 60 * 60 * 24 * 365);
    var audioUrl = (audioUrlRes.data && audioUrlRes.data.signedUrl) || null;

    var result = await generateManuscriptFromTranscript(supabase, openaiKey, caseId, transcription.text, {
      aiNotat: aiNotat,
      imageUrls: imageUrls,
      audioUrl: audioUrl,
      flerBiter: transcription.flerBiter,
      antallBiter: transcription.antallBiter
    });
    console.log("transcribe-audio-background fullført:", JSON.stringify(result));
  } catch (err) {
    console.error("transcribe-audio-background feilet:", err);
    await recordFailure(supabase, caseId, err.message);
  }

  return { statusCode: 200, body: "" };
};
