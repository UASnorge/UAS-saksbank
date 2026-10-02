// Bilder i VEDLEGG til kilden — typisk høringer: selve høringssiden er bare en
// tekstside, mens kart, figurer og illustrasjoner ligger inni PDF-ene som er
// lagt ved (høringsbrev, utkast til forskrift, rapporter). Dette følger
// lenkene til PDF-/Word-vedlegg på kildesiden, laster dem ned, trekker ut de
// redaksjonelle bildene (lib/docImages.js), kontrollerer dem med syn
// (lib/imageCheck.js — logoer/topptekster/tekstsider kastes) og leverer dem
// som bildealternativer med kreditering.
//
// Kreditering: hentet fra avsenderen av dokumentet (f.eks. «Luftfartstilsynet»),
// aldri «ukjent». Bruksrett merkes ALLTID som kategori C (uklare vilkår) —
// et vedlegg fra en myndighet er ikke det samme som en dokumentert fri lisens,
// og kartgrunnlaget kan ha egen rettighetshaver (Kartverket, Avinor …). Det
// står tydelig i kommentaren. Appen hevder aldri noe annet.

const crypto = require("crypto");
const { extractPdfImages, extractDocxImages } = require("./docImages.js");
const { classifyImage } = require("./imageCheck.js");

const UA = "Mozilla/5.0 (compatible; UASNorwaySaksbank/1.0)";
const MAX_DOC_BYTES = 25 * 1024 * 1024;
const MAX_DOCS = 6;
const MAX_PER_DOC = 3;
const MAX_TOTAL = 6;
const FETCH_TIMEOUT_MS = 20000;

const KNOWN_ORGS = {
  "luftfartstilsynet.no": "Luftfartstilsynet",
  "regjeringen.no": "Regjeringen",
  "avinor.no": "Avinor",
  "kartverket.no": "Kartverket",
  "kystverket.no": "Kystverket",
  "forsvaret.no": "Forsvaret",
  "politiet.no": "Politiet",
  "nve.no": "NVE",
  "miljodirektoratet.no": "Miljødirektoratet",
  "dsb.no": "DSB",
  "statensvegvesen.no": "Statens vegvesen",
  "easa.europa.eu": "EASA",
  "trafa.se": "Trafikanalys",
  "transportstyrelsen.se": "Transportstyrelsen",
  "trafi.fi": "Traficom",
  "traficom.fi": "Traficom"
};

function decodeAttr(s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x2F;/gi, "/");
}
function stripTags(s) {
  return decodeAttr(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./i, ""); } catch (e) { return ""; }
}

