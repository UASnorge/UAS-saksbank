// Små, avhengighetsfrie bildehjelpere delt av lib/articleImages.js (bilder
// fra nettartikler) og lib/docImages.js (bilder fra PDF/Word).

// Type ut fra de første bytene (magic bytes) — Content-Type-headere og
// filendelser lyver av og til. Returnerer "jpg" | "png" | "gif" | "webp" | null.
function imageTypeOf(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.toString("ascii", 0, 3) === "GIF") return "gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

// { width, height, components? } eller null. components (JPEG) brukes til å
// oppdage CMYK-JPEG (4), som nettlesere/Word viser med feil farger.
function sniffDimensions(buf) {
  try {
    var type = imageTypeOf(buf);
    if (type === "png" && buf.length > 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (type === "gif") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (type === "jpg") {
      var i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        var marker = buf[i + 1];
        if (marker === 0xff) { i++; continue; }
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (type === "webp") {
      var fmt = buf.toString("ascii", 12, 16);
      if (fmt === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (fmt === "VP8L") {
        var b = buf.readUInt32LE(21);
        return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
      }
      if (fmt === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  } catch (err) {}
  return null;
}

// URL-/filnavn-mønstre som nesten alltid er logoer, ikoner, standard delings-
// bilder eller sporingspiksler — ikke redaksjonelle bilder. Samme
// begrunnelse som i lib/imageResearch.js: modellen alene er ikke til å
// stole på her, så vi har et kode-nivå sikkerhetsnett.
var GENERIC_IMAGE_URL_PATTERN = /fallback|placeholder|default[-_]?(image|share|og)|og[-_]image|social[-_]?(share|media)|logo|favicon|sprite|avatar|icon[-_.\d]|\/icons?\/|banner[-_]?ad|pixel|tracking|spacer|blank\.|1x1|wordmark|badge|button|banner|annons|sponsor|partner|shareon|facebook|twitter|linkedin|instagram|whatsapp|newsletter|nyhetsbrev/i;

function looksGenericUrl(url) {
  return GENERIC_IMAGE_URL_PATTERN.test(String(url || ""));
}

module.exports = { imageTypeOf, sniffDimensions, looksGenericUrl, GENERIC_IMAGE_URL_PATTERN };
