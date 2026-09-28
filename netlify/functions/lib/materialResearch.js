// Dyp research rundt opplastet materiale (dokumenter/lenker): finner relevante
// EKSTERNE kilder på nettet som gjelder akkurat denne saken — primærkilder
// (regelverket dokumentet bygger på, myndighetens egen saksside), omtale og
// reaksjoner i nyhetsmedier/fagpresse, bakgrunnstall og tidligere dekning i
// Dronemagasinet/UAS Norway — slik at saken kan bygges videre enn det
// dokumentet alene sier.
//
// Samme grunnregel som resten av appen: søkemodellen dikter ALDRI opp en
// URL som blir stående. Hver funnet lenke HTTP-verifiseres, og selve
// kildeteksten hentes og gis til skribenten — som får kun bruke det som
// faktisk står i den hentede teksten (ikke modellens egen gjengivelse).

const { callSearchJson } = require("./webSearch.js");
const { verifyUrls } = require("./linkCheck.js");
const { fetchSourceArticle } = require("./manuscript.js");
const pdfParse = require("pdf-parse/lib/pdf-parse.js");

const MAX_SOURCES = 8;
const SOURCE_TEXT_CHARS = 3500;
const OWN_HOSTS = /(^|\.)(dronemag\.no|uasnorway\.no)$/i;

const FUNN_SCHEMA = {
  name: "eksterne_kilder",
  strict: true,
  schema: {
    type: "object", additionalProperties: false,
    properties: {
      funn: {
        type: "array", maxItems: MAX_SOURCES,
        items: {
          type: "object", additionalProperties: false,
          properties: {
            kilde_navn: { type: "string", description: "Avsender/medium, f.eks. «Luftfartstilsynet», «NRK», «Lovdata»." },
            tittel: { type: "string" },
            url: { type: "string", description: "Den ekte, faktisk funne URL-en. Aldri gjettet/konstruert." },
            type: { type: "string", enum: ["primaerkilde", "nyhetsomtale", "bakgrunn", "tidligere_dekning"] },
            hva_den_sier: { type: "string", description: "1–3 setninger: hva kilden faktisk sier som er relevant for saken. Trofast gjengivelse, ingen tolkning." },
            publisert: { type: ["string", "null"] }
          },
          required: ["kilde_navn", "tittel", "url", "type", "hva_den_sier", "publisert"]
        }
      }
    },
    required: ["funn"]
  }
};

const BASE = `Du er researcher for Dronemagasinet (dronemag.no) og UAS Norway, et norsk redaktørstyrt fagmedium om droner. Redaksjonen har fått et dokument (eller flere lenker) og skal skrive en sak. Du skal bruke WEBSØK AKTIVT og GRUNDIG — flere ulike søk med presise søkeord hentet fra dokumentets navn, referansenumre, tittel, involverte parter og temaer — for å finne EKSTERNE kilder som kan bygge saken videre.

KRAV:
- Kilden må handle om NØYAKTIG denne saken, dette forslaget/regelverket/prosjektet eller dets direkte forutsetninger — ikke bare et tilfeldig, lignende tema. Er du i tvil om det er samme sak: ta den ikke med.
- Foretrekk norske og nordiske kilder og offisielle kilder (myndigheter, Lovdata, regjeringen.no, EASA/EU-lovtekst) fremfor sekundære gjengivelser.
- Ikke ta med selve dokumentet redaksjonen allerede har.
- ALDRI dikt opp en URL, tittel eller innhold. En lenke som ikke faktisk ble funnet ved søk skal ikke være med. Finner du ingenting relevant, returner en tom liste — det er et fullt gyldig svar.
- hva_den_sier: trofast, konkret gjengivelse av det kilden faktisk sier (tall, datoer, bestemmelser) — ikke dine egne konklusjoner.
- Maks ${MAX_SOURCES} funn.`;

