// Reviderer et ALLEREDE GENERERT manus basert på et fritekstnotat fra
// redaksjonen ("AI-notat") — f.eks. "gjør saken lenger", "inkluder info fra
// kilden om X", "ta bilde herifra: <url>", "finn et annet bilde som er
// pressevennlig". Brukt av "Oppdater med AI"-knappen i manusredigeringen
// direkte i saken (public/index.html) og som verktøy for AI-assistenten.
//
// Samme faktadisiplin som førsteutkastet (lib/manuscript.js): reviderer kun
// basert på det som allerede står i manuset eller i den faktiske
// kildeteksten — finner ALDRI på nye fakta bare fordi notatet ber om "mer
// stoff". Bilder er et eget, strengere tilfelle: modellen kan ALDRI dikte opp
// en ny bilde-URL selv — den kan kun bruke en URL redaksjonen selv har limt
// inn i notatet, og selv den blir verifisert med en ekte HTTP-forespørsel her
// (lib/linkCheck.js) før den godtas. Ber notatet om et "annet"/"pressevennlig"
// bilde uten å oppgi en konkret lenke, beholdes gjeldende bilde uendret, og
// brukeren blir tydelig anbefalt å bruke "🖼️ Finn bilder"-funksjonen i
// stedet (som gjør ekte, verifisert bilderesearch) — ikke gjettet på her.

const { fetchSourceArticle, fetchImage, buildDocxParagraphs, callOpenAI, scaleToMaxWidth, HOUSE_STYLE, MODEL } = require("./manuscript.js");
const { verifyUrl } = require("./linkCheck.js");
const { Document, Packer } = require("docx");

const REVISE_SYSTEM_PROMPT = HOUSE_STYLE + `

Du reviderer nå et EKSISTERENDE manus basert på en konkret instruks fra redaksjonen ("AI-notatet"). Hold deg
UTELUKKENDE til fakta som allerede står i manuset eller i den oppgitte kildeteksten under — finn ALDRI på nye
detaljer, tall, sitater eller navn bare fordi notatet ber om f.eks. en lengre sak. Er kildeteksten for tynn til
å dekke det notatet ber om, skriv det tydelig i usikkerhetsnotat i stedet for å gjette.

Om bilder: du kan ALDRI dikte opp en bilde-URL selv. Sett bilde_handling til "bruk_ny_url" KUN dersom notatet
selv inneholder en konkret URL redaksjonen ber om å bruke — kopier den nøyaktig, ikke konstruer en variant av
den. Ber notatet om et "annet"/"bedre"/"pressevennlig" bilde UTEN å oppgi en konkret URL: sett bilde_handling
til "behold" og skriv i hva_ble_endret at redaksjonen bør bruke bilderesearch-funksjonen i verktøyet for å finne
et faktisk verifisert alternativ i stedet — ikke gjett på et bilde.`;

const REVISE_SCHEMA = {
  name: "manus_revidert",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      tittel: { type: "string" },
      ingress: { type: "string" },
      hovedtekst_avsnitt: { type: "array", items: { type: "string" }, minItems: 1 },
      alt_tekst_bilde: { type: "string" },
      bilde_handling: { type: "string", enum: ["behold", "bruk_ny_url"] },
      ny_bilde_url: { type: ["string", "null"], description: "KUN en URL redaksjonen selv oppga i notatet — aldri oppfunnet. Null om bilde_handling er 'behold'." },
      usikkerhetsnotat: { type: ["string", "null"] },
      hva_ble_endret: { type: "string", description: "1-2 setninger, til historikklogg — hva ble faktisk endret basert på notatet." }
    },
    required: ["tittel", "ingress", "hovedtekst_avsnitt", "alt_tekst_bilde", "bilde_handling", "ny_bilde_url", "usikkerhetsnotat", "hva_ble_endret"]
  }
};

