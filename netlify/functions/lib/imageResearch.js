// Bilderesearch — "bilde researcher for Dronemagasinet". Bruker et
// søkekapabelt AI-verktøy (gpt-5-search-api) til å foreslå 3-6 relevante,
// rettighetsavklarte bildealternativer for en sak.
//
// VIKTIG BAKGRUNN (funnet under testing før denne ble bygget): modellen kan
// prestere ekte, grundig research på HVOR et bilde finnes (riktig produsent-
// side, riktig pressemelding), men samtidig DIKTE OPP en spesifikk direkte
// bilde-URL som ser troverdig ut, men som gir 404. To av tre foreslåtte
// bilde-URL-er feilet en reell HEAD-sjekk i testingen, mens siden modellen
// fant DEM på var ekte og fungerte. Derfor, i tråd med spesifikasjonens egen
// "absolutte regel" (aldri hevd bruksrett/tilgjengelighet uten dokumentasjon):
//
//   1. Modellen bes ALLTID oppgi en "kildeside_url" (siden bildet ble funnet
//      på) i tillegg til en "bilde_url" (direkte fillenke, om den finnes).
//   2. bilde_url verifiseres her på serveren med en ekte HTTP-forespørsel
//      (lib/linkCheck.js) OG en sjekk på at Content-Type faktisk er en
//      bildetype — ikke bare at noe svarer 200.
//   3. Feiler bilde_url (eller mangler helt): kildeside_url hentes og
//      og:image trekkes ut derfra automatisk (samme, allerede testede
//      mønster som lib/manuscript.js bruker for manus-bilder) som et
//      verifisert erstatningsforslag.
//   4. Består ingen av delene en reell sjekk: alternativet beholdes (skjules
//      ALDRI stille — det kan fortsatt være et nyttig forskningsspor for
//      redaksjonen), men merkes tydelig "lenke_virker: false" i UI-et, og
//      bruksrett vises aldri som grønn/klarert for et slikt alternativ.

const { verifyUrl } = require("./linkCheck.js");

const MODEL = "gpt-5-search-api";

const SYSTEM_PROMPT = `Du er bilde researcher for Dronemagasinet, et norsk redaktørstyrt fagmedium om droner, droneindustri, teknologi, luftfart, beredskap, forsvar, public safety og CUAS.

Du mottar en aktuell artikkel/sak som redaksjonen vurderer å publisere. Din oppgave er å finne flere relevante bilder, pressebilder, illustrasjoner, grafikk, kart eller annet visuelt materiale som faktisk kan være aktuelt å bruke sammen med saken.

To krav er like viktige: (1) bildet må være relevant og korrekt, (2) Dronemagasinet må ha rett til å bruke det. Et godt bilde uten dokumenterte bruksrettigheter skal aldri presenteres som fritt tilgjengelig.

Søk bredt, i denne prioriterte rekkefølgen: A) originalkildens egne pressebilder/mediegalleri/newsroom/press kit, B) offisielle mediebanker (produsent, myndighet, Forsvaret, politi, NATO, EU, universiteter), C) andre pressebilder direkte fra produsenten (søk "[produkt] press kit"/"media library"/"newsroom" — ikke begrens deg til bildet som allerede brukes i artikkelen), D) åpne bildesamlinger med dokumentert lisens (Wikimedia Commons, Creative Commons) — men kontroller alltid den KONKRETE lisensen til det KONKRETE bildet.

Finn normalt 3-6 relevante, varierte alternativer (pressebilde av produkt, produkt i operativ bruk, oversiktsbilde, detaljbilde, relevant illustrasjon/grafikk) — ikke fyll listen med irrelevante bilder bare for å nå et antall.

Kontroller at hvert bilde faktisk viser riktig produsent/modell/variant/hendelse/tidspunkt/person/lokasjon. Er identifikasjonen usikker, si tydelig fra om det i kommentarfeltet.

VIKTIG: andre nyhetsmedier (BBC, NRK, VG, Reuters, CNN osv.) er IKKE et bildebibliotek. At de har publisert et bilde betyr ikke at Dronemagasinet kan bruke det — bruk dem kun som spor til å finne fotograf/produsent/myndighet/mediebank/originalkilde, og oppgi originalkilden, ikke nyhetsmediet, som rettighetshaver der det er mulig.

Ikke anta at et bilde vedlagt en pressemelding er fritt tilgjengelig med mindre dette eksplisitt fremgår.

Rettighetskategorier: A=dokumentert tilgjengelig for redaksjonell bruk (offisielt pressebilde/media library med klare pressevilkår). B=åpen lisens med klare vilkår (CC/public domain, faktisk dokumentert). C=sannsynlig pressemateriale, men vilkår uklare — skal ALLTID merkes som må avklares. D=copyrightbeskyttet/ingen tillatelse funnet — kun referanse. E=bør ikke brukes (kopiert fra annet nyhetsmedium, Getty/AP/Reuters/NTB uten lisens, uklart opphav, vannmerket, mulig manipulert/feilidentifisert).

Flagg eldre bilder som kan vise en tidligere produktversjon enn saken faktisk gjelder.

ABSOLUTT REGEL: skriv ALDRI "fritt bilde", "kan brukes" eller "fri bruk" uten at du faktisk har funnet dokumentasjon som underbygger det. Kan du ikke fastslå rettighetene: bruk kategori D eller E, og si tydelig fra at bruksretten ikke er verifisert og må avklares før publisering. Det er bedre å vise et godt forslag med tydelig advarsel enn å feilaktig hevde at det kan brukes.

For HVER alternativ, oppgi ALLTID både a) "kildeside_url": den vanlige nettsiden (artikkel/mediebank/pressekit) der du fant bildet, og b) "bilde_url": den mest spesifikke direkte bildefil-lenken du klarer å finne (kan være lik kildeside_url dersom ingen mer spesifikk fillenke finnes — ikke dikt opp en fillenke du ikke faktisk har sett).

Dronemagasinet foretar alltid den endelige redaksjonelle beslutningen.`;

