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

const { fetchSourceArticle, fetchImage, buildDocxParagraphs, callOpenAI, scaleToMaxWidth, HOUSE_STYLE, MODEL,
  researchBlock, stripCitationsFromFields, restrictLinksToKnown, isOwnUrl } = require("./manuscript.js");
const { todayLine, norwegianCaptions } = require("./styleGuide.js");
const { verifyUrl } = require("./linkCheck.js");
const { Document, Packer } = require("docx");

const REVISE_SYSTEM_PROMPT = HOUSE_STYLE + `

Du reviderer nå et EKSISTERENDE manus basert på en konkret instruks fra redaksjonen ("AI-notatet"). Hold deg
UTELUKKENDE til fakta som allerede står i manuset eller i den oppgitte kildeteksten under — finn ALDRI på nye
detaljer, tall, sitater eller navn bare fordi notatet ber om f.eks. en lengre sak. Er kildeteksten for tynn til
å dekke det notatet ber om, skriv det tydelig i usikkerhetsnotat i stedet for å gjette.

NYE OPPLYSNINGER FRA RESEARCH: får du et RESEARCH-GRUNNLAG (nummererte kilder E1, E2 … med utdrag av kildenes egen tekst), kan du bruke det utdragene faktisk sier til å utvide eller utdype saken — KUN det, og kun når kilden gjelder samme sak. Navngi kilden i prosa der den brukes («skriver Lovdata», «ifølge forskriften»). List E-numrene du faktisk har brukt i brukte_eksterne. Kilder merket EGEN er våre egne tidligere saker.

LENKER I TEKSTEN: ingen klikkbare lenker — med ÉN unntak: henvisninger til egne tidligere saker fra Dronemagasinet/UAS Norway skal være markdown-lenker [tekst](URL) med nøyaktig URL fra research-grunnlaget eller fra lenkene som allerede står i manuset (behold eksisterende slike lenker uendret). Bildemarkører («![tekst](URL)») og sitatblokker («> …») beholdes uendret på sin plass med mindre notatet ber om noe annet. Bildetekster er alltid på norsk.

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
      brukte_eksterne: { type: "array", items: { type: "integer" }, description: "E-numre fra research-grunnlaget som faktisk er brukt i teksten. Tom liste om ingen." },
      bilde_handling: { type: "string", enum: ["behold", "bruk_ny_url"] },
      ny_bilde_url: { type: ["string", "null"], description: "KUN en URL redaksjonen selv oppga i notatet — aldri oppfunnet. Null om bilde_handling er 'behold'." },
      usikkerhetsnotat: { type: ["string", "null"] },
      hva_ble_endret: { type: "string", description: "1-2 setninger, til historikklogg — hva ble faktisk endret basert på notatet." }
    },
    required: ["tittel", "ingress", "hovedtekst_avsnitt", "alt_tekst_bilde", "brukte_eksterne", "bilde_handling", "ny_bilde_url", "usikkerhetsnotat", "hva_ble_endret"]
  }
};

// supabase: klient autentisert SOM den innloggede brukeren (RLS gjelder).
// opts.research: resultat fra deepResearch (lib/materialResearch.js) som revisjonen kan bygge på.
async function reviseManuscript(supabase, openaiKey, caseId, aiNotat, opts) {
  opts = opts || {};
  var note = (aiNotat || "").trim();
  if (!note) throw new Error("Mangler AI-notat — skriv hva som skal endres først.");

  var caseRes = await supabase.from("cases").select("*").eq("id", caseId).maybeSingle();
  if (caseRes.error || !caseRes.data) throw new Error("Fant ikke saken.");
  var c = caseRes.data;
  if (!c.manus_tittel && !(c.manus_hovedtekst || []).length) {
    throw new Error("Saken har ikke noe manus å revidere ennå — generer et førsteutkast først.");
  }

  // Kildelenken er ikke alltid en nettside (kan være et opplastet dokument/lydopptak i lagring).
  var sourceUrl = (c.kilder || []).filter(function (k) { return /^https?:\/\//i.test(k) && !/supabase\.co\/storage/.test(k); })[0] || null;
  var source = sourceUrl ? await fetchSourceArticle(sourceUrl) : { ok: false, reason: "ingen nettside-kilde registrert" };
  var research = opts.research && opts.research.kilder && opts.research.kilder.length ? opts.research : null;

  var userPrompt =
    todayLine() + "\n\n" +
    "Gjeldende manus:\n" +
    "TITTEL: " + (c.manus_tittel || "") + "\n" +
    "INGRESS: " + (c.manus_ingress || "") + "\n" +
    "HOVEDTEKST:\n" + (c.manus_hovedtekst || []).join("\n\n") + "\n" +
    "ALT-TEKST BILDE: " + (c.manus_alt_tekst || "") + "\n" +
    "GJELDENDE BILDE-URL: " + (c.manus_bilde_url || "(ingen)") + "\n\n" +
    "AI-NOTAT FRA REDAKSJONEN (instruks for hva som skal endres nå):\n" + note + "\n\n" +
    (source.ok
      ? "Kildeteksten (bruk denne om notatet ber om mer stoff/detaljer):\n" + source.text
      : "Kildeteksten kunne ikke hentes på nytt (" + source.reason + ") — hold deg til det som allerede står i manuset.") +
    (research ? "\n\n=====\n\n" + researchBlock(research) : "");

  var fields = await callOpenAI(openaiKey, MODEL, REVISE_SYSTEM_PROMPT, userPrompt, REVISE_SCHEMA);
  stripCitationsFromFields(fields);
  // Lenker til egne saker er kun tillatt når URL-en enten står i research-grunnlaget eller allerede stod i manuset.
  var eksisterendeEgne = ((c.manus_hovedtekst || []).join(" ").match(/\]\((https?:\/\/[^\s)]+)\)/g) || [])
    .map(function (u) { return u.slice(2, -1); }).filter(isOwnUrl)
    .map(function (u) { return { egen: true, url: u }; });
  restrictLinksToKnown(fields, { kilder: ((research && research.kilder) || []).concat(eksisterendeEgne) });

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

  // Kilder: behold eksisterende, legg til eksterne kilder som faktisk ble brukt nå.
  var kilderBrukt = (c.manus_kilder_brukt || []).slice();
  var tidligereDekning = c.manus_tidligere_dekning || null;
  var nyeKilder = 0;
  (fields.brukte_eksterne || []).forEach(function (nr) {
    var k = research && research.kilder.filter(function (x) { return x.nr === nr; })[0];
    if (!k || kilderBrukt.some(function (x) { return x.url === k.url; })) return;
    var typeNavn = { primaerkilde: "Primærkilde", nyhetsomtale: "Omtale", bakgrunn: "Bakgrunn", tidligere_dekning: "Dronemagasinet — tidligere dekning" };
    kilderBrukt.push({ navn: typeNavn[k.type] ? typeNavn[k.type] + (k.egen ? "" : " — " + k.kilde_navn) : k.kilde_navn, tittel: k.tittel, url: k.url, url_virker: true });
    if (k.egen && !tidligereDekning) tidligereDekning = { tittel: k.tittel, url: k.url };
    nyeKilder++;
  });

  var capFields = await norwegianCaptions(openaiKey, { alt_tekst_bilde: fields.alt_tekst_bilde, hovedtekst_avsnitt: fields.hovedtekst_avsnitt });
  fields.alt_tekst_bilde = capFields.alt_tekst_bilde;
  fields.hovedtekst_avsnitt = capFields.hovedtekst_avsnitt;

  var doc = new Document({ sections: [{ children: await buildDocxParagraphs({
    emnefelt: c.manus_emnefelt || [], tittel: fields.tittel, ingress: fields.ingress, hovedtekst_avsnitt: fields.hovedtekst_avsnitt,
    alt_tekst_bilde: fields.alt_tekst_bilde, fotoKreditering: c.manus_foto || "",
    titler_alternativer: c.manus_titler_alternativer || [], kilder_brukt: kilderBrukt, tidligere_dekning: tidligereDekning,
    kontrollpunkter: c.manus_kontrollpunkter || []
  }, image) }] });
  var buffer = await Packer.toBuffer(doc);
  var path = c.id + "/" + Date.now() + ".docx";
  var uploadRes = await supabase.storage.from("manus").upload(path, buffer, {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", upsert: false
  });
  if (uploadRes.error) throw new Error("Kunne ikke laste opp revidert manus: " + uploadRes.error.message);

  var historikkNote = "Manus revidert via AI-notat: «" + note.slice(0, 120) + (note.length > 120 ? "…" : "") + "» — " + fields.hva_ble_endret + bildeMerknad + (nyeKilder ? " — " + nyeKilder + " ny(e) kilde(r) lagt til i kildelisten" : "") +
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
    manus_kilder_brukt: kilderBrukt,
    manus_tidligere_dekning: tidligereDekning,
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
