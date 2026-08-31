// Generelt websøk — finner nye saker UTENFOR den faste RSS-kildelisten,
// via et søkekapabelt AI-verktøy (gpt-5-search-api, samme modell som
// kildevurdering/bilderesearch/manusgenerering allerede bruker).
//
// Bruksområder, alle bygget på samme prinsipp — spør etter EKTE treff funnet
// ved faktisk websøk, aldri diktet opp (samme "grunnregel" som resten av appen):
//
//  1a. searchCivilianDroneNews / 1b. searchDefenseDroneNews — TO ATSKILTE søk
//      i stedet for ett bredt sveip. Testet live: ett enkelt sveip med kun en
//      "husk å dekke sivilt også"-instruks endte likevel opp 100% militært/
//      krigsrelatert (6/6 treff) — det globale nyhetsbildet (Ukraina-krigen)
//      overdøver enhver enkelt instruks om balanse. Løsningen er strukturell,
//      ikke enda en formulering: to helt separate kall med hvert sitt smale
//      tema garanterer en reell blanding, uansett hva som ellers er i nyhetsbildet.
//  2.  searchWebsiteSource     — ett bestemt nettsted (lagt inn som en
//      "sources"-rad med type='website', typisk fordi det ikke har RSS —
//      se add-sources.js) — nettstedbegrenset søk (site:domene).
//  3.  searchKeywordMentions   — ferske treff som nevner navngitte
//      operatør-/selskapsnavn (watch_keywords-tabellen), selv om selve
//      teksten ikke eksplisitt sier "drone".
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

Bruk websøk AKTIVT til å finne ekte, eksisterende artikler — GRUNNREGEL: dikt aldri opp en tittel, utgiver eller URL. Finner du ingen ekte treff som passer, returner en tom liste. En URL som ikke faktisk ble funnet ved søk skal ALDRI være med.

Skriv rene tekstfelt — ALDRI sett inn kildehenvisnings-/sitatlenker i formatet "([kilde](url))" eller "[kilde](url)" inni tittel/utgiver/kort_hvorfor_relevant. Selve funnet skal kun rapporteres via url-feltet.

Unngå åpenbare duplikater av samme hendelse fra flere nettsteder — velg den beste/mest opprinnelige kilden per hendelse.`;

// ---------- 1a. Sivilt/kommersielt sveip ----------

var CIVILIAN_SYSTEM = BASE_SYSTEM + `

Søk ETTER SIVIL/KOMMERSIELL/REGULATORISK dronebruk — IKKE krig, konflikt, militære angrep eller forsvarsmateriell. Prioriter norske kilder, men ta gjerne med sentrale internasjonale saker med tydelig relevans for norsk dronebransje.

Let aktivt etter: landbruksdroner, dronelevering/logistikk, film/foto/drone-video, kartlegging/inspeksjon/anleggsbransjen, droneracing/hobby/fritid, droneselskaper/oppstartsselskaper i Norge, droneregelverk for sivil bruk, luftfartstilsyn/sertifisering, droneutdanning/kurs, redningsaksjoner/viltredning med drone.

Maks 6 treff. IKKE ta med krigs-/konfliktrelaterte droneangrep eller ren forsvarsmaterielldekning her — det dekkes av et eget søk.`;

async function searchCivilianDroneNews(openaiKey, daysBack) {
  var days = daysBack || 3;
  var userPrompt = "Finn ekte, sivile/kommersielle drone-/UAS-relaterte nyhetssaker fra de siste " + days + " dagene.";
  return callSearch(openaiKey, CIVILIAN_SYSTEM, userPrompt);
}

// ---------- 1b. Forsvar/beredskap-sveip ----------

var DEFENSE_SYSTEM = BASE_SYSTEM + `

Søk ETTER forsvars-/beredskaps-/politirelatert dronebruk: motdrone/antidrone-teknologi, droneregelverk for forsvar/beredskap, norsk/europeisk forsvarsmateriell, droneøvelser, dronehendelser ved flyplasser/kritisk infrastruktur. Prioriter norske/nordiske/europeiske kilder.

Maks 4 treff. IKKE ta med generelle daglige krigsoppdateringer fra Ukraina/Midtøsten (droneangrep-etter-droneangrep) med mindre saken har en TYDELIG norsk/nordisk vinkling eller representerer en vesentlig ny teknologisk/strategisk utvikling — den daglige krigsrapporteringen dekkes allerede godt av andre medier og er sjelden noe Dronemagasinet selv publiserer om.`;

async function searchDefenseDroneNews(openaiKey, daysBack) {
  var days = daysBack || 3;
  var userPrompt = "Finn ekte, forsvars-/beredskapsrelaterte drone-/UAS-nyhetssaker fra de siste " + days + " dagene, med vekt på norsk/nordisk/europeisk relevans fremfor generell krigsrapportering.";
  return callSearch(openaiKey, DEFENSE_SYSTEM, userPrompt);
}

// ---------- 2. Ett bestemt nettsted (uten RSS) ----------

var WEBSITE_SYSTEM = BASE_SYSTEM + `

Du skal KUN se etter saker publisert på ETT bestemt nettsted, oppgitt av brukeren. Bruk søkeoperatøren site: mot akkurat det domenet. Ikke ta med treff fra andre nettsteder.`;

async function searchWebsiteSource(openaiKey, siteUrl, siteName, daysBack) {
  var days = daysBack || 3;
  var domain = String(siteUrl).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  var userPrompt = "Nettsted: " + (siteName || domain) + " (site:" + domain + ")\n" +
    "Finn ekte, drone-/UAS-relaterte artikler publisert på nøyaktig dette nettstedet de siste " + days + " dagene.";
  return callSearch(openaiKey, WEBSITE_SYSTEM, userPrompt);
}

// ---------- 3. Navngitte operatør-/selskapsnavn ----------

var KEYWORD_SYSTEM = BASE_SYSTEM + `

Du skal finne ferske nyhetsomtaler som nevner ett eller flere av de navngitte selskapene brukeren oppgir — SELV OM omtalen ikke eksplisitt nevner ordet "drone" (selskapet er allerede kjent som en droneoperatør/-aktør, så enhver reell nyhetsomtale av dem er potensielt interessant for redaksjonen). Ikke ta med generiske treningskurs-/rekrutteringsannonser eller åpenbart uinteressant selskapsomtale (f.eks. rene aksjekurs-/børsnoteringslister uten redaksjonelt innhold) — bruk skjønn.`;

async function searchKeywordMentions(openaiKey, keywords, daysBack) {
  var days = daysBack || 3;
  var userPrompt = "Registrerte droneoperatører/-selskaper å søke etter fersk omtale av: " + keywords.join(", ") + "\n" +
    "Finn ekte nyhetsomtaler av disse selskapene fra de siste " + days + " dagene.";
  return callSearch(openaiKey, KEYWORD_SYSTEM, userPrompt);
}

module.exports = {
  searchCivilianDroneNews, searchDefenseDroneNews, searchWebsiteSource, searchKeywordMentions,
  stripInlineCitations, SEARCH_MODEL
};
