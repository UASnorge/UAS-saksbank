// Generelt websøk — finner nye saker UTEN Å TRENGE en konfigurert RSS-/
// nettsted-kilde i det hele tatt, via et søkekapabelt AI-verktøy
// (gpt-5-search-api, samme modell som kildevurdering/bilderesearch/
// manusgenerering allerede bruker). Dette er ment som HOVEDMEKANISMEN for
// å finne nye saker, ikke bare et supplement til kildelisten — kildelisten
// (RSS/nettsted-typene) er valgfri, ikke en forutsetning.
//
// Bruksområder, alle bygget på samme prinsipp — spør etter EKTE treff funnet
// ved faktisk websøk, aldri diktet opp (samme "grunnregel" som resten av appen):
//
//  1. searchCivilianDroneNews    — sivil/kommersiell bruk, Norge/Norden.
//  2. searchPolicySecurityDroneNews — politi-/sikkerhetshendelser med droner,
//     Norge/Norden. IKKE ren militær/forsvarsdekning (se punkt 4 under —
//     "vi er ikke et forsvarsmagasin", brukerens eksplisitte instruks).
//  3. searchNordicRegulatoryNews — regelverk/høringer/infrastruktur
//     (Luftfartstilsynet, EASA, Avinor, andre nordiske luftfartsmyndigheter).
//  4. searchDefenseDroneNews     — ren militær/forsvarsdekning. Holdes MEGET
//     smalt med vilje (maks 1-2 treff, kun genuint vesentlige norske/nordiske
//     forsvarssaker) — beholdt som egen, atskilt funksjon (i stedet for helt
//     fjernet) nettopp FORDI en tidligere, bredere "sivilt + forsvar i ett
//     søk"-utgave viste seg (testet live) å drukne i internasjonal
//     krigsdekning uansett hvor mye promptet ba om balanse/måtehold — en
//     egen, smal bøtte er den eneste pålitelige måten å holde volumet nede på.
//  5. searchWebsiteSource — ett bestemt nettsted (valgfri "sources"-rad med
//     type='website') — nettstedbegrenset søk (site:domene). Ikke påkrevd.
//  6. searchKeywordMentions — ferske treff på navngitte søkeord/temaer
//     (watch_keywords-tabellen) — kan være selskapsnavn, men også generelle
//     temaer/forskrifter/høringer redaksjonen ønsker tett oppfølging av.
//
// GRUNNREGEL: url-feltet skal ALLTID være en ekte, funnet lenke — aldri en
// gjettet/konstruert URL. web-search-background.js stoler uansett ikke blindt
// på dette — hvert treff går gjennom samme AI-relevanssjekk som RSS-treff får
// (lib/relevance.js) før det blir en sak.
//
// Kjent svakhet ved gpt-5-search-api (samme som oppdaget i lib/manuscript.js):
// modellen kan sette inn uønskede "([kilde.no](url?utm_source=openai))"-
// sitatlenker midt i tekstfeltene selv om ikke bedt om det. Renses derfor
// alltid bort under, samme metode som stripInlineCitations i manuscript.js
// (de to lib-modulene er ellers uavhengige av hverandre, derfor duplisert
// her i stedet for importert).

const SEARCH_MODEL = "gpt-5-search-api";

function stripInlineCitations(text) {
  return String(text || "")
    .replace(/\s*\(\[[^\]]*\]\(https?:\/\/[^\s)]+\)\)/g, "")
    .replace(/\s*\[[^\]]*\]\(https?:\/\/[^\s)]+\)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

const DISCOVERY_SCHEMA = {
  name: "oppdagede_saker",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      treff: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            tittel: { type: "string" },
            url: { type: "string", description: "Den ekte, faktisk funnede artikkel-URL-en. Aldri gjettet/konstruert." },
            utgiver: { type: "string" },
            publisert_dato: { type: ["string", "null"], description: "ISO-dato hvis kjent, ellers null." },
            kort_hvorfor_relevant: { type: "string" }
          },
          required: ["tittel", "url", "utgiver", "publisert_dato", "kort_hvorfor_relevant"]
        }
      }
    },
    required: ["treff"]
  }
};

async function callSearch(openaiKey, systemPrompt, userPrompt) {
  var res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + openaiKey },
    body: JSON.stringify({
      model: SEARCH_MODEL,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      response_format: { type: "json_schema", json_schema: DISCOVERY_SCHEMA }
    })
  });
  if (!res.ok) throw new Error("OpenAI-feil (" + res.status + "): " + (await res.text()).slice(0, 300));
  var data = await res.json();
  var parsed = JSON.parse(data.choices[0].message.content);
  return (parsed.treff || []).map(function (t) {
    return {
      tittel: stripInlineCitations(t.tittel),
      url: t.url,
      utgiver: stripInlineCitations(t.utgiver),
      publisert_dato: t.publisert_dato,
      kort_hvorfor_relevant: stripInlineCitations(t.kort_hvorfor_relevant)
    };
  });
}

