// To nye måter å opprette en sak på, i stedet for kun det manuelle
// "Nytt tips"-skjemaet:
//
// 1. createCaseFromLink — lim inn en lenke til en aktuell sak, AI gjør resten
//    av jobben: oppretter saken og kjører den samme, allerede testede
//    research-drevne manusgenereringen (lib/manuscript.js) på den.
// 2. createCaseFromUpload — last opp et manus (.docx) som kanskje ikke
//    følger redaksjonens mal — AI plasserer innholdet i malen UTEN å
//    omskrive eller finne på nytt innhold, kun omorganiserer det som
//    faktisk står der.

const mammoth = require("mammoth");
const { Document, Packer } = require("docx");
const { generateManuscript, fetchSourceArticle, buildDocxParagraphs, callOpenAI, HOUSE_STYLE, MODEL, IMAGE_MARKER_RE } = require("./manuscript.js");

const IMPORT_SYSTEM_PROMPT = HOUSE_STYLE + `

Du får nå IKKE i oppgave å skrive noe nytt. Du får et manus/utkast en journalist allerede har skrevet, som
kanskje ikke følger redaksjonens faste mal (TITTEL/BILDE/ALT-TEKST BILDE/FOTO/INGRESS/HOVEDTEKST). Din ENESTE
oppgave er å omorganisere det inn i malen — ALDRI omskrive, forkorte, utvide eller legge til nytt innhold.
Bruk teksten som allerede står der, så ordrett som mulig.

- tittel: bruk overskriften i teksten om den finnes, ellers en kort, dekkende tittel hentet direkte fra første avsnitt.
- ingress: bruk en tydelig ingress/innledning om den finnes, ellers de første setningene i teksten.
- hovedtekst_avsnitt: resten av teksten, delt i avsnitt akkurat som i originalen. Fremstår noe tydelig som en
  mellomtittel i originalen, marker det som eget listeelement med prefiks "## ". Fremstår noe tydelig som et
  fremhevet sitat, marker det med prefiks "> ".
- alt_tekst_bilde: kun om en bildetekst/alt-tekst er eksplisitt nevnt i originalteksten, ellers tom streng.
- foto_kreditering: kun om en fotokreditering er eksplisitt nevnt, ellers tom streng.
- kilde_url: finner du noe i teksten som tydelig er en kildehenvisning (f.eks. en URL, eller "Kilde: ..."),
  oppgi den nøyaktig. Ellers null — ikke gjett eller dikt opp en lenke.

VIKTIG OM BILDER MIDT I TEKSTEN: originalteksten kan inneholde linjer i formatet "![alt-tekst](url)" — dette er
bilder som allerede lå i det opplastede dokumentet, hentet ut og lagret automatisk. Disse skal ALLTID bli med,
som EGNE listeelementer i hovedtekst_avsnitt, i nøyaktig samme relative posisjon i teksten som de opprinnelig
sto (ikke flyttet til toppen eller bunnen). Kopiér "![...](...)"-linjen NØYAKTIG som den står — ikke endre URL-
en, ikke fjern den, og dikt ALDRI opp en ny en som ikke fantes i originalteksten.

Er noe uklart eller mangler (f.eks. ingen tydelig tittel eller ingress i originalen), skriv det i
usikkerhetsnotat i stedet for å dikte opp innhold.`;

// Konverterer mammoth sin HTML-output (med bilder allerede lastet opp og
// erstattet med ekte URL-er, se extractDocxWithImages) til en enkel,
// linjebasert tekst der overskrifter/bilder er markert med de samme
// "## "/"![...](...)""-konvensjonene som resten av appen bruker — det AI-en
// faktisk får som "rå tekst" å jobbe med.
function htmlToMarkedLines(html) {
  return html
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, function (_, inner) { return "\n## " + stripTags(inner) + "\n"; })
    .replace(/<img[^>]*\bsrc="([^"]+)"[^>]*\balt="([^"]*)"[^>]*>/gi, function (_, src, alt) { return "\n![" + alt + "](" + src + ")\n"; })
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*\bsrc="([^"]+)"[^>]*>/gi, function (_, alt, src) { return "\n![" + alt + "](" + src + ")\n"; })
    .replace(/<img[^>]*\bsrc="([^"]+)"[^>]*>/gi, function (_, src) { return "\n![](" + src + ")\n"; })
    .replace(/<\/p>|<\/li>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .split("\n").map(function (l) { return l.trim(); }).filter(Boolean).join("\n");
}
function stripTags(s) { return String(s || "").replace(/<[^>]+>/g, "").trim(); }

