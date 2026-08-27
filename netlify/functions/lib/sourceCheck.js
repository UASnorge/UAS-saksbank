// Kildevurdering — "kildekontrollør for Dronemagasinet". Bruker et
// søkekapabelt AI-verktøy (gpt-5-search-api) til faktisk å undersøke
// avsender, originalkilde og tidspunkt for en sak, og presenterer resultatet
// i det faste "KILDEVURDERING"-formatet redaksjonen har spesifisert.
//
// VIKTIG, samme "grunnregel" som selve spesifikasjonen krever: modellen skal
// ALDRI fremstilles som å ha kontrollert en lenke uten at det faktisk er
// kontrollert. Derfor stoler IKKE denne modulen på modellens eget
// "lenkekontroll"-felt alene — url og originalkilde_url verifiseres på nytt
// med en ekte HTTP-forespørsel her på serveren (lib/linkCheck.js), og det
// endelige "lenkekontroll"-resultatet som vises til redaksjonen er basert på
// den faktiske sjekken, ikke bare på hva modellen påsto.

const { verifyUrls } = require("./linkCheck.js");

const MODEL = "gpt-5-search-api";

const SYSTEM_PROMPT = `Du er kildekontrollør for Dronemagasinet, et norsk redaktørstyrt fagmedium om droner, droneindustri, teknologi, regelverk, beredskap, forsvar, public safety, luftfart og tilgrensende teknologi.

Du mottar saker som allerede er identifisert som potensielt relevante. Din oppgave er IKKE å vurdere hvor interessant saken er — det gjør en annen del av systemet. Din oppgave er å besvare: Kan redaksjonen ha rimelig tillit til at denne saken og dens kildegrunnlag er reelt, aktuelt og korrekt identifisert?

Bruk websøk aktivt til å faktisk undersøke avsenderen, publikasjonen, originalkildene, lenkene og tidspunktet for publisering. Ikke anta noe du ikke har sjekket.

Skill alltid mellom (A) den som publiserer saken og (B) den opprinnelige kilden til opplysningene. Ikke anta at et nettsted er originalkilden bare fordi det er den første kilden funnet.

Kontroller lenker: eksisterer URL-en, leder den til riktig dokument, hva er publiseringsdatoen, er det en gammel artikkel som er redistribuert, sier kilden faktisk det saken hevder.

Kontroller om saken faktisk er ny — søk etter samme hendelse/kunngjøring for å avgjøre om noe gammelt fremstår som nytt.

Troverdighetsskala for AVSENDER (1-5): 5=etablert redaktørstyrt medium/offentlig myndighet/politi/forsvar/domstol/anerkjent forskningsinstitusjon. 4=etablert fagmedium/anerkjent bransjepublikasjon/selskap om egen virksomhet. 3=mindre fagnettsted/produsentens egne påstander/pressemelding uten bekreftelse. 2=blogg/kommersielt nettsted uten redaksjon/sosiale medier/aggregator. 1=anonym/ukjent/manglende originalkilde/mulig AI-generert. Skalaen gjelder avsenders dokumenterbarhet, ikke om vi liker innholdet — skill mellom "troverdig kilde til at en påstand er fremsatt" og "uavhengig dokumentasjon på at påstanden er sann".

Se etter røde flagg: manglende originalkilde, ikke-fungerende lenke, lenke som ikke støtter påstanden, uklar dato, saken er eldre enn den fremstår, kopiert fra annet medium, sensasjonell overskrift uten dokumentasjon, kun sosiale medier som kilde, anonym forfatter, ukjent utgiver, mulig AI-generert nettsted, tall/sitater uten kilde, militære påstander uten primærkilde, produktpåstander kun fra leverandør, flere nettsteder som kopierer samme svake originalkilde. Ikke regn flere nettsteder som uavhengige kilder dersom alle bare kopierer samme opprinnelige opplysning.

Forsøk å finne minst én uavhengig/alternativ kilde for viktige påstander, helst en primærkilde eller anerkjent redaktørstyrt kilde.

GRUNNREGEL: Du skal ALDRI fremstille noe som kontrollert dersom du ikke faktisk har kontrollert det. Mangler informasjon: skriv "Ikke verifisert" eller "Kunne ikke fastslås". Ikke gjett.

Dronemagasinet foretar alltid den endelige redaksjonelle vurderingen. Din oppgave er å gjøre denne vurderingen enklere.`;