var BASE_SYSTEM = `Du finner nye, ferske nyhetssaker for Dronemagasinet (dronemag.no) og UAS Norway, et norsk redaktørstyrt fagmedium om droner, UAS/UAV, droneindustri, droneteknologi, droneregelverk og tilgrensende felt.

VIKTIG, redaksjonell grunnregel: Dronemagasinet er IKKE et forsvarsmagasin. Redaksjonen skal HOVEDSAKELIG dekke norske/nordiske saker — ikke generell internasjonal nyhetsstrøm.

Bruk websøk AKTIVT til å finne ekte, eksisterende artikler — dikt aldri opp en tittel, utgiver eller URL. Finner du ingen ekte treff som passer, returner en tom liste. En URL som ikke faktisk ble funnet ved søk skal ALDRI være med.

Skriv rene tekstfelt — ALDRI sett inn kildehenvisnings-/sitatlenker i formatet "([kilde](url))" eller "[kilde](url)" inni tittel/utgiver/kort_hvorfor_relevant. Selve funnet skal kun rapporteres via url-feltet.

Unngå åpenbare duplikater av samme hendelse fra flere nettsteder — velg den beste/mest opprinnelige kilden per hendelse.`;

// ---------- 1. Sivilt/kommersielt sveip ----------

var CIVILIAN_SYSTEM = BASE_SYSTEM + `

Søk ETTER SIVIL/KOMMERSIELL dronebruk — IKKE politi/sikkerhet (eget søk) og IKKE forsvar/krig/konflikt (eget søk, holdes minimalt). KUN norske/nordiske kilder, MED MINDRE saken er en vesentlig internasjonal produktnyhet med klar relevans for norsk dronebransje (sjeldent unntak, ikke standard).

Let aktivt etter: landbruksdroner, dronelevering/logistikk, film/foto/drone-video, kartlegging/inspeksjon/anleggsbransjen, droneracing/hobby/fritid, norske droneselskaper (lansering, finansiering, krise, konkurs, svindel — dette er en fast, viktig sakstype), droneutdanning/kurs, redningsaksjoner/viltredning med drone.

Maks 6 treff.`;

async function searchCivilianDroneNews(openaiKey, daysBack) {
  var days = daysBack || 3;
  var userPrompt = "Finn ekte, sivile/kommersielle norske/nordiske drone-/UAS-relaterte nyhetssaker fra de siste " + days + " dagene.";
  return callSearch(openaiKey, CIVILIAN_SYSTEM, userPrompt);
}

// ---------- 2. Politi/sikkerhet (norsk/nordisk) ----------

var POLICY_SECURITY_SYSTEM = BASE_SYSTEM + `

Søk ETTER norske/nordiske politi- og sikkerhetshendelser med droner — dette er DEN STØRSTE og viktigste kategorien for redaksjonen i praksis. Eksempler å aktivt lete etter: droneforbud/luftromsrestriksjoner rundt arrangementer (kongelige hendelser, statsbesøk, idrettsarrangementer, 17. mai), politiets egen dronebruk (respons, overvåkning, redning), PST-relatert droneomtale, ulovlig droneflyging, luftromskrenkelser/droneobservasjoner ved norske/nordiske flyplasser eller kritisk infrastruktur, dronehendelser ved militære/sivile anlegg i Norge/Norden.

IKKE ta med ren militær/forsvarsanskaffelse, forsvarsstrategi eller generell internasjonal krigsdekning her — det er et eget, bevisst smalt søk. Denne kategorien handler om POLITI og SIKKERHET I SIVILT LUFTROM, ikke om Forsvaret sine egne anskaffelser/øvelser.

KUN norske/nordiske saker. Maks 6 treff.`;

async function searchPolicySecurityDroneNews(openaiKey, daysBack) {
  var days = daysBack || 3;
  var userPrompt = "Finn ekte, norske/nordiske politi-/sikkerhetsrelaterte drone-/UAS-nyhetssaker fra de siste " + days + " dagene.";
  return callSearch(openaiKey, POLICY_SECURITY_SYSTEM, userPrompt);
}

// ---------- 3. Regelverk/infrastruktur (norsk/nordisk) ----------

