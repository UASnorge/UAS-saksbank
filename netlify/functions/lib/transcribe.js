// Transkriberer et lydopptak (typisk et journalist-intervju, 30-45 min ifølge
// brukeren, men skal fungere uansett lengde) til tekst MED talerskille
// ("Taler 1"/"Taler 2" osv.), til bruk som grunnlag for et nytt manus.
//
// Bruker gpt-4o-transcribe-diarize (OpenAIs /v1/audio/transcriptions,
// response_format=diarized_json) — nyere modell enn whisper-1, skiller
// automatisk mellom ulike stemmer i opptaket. Verifisert via faktisk
// dokumentasjonsoppslag 2026-09-01 (ikke antatt fra treningsdata).
//
// HARD GRENSE (samme for alle modeller på dette endepunktet, uansett
// chunking_strategy): maks 25 MB / ca. 25 min PER FORESPØRSEL. Et opptak
// utover det MÅ splittes opp av oss selv FØR opplasting til OpenAI —
// chunking_strategy=auto styrer kun talergjenkjenning-kvalitet INNENFOR én
// forespørsel, det er ikke en vei rundt størrelsesgrensen.
//
// Splitting gjøres med en ekte ffmpeg-binær (npm-pakken "ffmpeg-static" —
// laster ned riktig plattformbinær automatisk ved "npm install", også på
// Netlify sin egen Linux-byggeserver ved deploy). Deles etter TID (faste
// 15-minutters biter, god margin under både 25 MB- og 25 min-grensen for
// vanlige taleopptak-bitrates) — ikke etter stillhet/VAD, for å holde det
// enkelt og forutsigbart.
//
// VIKTIG, ærlig begrensning: talergjenkjenningen er IKKE nødvendigvis
// konsistent PÅ TVERS av biter — "Taler 1" i bit 2 er ikke garantert samme
// person som "Taler 1" i bit 1, siden hver bit transkriberes uavhengig.
// Merkes derfor tydelig i teksten som går videre til manusgenereringen
// (lib/manuscript.js), som igjen advarer om dette i saken sitt
// usikkerhetsnotat — samme "grunnregel" som resten av appen: aldri fremstill
// noe som sikrere enn det faktisk er.

const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

const TRANSCRIBE_MODEL = "gpt-4o-transcribe-diarize";
const MAX_CHUNK_BYTES = 24 * 1024 * 1024; // 24 MB — margin under den faktiske 25 MB-grensen
const CHUNK_SECONDS = 15 * 60; // 15 min — margin under ~25 min-grensen for de fleste taleopptak-bitrates

function execFileP(cmd, args) {
  return new Promise(function (resolve, reject) {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, function (err, stdout, stderr) {
      if (err) { err.stderr = stderr; reject(err); return; }
      resolve({ stdout: stdout, stderr: stderr });
    });
  });
}

// Splitter EN lydfil i flere biter à CHUNK_SECONDS via ffmpeg sin
// segment-muxer. "-c copy" = re-enkoder ikke lyden (raskt, ingen tap) —
// fungerer for alle formatene OpenAI støtter (mp3/mp4/m4a/wav/webm/mpeg/mpga)
// siden de alle har en container-struktur segment-muxeren skjønner.
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
  }).filter(function (line) { return line.indexOf(": ") !== line.length - 2; }).join("\n");
}

// Hovedfunksjon. buffer = hele lydfilen, ext = filendelse MED punktum (f.eks.
// ".m4a"), avledet av opprinnelig filnavn ved opplasting.
// Returnerer { text, flerBiter, antallBiter } — text er ferdig
// sammenslått transkripsjon med talermerking, klar til å gis til AI-en som
// skriver selve manuset (lib/manuscript.js).
async function transcribeAudio(openaiKey, buffer, ext) {
  var safeExt = /^\.[a-zA-Z0-9]+$/.test(ext) ? ext : ".m4a";

  if (buffer.length <= MAX_CHUNK_BYTES) {
    var segments = await transcribeChunkBuffer(openaiKey, buffer, "opptak" + safeExt);
    return { text: segmentsToText(segments, null), flerBiter: false, antallBiter: 1 };
  }

  // Utover grensen — splitt med ffmpeg via en midlertidig mappe (Netlify
  // Functions har et skrivbart /tmp, ryddes automatisk mellom kall).
  var tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lydopptak-"));
  var inputPath = path.join(tmpDir, "input" + safeExt);
  try {
    await fs.writeFile(inputPath, buffer);
    var chunkPaths = await splitAudio(inputPath, safeExt);
    if (!chunkPaths.length) throw new Error("ffmpeg delte opp filen, men fant ingen biter etterpå.");

    var allText = [];
    for (var i = 0; i < chunkPaths.length; i++) {
      var chunkBuf = await fs.readFile(chunkPaths[i]);
      if (!chunkBuf.length) continue; // ffmpeg kan skrive en tom siste-bit
      var chunkSegments = await transcribeChunkBuffer(openaiKey, chunkBuf, "bit" + (i + 1) + safeExt);
      allText.push(segmentsToText(chunkSegments, "del " + (i + 1) + " av " + chunkPaths.length));
    }
    return { text: allText.join("\n"), flerBiter: true, antallBiter: chunkPaths.length };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(function () {});
  }
}

module.exports = { transcribeAudio, TRANSCRIBE_MODEL, MAX_CHUNK_BYTES, CHUNK_SECONDS };