// Leser et opplastet .docx og laster automatisk opp EVENTUELLE bilder som
// allerede lå inni dokumentet til "manus"-bøtta — brukes til bilder utover
// selve hovedbildet, midt i saken (f.eks. et bilde nummer to i et allerede
// skrevet manus). Signerte URL-er (24 timer) i stedet for direkte
// lagringsstier, slik at både AI-kallet og senere docx-/WordPress-bygging
// kan hente dem med en vanlig HTTP-forespørsel, samme mønster som resten av
// bildehåndteringen i appen.
async function extractDocxWithImages(supabase, buffer, caseIdPrefix) {
  var uploadedCount = 0;
  var result = await mammoth.convertToHtml({ buffer: buffer }, {
    convertImage: mammoth.images.imgElement(async function (image) {
      var base64 = await image.read("base64");
      var buf = Buffer.from(base64, "base64");
      var ext = (image.contentType || "").indexOf("png") !== -1 ? "png" : "jpg";
      uploadedCount++;
      var path = caseIdPrefix + "/importert-bilde-" + uploadedCount + "-" + Date.now() + "." + ext;
      var uploadRes = await supabase.storage.from("manus").upload(path, buf, { contentType: image.contentType || "image/jpeg", upsert: false });
      if (uploadRes.error) return { src: "" };
      // Ett år, ikke 24 timer — denne URL-en lagres varig i manus_hovedtekst
      // (og kan gjenbrukes ved WordPress-publisering lenge etter opplasting),
      // så den må ikke rekke å utløpe før noen faktisk får sett gjennom saken.
      var signedRes = await supabase.storage.from("manus").createSignedUrl(path, 60 * 60 * 24 * 365);
      if (signedRes.error || !signedRes.data) return { src: "" };
      return { src: signedRes.data.signedUrl };
    })
  });
  var text = htmlToMarkedLines(result.value || "");
  return { text: text, bilderFunnet: uploadedCount };
}

const IMPORT_SCHEMA = {
  name: "manus_import",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      tittel: { type: "string" },
      ingress: { type: "string" },
      hovedtekst_avsnitt: { type: "array", items: { type: "string" }, minItems: 1 },
      alt_tekst_bilde: { type: "string" },
      foto_kreditering: { type: "string" },
      kilde_url: { type: ["string", "null"] },
      usikkerhetsnotat: { type: ["string", "null"] }
    },
    required: ["tittel", "ingress", "hovedtekst_avsnitt", "alt_tekst_bilde", "foto_kreditering", "kilde_url", "usikkerhetsnotat"]
  }
};