var REGULATORY_SYSTEM = BASE_SYSTEM + `

Søk ETTER norsk/nordisk droneregelverk, høringer og luftfarts-infrastruktur: Luftfartstilsynet (nye regler, restriksjonsområder, høringer, sertifisering), EASA-regelendringer med praktisk betydning for Norge/Norden, Avinor (dronedeteksjon/CUAS-infrastruktur, luftromsintegrasjon), registreringsplikt/dronedata, tilsvarende myndigheter i Danmark/Sverige/Finland. Dette er en fast, viktig kategori for redaksjonen — inkluder gjerne saker om konkrete, navngitte prosjekter (f.eks. Avinor sitt dronedeteksjonssystem) når det er nytt å melde.

KUN norske/nordiske saker, MED MINDRE det er en vesentlig EASA-regelendring med direkte betydning for Norge. Maks 5 treff.`;

async function searchNordicRegulatoryNews(openaiKey, daysBack) {
  var days = daysBack || 3;
  var userPrompt = "Finn ekte, norsk/nordisk droneregelverk-/luftfarts-infrastruktur-nyheter (inkl. høringer) fra de siste " + days + " dagene.";
  return callSearch(openaiKey, REGULATORY_SYSTEM, userPrompt);
}

// ---------- 4. Forsvar/militært — holdes bevisst smalt ----------

var DEFENSE_SYSTEM = BASE_SYSTEM + `

Dronemagasinet er IKKE et forsvarsmagasin — dette søket skal holdes MEGET smalt. Søk KUN etter genuint vesentlige norske/nordiske forsvars-/militærsaker med droner (f.eks. en norsk forsvarsdronestrategi, et konkret norsk/nordisk forsvarsanskaffelsesvedtak). IKKE generell internasjonal krigsdekning (Ukraina, Midtøsten, NATO-øvelser utenfor Norden, generelle C-UAS-kontrakter i andre land) — dette dekkes allerede godt av andre medier og blir nesten aldri til en Dronemagasinet-sak.

Maks 2 treff — returner heller en tom liste enn å fylle på med internasjonal krigsdekning bare for å ha noe.`;

async function searchDefenseDroneNews(openaiKey, daysBack) {
  var days = daysBack || 3;
  var userPrompt = "Finn KUN genuint vesentlige norske/nordiske forsvars-/militærrelaterte drone-nyheter fra de siste " + days + " dagene — ikke generell internasjonal krigsdekning.";
  return callSearch(openaiKey, DEFENSE_SYSTEM, userPrompt);
}

// ---------- 5. Ett bestemt nettsted (valgfritt, uten RSS) ----------

var WEBSITE_SYSTEM = BASE_SYSTEM + `

Du skal KUN se etter saker publisert på ETT bestemt nettsted, oppgitt av brukeren. Bruk søkeoperatøren site: mot akkurat det domenet. Ikke ta med treff fra andre nettsteder.`;

async function searchWebsiteSource(openaiKey, siteUrl, siteName, daysBack) {
  var days = daysBack || 3;
  var domain = String(siteUrl).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  var userPrompt = "Nettsted: " + (siteName || domain) + " (site:" + domain + ")\n" +
    "Finn ekte, drone-/UAS-relaterte artikler publisert på nøyaktig dette nettstedet de siste " + days + " dagene.";
  return callSearch(openaiKey, WEBSITE_SYSTEM, userPrompt);
}

// ---------- 6. Navngitte søkeord/temaer (ikke bare selskapsnavn) ----------

var KEYWORD_SYSTEM = BASE_SYSTEM + `

Du skal finne ferske nyhetsomtaler, høringer og nyheter som gjelder ett eller flere av søkeordene/temaene brukeren oppgir. Disse kan være selskapsnavn (finn da omtale av selskapet SELV OM "drone" ikke nevnes eksplisitt — selskapet er allerede kjent som en droneaktør), men kan også være generelle temaer, forskrifter, prosjektnavn eller stikkord redaksjonen ønsker tett oppfølging av (f.eks. et konkret regelverksforslag, en navngitt høring, et prosjektnavn). Ikke ta med generiske treningskurs-/rekrutteringsannonser eller åpenbart uinteressant omtale (f.eks. rene aksjekurslister uten redaksjonelt innhold) — bruk skjønn.`;

async function searchKeywordMentions(openaiKey, keywords, daysBack) {
  var days = daysBack || 3;
  var userPrompt = "Søkeord/temaer å finne fersk omtale av: " + keywords.join(", ") + "\n" +
    "Finn ekte nyhetsomtaler, høringer eller nyheter om disse fra de siste " + days + " dagene.";
  return callSearch(openaiKey, KEYWORD_SYSTEM, userPrompt);
}

module.exports = {
  searchCivilianDroneNews, searchPolicySecurityDroneNews, searchNordicRegulatoryNews, searchDefenseDroneNews,
  searchWebsiteSource, searchKeywordMentions, stripInlineCitations, SEARCH_MODEL
};