// Lenker til PDF-/Word-dokumenter på siden. Mottakerlister o.l. havner sist
// (de har aldri bilder, men koster en nedlasting).
function findDocumentLinks(pageUrl, html) {
  var out = [], seen = {};
  var re = /<a\b[^>]*?href\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi, m;
  while ((m = re.exec(html || ""))) {
    var href = decodeAttr(m[1] !== undefined ? m[1] : m[2]);
    if (!/\.(pdf|docx)(\?|#|$)/i.test(href)) continue;
    var abs;
    try { abs = new URL(href, pageUrl).toString(); } catch (e) { continue; }
    if (seen[abs]) continue;
    seen[abs] = true;
    out.push({ url: abs, label: stripTags(m[3]) || decodeURIComponent(abs.split("/").pop() || "").replace(/[-_]+/g, " ") });
  }
  var low = /mottaker|høringsinstans|horingsmottaker|distribusjonsliste|adresseliste/i;
  out.sort(function (a, b) { return (low.test(a.url + " " + a.label) ? 1 : 0) - (low.test(b.url + " " + b.label) ? 1 : 0); });
  return out.slice(0, MAX_DOCS);
}

function orgNameFor(pageUrl, html) {
  var host = hostOf(pageUrl);
  var keys = Object.keys(KNOWN_ORGS);
  for (var i = 0; i < keys.length; i++) {
    if (host === keys[i] || host.endsWith("." + keys[i])) return KNOWN_ORGS[keys[i]];
  }
  var m = (html || "").match(/<meta[^>]+property=["']og:site_name["'][^>]*>/i);
  if (m) {
    var c = m[0].match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    var name = c ? decodeAttr(c[1] !== undefined ? c[1] : c[2]).trim() : "";
    if (name) return name;
  }
  return host;
}

async function downloadDocument(url) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
  try {
    var res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    var len = parseInt(res.headers.get("content-length") || "0", 10);
    if (len && len > MAX_DOC_BYTES) return null;
    var buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOC_BYTES) return null;
    return buf;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Tekst per PDF-side (valgfritt — brukes kun til å finne figurtekst/omtale).
// pdf-parse er en egen pakke som må være tilgjengelig i funksjonen; mangler
// den, eller feiler lesingen, hoppes figurteksten bare over.
async function pdfPageTexts(buf) {
  try {
    var pdfParse = require("pdf-parse");
    var pages = [];
    await pdfParse(buf, {
      pagerender: async function (pg) {
        var tc = await pg.getTextContent();
        var t = tc.items.map(function (i) { return i.str; }).join(" ").replace(/\s+/g, " ").trim();
        pages.push(t);
        return t;
      }
    });
    return pages;
  } catch (e) {
    return [];
  }
}

function sentencesMentioning(pages, label, num, exceptPage) {
  var re = new RegExp("\\b" + label + "\\s*" + num + "\\b", "i");
  for (var p = 0; p < pages.length; p++) {
    if (p === exceptPage) continue;
    var sents = String(pages[p] || "").split(/(?<=[.!?])\s+/);
    for (var i = 0; i < sents.length; i++) {
      if (re.test(sents[i]) && sents[i].length < 300) return sents[i].trim();
    }
  }
  return null;
}

// Figurtekst på selve siden ("Figur 1: Oversiktskart …") og/eller en setning
// et annet sted i dokumentet som omtaler figuren.
function figureContext(pages, pageNo) {
  if (!pages.length || !pageNo) return {};
  var idx = pageNo - 1;
  var text = pages[idx] || "";
  var m = text.match(/\b(Figur|Kart|Foto|Bilde|Illustrasjon)\s*(\d+)\s*[:.\-–]\s*(.{0,160})/i);
  var out = {};
  if (m) {
    out.label = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    out.caption = (m[3] || "").replace(/\s+(Luftfartstilsynet|Notat|Vår dato).*$/i, "").trim();
    out.mention = sentencesMentioning(pages, m[1], m[2], idx);
  }
  return out;
}

function kindFor(viser, label, mention) {
  var v = String(viser || "");
  if (/kart/i.test(v) || /^kart$/i.test(label || "") || (!v && /kart/i.test(String(mention || "")))) return "kart";
  if (/diagram|graf|figur|skisse|tegning|illustrasjon/i.test(v) || /^(figur|illustrasjon)$/i.test(label || "")) return "figur";
  return "foto";
}
var KIND_LABEL = { kart: "Kart", figur: "Figur/illustrasjon", foto: "Foto" };

// opts: { openaiKey, title, uploadImage: async (buffer, type, hint) => signedUrl|null }
// Returnerer [{ alt, image }] — alt i samme format som imageResearch sine
// alternativer, image = { url, buffer, type, width, height } (for .docx-manus).
async function findAttachmentImages(sourceUrls, opts) {
  opts = opts || {};
  var results = [];
  var seenHash = {};
  var pages = [];
  (sourceUrls || []).filter(function (u) { return /^https?:\/\//i.test(u); }).slice(0, 3).forEach(function (u) {
    if (pages.indexOf(u) === -1) pages.push(u);
  });

  for (var pi = 0; pi < pages.length && results.length < MAX_TOTAL; pi++) {
    var pageUrl = pages[pi];
    var docs, org;
    if (/\.(pdf|docx)(\?|#|$)/i.test(pageUrl)) {
      docs = [{ url: pageUrl, label: decodeURIComponent(pageUrl.split("/").pop() || "") }];
      org = orgNameFor(pageUrl, "");
    } else {
      var html = "";
      try {
        var res = await fetch(pageUrl, { headers: { "User-Agent": UA } });
        if (res.ok) html = await res.text();
      } catch (e) { /* siden kunne ikke hentes — ingen vedlegg å lete i */ }
      docs = findDocumentLinks(pageUrl, html);
      org = orgNameFor(pageUrl, html);
    }

    for (var di = 0; di < docs.length && results.length < MAX_TOTAL; di++) {
      var doc = docs[di];
      var buf = await downloadDocument(doc.url);
      if (!buf) continue;
      var isPdf = buf.slice(0, 5).toString("latin1") === "%PDF-";
      var imgs = [];
      try {
        imgs = isPdf ? await extractPdfImages(buf, { max: MAX_PER_DOC + 3 }) : await extractDocxImages(buf, { max: MAX_PER_DOC + 3 });
      } catch (e) { continue; }
      if (!imgs.length) continue;
      var texts = isPdf ? await pdfPageTexts(buf) : [];

      var taken = 0;
      for (var ii = 0; ii < imgs.length && taken < MAX_PER_DOC && results.length < MAX_TOTAL; ii++) {
        var img = imgs[ii];
        if (seenHash[img.hash]) continue;
        // Syn: kast logoer/topptekster/dokumentsider — behold kart, figurer, foto.
        var cls = opts.openaiKey ? await classifyImage(opts.openaiKey, img, { tittel: opts.title }) : { vurdert: false, ok: true, viser: "" };
        if (cls.vurdert && !cls.ok) continue;
        seenHash[img.hash] = true;

        var signedUrl = opts.uploadImage ? await opts.uploadImage(img.buffer, img.type, img.hash.slice(0, 12)) : null;
        if (!signedUrl) continue;

        var ctx = figureContext(texts, img.page);
        var kind = kindFor(cls.viser, ctx.label, ctx.mention || ctx.caption);
        var docPageRef = doc.url + (img.page ? "#page=" + img.page : "");
        var motiv = (cls.viser && cls.viser.trim()) || ctx.caption || (KIND_LABEL[kind] + " fra vedlagt dokument");
        var alt = {
          motiv: motiv,
          hvorfor_relevant: ctx.mention
            ? "Hentet fra vedlegget «" + doc.label + "» (side " + img.page + "). Dokumentet omtaler figuren slik: «" + ctx.mention + "»"
            : "Hentet fra vedlegget «" + doc.label + "»" + (img.page ? " (side " + img.page + ")" : "") + " — hører direkte til saken og viser det saken handler om.",
          originalkilde_navn: org + " — vedlegg: " + doc.label,
          kildeside_url: docPageRef,
          bilde_url: signedUrl,
          rettighetshaver: org,
          fotograf: null,
          foreslatt_kreditering: org,
          bruksrett: "C",
          dokumentasjon_url: pageUrl,
          eldre_enn_saken: false,
          er_logo: false,
          kommentar: "📎 " + KIND_LABEL[kind] + " trukket ut av PDF-/Word-vedlegg til kilden (ikke et bilde på nettsiden). Kreditér avsenderen («" + org + "»). " +
            "Bruksrett er IKKE dokumentert — kartgrunnlaget kan ha egen rettighetshaver (f.eks. Kartverket/Avinor); bekreft med " + org + " ved tvil før publisering.",
          verifisering: {
            lenke_virker: true, verifisert_bilde_url: signedUrl,
            verifiseringsmetode: "trukket ut av vedlegg og lastet opp (" + img.width + "×" + img.height + ", " + img.type + ")", detalj: ""
          },
          kilde_vedlegg: true,
          vedlegg: { dokument_url: doc.url, dokument_navn: doc.label, side: img.page || null, type: kind }
        };
        results.push({
          alt: alt,
          image: { url: signedUrl, buffer: img.buffer, type: img.type, width: img.width, height: img.height }
        });
        taken++;
      }
    }
  }
  return results;
}

// Hjelper for kallere som har en Supabase-klient: laster opp til "manus"-bøtta
// (samme som AI-illustrasjoner/manusbilder) og gir en signert lenke i ett år.
function makeUploader(supabase, caseId) {
  return async function (buffer, type, hint) {
    var ext = type === "png" ? "png" : "jpg";
    var path = caseId + "/vedlegg-" + (hint || crypto.randomBytes(5).toString("hex")) + "." + ext;
    var up = await supabase.storage.from("manus").upload(path, buffer, { contentType: ext === "png" ? "image/png" : "image/jpeg", upsert: true });
    if (up.error) return null;
    var signed = await supabase.storage.from("manus").createSignedUrl(path, 60 * 60 * 24 * 365);
    return signed.error || !signed.data ? null : signed.data.signedUrl;
  };
}

module.exports = { findAttachmentImages, findDocumentLinks, makeUploader };
