// Transkriberer ett eller flere lydopptak (typisk et journalist-intervju,
// evt. delt i flere filer — f.eks. et intervju tatt opp i to økter) til
// tekst MED talerskille ("Taler 1"/"Taler 2" osv.), til bruk som grunnlag
// for et nytt manus.
//
// Bruker gpt-4o-transcribe-diarize (OpenAIs /v1/audio/transcriptions,
// response_format=diarized_json) — skiller automatisk mellom ulike stemmer.
//
// HARD GRENSE (samme for alle modeller på dette endepunktet, ingen vei
// utenom — IKKE noe vi kan sette høyere selv): maks 25 MB OG maks ca. 25
// min PER FORESPØRSEL. VIKTIG, oppdaget i praksis (25 min-opptak feilet
// selv om filen var godt under 25 MB): et komprimert taleopptak (lav
// bitrate, typisk fra en telefons opptaksapp) treffer nesten alltid
// VARIGHETSGRENSEN lenge før størrelsesgrensen — det er derfor IKKE nok å
// bare sjekke filstørrelse for å avgjøre om noe må deles opp. Denne filen
// sjekker derfor ALLTID den faktiske varigheten (ekte ffmpeg-probing, ikke
// et anslag ut fra filstørrelse/bitrate) i tillegg til størrelsen.
//
// Splitting gjøres med en ekte ffmpeg-binær (npm-pakken "ffmpeg-static").
// Deles etter TID i biter på CHUNK_SECONDS — satt med god margin under både
// 25 MB- og 25 min-grensen, selv for opptak med høyere bitrate enn typisk
// komprimert taleopptak.
//
// VIKTIG, ærlig begrensning: talergjenkjenningen er IKKE nødvendigvis
// konsistent på tvers av separate biter ELLER separate opplastede filer —
// "Taler 1" i bit/fil 2 er ikke garantert samme person som "Taler 1" i
// bit/fil 1, siden hver del transkriberes uavhengig. Merkes tydelig i
// teksten som går videre til manusgenereringen (lib/manuscript.js), som
// advarer om dette i saken sitt usikkerhetsnotat.

const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

const TRANSCRIBE_MODEL = "gpt-4o-transcribe-diarize";
const MAX_CHUNK_BYTES = 20 * 1024 * 1024; // 20 MB — god margin under den faktiske 25 MB-grensen
const CHUNK_SECONDS = 12 * 60; // 12 min — god margin under ~25 min-grensen, selv ved høyere bitrate enn typisk taleopptak

function execFileP(cmd, args) {
  return new Promise(function (resolve, reject) {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, function (err, stdout, stderr) {
      if (err) { err.stderr = stderr; reject(err); return; }
      resolve({ stdout: stdout, stderr: stderr });
    });
  });
}

// "ffmpeg -i fil" (uten -o) avslutter alltid med feilkode 1, men skriver
// ekte metadata (inkl. "Duration: HH:MM:SS.ms") til stderr FØR den feiler —
// stderr leses derfor uansett om kallet selv "feiler".
async function getAudioDurationSeconds(filePath) {
  var stderr = "";
  try {
    await execFileP(ffmpegPath, ["-i", filePath]);
  } catch (err) {
    stderr = err.stderr || "";
  }
  var m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null; // ukjent varighet — behandles som "må sjekkes på størrelse alene"
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

// Splitter EN lydfil i flere biter à CHUNK_SECONDS via ffmpeg sin
// segment-muxer. "-c copy" = re-enkoder ikke lyden (raskt, ingen tap).
// "-reset_timestamps 1" er nødvendig — uten den arver hver bit hele
// originalfilens varighet i metadata, som kan forvirre transkriberingen.
async function splitAudio(inputPath, ext) {
  var outDir = path.dirname(inputPath);
  var outPattern = path.join(outDir, "chunk_%03d" + ext);
  await execFileP(ffmpegPath, [
    "-i", inputPath,
    "-f", "segment",
    "-segment_time", String(CHUNK_SECONDS),
    "-c", "copy",
    "-reset_timestamps", "1",
    "-y",
    outPattern
  ]);
  var files = (await fs.readdir(outDir))
    .filter(function (f) { return f.indexOf("chunk_") === 0 && f.endsWith(ext); })
    .sort();
  return files.map(function (f) { return path.join(outDir, f); });
}

async function transcribeChunkBuffer(openaiKey, buffer, filename) {
  var form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("model", TRANSCRIBE_MODEL);
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");

  var res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + openaiKey },
    body: form
  });
  if (!res.ok) throw new Error("Transkribering feilet (" + res.status + "): " + (await res.text()).slice(0, 300));
  var data = await res.json();
  return data.segments || [];
}

