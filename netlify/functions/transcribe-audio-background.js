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
const { friendlyError } = require("./lib/errors.js");
const { transcribeMultipleAudioFiles } = require("./lib/transcribe.js");
const { extractPptx } = require("./lib/pptx.js");
const { generateManuscriptFromTranscript } = require("./lib/manuscript.js");
const { isAuthorizedUser } = require("./lib/authCheck.js");

// En «sti» kan være én lagringssti, eller { parts: [...], ext } når filen var for stor
// til å lastes opp samlet (Supabase avviser >50 MB) og ble delt i biter i nettleseren.
// Delene settes sammen igjen i rekkefølge — byte for byte, så filen er identisk med originalen.
function pathParts(entry) { return typeof entry === "string" ? [entry] : ((entry && entry.parts) || []); }
function pathExt(entry, fallback) {
  var src = typeof entry === "string" ? entry : (entry && entry.ext) || "";
  var m = String(src).match(/\.[a-zA-Z0-9]+$/);
  return m ? m[0] : fallback;
}
function validEntry(entry) {
  var parts = pathParts(entry);
  return parts.length > 0 && parts.every(function (p) { return typeof p === "string" && p.indexOf("..") === -1; });
}
async function downloadAssembled(supabase, entry) {
  var bufs = [];
  var parts = pathParts(entry);
  for (var i = 0; i < parts.length; i++) {
    var dl = await supabase.storage.from("manus").download(parts[i]);
    if (dl.error || !dl.data) throw new Error("Kunne ikke laste ned " + (parts.length > 1 ? "del " + (i + 1) + " av " + parts.length : "filen") + " fra lagringen: " + (dl.error ? dl.error.message : "ukjent feil"));
    bufs.push(Buffer.from(await dl.data.arrayBuffer()));
  }
  return bufs.length === 1 ? bufs[0] : Buffer.concat(bufs);
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Mangler SUPABASE_URL og/eller SUPABASE_SERVICE_ROLE_KEY som miljøvariabler i Netlify.");
  return createClient(url, key);
}

