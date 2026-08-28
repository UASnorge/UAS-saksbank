// Oppretter et WordPress-UTKAST fra en sak sitt genererte manus — på riktig
// nettsted (dronemag.no ELLER uasnorway.no), styrt av saken sitt eget
// "nettsted"-felt. Bruker "WordPress Infosak Batch Administrator" sin
// allerede testede integrasjon (portert til lib/wordpress.js) for
// uasnorway.no; dronemag.no bruker WordPress sine standardfelt inntil
// eventuelle egendefinerte felt der er bekreftet (se lib/wordpress.js).
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
// Krever innlogget bruker (Bearer-token). Krever miljøvariablene
// WP_UASNORWAY_URL/USERNAME/APP_PASSWORD og/eller WP_DRONEMAG_URL/USERNAME/
// APP_PASSWORD (kun det nettstedet saken faktisk peker på trenger å være
// satt), i tillegg til de eksisterende SUPABASE_URL/SUPABASE_ANON_KEY.

const { createClient } = require("@supabase/supabase-js");
const { uploadMediaForSite, createDraftPost } = require("./lib/wordpress.js");

function getSupabaseForUser(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } }
  });
}

// Samme feltkrav som malen ("Mal-opplasting-av-saker.docx") og det
// eksisterende WordPress-verktøyet stiller: TITTEL, INGRESS, HOVEDTEKST og
// minst ett bilde er obligatorisk. FOTO (fotokreditering) er valgfritt.
// Stikkord/kategori/byline er, etter tilbakemelding, ALDRI noe som skal
// utledes stille — redaksjonen velger dem selv per sak, og publisering
// stoppes her (samme prinsipp som manus-feltene) om noen av dem mangler.
function findMissingFields(c) {
  const missing = [];
  if (!((c.manus_tittel || c.title || "").trim())) missing.push("Tittel");
  if (!((c.manus_ingress || "").trim())) missing.push("Ingress");
  if (!(Array.isArray(c.manus_hovedtekst) && c.manus_hovedtekst.some((p) => (p || "").trim()))) missing.push("Hovedtekst");
  if (!((c.manus_bilde_url || "").trim())) missing.push("Bilde");
  if (!((c.wp_stikkord || "").trim())) missing.push("Stikkord");
  if (!(Array.isArray(c.wp_kategori) && c.wp_kategori.length)) missing.push("Kategori");
  if (!((c.wp_byline || "").trim())) missing.push("Byline");
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
  const media = await uploadMediaForSite(c.nettsted, {
    buffer: img.buffer, filename: img.filename, mimeType: img.mimeType,
    altText: c.manus_alt_tekst || "", caption: c.manus_alt_tekst || ""
  });

  const post = await createDraftPost(c.nettsted, {
    title: c.manus_tittel || c.title,
    ingress: c.manus_ingress,
    hovedtekstAvsnitt: c.manus_hovedtekst,
    byline: c.wp_byline,
    photoCredit: c.manus_foto || "",
    caption: c.manus_alt_tekst || "",
    featuredMediaId: media.id,
    // wp_stikkord er det ENESTE som sendes som WP-stikkord (tags) — nøyaktig
    // det redaksjonen selv har valgt (INFO/Dronemagasinet), ingen AI-
    // foreslåtte eller andre automatisk utledede stikkord i tillegg.
    tagNames: [c.wp_stikkord],
    // wp_kategori (INFO/Dronemagasinet/Aktuelt, kan være flere) er en EGEN
    // WordPress-taksonomi (categories), ikke det samme som stikkord over.
    categoryNames: c.wp_kategori
  });

  const historikk = [{
    ts: new Date().toISOString(),
    text: "WordPress-utkast opprettet på " + c.nettsted + " (automatisk, via saksbanken) — post-ID " + post.id +
      (post.usedAcfFields === false ? " — OBS: opprettet med kun standardfelt, ingen bekreftede egendefinerte visningsfelt for dette nettstedet ennå" : "")
  }].concat(c.historikk || []);

  const newStatus = c.status === "ide" || c.status === "godkjent" || c.status === "i-arbeid"
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

  return { ok: true, wpPostId: post.id, editLink: post.editLink, title: c.manus_tittel || c.title, nettsted: c.nettsted, usedAcfFields: post.usedAcfFields };
}

// Eksportert for testbarhet — Netlify bruker kun exports.handler.
module.exports.findMissingFields = findMissingFields;
module.exports.publishOneCase = publishOneCase;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ error: "Kun POST er støttet." }) };

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: "Mangler innlogging." }) };

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