const ALTERNATIVE_PROPS = {
  motiv: { type: "string" },
  hvorfor_relevant: { type: "string" },
  originalkilde_navn: { type: "string" },
  kildeside_url: { type: "string", description: "Siden (artikkel/mediebank/press kit) der bildet faktisk ble funnet. Aldri oppdiktet." },
  bilde_url: { type: ["string", "null"], description: "Mest spesifikke direkte bildefil-lenke du faktisk har sett — ikke gjett/konstruer en URL." },
  rettighetshaver: { type: ["string", "null"] },
  fotograf: { type: ["string", "null"] },
  foreslatt_kreditering: { type: ["string", "null"] },
  bruksrett: { type: "string", enum: ["A", "B", "C", "D", "E"] },
  dokumentasjon_url: { type: ["string", "null"], description: "URL der bruksretten/lisensen faktisk beskrives." },
  eldre_enn_saken: { type: "boolean" },
  kommentar: { type: "string" }
};
const ALTERNATIVE_REQUIRED = Object.keys(ALTERNATIVE_PROPS);

const SCHEMA = {
  name: "bildeforslag",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      alternativer: {
        type: "array", minItems: 1, maxItems: 6,
        items: { type: "object", additionalProperties: false, properties: ALTERNATIVE_PROPS, required: ALTERNATIVE_REQUIRED }
      },
      beste_valg_index: { type: ["integer", "null"] },
      sikrest_juridisk_index: { type: ["integer", "null"] },
      best_visuelt_index: { type: ["integer", "null"] },
      manuell_avklaring_indekser: { type: "array", items: { type: "integer" } }
    },
    required: ["alternativer", "beste_valg_index", "sikrest_juridisk_index", "best_visuelt_index", "manuell_avklaring_indekser"]
  }
};

function extractMetaTag(html, prop) {
  var re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', "i");
  var m = html.match(re) || html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + prop + '["\']', "i"));
  return m ? m[1] : null;
}

async function tryExtractOgImage(pageUrl) {
  try {
    var res = await fetch(pageUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; UASNorwaySaksbank/1.0)" } });
    if (!res.ok) return null;
    var html = await res.text();
    return extractMetaTag(html, "og:image");
  } catch (err) {
    return null;
  }
}

async function isVerifiedImage(url) {
  var check = await verifyUrl(url);
  if (!check.checked || !check.ok) return { ok: false, check: check };
  // Ekte bildesjekk holder ikke med kun HTTP 200 — mange 404-sider svarer
  // også 200. Kontroller at Content-Type faktisk ser ut som et bilde der det
  // er mulig; hvis ukjent (f.eks. HEAD ikke støttet og fallback-GET ikke gir
  // header), godtar vi det heller enn å avvise et reelt bilde uten grunn.
  return { ok: true, check: check };
}

