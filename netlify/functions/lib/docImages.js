// Trekker ut redaksjonelle bilder fra opplastede dokumenter (PDF og Word), så
// de kan brukes som hovedbilde og støttebilder i saken — med bildetekst.
//
// PDF: leser bilde-objektene (XObject/Image) direkte med pdf-lib (ren JS,
// ingen native avhengigheter, ingen worker — trygt i Netlify Functions).
//  - DCTDecode (JPEG) er selve bildefilen og hentes rett ut (foto i
//    rapporter er nesten alltid JPEG). CMYK-JPEG hoppes over (feil farger).
//  - FlateDecode (rå piksler, typisk PNG/kart/figurer): pakkes ut, PNG-
//    prediktorer reverseres, og skrives som ekte PNG. Kun 8 bit gråtone/RGB
//    støttes (ICCBased leses via N); indeksert/CMYK/JPX/CCITT hoppes over.
//  - Bilder som gjentas på flere sider (logo/topptekst), er små, har
//    ekstreme sideforhold eller er duplikater filtreres bort.
// Word: hentes via mammoth (samme bibliotek som resten av appen bruker).

const zlib = require("zlib");
const crypto = require("crypto");
const mammoth = require("mammoth");
const { PDFDocument, PDFName, PDFRawStream, PDFRef, PDFDict, PDFArray, PDFNumber } = require("pdf-lib");
const { imageTypeOf, sniffDimensions } = require("./imageUtils.js");

const MIN_W = 350, MIN_H = 200, MIN_AREA = 120000, MIN_BYTES = 2500;
const MIN_ASPECT = 0.35, MAX_ASPECT = 3.6;
const MAX_REPEAT_PAGES = 2; // brukt på flere sider enn dette = logo/topptekst
const MAX_IMAGES = 10;

