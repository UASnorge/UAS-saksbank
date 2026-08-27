// Oppretter et WordPress-UTKAST på uasnorway.no fra en sak sitt genererte manus.
// Bruker "WordPress Infosak Batch Administrator" sin allerede testede
// integrasjon (portert til lib/wordpress.js — samme ACF-felt, samme prinsipp).
//
// VIKTIG, ufravikelig: oppretter ALLTID status "draft" i WordPress. Aldri
// "publish" — den overgangen skal skje manuelt, enten i WordPress sin egen
// admin eller i Oversikt-fanen i wordpress-infosak-verktøyet, med et menneske
// som faktisk har lest gjennom saken der. Dette endrer ikke saksbankens egen
// STOPP-regel for status "Publisert" heller — de er to separate kontroller.
//
// Validerer at saken faktisk har alt malen krever FØR noe sendes til
// WordPress — ingen WP-kall gjøres i det hele tatt om noe obligatorisk
// mangler. Kalles fra "🌐 Publiser til WordPress"-knappen(e) i saksbanken.
//
// Krever innlogget bruker (Bearer-token). Krever miljøvariablene WP_URL,
// WP_USERNAME, WP_APP_PASSWORD (WordPress Application Password) i tillegg
// til de eksisterende SUPABASE_URL/SUPABASE_ANON_KEY.

const { createClient } = require("@supabase/supabase-js");
const { uploadMedia, createDraftPost } = require("./lib/wordpress.js");

function getSupabaseForUser(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } }
  });
}

// Samme feltkrav som malen ("Mal-opplasting-av-saker.docx") og det
// eksisterende WordPress-verktøyet stiller: TITTEL, INGRESS, HOVEDTEKST og
// minst ett bilde er obligatorisk. FOTO (fotokreditering) er valgfritt.
function findMissingFields(c) {
  const missing = [];
  if (!((c.manus_tittel || c.title || "").trim())) missing.push("Tittel");
  if (!((c.manus_ingress || "").trim())) missing.push("Ingress");
  if (!(Array.isArray(c.manus_hovedtekst) && c.manus_hovedtekst.some((p) => (p || "").trim()))) missing.push("Hovedtekst");
  if (!((c.manus_bilde_url || "").trim())) missing.push("Bilde");
  return missing;
}

async function fetchImageForUpload(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Kunne ikke hente bildet på nytt fra kilden (HTTP " + res.status + ") — bildet kan ha blitt fjernet siden manuset ble generert.");
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = contentType.indexOf("png") !== -1 ? "png" : "jpg";
  return { buffer, mimeType: contentType, filename: "bilde." + ext };
}

async function publishOneCase(supabase, caseId) {
  const caseRes = await supabase.from("cases").select("*").eq("id", caseId).maybeSingle();
  if (caseRes.error || !caseRes.data) throw new Error("Fant ikke saken.");
  const c = caseRes.data;

  const missing = findMissingFields(c);
  if (missing.length) {
    var err = new Error("Saken mangler felt som kreves før WordPress-utkast kan opprettes: " + missing.join(", ") + ". Generer/rediger manuset først.");
    err.missingFields = missing;
    throw err;
  }

  const img = await fetchImageForUpload(c.manus_bilde_url);
  const media = await uploadMedia({
    buffer: img.buffer, filename: img.filename, mimeType: img.mimeType,
    altText: c.manus_alt_tekst || "", caption: c.manus_alt_tekst || ""
  });

  const byline = c.eier && c.eier !== "Ikke tildelt" ? c.eier : "";
  const post = await createDraftPost({
    title: c.manus_tittel || c.title,
    ingress: c.manus_ingress,
    hovedtekstAvsnitt: c.manus_hovedtekst,
    byline: byline,
    photoCredit: c.manus_foto || "",
    caption: c.manus_alt_tekst || "",
    featuredMediaId: media.id,
    tagNames: c.kategori ? [c.kategori] : []
  });

  const historikk = [{
    ts: new Date().toISOString(),
    text: "WordPress-utkast opprettet (automatisk, via saksbanken) — post-ID " + post.id
  }].concat(c.historikk || []);

  const newStatus = c.status === "ide" || c.status === "godkjent" || c.status === "i-arbeid" || c.status === "utkast-klart"
    ? "wp-utkast"
    : c.status;

  const updateRes = await supabase.from("cases").update({
    wp_post_id: post.id,
    wp_edit_link: post.editLink,
    wp_status: "draft",
    status: newStatus,
    historikk: historikk
  }).eq("id", c.id);
  if (updateRes.error) throw new Error(updateRes.error.message);

  return { ok: true, wpPostId: post.id, editLink: post.editLink, title: c.manus_tittel || c.title };
}

// Eksportert for testbarhet — Netlify bruker kun exports.handler.
module.exports.findMissingFields = findMissingFields;
module.exports.publishOneCase = publishOneCase;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ error: "Kun POST er støttet." }) };

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: "Mangler innlogging." }) };

  if (!process.env.WP_URL || !process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD) {
    return { statusCode: 500, body: JSON.stringify({ error: "WP_URL / WP_USERNAME / WP_APP_PASSWORD er ikke satt som miljøvariabler i Netlify ennå." }) };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "SUPABASE_URL/SUPABASE_ANON_KEY mangler som miljøvariabler." }) };
  }

  const supabase = getSupabaseForUser(token);
  const userRes = await supabase.auth.getUser(token);
  if (userRes.error || !userRes.data.user) return { statusCode: 401, body: JSON.stringify({ error: "Ugyldig eller utløpt innlogging." }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Ugyldig forespørsel." }) }; }
  if (!body.caseId) return { statusCode: 400, body: JSON.stringify({ error: "Mangler caseId." }) };

  try {
    const result = await publishOneCase(supabase, body.caseId);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: err.missingFields ? 422 : 500, body: JSON.stringify({ error: err.message, missingFields: err.missingFields || null }) };
  }
};