async function recordProgress(supabase, caseId, text) {
  try {
    var current = await supabase.from("cases").select("historikk").eq("id", caseId).maybeSingle();
    await supabase.from("cases").update({ historikk: [{ ts: new Date().toISOString(), text: text }].concat((current.data && current.data.historikk) || []) }).eq("id", caseId);
  } catch (err) { /* fremdriftsnotis er ikke kritisk */ }
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
  // audioPaths (flertall, ny) — én eller flere lydfiler for samme sak
  // ("2 x 30 minutter"-intervju osv.). audioPath (entall) beholdt som
  // fallback for bakoverkompatibilitet.
  var audioPaths = body.audioPaths || (body.audioPath ? [body.audioPath] : []);
  var imagePaths = body.imagePaths || [];
  var pptxPaths = body.pptxPaths || [];
  var aiNotat = body.aiNotat || "";

  if (!caseId || (!audioPaths.length && !pptxPaths.length)) return { statusCode: 400, body: "" };
  if (!audioPaths.concat(pptxPaths).every(validEntry)) return { statusCode: 400, body: "" };

  var supabase = getSupabase();
  if (!openaiKey) { await recordFailure(supabase, caseId, "OPENAI_API_KEY er ikke satt i Netlify ennå."); return { statusCode: 200, body: "" }; }

  try {
    var files = [];
    var audioUrls = [];
    for (var p = 0; p < audioPaths.length; p++) {
      var audioEntry = audioPaths[p];
      var buffer = await downloadAssembled(supabase, audioEntry);
      files.push({ buffer: buffer, ext: pathExt(audioEntry, ".m4a") });
      console.log("transcribe-audio-background: lydfil " + (p + 1) + "/" + audioPaths.length + " (" + pathParts(audioEntry).length + " del(er), " + (buffer.length / 1024 / 1024).toFixed(1) + " MB)");

      // Delt opp i biter = ingen enkelt lagringsfil å lenke til (kan ikke spilles av samlet).
      if (typeof audioEntry !== "string") continue;
      var audioPath = audioEntry;

      // Signert lenke til selve lydopptaket (1 år) — lagres som saken sine
      // kilder, slik at noen faktisk kan spille det av igjen for å
      // dobbeltsjekke et sitat senere.
      var audioUrlRes = await supabase.storage.from("manus").createSignedUrl(audioPath, 60 * 60 * 24 * 365);
      if (audioUrlRes.data && audioUrlRes.data.signedUrl) audioUrls.push(audioUrlRes.data.signedUrl);
    }

    var delteOpptak = audioPaths.filter(function (e) { return typeof e !== "string"; }).length;
    if (delteOpptak) await recordProgress(supabase, caseId, "🎙️ " + delteOpptak + " lydfil(er) var over 50 MB og ble lastet opp i deler — de er satt sammen igjen for transkribering, men kan ikke spilles av direkte fra saken");

    // Koble lydopptaket til saken UMIDDELBART — ikke først når hele jobben er
    // ferdig. Transkribering + research + manusskriving kan feile eller gå ut
    // på tid (lange opptak), og da ble opptaket liggende i lagringen uten
    // noen kobling til saken. Rører aldri kilder som allerede er satt.
    var curCase = await supabase.from("cases").select("kilder").eq("id", caseId).maybeSingle();
    if (audioUrls.length && !(curCase.data && curCase.data.kilder && curCase.data.kilder.length)) {
      await supabase.from("cases").update({ kilder: audioUrls }).eq("id", caseId);
    }

    // PowerPoint-presentasjoner: lysbildetekst + talernotater brukes som
    // ekstra faktagrunnlag sammen med opptaket (eller alene, uten opptak).
    var presTekster = [], presInfo = [];
    for (var q = 0; q < pptxPaths.length; q++) {
      var ppt = await extractPptx(await downloadAssembled(supabase, pptxPaths[q]));
      if (ppt.tekst.trim()) {
        presTekster.push((pptxPaths.length > 1 ? "=== PRESENTASJON " + (q + 1) + " ===\n" : "") + ppt.tekst);
        presInfo.push(ppt.slides.length + " lysbilder, " + ppt.antallNotater + " med talernotater");
      }
    }
    if (pptxPaths.length) await recordProgress(supabase, caseId, "📊 Leste " + presTekster.length + " presentasjon(er): " + (presInfo.join("; ") || "ingen tekst funnet"));

    var transcription = { text: "", flerBiter: false, antallBiter: 0 };
    if (files.length) {
      transcription = await transcribeMultipleAudioFiles(openaiKey, files);
      if (!transcription.text || !transcription.text.trim()) {
        throw new Error("Fant ingen tale i opptaket/opptakene — sjekk at filen(e) faktisk inneholder lyd/tale.");
      }
    } else if (!presTekster.length) {
      throw new Error("Fant ingen tekst i presentasjonen(e) — sjekk at filen(e) er gyldige .pptx-filer med tekst.");
    } else {
      transcription.text = "(Ingen lydopptak ble lastet opp — saken bygger kun på presentasjonen under.)";
    }

    var imageUrls = [];
    for (var i = 0; i < imagePaths.length; i++) {
      var signed = await supabase.storage.from("manus").createSignedUrl(imagePaths[i], 60 * 60 * 24 * 365);
      if (signed.data && signed.data.signedUrl) imageUrls.push(signed.data.signedUrl);
    }

    var result = await generateManuscriptFromTranscript(supabase, openaiKey, caseId, transcription.text, {
      aiNotat: aiNotat,
      imageUrls: imageUrls,
      audioUrls: audioUrls,
      presentasjonTekst: presTekster.join("\n\n"),
      presentasjonInfo: presInfo.join("; "),
      flerBiter: transcription.flerBiter,
      antallBiter: transcription.antallBiter
    });
    console.log("transcribe-audio-background fullført:", JSON.stringify(result));
  } catch (err) {
    console.error("transcribe-audio-background feilet:", err);
    await recordFailure(supabase, caseId, friendlyError(err.message));
  }

  return { statusCode: 200, body: "" };
};
