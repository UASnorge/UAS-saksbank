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
const { generateManuscript, fetchSourceArticle, buildDocxParagraphs, callOpenAI, HOUSE_STYLE, MODEL } = require("./manuscript.js");

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

Er noe uklart eller mangler (f.eks. ingen tydelig tittel eller ingress i originalen), skriv det i
usikkerhetsnotat i stedet for å dikte opp innhold.`;

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

  let extracted;
  try {
    extracted = await mammoth.extractRawText({ buffer: buffer });
  } catch (err) {
    throw new Error("Kunne ikke lese .docx-filen — er den gyldig? (" + err.message + ")");
  }
  const rawText = (extracted.value || "").trim();
  if (rawText.length < 40) throw new Error("Fant nesten ingen tekst i den opplastede filen — er det riktig fil?");

  const userPrompt = "Opplastet manusfil (\"" + (originalFilename || "ukjent filnavn") + "\"), rå tekst:\n\n" + rawText.slice(0, 12000);
  const fields = await callOpenAI(openaiKey, MODEL, IMPORT_SYSTEM_PROMPT, userPrompt, IMPORT_SCHEMA);

  const doc = new Document({ sections: [{ children: buildDocxParagraphs({
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

  return { ok: true, caseId: caseRes.data.id, title: fields.tittel, usikkerhetsnotat: fields.usikkerhetsnotat || null };
}

module.exports = { createCaseFromLink, createCaseFromUpload };
