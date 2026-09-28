// Finner de faktiske REDAKSJONELLE bildene i en nettartikkel — bildene som
// hører til selve saken — i stedet for å stole blindt på og:image. og:image er
// svært ofte en logo eller et generisk delingsbilde (etatens/mediets
// standardgrafikk), noe som ga en logo som hovedbilde på en sak (tilbake-
// melding). Her leses selve artikkelinnholdet: bilder i <article>/<figure>
// med bildetekst prioriteres, logoer/ikoner/avatarer/sporingspiksler og
// for små bilder filtreres bort, og hvert kandidatbilde lastes faktisk ned og
// kontrolleres (ekte bildefil, mål, sideforhold, ikke CMYK).
//
// og:image/twitter:image brukes kun som siste utvei — og aldri hvis URL-en
// ser ut som en logo/standard delingsgrafikk (se imageUtils.looksGenericUrl).

const { imageTypeOf, sniffDimensions, looksGenericUrl } = require("./imageUtils.js");

const UA = "Mozilla/5.0 (compatible; UASNorwaySaksbank/1.0)";
const MAX_BYTES = 8 * 1024 * 1024;
const MIN_W = 500, MIN_H = 280;
const BAD_CLASS = /logo|icon|avatar|author|byline|share|social|sponsor|advert|\bad[-_]|promo|thumb-small|emoji|profile/i;

function decodeAttr(s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x2F;/gi, "/");
}
function attr(tag, name) {
  var m = tag.match(new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i"));
  return m ? decodeAttr(m[1] !== undefined ? m[1] : m[2]) : null;
}
function stripTags(s) {
  return decodeAttr(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function largestFromSrcset(srcset) {
  if (!srcset) return null;
  var best = null, bestW = -1;
  String(srcset).split(",").forEach(function (part) {
    var bits = part.trim().split(/\s+/);
    if (!bits[0]) return;
    var w = /(\d+)w/.exec(bits[1] || "");
    var width = w ? parseInt(w[1], 10) : 1;
    if (width > bestW) { bestW = width; best = bits[0]; }
  });
  return best;
}
function absolute(src, base) {
  try { return new URL(src, base).toString(); } catch (e) { return null; }
}
function metaContent(html, prop) {
  var re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*>', "i");
  var m = html.match(re);
  return m ? attr(m[0], "content") : null;
}

// Rangerte kandidater ({ url, alt, caption, score, kilde }) fra HTML-en.
function findImageCandidates(html, pageUrl) {
  var cands = [];
  var seen = {};
  function add(c) {
    if (!c.url || seen[c.url]) return;
    if (/^data:/i.test(c.url) || /\.svg(\?|$)/i.test(c.url) || looksGenericUrl(c.url)) return;
    seen[c.url] = true;
    cands.push(c);
  }

  var rootMatch = html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i);
  var scopes = [{ html: rootMatch ? rootMatch[0] : html, inArticle: !!rootMatch }];
  scopes.forEach(function (scope) {
    var text = scope.html.slice(0, 400000);
    // <figure> først — gir bildetekst
    var figureRe = /<figure[\s\S]*?<\/figure>/gi, fm;
    var inFigure = [];
    while ((fm = figureRe.exec(text))) {
      var imgTag = (fm[0].match(/<img[^>]*>/i) || [])[0];
      if (!imgTag) continue;
      var cap = (fm[0].match(/<figcaption[\s\S]*?<\/figcaption>/i) || [])[0];
      inFigure.push({ tag: imgTag, caption: cap ? stripTags(cap) : "" });
    }
    var imgRe = /<img[^>]*>/gi, im, pos = 0;
    var captionByTag = {};
    inFigure.forEach(function (f) { captionByTag[f.tag] = f.caption; });
    while ((im = imgRe.exec(text))) {
      var tag = im[0];
      pos++;
      var cls = (attr(tag, "class") || "") + " " + (attr(tag, "id") || "");
      if (BAD_CLASS.test(cls)) continue;
      var w = parseInt(attr(tag, "width"), 10), h = parseInt(attr(tag, "height"), 10);
      if ((w && w < 250) || (h && h < 150)) continue;
      var src = largestFromSrcset(attr(tag, "srcset") || attr(tag, "data-srcset")) ||
        attr(tag, "data-src") || attr(tag, "data-lazy-src") || attr(tag, "data-original") || attr(tag, "src");
      var url = src ? absolute(src, pageUrl) : null;
      var caption = captionByTag.hasOwnProperty(tag) ? captionByTag[tag] : "";
      var alt = attr(tag, "alt") || "";
      var score = 1 + (scope.inArticle ? 2 : 0) + (caption ? 3 : 0) + (captionByTag.hasOwnProperty(tag) ? 1 : 0) +
        (w >= 600 ? 2 : 0) + (alt.length > 15 ? 1 : 0) + Math.max(0, 3 - pos * 0.5);
      add({ url: url, alt: alt, caption: caption, score: score, kilde: "artikkel" });
    }
  });

  ["og:image", "twitter:image"].forEach(function (p, i) {
    var v = metaContent(html, p);
    var u = v ? absolute(v, pageUrl) : null;
    add({ url: u, alt: "", caption: "", score: 0.5 - i * 0.1, kilde: "meta" });
  });

  cands.sort(function (a, b) { return b.score - a.score; });
  return cands;
}

async function downloadImage(url) {
  try {
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, 12000);
    var res = await fetch(url, { headers: { "User-Agent": UA }, signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    var buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8000 || buf.length > MAX_BYTES) return null;
    var type = imageTypeOf(buf);
    if (!type || type === "gif") return null;
    var dims = sniffDimensions(buf);
    if (!dims || dims.components === 4) return null;
    if (dims.width < MIN_W || dims.height < MIN_H) return null;
    var aspect = dims.width / dims.height;
    if (aspect < 0.5 || aspect > 3.2) return null;
    return { url: url, buffer: buf, type: type, width: dims.width, height: dims.height };
  } catch (err) {
    return null;
  }
}

// Verifiserte redaksjonelle bilder fra siden, beste først. jpg/png først
// (fungerer overalt, også i .docx), webp kun som reserve.
// opts.verify: async (img) => boolean — innholdssjekk av selve bildet (lib/imageCheck.js).
// URL-filteret fanger ikke en logo på en anonym CDN-URL (Aftenposten sin
// merkevare-logo var og:image og ble hovedbilde på en sak), så:
//  - og:image/twitter:image (kilde «meta») brukes KUN når verify er oppgitt og godkjenner bildet
//  - artikkelbilder godkjennes av verify hvis den er oppgitt
async function pickArticleImages(pageUrl, html, max, opts) {
  max = max || 1;
  opts = opts || {};
  var cands = findImageCandidates(html, pageUrl).slice(0, 8);
  var verified = [];
  for (var i = 0; i < cands.length && verified.length < max + 2; i++) {
    if (cands[i].kilde === "meta" && !opts.verify) continue;
    var img = await downloadImage(cands[i].url);
    if (!img) continue;
    if (opts.verify && !(await opts.verify(img))) continue;
    verified.push(Object.assign({}, cands[i], img));
  }
  var preferred = verified.filter(function (v) { return v.type === "jpg" || v.type === "png"; });
  var rest = verified.filter(function (v) { return v.type === "webp"; });
  return preferred.concat(rest).slice(0, max);
}

module.exports = { findImageCandidates, pickArticleImages, downloadImage };
