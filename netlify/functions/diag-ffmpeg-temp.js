// MIDLERTIDIG diagnosefunksjon — kun for å bekrefte at ffmpeg-static sin
// binærfil faktisk fungerer på Netlify sitt ekte Linux-miljø etter esbuild-
// bundling, FØR "🎙️ Lydopptak"-funksjonen stoles på i produksjon. Ingen
// autentisering, ingen ekte data — slettes rett etter verifisering.
const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

function execFileP(cmd, args) {
  return new Promise(function (resolve, reject) {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 20 }, function (err, stdout, stderr) {
      if (err) { err.stderr = stderr; reject(err); return; }
      resolve({ stdout: stdout, stderr: stderr });
    });
  });
}

exports.handler = async function () {
  var report = { ffmpegPath: ffmpegPath, steps: [] };
  try {
    var stat = await fs.stat(ffmpegPath);
    report.steps.push("binærfil finnes: " + stat.size + " bytes, mode " + stat.mode.toString(8));
  } catch (err) {
    report.steps.push("FEIL: binærfil finnes IKKE på " + ffmpegPath + " — " + err.message);
    return { statusCode: 200, body: JSON.stringify(report, null, 2) };
  }

  try {
    var v = await execFileP(ffmpegPath, ["-version"]);
    report.steps.push("ffmpeg -version OK: " + v.stdout.split("\n")[0]);
  } catch (err) {
    report.steps.push("FEIL: kunne ikke kjøre ffmpeg -version — " + err.message + " / stderr: " + (err.stderr || "").slice(0, 300));
    return { statusCode: 200, body: JSON.stringify(report, null, 2) };
  }

  // Ekte splitting-test: generer 3 sekunder stillhet, del i 1-sekunds biter.
  try {
    var tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "diag-"));
    var inputPath = path.join(tmpDir, "input.wav");
    await execFileP(ffmpegPath, ["-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "3", "-y", inputPath]);
    var outPattern = path.join(tmpDir, "chunk_%03d.wav");
    await execFileP(ffmpegPath, ["-i", inputPath, "-f", "segment", "-segment_time", "1", "-c", "copy", "-reset_timestamps", "1", "-y", outPattern]);
    var files = (await fs.readdir(tmpDir)).filter(function (f) { return f.indexOf("chunk_") === 0; });
    report.steps.push("splitting OK: " + files.length + " biter generert (" + files.join(", ") + ")");
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch (err) {
    report.steps.push("FEIL under splitting-test: " + err.message + " / stderr: " + (err.stderr || "").slice(0, 300));
  }

  return { statusCode: 200, body: JSON.stringify(report, null, 2) };
};