const PROMPT_PRIMAER = BASE + `

DIN OPPGAVE (runde 1 — primærkilder og bakgrunn): finn (a) regelverket, forskriften, EU-forordningen, rapporten eller vedtaket dokumentet bygger på eller endrer, (b) myndighetens/avsenderens egen saksside, høringsside eller pressemelding om saken, (c) tidligere versjoner, relaterte høringer eller vedtak, (d) relevante bakgrunnstall/statistikk fra offisielle kilder. Bruk type «primaerkilde» eller «bakgrunn».`;

const PROMPT_OMTALE = BASE + `

DIN OPPGAVE (runde 2 — omtale og tidligere dekning): finn (a) nyhetsomtale, reaksjoner og kommentarer fra norske/nordiske medier og fagpresse om akkurat denne saken (NRK, E24, Teknisk Ukeblad, Kommunal Rapport, Aftenposten, Elektro247, Byggeindustrien, DroneLife m.fl.), (b) uttalelser fra berørte parter (organisasjoner, bransjeforeninger, selskaper), (c) tidligere dekning i Dronemagasinet/UAS Norway om samme sak, selskap eller regelverk (søk med site:dronemag.no og site:uasnorway.no). Bruk type «nyhetsomtale» eller «tidligere_dekning».`;

function plainText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&sect;/g, "§")
    .replace(/\s+/g, " ").trim();
}

var STOPP = /^(og|som|for|det|den|til|med|av|på|en|et|er|har|skal|kan|vil|fra|om|ved|ikke|the|and|for|that|this|with|dette|disse|eller|også|mellom|under|over|etter|blir|ble|være)$/i;
function tokens(text) {
  var out = {};
  (String(text || "").toLowerCase().match(/[a-zæøå0-9§]{4,}/g) || []).forEach(function (w) { if (!STOPP.test(w)) out[w] = true; });
  return Object.keys(out);
}

// Velger de mest relevante utdragene fra en lang kildetekst i stedet for de
// første tegnene (som ofte er navigasjon/topptekst) — score = antall
// søketermer (fra saken og hva kilden ble funnet for) som finnes i vinduet.
function bestPassages(fullText, queryText, maxChars) {
  if (fullText.length <= maxChars) return fullText;
  var WIN = 1100, STEP = 550;
  var q = tokens(queryText);
  var windows = [];
  for (var i = 0; i < fullText.length; i += STEP) {
    var w = fullText.slice(i, i + WIN).toLowerCase();
    var score = 0;
    q.forEach(function (t) { if (w.indexOf(t) !== -1) score++; });
    windows.push({ start: i, score: score });
  }
  var chosen = windows.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, Math.max(1, Math.floor(maxChars / WIN)));
  chosen.sort(function (a, b) { return a.start - b.start; });
  var out = [], lastEnd = -1;
  chosen.forEach(function (c) {
    var start = Math.max(c.start, lastEnd);
    if (start >= c.start + WIN) return;
    out.push(fullText.slice(start, c.start + WIN));
    lastEnd = c.start + WIN;
  });
  return out.join(" […] ").slice(0, maxChars + 200);
}

const PROMPT_SAKSSIDE = BASE + `

DIN OPPGAVE (runde 3 — avsenderens egen saksside): finn den OFFISIELLE saksesiden, høringssiden eller pressemeldingen fra avsenderen (myndigheten/organisasjonen/selskapet) for AKKURAT dette dokumentet. Søk med dokumentets eksakte tittel, referansenummer/saksnummer, navnet på søker/avsender og ordet «høring»/«pressemelding», gjerne med site:-operatør mot avsenderens domene (f.eks. site:luftfartstilsynet.no, site:regjeringen.no, site:avinor.no, site:easa.europa.eu). Formålet er å få med opplysninger dokumentet selv ikke har: høringsfrist, hvem som kan svare og hvordan, saksnummer, kontaktperson, status/vedtak og eventuelle oppdateringer. Ta også med senere nyheter fra avsenderen om samme sak. Bruk type «primaerkilde» (avsenderens egen side) eller «nyhetsomtale».`;