const SCHEMA = {
  name: "kildevurdering",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      troverdighet_score: { type: "integer", minimum: 1, maximum: 5 },
      publisert_av_navn: { type: "string" },
      publisert_av_type: {
        type: "string",
        enum: ["redaktørstyrt medium", "offentlig myndighet", "politi/forsvar/offentlig etat", "selskap/produsent",
          "pressemelding", "bransjemedium", "forskningsinstitusjon/universitet", "organisasjon", "blogg",
          "sosialt medium", "ukjent"]
      },
      publisert_av_redaktorstyrt: { type: ["boolean", "null"] },
      forfatter: { type: ["string", "null"] },
      publisert_dato: { type: ["string", "null"] },
      sist_oppdatert: { type: ["string", "null"] },
      url: { type: ["string", "null"] },
      land: { type: ["string", "null"] },
      originalkilde_navn: { type: ["string", "null"] },
      originalkilde_url: { type: ["string", "null"] },
      originalkilde_type: {
        type: ["string", "null"],
        enum: ["pressemelding", "myndighetsdokument", "offentlig kunngjøring", "produsentens nettside",
          "forskningsrapport", "kontraktskunngjøring", "rettsdokument", "offentlig register", "intervju",
          "annet medium", "innlegg i sosiale medier", "ukjent kilde", null]
      },
      originalkilde_stotter_pastand: { type: ["boolean", "null"], description: "Sier originalkilden faktisk det saken hevder? Kun modellens innholdsvurdering — lenkens tekniske funksjon sjekkes separat." },
      hendelse_dato: { type: ["string", "null"] },
      saken_er: { type: "string", enum: ["NY", "FORTSATT_AKTUELL", "ELDRE_SAK", "UKLART"] },
      uavhengig_bekreftelse_funnet: { type: "boolean" },
      uavhengig_bekreftelse_kilder: { type: "array", items: { type: "string" }, description: "Navn + URL per funnet uavhengig kilde." },
      rode_flagg: { type: "array", items: { type: "string" } },
      kort_vurdering: { type: "string", description: "3-5 setninger." },
      anbefaling: { type: "string", enum: ["TRYGG", "BOR_VERIFISERES", "KUN_TIPS", "BOR_IKKE_BRUKES"] },
      forbehold: { type: "array", items: { type: "string" } }
    },
    required: ["troverdighet_score", "publisert_av_navn", "publisert_av_type", "publisert_av_redaktorstyrt",
      "forfatter", "publisert_dato", "sist_oppdatert", "url", "land", "originalkilde_navn", "originalkilde_url",
      "originalkilde_type", "originalkilde_stotter_pastand", "hendelse_dato", "saken_er",
      "uavhengig_bekreftelse_funnet", "uavhengig_bekreftelse_kilder", "rode_flagg", "kort_vurdering",
      "anbefaling", "forbehold"]
  }
};

const TROVERDIGHET_LABELS = { 5: "SVÆRT HØY", 4: "HØY", 3: "MIDDELS", 2: "LAV", 1: "SVÆRT LAV" };

function extractUrlsFromKilder(list) {
  return (list || []).map(function (s) {
    var m = String(s).match(/https?:\/\/[^\s)"']+/);
    return m ? m[0] : null;
  }).filter(Boolean);
}

async function callOpenAI(openaiKey, userPrompt) {
  var res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + openaiKey },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt }],
      response_format: { type: "json_schema", json_schema: SCHEMA }
    })
  });
  if (!res.ok) throw new Error("OpenAI-feil (" + res.status + "): " + (await res.text()).slice(0, 300));
  var data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// Kombinerer modellens egen innholdsvurdering med FAKTISKE HTTP-sjekker av
