// Leser en PowerPoint (.pptx): tekst på hvert lysbilde OG talernotatene
// (notes) taleren har skrevet under bildene, i riktig lysbilderekkefølge.
// En .pptx er en ZIP med XML — ren JS (jszip), ingen native avhengigheter.
//
// Talernotater er ofte det mest verdifulle i et foredrag (taleren har skrevet
// det hun/han faktisk skal si), men de er forberedte notater, ikke
// nødvendigvis det som ble sagt — det merkes tydelig i teksten som leveres.

const JSZip = require("jszip");

function decodeXml(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCodePoint(parseInt(n, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&amp;/g, "&");
}

// Avsnitt (<a:p>) → linjer; tekstbiter (<a:t>) og linjeskift (<a:br/>) settes sammen.
function paragraphsOf(xmlFragment) {
  var out = [];
  var re = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g, m;
  while ((m = re.exec(xmlFragment))) {
    var line = "";
    var tokens = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/?>/g, t;
    while ((t = tokens.exec(m[1]))) line += t[1] !== undefined ? decodeXml(t[1]) : "\n";
    line = line.replace(/[ \t]+/g, " ").trim();
    if (line) out.push(line);
  }
  return out;
}

// Alle former (<p:sp>) på en side, uten plassholdere for bildenummer/dato/bunntekst
// (og uten selve lysbilde-miniatyren i notatsiden).
function shapeTexts(xml, skipTypes) {
  var out = [];
  var re = /<p:sp\b[\s\S]*?<\/p:sp>/g, m;
  while ((m = re.exec(xml))) {
    var ph = m[0].match(/<p:ph\b[^>]*\btype="([^"]+)"/);
    if (ph && skipTypes.indexOf(ph[1]) !== -1) continue;
    paragraphsOf(m[0]).forEach(function (l) { out.push(l); });
  }
  return out;
}

function relsMap(xml) {
  var map = {};
  var re = /<Relationship\b[^>]*>/g, m;
  while ((m = re.exec(xml || ""))) {
    var id = (m[0].match(/\bId="([^"]+)"/) || [])[1];
    var target = (m[0].match(/\bTarget="([^"]+)"/) || [])[1];
    var type = (m[0].match(/\bType="([^"]+)"/) || [])[1];
    if (id && target) map[id] = { target: target, type: type || "" };
  }
  return map;
}

function resolvePath(baseDir, target) {
  if (target.charAt(0) === "/") return target.slice(1);
  var parts = (baseDir + "/" + target).split("/"), out = [];
  parts.forEach(function (p) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); });
  return out.join("/");
}

async function readText(zip, path) {
  var f = zip.file(path);
  return f ? f.async("string") : null;
}

// Returnerer { slides: [{ nr, tekst, notater }], antallNotater, tekst } der
// tekst er ferdig formatert for en AI-prompt.
async function extractPptx(buffer) {
  var zip = await JSZip.loadAsync(buffer);
  var pres = await readText(zip, "ppt/presentation.xml");
  if (!pres) throw new Error("Ikke en gyldig PowerPoint-fil (.pptx).");
  var presRels = relsMap(await readText(zip, "ppt/_rels/presentation.xml.rels"));

  // Lysbilder i faktisk visningsrekkefølge (sldIdLst), ikke filnavn-rekkefølge.
  var order = [];
  var idRe = /<p:sldId\b[^>]*\br:id="([^"]+)"/g, m;
  while ((m = idRe.exec(pres))) { if (presRels[m[1]]) order.push(resolvePath("ppt", presRels[m[1]].target)); }

  var slides = [];
  for (var i = 0; i < order.length; i++) {
    var slidePath = order[i];
    var slideXml = await readText(zip, slidePath);
    if (!slideXml) continue;
    var tekst = shapeTexts(slideXml, ["sldNum", "dt", "ftr", "hdr"]);

    var notater = [];
    var dir = slidePath.slice(0, slidePath.lastIndexOf("/"));
    var rels = relsMap(await readText(zip, dir + "/_rels/" + slidePath.slice(slidePath.lastIndexOf("/") + 1) + ".rels"));
    var notesRel = Object.keys(rels).map(function (k) { return rels[k]; }).filter(function (r) { return /notesSlide$/.test(r.type); })[0];
    if (notesRel) {
      var notesXml = await readText(zip, resolvePath(dir, notesRel.target));
      if (notesXml) notater = shapeTexts(notesXml, ["sldNum", "dt", "ftr", "hdr", "sldImg"]);
    }
    slides.push({ nr: slides.length + 1, tekst: tekst, notater: notater });
  }

  var antallNotater = slides.filter(function (s) { return s.notater.length; }).length;
  var tekst = slides.map(function (s) {
    return "LYSBILDE " + s.nr + ":\n" + (s.tekst.length ? s.tekst.join("\n") : "(ingen tekst)") +
      (s.notater.length ? "\nTALERNOTATER (forberedt av taleren):\n" + s.notater.join("\n") : "");
  }).join("\n\n");

  return { slides: slides, antallNotater: antallNotater, tekst: tekst };
}

module.exports = { extractPptx };