// Henter kildens tekst (HTML-side eller PDF) og plukker de relevante utdragene.
async function readExternalSource(url, queryText) {
  try {
    var res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; UASNorwaySaksbank/1.0)" }, redirect: "follow" });
    if (!res.ok) return null;
    var ct = (res.headers.get("content-type") || "").toLowerCase();
    var full;
    if (ct.indexOf("pdf") !== -1 || /\.pdf(\?|$)/i.test(url)) {
      var buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 25 * 1024 * 1024) return null;
      full = ((await pdfParse(buf)).text || "").replace(/\s+/g, " ").trim();
    } else {
      full = plainText(await res.text()).slice(0, 400000);
    }
    if (!full || full.length < 200) return null;
    return bestPassages(full, queryText || "", SOURCE_TEXT_CHARS);
  } catch (err) {
    return null;
  }
}

// opts: { materialUtdrag, beskrivelse, dokumentNavn[], lenker[] }
// Returnerer { kilder: [{ nr, kilde_navn, tittel, url, type, hva_den_sier, publisert, tekst, fulltekst }], antallFunnet, antallVerifisert, feil }
async function deepResearch(openaiKey, opts) {
  var userPrompt =
    "REDAKSJONENS FORKLARING AV SAKEN:\n" + opts.beskrivelse + "\n\n" +
    (opts.dokumentNavn && opts.dokumentNavn.length ? "DOKUMENTER: " + opts.dokumentNavn.join(", ") + "\n" : "") +
    (opts.lenker && opts.lenker.length ? "LENKER REDAKSJONEN HAR GITT: " + opts.lenker.join(", ") + "\n" : "") +
    "\nUTDRAG AV MATERIALET (bruk navn, referansenumre, parter og temaer herfra som søkeord):\n" + opts.materialUtdrag;

  var funn = [];
  var feil = [];
  var prompts = [PROMPT_SAKSSIDE, PROMPT_PRIMAER, PROMPT_OMTALE];
  for (var i = 0; i < prompts.length; i++) {
    try {
      var res = await callSearchJson(openaiKey, prompts[i], userPrompt, FUNN_SCHEMA);
      funn = funn.concat(res.funn || []);
    } catch (err) {
      feil.push("Søkerunde " + (i + 1) + " feilet: " + err.message);
    }
  }

  // Dedupliser på URL (uten fragment/sporingsparametere) og fjern ugyldige.
  var seen = {};
  var unike = [];
  funn.forEach(function (f) {
    if (!f.url || !/^https?:\/\//i.test(f.url)) return;
    var key = f.url.replace(/#.*$/, "").replace(/[?&]utm_[^&]+/g, "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    f.url = f.url.replace(/[?&]utm_[^&]+/g, "");
    unike.push(f);
  });

  // Fjern lenker redaksjonen selv har oppgitt — de er allerede kilder.
  var gitt = {};
  (opts.lenker || []).forEach(function (u) { gitt[u.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase()] = true; });
  unike = unike.filter(function (f) { return !gitt[f.url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase()]; });

  var checks = await verifyUrls(unike.map(function (f) { return f.url; }));
  var verifisert = unike.filter(function (f) { return checks[f.url] && checks[f.url].ok; });

  // Primærkilder først, deretter omtale/bakgrunn/tidligere dekning.
  var rank = { primaerkilde: 0, bakgrunn: 1, nyhetsomtale: 2, tidligere_dekning: 3 };
  verifisert.sort(function (a, b) { return (rank[a.type] || 9) - (rank[b.type] || 9); });
  verifisert = verifisert.slice(0, MAX_SOURCES);

  var kilder = await Promise.all(verifisert.map(async function (f) {
    var tekst = await readExternalSource(f.url, f.hva_den_sier + " " + f.tittel + " " + opts.beskrivelse);
    return Object.assign({}, f, { tekst: tekst || "", fulltekst: !!tekst });
  }));
  kilder.forEach(function (k, idx) { k.nr = idx + 1; });

  return { kilder: kilder, antallFunnet: unike.length, antallVerifisert: verifisert.length, feil: feil };
}

module.exports = { deepResearch, readExternalSource, OWN_HOSTS };