// ---------- PNG-skriving (uten avhengigheter) ----------
var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  var c = 0xffffffff;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  var td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, components, raw) {
  var stride = width * components;
  var rows = Buffer.alloc((stride + 1) * height);
  for (var y = 0; y < height; y++) {
    rows[y * (stride + 1)] = 0;
    raw.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = components === 1 ? 0 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// Reverserer PNG-prediktorer (PDF Predictor 10–15) på utpakkede Flate-data.
function unpredictPng(data, columns, colors, bpc) {
  var bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  var rowBytes = Math.ceil((colors * bpc * columns) / 8);
  var rowCount = Math.floor(data.length / (rowBytes + 1));
  var out = Buffer.alloc(rowCount * rowBytes);
  for (var y = 0; y < rowCount; y++) {
    var ft = data[y * (rowBytes + 1)];
    var srcOff = y * (rowBytes + 1) + 1;
    var dstOff = y * rowBytes;
    var prevOff = (y - 1) * rowBytes;
    for (var x = 0; x < rowBytes; x++) {
      var raw = data[srcOff + x];
      var left = x >= bpp ? out[dstOff + x - bpp] : 0;
      var up = y > 0 ? out[prevOff + x] : 0;
      var upLeft = y > 0 && x >= bpp ? out[prevOff + x - bpp] : 0;
      var v;
      if (ft === 0) v = raw;
      else if (ft === 1) v = raw + left;
      else if (ft === 2) v = raw + up;
      else if (ft === 3) v = raw + ((left + up) >> 1);
      else if (ft === 4) {
        var p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else v = raw;
      out[dstOff + x] = v & 0xff;
    }
  }
  return out;
}

// ---------- pdf-lib-hjelpere ----------
function nameStr(o) { return o instanceof PDFName ? o.toString().replace(/^\//, "") : null; }
function num(dict, key) {
  var v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : null;
}
function filterList(dict) {
  var f = dict.lookup(PDFName.of("Filter"));
  if (!f) return [];
  if (f instanceof PDFArray) return f.asArray().map(function (x) { return nameStr(dict.context.lookup(x)); });
  return [nameStr(f)];
}
function decodeParams(dict) {
  var p = dict.lookup(PDFName.of("DecodeParms"));
  if (p instanceof PDFArray) p = p.size() ? dict.context.lookup(p.get(0)) : null;
  return p instanceof PDFDict ? p : null;
}
function colorComponents(dict) {
  var cs = dict.lookup(PDFName.of("ColorSpace"));
  if (cs instanceof PDFName) {
    var n = nameStr(cs);
    if (n === "DeviceRGB") return 3;
    if (n === "DeviceGray") return 1;
    return null; // DeviceCMYK m.fl.
  }
  if (cs instanceof PDFArray && cs.size() >= 2) {
    var kind = nameStr(cs.lookup(0));
    if (kind === "ICCBased") {
      var prof = dict.context.lookup(cs.get(1));
      if (prof && prof.dict) { var N = num(prof.dict, "N"); return N === 1 || N === 3 ? N : null; }
    }
    if (kind === "CalRGB") return 3;
    if (kind === "CalGray") return 1;
  }
  return null;
}

function passesSizeFilter(w, h, bytes) {
  if (!w || !h) return false;
  if (w < MIN_W || h < MIN_H || w * h < MIN_AREA) return false;
  var aspect = w / h;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) return false;
  if (bytes < MIN_BYTES) return false;
  return true;
}

async function extractPdfImages(buffer, opts) {
  opts = opts || {};
  var max = opts.max || MAX_IMAGES;
  var doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  var ctx = doc.context;

  // Hvilke sider bruker hvilke bilde-objekter?
  var usage = {}; // refString -> Set(sideindeks)
  doc.getPages().forEach(function (page, pageIdx) {
    try {
      var res = page.node.Resources();
      var xobj = res && res.lookupMaybe(PDFName.of("XObject"), PDFDict);
      if (!xobj) return;
      xobj.entries().forEach(function (entry) {
        var ref = entry[1];
        if (ref instanceof PDFRef) {
          var key = ref.toString();
          (usage[key] = usage[key] || new Set()).add(pageIdx);
        }
      });
    } catch (e) {}
  });

  var found = [];
  var seenHash = {};
  ctx.enumerateIndirectObjects().forEach(function (pair) {
    var ref = pair[0], obj = pair[1];
    try {
      if (!(obj instanceof PDFRawStream)) return;
      var dict = obj.dict;
      if (nameStr(dict.lookup(PDFName.of("Subtype"))) !== "Image") return;
      var w = num(dict, "Width"), h = num(dict, "Height");
      var pages = usage[ref.toString()];
      if (pages && pages.size > MAX_REPEAT_PAGES) return; // logo/topptekst
      var filters = filterList(dict);
      var bpc = num(dict, "BitsPerComponent") || 8;
      var out = null;

      if (filters.length === 1 && filters[0] === "DCTDecode") {
        var jpg = Buffer.from(obj.contents);
        var dims = sniffDimensions(jpg);
        if (!dims || dims.components === 4) return; // CMYK
        if (imageTypeOf(jpg) !== "jpg") return;
        out = { buffer: jpg, type: "jpg", width: dims.width || w, height: dims.height || h };
      } else if (filters.length && filters[filters.length - 1] === "FlateDecode" && filters.length === 1 && bpc === 8) {
        var comps = colorComponents(dict);
        if (!comps || !w || !h || w * h > 12000000) return;
        var data;
        try { data = zlib.inflateSync(Buffer.from(obj.contents), { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (e) { return; }
        var params = decodeParams(dict);
        var predictor = params ? (num(params, "Predictor") || 1) : 1;
        if (predictor >= 10) data = unpredictPng(data, (params && num(params, "Columns")) || w, (params && num(params, "Colors")) || comps, bpc);
        else if (predictor !== 1) return;
        if (data.length < w * h * comps) return;
        out = { buffer: encodePng(w, h, comps, data), type: "png", width: w, height: h };
      } else return;

      if (!passesSizeFilter(out.width, out.height, out.buffer.length)) return;
      var hash = crypto.createHash("md5").update(out.buffer).digest("hex");
      if (seenHash[hash]) return;
      seenHash[hash] = true;
      out.hash = hash;
      out.page = pages ? Math.min.apply(null, Array.from(pages)) + 1 : null;
      found.push(out);
    } catch (e) { /* ett ødelagt bilde skal ikke stoppe resten */ }
  });

  found.sort(function (a, b) { return b.width * b.height - a.width * a.height; });
  return found.slice(0, max);
}

async function extractDocxImages(buffer, opts) {
  opts = opts || {};
  var max = opts.max || MAX_IMAGES;
  var found = [];
  var seenHash = {};
  var order = 0;
  await mammoth.convertToHtml({ buffer: buffer }, {
    convertImage: mammoth.images.imgElement(async function (image) {
      try {
        var buf = Buffer.from(await image.read("base64"), "base64");
        var type = imageTypeOf(buf);
        var dims = sniffDimensions(buf);
        order++;
        if ((type === "jpg" || type === "png") && dims && passesSizeFilter(dims.width, dims.height, buf.length) && dims.components !== 4) {
          var hash = crypto.createHash("md5").update(buf).digest("hex");
          if (!seenHash[hash]) { seenHash[hash] = true; found.push({ buffer: buf, type: type, width: dims.width, height: dims.height, hash: hash, page: null, rekkefolge: order }); }
        }
      } catch (e) {}
      return { src: "" };
    })
  });
  found.sort(function (a, b) { return b.width * b.height - a.width * a.height; });
  return found.slice(0, max);
}

module.exports = { extractPdfImages, extractDocxImages, encodePng, passesSizeFilter };