// url og originalkilde_url til ett endelig, verifisert lenkekontroll-resultat.
function computeLenkekontroll(fields, linkResults) {
  var checks = [];
  [fields.url, fields.originalkilde_url].forEach(function (u) {
    if (u && linkResults[u] && linkResults[u].checked) checks.push(linkResults[u]);
  });
  if (!checks.length) return { status: "IKKE_BEKREFTET", detalj: "Ingen lenker å kontrollere ble oppgitt." };
  var allOk = checks.every(function (c) { return c.ok; });
  var anyOk = checks.some(function (c) { return c.ok; });
  var brokenNote = checks.filter(function (c) { return !c.ok; })
    .map(function (c) { return c.status ? "HTTP " + c.status : (c.error || "ukjent feil"); }).join("; ");
  if (allOk && fields.originalkilde_stotter_pastand === false) {
    return { status: "DELVIS_BEKREFTET", detalj: "Lenkene fungerer teknisk, men AI-vurderingen antyder at originalkilden ikke tydelig støtter påstanden — se «Kort vurdering»." };
  }
  if (allOk) return { status: "BEKREFTET", detalj: "Alle oppgitte lenker ble faktisk testet (HTTP) og svarer." };
  if (anyOk) return { status: "DELVIS_BEKREFTET", detalj: "Minst én lenke feilet ved faktisk test: " + brokenNote };
  return { status: "IKKE_BEKREFTET", detalj: "Lenke(r) feilet ved faktisk test: " + brokenNote };
}

// supabase: klient autentisert SOM den innloggede brukeren (RLS gjelder).
async function checkSource(supabase, openaiKey, caseId) {
  var caseRes = await supabase.from("cases").select("*").eq("id", caseId).maybeSingle();
  if (caseRes.error || !caseRes.data) throw new Error("Fant ikke saken.");
  var c = caseRes.data;

  var sourceUrl = c.kilder && c.kilder.length ? c.kilder[0] : null;
  var userPrompt =
    "Vurder denne saken:\n\n" +
    "Tittel: " + c.title + "\n" +
    "Kilde-URL: " + (sourceUrl || "(ingen oppgitt — søk opp saken basert på tittelen)") + "\n" +
    (c.oppsummering ? "Tidligere AI-sammendrag: " + c.oppsummering + "\n" : "");

  var fields = await callOpenAI(openaiKey, userPrompt);

  var urlsToVerify = [fields.url, fields.originalkilde_url].concat(extractUrlsFromKilder(fields.uavhengig_bekreftelse_kilder));
  var linkResults = await verifyUrls(urlsToVerify);
  var lenkekontroll = computeLenkekontroll(fields, linkResults);

  var result = {
    troverdighet_score: fields.troverdighet_score,
    troverdighet_label: TROVERDIGHET_LABELS[fields.troverdighet_score] || "UKJENT",
    publisert_av_navn: fields.publisert_av_navn,
    publisert_av_type: fields.publisert_av_type,
    publisert_av_redaktorstyrt: fields.publisert_av_redaktorstyrt,
    forfatter: fields.forfatter,
    publisert_dato: fields.publisert_dato,
    sist_oppdatert: fields.sist_oppdatert,
    url: fields.url,
    land: fields.land,
    originalkilde_navn: fields.originalkilde_navn,
    originalkilde_url: fields.originalkilde_url,
    originalkilde_type: fields.originalkilde_type,
    hendelse_dato: fields.hendelse_dato,
    saken_er: fields.saken_er,
    lenkekontroll: lenkekontroll.status,
    lenkekontroll_detalj: lenkekontroll.detalj,
    lenke_verifisering: linkResults,
    uavhengig_bekreftelse_funnet: fields.uavhengig_bekreftelse_funnet,
    uavhengig_bekreftelse_kilder: fields.uavhengig_bekreftelse_kilder,
    rode_flagg: fields.rode_flagg,
    kort_vurdering: fields.kort_vurdering,
    anbefaling: fields.anbefaling,
    forbehold: fields.forbehold,
    generert_ts: new Date().toISOString()
  };

  var historikk = [{ ts: result.generert_ts, text: "Kildevurdering kjørt — troverdighet " + result.troverdighet_score + "/5 (" + result.troverdighet_label + "), anbefaling: " + result.anbefaling }]
    .concat(c.historikk || []);

  var updateRes = await supabase.from("cases").update({
    kildevurdering: result, kildevurdering_ts: result.generert_ts, historikk: historikk
  }).eq("id", c.id);
  if (updateRes.error) throw new Error(updateRes.error.message);

  return { ok: true, kildevurdering: result };
}

module.exports = { checkSource };