// supabase: klient autentisert SOM den innloggede brukeren (RLS gjelder).
async function reviseManuscript(supabase, openaiKey, caseId, aiNotat) {
  var note = (aiNotat || "").trim();
  if (!note) throw new Error("Mangler AI-notat — skriv hva som skal endres først.");

  var caseRes = await supabase.from("cases").select("*").eq("id", caseId).maybeSingle();
  if (caseRes.error || !caseRes.data) throw new Error("Fant ikke saken.");
  var c = caseRes.data;
  if (!c.manus_tittel && !(c.manus_hovedtekst || []).length) {
    throw new Error("Saken har ikke noe manus å revidere ennå — generer et førsteutkast først.");
  }

  var sourceUrl = c.kilder && c.kilder.length ? c.kilder[0] : null;
  var source = sourceUrl ? await fetchSourceArticle(sourceUrl) : { ok: false, reason: "ingen kildelenke registrert" };

  var userPrompt =
    "Gjeldende manus:\n" +
    "TITTEL: " + (c.manus_tittel || "") + "\n" +
    "INGRESS: " + (c.manus_ingress || "") + "\n" +
    "HOVEDTEKST:\n" + (c.manus_hovedtekst || []).join("\n\n") + "\n" +
    "ALT-TEKST BILDE: " + (c.manus_alt_tekst || "") + "\n" +
    "GJELDENDE BILDE-URL: " + (c.manus_bilde_url || "(ingen)") + "\n\n" +
    "AI-NOTAT FRA REDAKSJONEN (instruks for hva som skal endres nå):\n" + note + "\n\n" +
    (source.ok
      ? "Kildeteksten (bruk denne om notatet ber om mer stoff/detaljer):\n" + source.text
      : "Kildeteksten kunne ikke hentes på nytt (" + source.reason + ") — hold deg til det som allerede står i manuset.");

  var fields = await callOpenAI(openaiKey, MODEL, REVISE_SYSTEM_PROMPT, userPrompt, REVISE_SCHEMA);

  var newImageUrl = c.manus_bilde_url || "";
  var image = null;
  var bildeMerknad = "";
  if (fields.bilde_handling === "bruk_ny_url" && fields.ny_bilde_url) {
    var check = await verifyUrl(fields.ny_bilde_url);
    if (check.ok) {
      newImageUrl = fields.ny_bilde_url;
      bildeMerknad = " — nytt bilde satt inn (lenke verifisert)";
    } else {
      bildeMerknad = " — ⚠️ det foreslåtte nye bildet kunne ikke bekreftes (" + (check.status ? "HTTP " + check.status : check.error) + "), gjeldende bilde er beholdt";
    }
  }
  if (newImageUrl) image = await fetchImage(newImageUrl);

  var doc = new Document({ sections: [{ children: await buildDocxParagraphs({
    tittel: fields.tittel, ingress: fields.ingress, hovedtekst_avsnitt: fields.hovedtekst_avsnitt,
    alt_tekst_bilde: fields.alt_tekst_bilde, fotoKreditering: c.manus_foto || ""
  }, image) }] });
  var buffer = await Packer.toBuffer(doc);
  var path = c.id + "/" + Date.now() + ".docx";
  var uploadRes = await supabase.storage.from("manus").upload(path, buffer, {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", upsert: false
  });
  if (uploadRes.error) throw new Error("Kunne ikke laste opp revidert manus: " + uploadRes.error.message);

  var historikkNote = "Manus revidert via AI-notat: «" + note.slice(0, 120) + (note.length > 120 ? "…" : "") + "» — " + fields.hva_ble_endret + bildeMerknad +
    (fields.usikkerhetsnotat ? " — ⚠️ " + fields.usikkerhetsnotat : "");
  var historikk = [{ ts: new Date().toISOString(), text: historikkNote }].concat(c.historikk || []);

  var updateRes = await supabase.from("cases").update({
    manus_url: path,
    manus_generert_ts: new Date().toISOString(),
    manus_tittel: fields.tittel || "",
    manus_ingress: fields.ingress || "",
    manus_hovedtekst: fields.hovedtekst_avsnitt || [],
    manus_alt_tekst: fields.alt_tekst_bilde || "",
    manus_bilde_url: newImageUrl,
    manus_ai_notat: note,
    historikk: historikk
  }).eq("id", c.id);
  if (updateRes.error) throw new Error(updateRes.error.message);

  return {
    ok: true, path: path,
    manus: { tittel: fields.tittel, ingress: fields.ingress, hovedtekst: fields.hovedtekst_avsnitt, altTekst: fields.alt_tekst_bilde, bildeUrl: newImageUrl },
    hvaBleEndret: fields.hva_ble_endret, bildeMerknad: bildeMerknad || null, usikkerhetsnotat: fields.usikkerhetsnotat || null
  };
}

module.exports = { reviseManuscript };