function segmentsToText(segments, chunkLabel) {
  return segments.map(function (s) {
    var speaker = (s.speaker || "Ukjent taler") + (chunkLabel ? " (" + chunkLabel + ")" : "");
    return speaker + ": " + (s.text || "").trim();
  }).join("\n");
}

// Transkriberer ÉN lydfil (kan bli delt internt). Returnerer
// { text, flerBiter, antallBiter }. filePrefix (valgfritt) brukes i
// bit-merkingen når filen er én av flere opplastede opptak for samme sak
// (se transcribeMultipleAudioFiles under).
async function transcribeAudio(openaiKey, buffer, ext, filePrefix) {
  var safeExt = /^\.[a-zA-Z0-9]+$/.test(ext) ? ext : ".m4a";
  var tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lydopptak-"));
  var inputPath = path.join(tmpDir, "input" + safeExt);
  try {
    await fs.writeFile(inputPath, buffer);

    var durationSeconds = await getAudioDurationSeconds(inputPath);
    var mustSplit = buffer.length > MAX_CHUNK_BYTES || (durationSeconds !== null && durationSeconds > CHUNK_SECONDS);

    if (!mustSplit) {
      var segments = await transcribeChunkBuffer(openaiKey, buffer, "opptak" + safeExt);
      return { text: segmentsToText(segments, filePrefix || null), flerBiter: false, antallBiter: 1 };
    }

    var chunkPaths = await splitAudio(inputPath, safeExt);
    if (!chunkPaths.length) throw new Error("ffmpeg delte opp filen, men fant ingen biter etterpå.");

    var allText = [];
    for (var i = 0; i < chunkPaths.length; i++) {
      var chunkBuf = await fs.readFile(chunkPaths[i]);
      if (!chunkBuf.length) continue; // ffmpeg kan skrive en tom siste-bit
      var chunkSegments = await transcribeChunkBuffer(openaiKey, chunkBuf, "bit" + (i + 1) + safeExt);
      var label = (filePrefix ? filePrefix + ", " : "") + "del " + (i + 1) + " av " + chunkPaths.length;
      allText.push(segmentsToText(chunkSegments, label));
    }
    return { text: allText.join("\n"), flerBiter: true, antallBiter: chunkPaths.length };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(function () {});
  }
}

// Transkriberer FLERE opplastede lydfiler for samme sak (f.eks. et intervju
// tatt opp i flere økter — "2 x 30 minutter") og slår dem sammen til én
// tekst, i rekkefølge, med tydelig merking av hvilket opptak hver linje
// kommer fra. files: [{ buffer, ext }, …] i den rekkefølgen de skal leses.
async function transcribeMultipleAudioFiles(openaiKey, files) {
  var allText = [];
  var flerBiter = files.length > 1; // flere filer = samme usikkerhet om taler-konsistens som flere biter
  var totalBiter = 0;
  for (var i = 0; i < files.length; i++) {
    var filePrefix = files.length > 1 ? "opptak " + (i + 1) + " av " + files.length : null;
    var result = await transcribeAudio(openaiKey, files[i].buffer, files[i].ext, filePrefix);
    if (result.flerBiter) flerBiter = true;
    totalBiter += result.antallBiter;
    if (result.text.trim()) allText.push(result.text);
  }
  return { text: allText.join("\n"), flerBiter: flerBiter, antallBiter: totalBiter };
}

module.exports = { transcribeAudio, transcribeMultipleAudioFiles, TRANSCRIBE_MODEL, MAX_CHUNK_BYTES, CHUNK_SECONDS };
