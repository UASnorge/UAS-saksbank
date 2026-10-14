// Vedlegg til en sak: filer redaksjonen har lastet opp inn i en eksisterende
// sak (presentasjon, PDF, Word, tekst), lagret som liste i cases.vedlegg:
//   { id, navn, sti: "lagringssti" | { parts: [...], ext }, storrelse, ts, av }
// Teksten leses ved behov (lysbilder + talernotater fra .pptx, tekst fra
// PDF/Word) og brukes av AI-assistenten og manusrevisjonen som godkjent
// faktagrunnlag — redaksjonen har selv lagt det ved saken.

const { readDocument } = require("./documentCases.js");

const MAX_TOTAL_CHARS = 40000;   // til manusrevisjon (alle vedlegg samlet)
const MAX_TOOL_CHARS = 20000;    // per les_vedlegg-kall

function entryPath(v) {
  var s = v && v.sti;
  if (s && typeof s === "object") return { parts: s.parts || [], ext: s.ext || "", navn: v.navn };
  return s;
}

// Leser ett vedlegg til { navn, tekst } eller { navn, feil }.
async function readAttachment(supabase, v) {
  var doc = await readDocument(supabase, entryPath(v));
  doc.navn = v.navn || doc.navn;
  if (doc.feil) return { navn: doc.navn, feil: doc.feil };
  if (doc.nativePdf) return { navn: doc.navn, feil: "PDF-en ser ut til å være skannet (nesten ingen tekst) og kan ikke leses som tekst — last opp en PDF med tekst, eller en Word-/tekstfil." };
  var tekst = String(doc.tekst || "").trim();
  if (!tekst) return { navn: doc.navn, feil: "Fant ingen tekst i filen." };
  return { navn: doc.navn, tekst: tekst };
}

// Alle vedlegg samlet til én tekstblokk for en AI-prompt (kuttet til maxChars).
async function attachmentsBlock(supabase, vedlegg, maxChars) {
  maxChars = maxChars || MAX_TOTAL_CHARS;
  var list = Array.isArray(vedlegg) ? vedlegg : [];
  if (!list.length) return { tekst: "", navn: [], feil: [] };
  var parts = [], used = [], feil = [], left = maxChars;
  for (var i = 0; i < list.length && left > 500; i++) {
    var r = await readAttachment(supabase, list[i]);
    if (r.feil) { feil.push(r.navn + ": " + r.feil); continue; }
    var share = Math.min(r.tekst.length, Math.max(2000, Math.floor(left / (list.length - i))));
    var chunk = r.tekst.slice(0, share);
    parts.push("=== VEDLEGG: " + r.navn + (r.tekst.length > share ? " (kortet — " + r.tekst.length + " tegn totalt)" : "") + " ===\n" + chunk);
    used.push(r.navn);
    left -= chunk.length;
  }
  return { tekst: parts.join("\n\n"), navn: used, feil: feil };
}

module.exports = { readAttachment, attachmentsBlock, MAX_TOOL_CHARS };