// supabase: klient autentisert SOM den innloggede brukeren (RLS gjelder).
async function createCaseFromLink(supabase, openaiKey, url) {
  if (!/^https?:\/\//i.test(url || "")) throw new Error("Ugyldig lenke — må starte med http:// eller https://");

  const preview = await fetchSourceArticle(url);
  const title = (preview.ok && preview.title) ? preview.title : url;

  const nowIsoStr = new Date().toISOString();
  const caseRes = await supabase.from("cases").insert({
    title: title,
    sakstype: "redaksjonell",
    hastegrad: "planlagt",
    status: "godkjent", // menneske har allerede bestemt at dette skal bli en sak — hopper over Idé-vurderingen
    eier: "Ikke tildelt",
    kilder: [url],
    neste_handling: "AI genererer manus …",
    triage: { aktualitet: 3, betydning: 3, innsats: 3, eksklusivitet: 3 },
    historikk: [{ ts: nowIsoStr, text: "Sak opprettet manuelt fra lenke — AI genererer manus automatisk" }]
  }).select().single();
  if (caseRes.error) throw new Error("Kunne ikke opprette sak: " + caseRes.error.message);

  // Gjenbruker den allerede testede, research-drevne manusgenereringen —
  // ikke en egen, uverifisert kopi av samme logikk.
  const manusResult = await generateManuscript(supabase, openaiKey, caseRes.data.id);

  return { ok: true, caseId: caseRes.data.id, title: title, manus: manusResult };
}

// supabase: klient autentisert SOM den innloggede brukeren (RLS gjelder).
async function createCaseFromUpload(supabase, openaiKey, storagePath, originalFilename) {
  const downloadRes = await supabase.storage.from("manus").download(storagePath);
  if (downloadRes.error) throw new Error("Kunne ikke hente opplastet fil: " + downloadRes.error.message);

  const arrayBuffer = await downloadRes.data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Midlertidig mappeprefiks for eventuelle bilder funnet inni dokumentet —
  // saken har ikke fått en id ennå på dette tidspunktet.
  const tempPrefix = "importert-" + Date.now();
  let extraction;
  try {
    extraction = await extractDocxWithImages(supabase, buffer, tempPrefix);
  } catch (err) {
    throw new Error("Kunne ikke lese .docx-filen — er den gyldig? (" + err.message + ")");
  }
  const rawText = (extraction.text || "").trim();
  if (rawText.length < 40) throw new Error("Fant nesten ingen tekst i den opplastede filen — er det riktig fil?");

  const userPrompt = "Opplastet manusfil (\"" + (originalFilename || "ukjent filnavn") + "\"), rå tekst" +
    (extraction.bilderFunnet ? " (inneholder " + extraction.bilderFunnet + " bilde(r), markert med ![...](...)  — behold dem)" : "") +
    ":\n\n" + rawText.slice(0, 14000);
  const fields = await callOpenAI(openaiKey, MODEL, IMPORT_SYSTEM_PROMPT, userPrompt, IMPORT_SCHEMA);

  // Sjekk at AI-en faktisk beholdt like mange bildemarkører som ble funnet i
  // originaldokumentet — stol ikke bare på at instruksen ble fulgt.
  var keptImages = (fields.hovedtekst_avsnitt || []).filter(function (p) { return IMAGE_MARKER_RE.test(p); }).length;
  if (extraction.bilderFunnet && keptImages < extraction.bilderFunnet) {
    fields.usikkerhetsnotat = ((fields.usikkerhetsnotat ? fields.usikkerhetsnotat + " " : "") +
      "OBS: " + extraction.bilderFunnet + " bilde(r) ble funnet i det opplastede dokumentet, men kun " + keptImages + " ble med i det plasserte manuset — sjekk om noe mangler.").trim();
  }

  const doc = new Document({ sections: [{ children: await buildDocxParagraphs({
    tittel: fields.tittel, ingress: fields.ingress, hovedtekst_avsnitt: fields.hovedtekst_avsnitt,
    alt_tekst_bilde: fields.alt_tekst_bilde, fotoKreditering: fields.foto_kreditering
  }, null) }] });
  const docBuffer = await Packer.toBuffer(doc);

  const nowIsoStr = new Date().toISOString();
  const caseRes = await supabase.from("cases").insert({
    title: fields.tittel,
    sakstype: "redaksjonell",
    hastegrad: "planlagt",
    status: "i-arbeid", // manus finnes allerede — hopper rett til arbeidssteget
    eier: "Ikke tildelt",
    kilder: fields.kilde_url ? [fields.kilde_url] : [],
    neste_handling: "Se gjennom AI-plassert manus før publisering",
    triage: { aktualitet: 3, betydning: 3, innsats: 3, eksklusivitet: 3 },
    manus_tittel: fields.tittel, manus_ingress: fields.ingress, manus_hovedtekst: fields.hovedtekst_avsnitt,
    manus_alt_tekst: fields.alt_tekst_bilde, manus_foto: fields.foto_kreditering,
    manus_generert_ts: nowIsoStr,
    historikk: [{
      ts: nowIsoStr,
      text: "Sak opprettet fra opplastet manus (" + (originalFilename || "ukjent fil") + ") — AI plasserte innholdet i malen" +
        (extraction.bilderFunnet ? ", inkl. " + extraction.bilderFunnet + " bilde(r) fra dokumentet" : "") +
        (fields.usikkerhetsnotat ? " — ⚠️ " + fields.usikkerhetsnotat : "")
    }]
  }).select().single();
  if (caseRes.error) throw new Error("Kunne ikke opprette sak: " + caseRes.error.message);

  const path = caseRes.data.id + "/" + Date.now() + ".docx";
  const uploadRes = await supabase.storage.from("manus").upload(path, docBuffer, {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", upsert: false
  });
  if (!uploadRes.error) {
    await supabase.from("cases").update({ manus_url: path }).eq("id", caseRes.data.id);
  }

  return { ok: true, caseId: caseRes.data.id, title: fields.tittel, usikkerhetsnotat: fields.usikkerhetsnotat || null, bilderFunnet: extraction.bilderFunnet };
}

module.exports = { createCaseFromLink, createCaseFromUpload };