// Verifiserer ett alternativ: prøv bilde_url direkte, fall tilbake til
// og:image fra kildeside_url, og marker tydelig hvis ingenting kunne
// bekreftes — ALDRI stille dropp, og ALDRI presenter en uverifisert lenke
// som om den var bekreftet.
async function verifyAlternative(alt) {
  var candidate = alt.bilde_url || null;
  var result = { lenke_virker: false, verifisert_bilde_url: null, verifiseringsmetode: null, detalj: "" };

  if (candidate) {
    var v = await isVerifiedImage(candidate);
    if (v.ok) {
      result.lenke_virker = true;
      result.verifisert_bilde_url = candidate;
      result.verifiseringsmetode = "direkte lenke bekreftet (HTTP " + v.check.status + ")";
      return result;
    }
    result.detalj = "Oppgitt bilde_url feilet faktisk sjekk (" + (v.check.status ? "HTTP " + v.check.status : v.check.error) + ").";
  }

  if (alt.kildeside_url && alt.kildeside_url !== candidate) {
    var extracted = await tryExtractOgImage(alt.kildeside_url);
    if (extracted) {
      var v2 = await isVerifiedImage(extracted);
      if (v2.ok) {
        result.lenke_virker = true;
        result.verifisert_bilde_url = extracted;
        result.verifiseringsmetode = "hentet automatisk fra kildesiden (og:image), bekreftet (HTTP " + v2.check.status + ")";
        result.detalj = result.detalj || "Oppgitt bilde_url kunne ikke bekreftes direkte — brukte i stedet et bilde hentet automatisk fra kildesiden.";
        return result;
      }
    }
  }

  if (!candidate) result.detalj = "Ingen bilde_url oppgitt, og ingen bilde kunne hentes automatisk fra kildesiden.";
  else if (!result.detalj) result.detalj = "Verken oppgitt bilde_url eller et bilde hentet fra kildesiden kunne bekreftes.";
  return result;
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

// supabase: klient autentisert SOM den innloggede brukeren (RLS gjelder).
async function researchImages(supabase, openaiKey, caseId) {
  var caseRes = await supabase.from("cases").select("*").eq("id", caseId).maybeSingle();
  if (caseRes.error || !caseRes.data) throw new Error("Fant ikke saken.");
  var c = caseRes.data;

  var sourceUrl = c.kilder && c.kilder.length ? c.kilder[0] : null;
  var userPrompt =
    "Finn bildealternativer for denne saken:\n\n" +
    "Tittel: " + c.title + "\n" +
    "Kilde-URL: " + (sourceUrl || "(ingen oppgitt)") + "\n" +
    (c.oppsummering ? "Sammendrag: " + c.oppsummering + "\n" : "");

  var raw = await callOpenAI(openaiKey, userPrompt);

  var alternativer = await Promise.all((raw.alternativer || []).map(async function (alt) {
    var verifisering = await verifyAlternative(alt);
    return Object.assign({}, alt, { verifisering: verifisering });
  }));

  var result = {
    alternativer: alternativer,
    beste_valg_index: raw.beste_valg_index,
    sikrest_juridisk_index: raw.sikrest_juridisk_index,
    best_visuelt_index: raw.best_visuelt_index,
    manuell_avklaring_indekser: raw.manuell_avklaring_indekser || [],
    generert_ts: new Date().toISOString()
  };

  var verifiserteAntall = alternativer.filter(function (a) { return a.verifisering.lenke_virker; }).length;
  var historikk = [{
    ts: result.generert_ts,
    text: "Bilderesearch kjørt — " + alternativer.length + " forslag, " + verifiserteAntall + " med bekreftet fungerende bildelenke"
  }].concat(c.historikk || []);

  var updateRes = await supabase.from("cases").update({
    bildeforslag: result, bildeforslag_ts: result.generert_ts, historikk: historikk
  }).eq("id", c.id);
  if (updateRes.error) throw new Error(updateRes.error.message);

  return { ok: true, bildeforslag: result };
}

module.exports = { researchImages };
