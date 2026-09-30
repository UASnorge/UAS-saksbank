// Delt kjernelogikk for AI-generert manus. Brukt av generate-manuscript-background.js
// (kalt fra "Generer manus"-knappen) og assistant-chat.js (kalt som verktøy
// av AI-assistenten) — samme, allerede testede logikk.
//
// VIKTIG, etter redaksjonell tilbakemelding: dette skal være faktisk
// redaksjonelt arbeid, ikke bare en omskriving av én artikkel — og saker som
// er «litt korte» med for tynt websøk er ikke godt nok. Flyten er derfor delt:
//  1. DYP RESEARCH (lib/materialResearch.js, gpt-5-search-api, tre runder):
//     avsenderens egen side, primærkilder/regelverk/bakgrunn, omtale og
//     tidligere dekning i Dronemagasinet/UAS Norway. Hver lenke HTTP-verifiseres
//     og kildens faktiske tekst hentes.
//  2. SKRIVING (gpt-5.5, ingen søk): bygger saken på kildeartikkelen + de
//     verifiserte utdragene, i redaksjonens skrivestil (lib/styleGuide.js).
// Grunnregel som ellers i appen: AI-en dikter ALDRI opp en URL — skribenten
// refererer kun til kilder med E-nummer, og URL-ene i kildelisten og i lenker
// til egne saker kommer alltid fra det verifiserte researchgrunnlaget.

const { Document, Packer, Paragraph, TextRun, ImageRun, ExternalHyperlink } = require("docx");
const { STYLE_PRINCIPLES, fetchDronemagExamples, styleExamplesBlock, polishManuscript, todayLine, hostCredit, cleanCredit, norwegianCaptions, AI_DISCLOSURE_PARAGRAPHS } = require("./styleGuide.js");
const { pickArticleImages } = require("./articleImages.js");
const { classifyImage } = require("./imageCheck.js");

const MODEL = "gpt-5.5"; // brukt av lib/reviseManuscript.js (rask tekstrevidering, ikke ny research)
const MAX_SOURCE_CHARS = 6000;

const HOUSE_STYLE = `Du er journalist i Dronemagasinet (dronemag.no), medlem av Fagpressen og underlagt Redaktørplakaten.
Skriv nøktern, faktabasert norsk fagjournalistikk — kort ingress (1-3 setninger), så brødtekst i korte,
konkrete avsnitt. Bruk aktiv form, unngå synsing. Oppgi alltid hvor informasjon kommer fra når det er naturlig
(f.eks. "ifølge X" eller "skriver Y"). Basér deg UTELUKKENDE på fakta som faktisk står i kildeteksten du får
oppgitt under — finn ALDRI på detaljer, tall, sitater eller navn som ikke står der. Er noe uklart eller mangler
i kildeteksten, skriv det tydelig i feltet "usikkerhetsnotat" i stedet for å gjette i selve teksten.
Fet skrift ("**tekst**") kun unntaksvis for noe genuint viktig — aldri som standard virkemiddel i vanlige avsnitt.

${STYLE_PRINCIPLES}`;

// Systemprompt for selve FØRSTEUTKASTET (lenke-basert). Skriveren søker IKKE
// selv — websøket er gjort i forkant av lib/materialResearch.js (tre runder,
// HTTP-verifiserte kilder, faktisk kildetekst), og resultatet gis hit som
// nummererte kilder (E1, E2 …). Dette skiller research (søkemodell) fra
// skriving (tekstmodell) og ga vesentlig grundigere saker enn ett samlet
// søkekall der modellen både skulle lete og skrive.
const WRITER_SYSTEM_PROMPT = `Du er journalist i Dronemagasinet (dronemag.no), medlem av Fagpressen og underlagt Redaktørplakaten. Du har fått en kildeartikkel om en sak redaksjonen skal skrive om, og et verifisert RESEARCH-GRUNNLAG: nummererte eksterne kilder (E1, E2 …) med utdrag av kildenes egen tekst. Kilder merket EGEN er tidligere saker fra Dronemagasinet/UAS Norway. Din jobb er IKKE å omskrive kildeartikkelen — det er å bygge en gjennomarbeidet, dokumentert sak som går videre enn kilden, med bakgrunn, regelverk, tall og norsk relevans hentet fra research-grunnlaget.

1. IDENTIFISER KILDEN KORREKT OG NAVNGI DEN I PROSA — OBLIGATORISK. Du får navnet på kildemediet (f.eks. «NRK») — dette ER kildeartikkelen saken bygger på. Selv om research-grunnlaget gir bedre primærkilder, ERSTATTER det aldri plikten til å navngi kildemediet for det som faktisk kommer derfra. Krav:
   - Kildemediet navngis i PROSA i første eller andre avsnitt (f.eks. «NRK skriver at …», «Det kommer frem i en sak fra NRK …») og gjentas med varierte formuleringer der det er naturlig.
   - Inneholder saken en sitatblokk (prefiks "> "), skal den ALLTID avsluttes med «– navn, rolle, til [nøyaktig kildemedium]» — ALDRI «til Dronemagasinet», og aldri uten navngitt kildemedium der sitatet kommer fra kildeartikkelen.
   - La ALDRI et sitat et annet medium har innhentet fremstå som om Dronemagasinet selv har intervjuet personen.

2. LENKER I TEKSTEN: sett ALDRI inn klikkbare lenker, URL-er eller fotnoter i brødteksten — med ÉN ufravikelig unntak: når du viser til en tidligere sak fra Dronemagasinet/UAS Norway (kilder merket EGEN), skal du skrive en markdown-lenke [lenketekst](URL) med NØYAKTIG den URL-en du har fått oppgitt, og kildehenvise i prosa («som Dronemagasinet skrev 18. september», «Dronemagasinet har tidligere omtalt saken»). HVER henvisning til en tidligere sak skal ha sin lenke — også «i 2021 skrev Dronemagasinet …» og «allerede i 2019 fortalte politiet til Dronemagasinet …». Henviser du til en tidligere sak du ikke har URL til, skal du la være å henvise til den. Alle andre kilder (NRK, myndigheter, Lovdata osv.) navngis KUN i prosa («ifølge forskriften § 20», «skriver Luftfartstilsynet») — ingen lenke.

3. BRUK RESEARCH-GRUNNLAGET AKTIVT OG DYPT. Les utdragene og bruk det de faktisk sier: primærkilden/vedtaket/lovteksten bak saken, bakgrunn og forhistorie, tall, reaksjoner og motstridende syn, og — når saken gjelder utlandet — hva reglene er i Norge (kun når en kilde i grunnlaget sier det). Bruk KUN det utdragene faktisk sier, og KUN når kilden gjelder samme sak. Utdrag merket «kunne ikke lese fulltekst» er ikke grunnlag for fakta. Motsier en nyere/bedre kilde kildeartikkelen, si det åpent i teksten.

4. EGET ARKIV: kilder merket EGEN er funnet automatisk ved søk i Dronemagasinets/UAS Norways arkiv på nøkkelord, og kan i blant være uten reell relevans. Handler en av dem om samme sak, selskap eller tema — bruk den som forhistorie («hva har vi skrevet før?») og forklar HVA SOM ER NYTT nå, og LENK til den etter regel 2. Finnes det en EGEN kilde som handler om NØYAKTIG samme sak eller samme selskap/prosjekt (samme navn går igjen i tittelen), SKAL saken vise til den med lenke minst én gang. Handler den om noe annet, ignorer den.

5. IKKE GJETT — MARKÉR USIKKERHET. Er noe uklart (om noe er operativt eller under innføring, hvem som var «først», motstridende tall), skriv det rett ut i brødteksten («det er ikke bekreftet at …») — presenter det ALDRI som bekreftet. Unngå kategoriske formuleringer («først i Norge», «tatt i bruk») med mindre en primærkilde bekrefter det presist.

6. STRUKTUR. hovedtekst_avsnitt er en ordnet liste der: et vanlig avsnitt er bare teksten; en mellomtittel er eget listeelement med prefiks "## " (2–4 i en middels lang sak, aldri i en veldig kort); et direkte sitat med god kildeverdi er eget listeelement med prefiks "> " i formatet '> «sitatet» – navn, rolle, til Kilde' (kun når kilden faktisk inneholder sitatet — dikt aldri opp et sitat). Fet skrift ("**tekst**") UNNTAKSVIS.

7. BILDE. alt_tekst_bilde er en kort, konkret BILDETEKST på NORSK (bokmål) — også når kilden er svensk/engelsk: oversett. Beskriv kun det saken/kilden faktisk sier bildet viser; er bildet et generisk arkiv- eller produsentbilde som ikke viser den konkrete situasjonen, sett bilde_er_illustrasjon til true og skriv en nøktern, generisk bildetekst.

8. KILDER BRUKT. brukte_eksterne lister NUMRENE (E-nummer) til de eksterne kildene du faktisk har brukt i teksten — ikke flere. Kildeartikkelen selv legges til automatisk.

9. KONTROLLPUNKTER. Konkrete, SAKSSPESIFIKKE åpne spørsmål redaksjonen bør avklare før publisering (ikke generiske floskler) — inkluder relevante påminnelser der de er aktuelle (presis tittel, sitatpraksis, bildebruk/kreditering, om en kommentar fra en relevant part bør innhentes).

GRUNNREGEL: skriv ALDRI noe som om det er bekreftet uten at det står i kildeartikkelen eller i et research-utdrag. Er noe usikkert, si det — ikke fyll hull med antakelser.

${STYLE_PRINCIPLES}

(Skrivestilen gjelder språket og oppbyggingen. Reglene om kildenavngivning, sitatattribusjon, lenker til egne saker og ærlighet om usikkerhet går alltid foran.)`;

const WRITER_SCHEMA = {
  name: "manus_skriving",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      emnefelt: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, description: "1-3 korte emneord/kategori-tagger, med store bokstaver, f.eks. FORSVAR, C-UAS." },
      tittel: { type: "string" },
      titler_alternativer: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2, description: "To alternative titler ved siden av den anbefalte." },
      ingress: { type: "string" },
      hovedtekst_avsnitt: {
        type: "array", minItems: 1, items: { type: "string" },
        description: "Ordnet avsnittsliste. Mellomtittel: '## Tittel'. Sitatblokk: '> «sitat» – navn, rolle, til Kilde'. Lenke til egen sak: [tekst](URL). Alt annet: vanlig brødtekstavsnitt."
      },
      alt_tekst_bilde: { type: "string", description: "Bildetekst på norsk." },
      bilde_er_illustrasjon: { type: "boolean", description: "true hvis bildet er et generisk produsent-/arkivbilde som IKKE er bekreftet å vise den faktiske situasjonen." },
      brukte_eksterne: { type: "array", items: { type: "integer" }, description: "E-numrene til eksterne kilder faktisk brukt i teksten." },
      kontrollpunkter: { type: "array", minItems: 1, items: { type: "string" }, description: "Konkrete, saksspesifikke åpne spørsmål/ting som bør avklares før publisering." },
      usikkerhetsnotat: { type: ["string", "null"] }
    },
    required: ["emnefelt", "tittel", "titler_alternativer", "ingress", "hovedtekst_avsnitt", "alt_tekst_bilde",
      "bilde_er_illustrasjon", "brukte_eksterne", "kontrollpunkter", "usikkerhetsnotat"]
  }
};

// Bygger researchgrunnlaget som tekstblokk til skriveprompten, og gjør det
// om til ferdige felt (kilder_brukt, tidligere_dekning) fra de faktiske,
// verifiserte URL-ene — modellen får aldri skrive URL-er selv (kun
// E-numre), så en oppdiktet lenke kan ikke ende i kildelisten.
function researchBlock(research) {
  if (!research || !research.kilder.length) return "RESEARCH-GRUNNLAG: (søket fant ingen verifiserte eksterne kilder — hold deg til kildeartikkelen, og si det i kontrollpunkter.)";
  return "RESEARCH-GRUNNLAG (verifiserte kilder funnet ved websøk; utdragene er kildenes egen tekst):\n\n" +
    research.kilder.map(function (k) {
      return "[E" + k.nr + (k.egen ? " — EGEN (Dronemagasinet/UAS Norway)" : "") + ": " + k.kilde_navn + " — " + k.tittel + " (" + k.type + ")" + (k.egen ? " URL: " + k.url : "") + "]\n" +
        (k.tekst ? "UTDRAG: " + k.tekst : "(kunne ikke lese fulltekst — ikke bruk denne til fakta)");
    }).join("\n\n");
}

function applyResearchToFields(fields, research) {
  var used = (fields.brukte_eksterne || []).map(function (nr) {
    return (research && research.kilder || []).filter(function (k) { return k.nr === nr; })[0];
  }).filter(Boolean);
  var typeNavn = { primaerkilde: "Primærkilde", nyhetsomtale: "Omtale", bakgrunn: "Bakgrunn", tidligere_dekning: "Dronemagasinet — tidligere dekning" };
  fields.kilder_brukt = used.map(function (k) {
    return { navn: typeNavn[k.type] ? typeNavn[k.type] + (k.egen ? "" : " — " + k.kilde_navn) : k.kilde_navn, tittel: k.tittel, url: k.url, url_virker: true };
  });
  var egen = used.filter(function (k) { return k.egen; })[0];
  fields.tidligere_dekning = egen ? { tittel: egen.tittel, url: egen.url } : null;
  return fields;
}

// Dekoder både navngitte HTML-entiteter (&amp; &#39; osv.) OG numeriske
// (&#39; &#x27; osv., desimal og heksadesimal) — stripHtml dekket tidligere
// kun &#39;, ikke &#039; (nullpadded) eller andre tegn, noe som viste seg i
// praksis (en apostrof i en ekte artikkeltittel kom gjennom som &#039;).
var NAMED_ENTITIES = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCodePoint(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function (_, dec) { return String.fromCodePoint(parseInt(dec, 10)); })
    .replace(/&([a-z]+);/gi, function (m, name) { return NAMED_ENTITIES[name.toLowerCase()] || m; });
}

function stripHtml(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractMeta(html, prop) {
  var re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', "i");
  var m = html.match(re) || html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + prop + '["\']', "i"));
  return m ? m[1] : null;
}

function extractTitle(html) {
  var og = extractMeta(html, "og:title");
  if (og) return decodeHtmlEntities(og).trim();
  var m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? decodeHtmlEntities(m[1]).trim() : null;
}

// Domenenavn → mediets vanlige navn i løpende tekst («www.elektro247.no» →
// «Elektro247», «nrk.no» → «NRK»). Brukes kun når siden ikke oppgir
// og:site_name selv.
var KJENTE_MEDIER = { nrk: "NRK", e24: "E24", vg: "VG", dn: "DN", tu: "Teknisk Ukeblad", tv2: "TV 2", dronemag: "Dronemagasinet",
  aftenposten: "Aftenposten", kommunal: "Kommunal Rapport", ntb: "NTB", bt: "BT", adressa: "Adresseavisen", nettavisen: "Nettavisen", dronelife: "DroneLife" };
function humanizeSiteName(host) {
  var base = String(host || "").replace(/^www\./i, "").split(".")[0].toLowerCase();
  if (!base) return host;
  if (KJENTE_MEDIER[base]) return KJENTE_MEDIER[base];
  if (base.length <= 3) return base.toUpperCase();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

async function fetchSourceArticle(url) {
  try {
    var res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; UASNorwaySaksbank/1.0)" } });
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
    var html = await res.text();
    var ogImage = extractMeta(html, "og:image");
    var siteName = extractMeta(html, "og:site_name");
    if (siteName) siteName = decodeHtmlEntities(siteName).trim();
    var title = extractTitle(html);
    var text = stripHtml(html).slice(0, MAX_SOURCE_CHARS);
    return { ok: true, text: text, imageUrl: ogImage, siteName: siteName || humanizeSiteName(new URL(url).hostname), title: title, html: html };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function fetchImage(url) {
  try {
    var res = await fetch(url);
    if (!res.ok) return null;
    var contentType = res.headers.get("content-type") || "";
    var type = contentType.indexOf("png") !== -1 ? "png" : (contentType.indexOf("jpeg") !== -1 || contentType.indexOf("jpg") !== -1) ? "jpg" : null;
    if (!type) return null;
    var buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return null;
    var dims = sniffImageDimensions(buf, type) || { width: 900, height: 550 };
    return { buffer: buf, type: type, width: dims.width, height: dims.height };
  } catch (err) {
    return null;
  }
}

function sniffImageDimensions(buf, type) {
  try {
    if (type === "png" && buf.length > 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (type === "jpg") {
      var i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        var marker = buf[i + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        var segLen = buf.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
    }
  } catch (err) {}
  return null;
}

function scaleToMaxWidth(w, h, maxW) {
  if (w <= maxW) return { width: w, height: h };
  var ratio = maxW / w;
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

async function callOpenAI(apiKey, model, systemPrompt, userPrompt, schema) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model: model,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      response_format: { type: "json_schema", json_schema: schema }
    })
  });
  if (!res.ok) throw new Error("OpenAI-feil (" + res.status + "): " + (await res.text()).slice(0, 300));
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// Tolker "## "/"> "-prefiks i et avsnitt til riktig docx-formatering.
// Hard sperre, uavhengig av hvor godt promptet følges: gpt-5-search-api
// setter ofte selv inn markdown-siteringer midt i løpende tekst (f.eks.
// "... ([dronemag.no](https://dronemag.no/...))") som en del av sin egen
// grunngivning — dette er forskningsverktøy-støy, ikke ferdig redigert
// journalistikk, og kan i tillegg feilaktig gi inntrykk av at Dronemagasinet
// er kilden til noe som egentlig kommer fra kildeartikkelen (se punkt 1 i
// WRITER_SYSTEM_PROMPT). Fjernes derfor alltid server-side, uansett om
// promptet ble fulgt eller ikke — ekte kildehenvisning skal kun stå i
// kilder_brukt-listen og i selve prosaen ("ifølge NRK"), aldri som en
// klikkbar lenke inni en artikkel-setning.
// Lenker til VÅRE egne saker (dronemag.no/uasnorway.no) er ønsket i teksten —
// redaksjonelt krav: en henvisning til en tidligere sak skal ha direkte URL.
// Alle andre markdown-lenker er søkemodell-støy og fjernes.
var OWN_HOST_RE = /^(www\.)?(dronemag\.no|uasnorway\.no)$/i;
function isOwnUrl(u) {
  try { return OWN_HOST_RE.test(new URL(u).hostname); } catch (e) { return false; }
}
function stripInlineCitations(text) {
  return String(text || "")
    .replace(/\s*\(\[[^\]]*\]\(https?:\/\/[^\s)]+\)\)/g, "")
    .replace(/(\s*)\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, function (m, sp, label, url) { return isOwnUrl(url) ? m : sp + label; })
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

// Hard sperre: en markdown-lenke i teksten må peke på en egen sak som faktisk
// står i det verifiserte researchgrunnlaget — ellers fjernes selve lenken
// (lenketeksten beholdes). Modellen skal aldri kunne skrive en oppdiktet URL
// inn i en publisert tekst.
function restrictLinksToKnown(fields, research) {
  var allowed = {};
  ((research && research.kilder) || []).forEach(function (k) { if (k.egen) allowed[k.url] = true; });
  fields.hovedtekst_avsnitt = (fields.hovedtekst_avsnitt || []).map(function (p) {
    if (/^!\[/.test(p)) return p;
    return p.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (m, label, url) { return allowed[url] ? m : label; });
  });
  return fields;
}

// Redaksjonelt krav: HVER henvisning til en tidligere sak fra Dronemagasinet/
// UAS Norway skal ha direkte lenke. Skribenten glemmer av og til lenken på
// «i 2021 skrev Dronemagasinet …»-henvisninger. Denne kontrollen finner
// avsnitt som henviser til egen tidligere dekning uten lenke og ber en liten
// modell KUN legge til lenke på de aktuelle ordene — med URL-er fra det
// verifiserte grunnlaget. Resultatet godkjennes bare hvis teksten er
// tegn-for-tegn lik originalen bortsett fra de tilføyde lenkene.
var EGEN_HENVISNING_RE = /(Dronemagasinet|UAS Norway)[^.]{0,60}(skrev|omtalte|omtaler|meldte|fortalte|rapporterte|har tidligere|tidligere omtalt|har skrevet|dekket)|(skrev|omtalte|meldte|rapporterte|fortalte)[^.]{0,40}(Dronemagasinet|UAS Norway)|tidligere dekning/i;
async function ensureOwnLinks(openaiKey, fields, research) {
  try {
    var egne = ((research && research.kilder) || []).filter(function (k) { return k.egen; });
    if (!egne.length) return fields;
    var paras = fields.hovedtekst_avsnitt || [];
    var needs = [];
    paras.forEach(function (p, i) {
      if (/^(## |> |!\[)/.test(p)) return;
      if (EGEN_HENVISNING_RE.test(p) && !/\]\(https?:\/\//.test(p)) needs.push(i);
    });
    if (!needs.length) return fields;

    var res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + openaiKey },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: "Du legger inn lenker i norsk nyhetstekst. Du får avsnitt (med indeks) som henviser til tidligere saker fra Dronemagasinet/UAS Norway, og en liste over våre egne tidligere saker (tittel, URL, utdrag). For hvert avsnitt: finn hvilken av sakene i listen avsnittet henviser til, og pakk INN de ordene som beskriver henvisningen i en markdown-lenke [ord](URL) med NØYAKTIG den URL-en fra listen. Endre ELLERS ikke en eneste bokstav i avsnittet. Henviser avsnittet til en tidligere sak som IKKE finnes i listen, eller er du usikker på hvilken det er, returner avsnittet helt uendret. Bruk aldri en URL som ikke står i listen." },
          { role: "user", content: JSON.stringify({ egne_saker: egne.map(function (k) { return { tittel: k.tittel, url: k.url, publisert: k.publisert || null, utdrag: (k.tekst || "").slice(0, 300) }; }), avsnitt: needs.map(function (i) { return { indeks: i, tekst: paras[i] }; }) }) }
        ],
        response_format: { type: "json_schema", json_schema: { name: "lenker", strict: true, schema: { type: "object", additionalProperties: false, properties: { avsnitt: { type: "array", items: { type: "object", additionalProperties: false, properties: { indeks: { type: "integer" }, tekst: { type: "string" } }, required: ["indeks", "tekst"] } } }, required: ["avsnitt"] } } }
      })
    });
    if (!res.ok) return fields;
    var out = JSON.parse((await res.json()).choices[0].message.content).avsnitt || [];
    var allowed = {};
    egne.forEach(function (k) { allowed[k.url] = true; });
    var copy = paras.slice();
    out.forEach(function (o) {
      if (needs.indexOf(o.indeks) === -1) return;
      var orig = paras[o.indeks];
      var stripped = String(o.tekst).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1");
      var urls = (String(o.tekst).match(/\]\((https?:\/\/[^\s)]+)\)/g) || []).map(function (u) { return u.slice(2, -1); });
      if (stripped === orig && urls.every(function (u) { return allowed[u]; })) copy[o.indeks] = o.tekst;
    });
    fields.hovedtekst_avsnitt = copy;
    return fields;
  } catch (err) {
    return fields;
  }
}

// Fremdriftslinje i sakens historikk (vises live i verktøyet).
async function logProgress(supabase, caseId, text) {
  try {
    var cur = await supabase.from("cases").select("historikk").eq("id", caseId).maybeSingle();
    await supabase.from("cases").update({ historikk: [{ ts: new Date().toISOString(), text: text }].concat((cur.data && cur.data.historikk) || []) }).eq("id", caseId);
  } catch (e) {}
}

function stripCitationsFromFields(fields) {
  fields.tittel = stripInlineCitations(fields.tittel);
  fields.ingress = stripInlineCitations(fields.ingress);
  fields.hovedtekst_avsnitt = (fields.hovedtekst_avsnitt || []).map(function (p) {
    // Bildemarkører («![bildetekst](URL)») er bevisst lenker og skal aldri renses bort.
    if (/^!\[[^\]]*\]\(https?:\/\/[^\s)]+\)$/.test(p)) return p;
    // "## "/"> "-prefiks må bevares, selve teksten etter dem renses.
    var prefix = p.indexOf("## ") === 0 ? "## " : p.indexOf("> ") === 0 ? "> " : "";
    var rest = prefix ? p.slice(prefix.length) : p;
    return prefix + stripInlineCitations(rest);
  }).filter(function (p) { return p.replace(/^(##|>)\s*/, "").trim().length > 0; });
  return fields;
}

// To ekstra sperrer, uavhengig av hvor godt promptet følges — testing viste
// at modellen av og til (a) rett og slett utelot selve kildeartikkelen fra
// kilder_brukt (fordi den fant "bedre" primærkilder underveis), og (b)
// leverte en sitatblokk uten kildemedium i attribusjonen. Begge rettes her,
// deterministisk, i stedet for å stole på at prompt-instruksen alltid følges.
function ensureOriginalSourceListed(fields, sourceUrl, siteName, caseTitle) {
  if (!sourceUrl) return fields;
  var alreadyListed = (fields.kilder_brukt || []).some(function (k) { return k.url === sourceUrl; });
  if (!alreadyListed) {
    fields.kilder_brukt = [{ navn: siteName || "Kildeartikkel", tittel: caseTitle || siteName || "Kildeartikkel", url: sourceUrl }]
      .concat(fields.kilder_brukt || []);
  }
  return fields;
}

function ensureQuoteAttribution(fields, siteName) {
  if (!siteName) return fields;
  fields.hovedtekst_avsnitt = (fields.hovedtekst_avsnitt || []).map(function (p) {
    if (p.indexOf("> ") !== 0) return p;
    var hasMedium = p.toLowerCase().indexOf(siteName.toLowerCase()) !== -1;
    if (hasMedium) return p;
    return p + " – til " + siteName;
  });
  return fields;
}

// Bildemarkør — vanlig Markdown-bildesyntaks, "![alt-tekst](url)" — brukt for
// EKSTRA bilder midt i en sak (utover selve hovedbildet), f.eks. funnet i et
// opplastet manus som allerede hadde bilder plassert i brødteksten (se
// lib/importManuscript.js). Samme prinsipp som "## "/"> ": et helt
// avsnitts-listeelement, tolket likt av både docx-bygging (her) og
// WordPress-publisering (lib/wordpress.js).
var IMAGE_MARKER_RE = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/;
function parseImageMarker(text) {
  var m = String(text || "").match(IMAGE_MARKER_RE);
  return m ? { alt: m[1], url: m[2] } : null;
}

// Tolker "**fet tekst**" (markdown-stil, som AI-en av og til bruker for å
// fremheve noe) til ekte fete TextRun-er i .docx-en, i stedet for at
// stjernetegnene vises bokstavelig — samme rettelse som gjort i
// lib/wordpress.js (duplisert, ikke importert — de to lib-modulene er
// ellers uavhengige av hverandre).
function textRunsFromMarkdownBold(text) {
  var s = String(text);
  var runs = [];
  var re = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  var last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) runs.push(new TextRun({ text: s.slice(last, m.index) }));
    if (m[1] !== undefined) runs.push(new TextRun({ text: m[1], bold: true }));
    else runs.push(new ExternalHyperlink({ link: m[3], children: [new TextRun({ text: m[2], color: "0563C1", underline: {} })] }));
    last = re.lastIndex;
  }
  if (last < s.length) runs.push(new TextRun({ text: s.slice(last) }));
  return runs.length ? runs : [new TextRun({ text: "" })];
}

// Returnerer en LISTE med paragrafer (et vanlig avsnitt blir én, et bilde kan
// bli to — selve bildet og en bildetekst). Async fordi et bildemarkør-avsnitt
// må hente bildet før det kan legges inn i dokumentet.
async function paragraphsFromMarkedText(text) {
  if (text.indexOf("## ") === 0) {
    return [new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: text.slice(3), bold: true, size: 26 })] })];
  }
  if (text.indexOf("> ") === 0) {
    return [new Paragraph({ indent: { left: 400 }, children: [new TextRun({ text: text.slice(2), italics: true })] })];
  }
  var imgMarker = parseImageMarker(text);
  if (imgMarker) {
    var img = await fetchImage(imgMarker.url);
    if (img) {
      var size = scaleToMaxWidth(img.width, img.height, 600);
      var out = [new Paragraph({ alignment: "center", children: [new ImageRun({ type: img.type, data: img.buffer, transformation: size })] })];
      if (imgMarker.alt) out.push(new Paragraph({ alignment: "center", children: [new TextRun({ text: imgMarker.alt, italics: true, size: 18 })] }));
      return out;
    }
    return [new Paragraph({ children: [new TextRun({ text: "(Bilde ikke funnet automatisk: " + imgMarker.url + (imgMarker.alt ? " — " + imgMarker.alt : "") + ")", italics: true })] })];
  }
  return [new Paragraph({ children: textRunsFromMarkdownBold(text) })];
}

async function buildDocxParagraphs(fields, image) {
  var paras = [];
  function field(label, value) {
    paras.push(new Paragraph({ children: [
      new TextRun({ text: label + ": ", bold: true }),
      new TextRun({ text: value || "" })
    ] }));
  }
  function heading(text) {
    paras.push(new Paragraph({ spacing: { before: 300, after: 100 }, children: [new TextRun({ text: text, bold: true, size: 24 })] }));
  }

  if (fields.emnefelt && fields.emnefelt.length) field("EMNEFELT", fields.emnefelt.join(" | "));
  field("TITTEL", fields.tittel);
  paras.push(new Paragraph({ children: [new TextRun({ text: "BILDE:", bold: true })] }));
  if (image) {
    var size = scaleToMaxWidth(image.width, image.height, 900);
    paras.push(new Paragraph({ children: [new ImageRun({ type: image.type, data: image.buffer, transformation: size })] }));
  } else {
    paras.push(new Paragraph({ children: [new TextRun({ text: "(Ikke funnet automatisk — sett inn manuelt før opplasting)", italics: true })] }));
  }
  var altTekst = fields.alt_tekst_bilde || "";
  if (fields.bilde_er_illustrasjon) altTekst = (altTekst ? altTekst + " " : "") + "(Illustrasjonsfoto — ikke bekreftet å vise den faktiske situasjonen saken omtaler.)";
  field("ALT-TEKST BILDE", altTekst);
  field("FOTO", fields.fotoKreditering);
  field("INGRESS", fields.ingress);

  paras.push(new Paragraph({ children: [new TextRun({ text: "HOVEDTEKST:", bold: true })] }));
  // KI-merknad legges alltid til sist i selve brødteksten (ikke i det
  // interne kontrollavsnittet under) — redaksjonelt krav, skal med i det
  // som faktisk publiseres. Se lib/styleGuide.js for hvorfor den holdes
  // utenfor fields.hovedtekst_avsnitt (aldri noe AI-en selv kan omskrive).
  var hovedtekstMedKiMerknad = fields.hovedtekst_avsnitt.concat(AI_DISCLOSURE_PARAGRAPHS);
  for (var i = 0; i < hovedtekstMedKiMerknad.length; i++) {
    var resolved = await paragraphsFromMarkedText(hovedtekstMedKiMerknad[i]);
    resolved.forEach(function (p) { paras.push(p); });
    if (i < hovedtekstMedKiMerknad.length - 1) paras.push(new Paragraph({ children: [] }));
  }

  if (fields.tidligere_dekning) {
    paras.push(new Paragraph({ children: [] }));
    paras.push(new Paragraph({ children: [
      new TextRun({ text: "TIDLIGERE DEKNING: ", bold: true }),
      new TextRun({ text: fields.tidligere_dekning.tittel + " — " + fields.tidligere_dekning.url })
    ] }));
  }

  if (fields.titler_alternativer && fields.titler_alternativer.length) {
    heading("Forslag til titler");
    field("Anbefalt", fields.tittel);
    fields.titler_alternativer.forEach(function (t) { field("Alternativ", t); });
  }

  if (fields.kilder_brukt && fields.kilder_brukt.length) {
    heading("Kilder brukt i dette arbeidsutkastet");
    fields.kilder_brukt.forEach(function (k) {
      paras.push(new Paragraph({ children: [
        new TextRun({ text: k.navn + ": ", bold: true }),
        new TextRun({ text: k.tittel + " — " + k.url + (k.url_virker === false ? "  ⚠️ lenke kunne ikke bekreftes" : "") })
      ] }));
    });
  }

  if (fields.kontrollpunkter && fields.kontrollpunkter.length) {
    paras.push(new Paragraph({ children: [] }));
    paras.push(new Paragraph({ spacing: { before: 300, after: 100 }, children: [
      new TextRun({ text: "⚠️ INTERNT — FJERNES FØR PUBLISERING", bold: true, size: 26 })
    ] }));
    paras.push(new Paragraph({ children: [new TextRun({ text: "Redaksjonell kontroll og oppfølging:", bold: true })] }));
    fields.kontrollpunkter.forEach(function (k, i) {
      paras.push(new Paragraph({ children: [new TextRun({ text: (i + 1) + ". " + k })] }));
    });
  }

  return paras;
}

// supabase: en klient autentisert SOM en innlogget bruker (RLS gjelder).
async function generateManuscript(supabase, openaiKey, caseId) {
  const caseRes = await supabase.from("cases").select("*").eq("id", caseId).maybeSingle();
  if (caseRes.error || !caseRes.data) throw new Error("Fant ikke saken.");
  const c = caseRes.data;

  let eventContext = "";
  if (c.event_id) {
    const evRes = await supabase.from("events").select("*").eq("id", c.event_id).maybeSingle();
    if (evRes.data) {
      eventContext = "Denne saken er en INFO-sak koblet til arrangementet «" + evRes.data.title + "» (" +
        evRes.data.event_type + ", " + evRes.data.location + ", " + evRes.data.starts_on + "). Nevn arrangementet naturlig i teksten.";
    }
  }

  const sourceUrl = c.kilder && c.kilder.length ? c.kilder[0] : null;
  const source = sourceUrl ? await fetchSourceArticle(sourceUrl) : { ok: false, reason: "ingen kildelenke registrert" };

  const styleExamples = await fetchDronemagExamples();

  // DYP RESEARCH før skriving (lib/materialResearch.js): tre søkerunder, HTTP-
  // verifiserte kilder og deres faktiske tekst. Lazy require — materialResearch
  // importerer selv fetchSourceArticle herfra (sirkulær avhengighet ellers).
  const { deepResearch } = require("./materialResearch.js");
  await logProgress(supabase, c.id, "🔎 Søker dypt på nettet etter primærkilder, bakgrunn og tidligere dekning (2–3 minutter) …");
  let research = { kilder: [], antallFunnet: 0, antallVerifisert: 0, feil: [] };
  try {
    research = await deepResearch(openaiKey, {
      materialUtdrag: source.ok
        ? "[" + (source.siteName || "") + " — " + (source.title || c.title) + "]\n" + source.text
        : c.title + "\n" + (c.oppsummering || ""),
      beskrivelse: "Saken «" + c.title + "»" + (source.ok ? " bygger på en artikkel fra " + source.siteName + "." : ".") +
        " Redaksjonen skriver en fagjournalistisk sak for Dronemagasinet (norsk fagmedium om droner). " + (c.oppsummering || ""),
      dokumentNavn: [], lenker: sourceUrl ? [sourceUrl] : [],
      egenSok: c.title + " " + (source.ok && source.title ? source.title : "")
    });
  } catch (err) {
    research.feil.push(err.message);
  }
  await logProgress(supabase, c.id, "🔎 Fant " + research.antallVerifisert + (research.antallVerifisert === 1 ? " verifisert ekstern kilde" : " verifiserte eksterne kilder") +
    (research.feil.length ? " — ⚠️ " + research.feil.length + " søkerunde(r) feilet" : "") + " — skriver saken …");

  const userPrompt =
    todayLine() + "\n\n" +
    (styleExamples.length ? styleExamplesBlock(styleExamples) + "\n\n=====\n\n" : "") +
    "Sakstittel (arbeidstittel, du kan forbedre den): " + c.title + "\n" +
    "Tidligere AI-sammendrag: " + (c.oppsummering || "(ingen)") + "\n" +
    (eventContext ? eventContext + "\n" : "") +
    "Kildelenke: " + (sourceUrl || "(ingen)") + "\n" +
    (source.ok && source.siteName ? "KILDEMEDIET (navngi dette eksplisitt i teksten — se punkt 1): " + source.siteName + "\n" : "") +
    "Destinasjonsnettsted for saken: " + (c.nettsted || "dronemag.no") + "\n\n" +
    (source.ok
      ? "Hentet kildetekst (dette er UTGANGSPUNKTET, ikke noe som bare skal skrives om):\n" + source.text
      : "Kildeteksten kunne ikke hentes automatisk (" + source.reason + "). Bygg på tittelen, sammendraget og research-grunnlaget, og sett usikkerhetsnotat til at kilden må sjekkes manuelt før publisering.") +
    "\n\n=====\n\n" + researchBlock(research);

  const fields = await callOpenAI(openaiKey, MODEL, WRITER_SYSTEM_PROMPT, userPrompt, WRITER_SCHEMA);
  applyResearchToFields(fields, research);
  stripCitationsFromFields(fields);
  restrictLinksToKnown(fields, research);
  if (source.ok) {
    ensureOriginalSourceListed(fields, sourceUrl, source.siteName, c.title);
    ensureQuoteAttribution(fields, source.siteName);
  }

  // Redaktørrunde: strammer tittel/ingress/rytme etter skriveprinsippene, uten å endre fakta.
  const polished = await polishManuscript(openaiKey, MODEL, fields, styleExamples,
    source.ok && source.siteName ? "- Kildemediet «" + source.siteName + "» skal fortsatt navngis i prosa i første eller andre avsnitt." : "");
  Object.assign(fields, polished.fields);
  restrictLinksToKnown(fields, research);
  await ensureOwnLinks(openaiKey, fields, research);

  // Hovedbilde: faktisk redaksjonelt bilde fra artikkelen (ikke logo/delingsgrafikk).
  let image = null;
  if (source.ok && source.html) {
    const picked = await pickArticleImages(sourceUrl, source.html, 1, {
      verify: async function (img) { return (await classifyImage(openaiKey, img, { tittel: c.title })).ok; }
    });
    if (picked.length) image = picked[0];
  }
  // Foto-kreditering = KUN hvor bildet er hentet fra (f.eks. «polisen.se»),
  // aldri «produsentbilde/illustrasjon» — redaksjonelt krav.
  fields.fotoKreditering = image ? cleanCredit(hostCredit(sourceUrl)) : "";
  Object.assign(fields, await norwegianCaptions(openaiKey, fields));

  const doc = new Document({ sections: [{ children: await buildDocxParagraphs(fields, image) }] });
  const buffer = await Packer.toBuffer(doc);

  const path = c.id + "/" + Date.now() + ".docx";
  const uploadRes = await supabase.storage.from("manus").upload(path, buffer, {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    upsert: false
  });
  if (uploadRes.error) throw new Error("Kunne ikke laste opp manus: " + uploadRes.error.message);

  const historikkNote = "Manus generert (AI-førsteutkast med research)" +
    (fields.tidligere_dekning ? " — lenker til tidligere dekning: " + fields.tidligere_dekning.tittel : "") +
    " — " + (fields.kilder_brukt || []).length + " kilde(r) brukt av " + research.antallVerifisert + " verifiserte" +
    (fields.usikkerhetsnotat ? " — ⚠️ " + fields.usikkerhetsnotat : "") +
    (image ? "" : " — ingen redaksjonelt bilde funnet i kildeartikkelen (logoer/delingsgrafikk er bevisst ikke brukt), bruk «Finn bilder»") +
    (polished.polished ? " — språkvasket av redaktørrunden" : (polished.forkastet ? " — redaktørrunden ble forkastet (" + polished.forkastet + ")" : "")) +
    " — " + fields.kontrollpunkter.length + " kontrollpunkt(er) å avklare før publisering";
  const historikkEntries = [{ ts: new Date().toISOString(), text: historikkNote }];

  // Arbeidsflyt: å generere manus er starten på det redaksjonelle arbeidet —
  // saken flyttes derfor automatisk til "I arbeid" her (der selve
  // manusredigeringen skjer i verktøyet) om den fortsatt sto i "Idé" (f.eks.
  // trigget direkte via AI-assistenten, uten å gå via Godkjenn-knappen først).
  // Rører aldri en sak som allerede har kommet lenger (i-arbeid/wp-utkast/publisert).
  const statusUpdate = {};
  if (c.status === "ide") {
    statusUpdate.status = "i-arbeid";
    historikkEntries.push({ ts: new Date().toISOString(), text: "Status endret automatisk (manus generert): Idé → I arbeid" });
  }
  const historikk = historikkEntries.concat(c.historikk || []);

  const updateRes = await supabase.from("cases").update(Object.assign({
    manus_url: path,
    manus_generert_ts: new Date().toISOString(),
    // Strukturerte felt ved siden av .docx-filen — slik at "Publiser til
    // WordPress" kan lese innholdet direkte, uten å parse dokumentet på nytt,
    // og slik at manglende felt kan sjekkes FØR noe sendes til WordPress.
    manus_tittel: fields.tittel || "",
    manus_ingress: fields.ingress || "",
    manus_hovedtekst: fields.hovedtekst_avsnitt || [],
    manus_alt_tekst: fields.alt_tekst_bilde || "",
    manus_bilde_url: image ? image.url : "",
    manus_foto: fields.fotoKreditering || "",
    manus_emnefelt: fields.emnefelt || [],
    manus_titler_alternativer: fields.titler_alternativer || [],
    manus_tidligere_dekning: fields.tidligere_dekning || null,
    manus_kilder_brukt: fields.kilder_brukt || [],
    manus_kontrollpunkter: fields.kontrollpunkter || [],
    manus_bilde_er_illustrasjon: !!fields.bilde_er_illustrasjon,
    historikk: historikk
  }, statusUpdate)).eq("id", c.id);
  if (updateRes.error) throw new Error(updateRes.error.message);

  return {
    ok: true, path: path, harBilde: !!image, usikkerhetsnotat: fields.usikkerhetsnotat || null, nyStatus: statusUpdate.status || null,
    fantTidligereDekning: !!fields.tidligere_dekning, antallKontrollpunkter: fields.kontrollpunkter.length
  };
}

// Maks tegn transkripsjon som sendes til AI-en — MYE høyere enn
// MAX_SOURCE_CHARS (som gjelder hentet HTML fra en nettartikkel). Et 35 min
// intervju er typisk 25-30 000 tegn — vanlige modellers kontekstvindu tar
// dette uten problem, ingen grunn til å kutte det ned slik en nettartikkel
// kuttes. Kun en sperre mot reelt ekstreme opptak (flere timer).
const MAX_TRANSCRIPT_CHARS = 80000;

// Systemprompt for manus FRA ET LYDOPPTAK (intervju e.l.) — egen fra
// WRITER_SYSTEM_PROMPT (som handler om å bearbeide en ekte, EKSTERN
// artikkel) siden grunnlaget her er redaksjonens EGET opptak, ikke en
// publisert kilde å kreditere. Gjenbruker likevel samme WRITER_SCHEMA —
// feltene (tittel/ingress/hovedtekst_avsnitt/kilder_brukt/kontrollpunkter
// osv.) passer like godt her.
const TRANSCRIPT_SYSTEM_PROMPT = `Du er journalist i Dronemagasinet (dronemag.no)/UAS Norway, medlem av Fagpressen og underlagt Redaktørplakaten. Du har fått en TRANSKRIBERT LYDOPPTAK-tekst (typisk et intervju redaksjonen selv har gjort) som grunnlag for en ny sak, samt en arbeidstittel og eventuelt et redaksjonelt notat om vinkling/lengde/hva saken skal handle om.

GRUNNREGEL, ufravikelig: bygg UTELUKKENDE på det som faktisk sies i transkripsjonen. Dikt ALDRI opp sitater, tall, navn eller påstander som ikke faktisk finnes i teksten du får. Transkripsjonen kan inneholde feilhørte ord/navn (automatisk talegjenkjenning) — er noe åpenbart feilstavet eller usikkert (f.eks. et uvanlig firmanavn eller produktnavn), noter det i usikkerhetsnotat i stedet for å gjette blindt.

VIKTIG OM TALERE: transkripsjonen merker ulike stemmer som "Taler 1"/"Taler 2" osv. Er transkripsjonen merket som delt opp i flere biter (fremgår av teksten du får), er IKKE talermerkingen nødvendigvis konsistent på tvers av delene — "Taler 1" i del 2 er ikke garantert samme person som "Taler 1" i del 1. Bruk sitater/attribusjon med varsomhet i så fall, og nevn i usikkerhetsnotat at taleridentitet bør dobbeltsjekkes mot selve lydopptaket før publisering. Er transkripsjonen IKKE delt opp, kan talermerkingen innad i opptaket stort sett stoles på.

Gjør, i denne rekkefølgen:

1. Skriv et redaksjonelt førsteutkast basert på intervjuet — ikke et rått referat, men en ferdig strukturert sak (ingress, mellomtitler, sitatblokker der de faktisk sier noe sitatverdig).
2. Følg det redaksjonelle notatet (vinkling/lengde/hva saken skal handle om) hvis det er oppgitt — det styrer hvordan saken vinkles og hvor omfattende den blir, men overstyrer ALDRI grunnregelen om å aldri dikte opp innhold utover det som faktisk sies i opptaket.
3. BRUK RESEARCH-GRUNNLAGET (nummererte eksterne kilder E1, E2 … med utdrag av kildenes egen tekst, verifisert i forkant) til å verifisere/utdype faktapåstander fra intervjuet (selskapsnavn, produkter, tall, hendelser) og til å gi bakgrunn og kontekst. Bruk KUN det utdragene faktisk sier, og kun når kilden gjelder samme sak/selskap. Kilder merket EGEN er tidligere saker fra Dronemagasinet/UAS Norway: viser du til en, skriv en markdown-lenke [lenketekst](URL) med NØYAKTIG oppgitt URL og kildehenvis i prosa («som Dronemagasinet skrev …»). Alle andre kilder navngis kun i prosa, uten lenke.
4. Sitatblokker (prefiks "> ") skal formateres '> «sitatet» – navn, rolle' (navn/rolle fra intervjuobjektet om det er kjent fra konteksten/arbeidstittelen/notatet — er navn/rolle ukjent, skriv "– intervjuobjektet" og noter i usikkerhetsnotat at navn/rolle bør bekreftes før publisering). IKKE skriv "til Dronemagasinet" e.l. etter sitatet — det er unødvendig når kilden er redaksjonens eget intervju.
5. STRUKTUR: samme avsnittskonvensjon som ellers — mellomtittel "## Tittel", sitatblokk "> ...", vanlig avsnitt uten prefiks. Fet skrift ("**tekst**") kun unntaksvis for noe genuint viktig, aldri som standard.
6. brukte_eksterne: list E-numrene til de eksterne kildene du faktisk har brukt i teksten (ikke flere). Selve intervjuet er ikke en kilde i denne listen.
7. KONTROLLPUNKTER: konkrete, saksspesifikke ting redaksjonen bør avklare før publisering — inkluder ALLTID et punkt om å dobbeltsjekke sitater/attribusjon mot selve lydopptaket, i tillegg til andre sakspesifikke punkter.
8. alt_tekst_bilde: sett til en kort, generisk BILDETEKST PÅ NORSK basert på temaet (redaksjonen laster selv opp egne bilder til saken, ingen bilde-URL er hentet automatisk her) — bilde_er_illustrasjon settes til false.

GRUNNREGEL, som ellers i redaksjonens verktøy: skriv ALDRI noe som om det er bekreftet uten at det faktisk sies i opptaket eller er funnet ved websøk. Er noe usikkert, si det i usikkerhetsnotat — ikke fyll hull med antakelser.

${STYLE_PRINCIPLES}

(Skrivestilen over gjelder språket og oppbyggingen. Reglene om at alt må ha dekning i opptaket, og om sitatattribusjon, går alltid foran.)`;

async function generateManuscriptFromTranscript(supabase, openaiKey, caseId, transcript, opts) {
  opts = opts || {};
  const caseRes = await supabase.from("cases").select("*").eq("id", caseId).maybeSingle();
  if (caseRes.error || !caseRes.data) throw new Error("Fant ikke saken.");
  const c = caseRes.data;

  var truncated = transcript.length > MAX_TRANSCRIPT_CHARS;
  var transcriptForPrompt = truncated ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : transcript;

  const styleExamples = await fetchDronemagExamples();

  const userPrompt =
    todayLine() + "\n\n" +
    (styleExamples.length ? styleExamplesBlock(styleExamples) + "\n\n=====\n\n" : "") +
    "Arbeidstittel: " + c.title + "\n" +
    (opts.aiNotat ? "Redaksjonelt notat (vinkling/lengde/hva saken skal handle om): " + opts.aiNotat + "\n" : "") +
    "Destinasjonsnettsted: " + (c.nettsted || "dronemag.no") + " — søk primært i dronemag.no sitt arkiv etter tidligere dekning, også om saken skal publiseres på uasnorway.no.\n" +
    (opts.flerBiter ? "MERK: opptaket var langt og ble transkribert i " + opts.antallBiter + " deler — talermerking er IKKE nødvendigvis konsistent på tvers av delene, se instruks over.\n" : "") +
    (truncated ? "(NB: transkripsjonen var svært lang og er kuttet til de første " + MAX_TRANSCRIPT_CHARS + " tegnene.)\n" : "") +
    "\nTRANSKRIBERT LYDOPPTAK:\n" + transcriptForPrompt;

  const { deepResearch } = require("./materialResearch.js");
  await logProgress(supabase, c.id, "🔎 Søker dypt på nettet for å verifisere og utdype det som sies i opptaket (2–3 minutter) …");
  let research = { kilder: [], antallFunnet: 0, antallVerifisert: 0, feil: [] };
  try {
    research = await deepResearch(openaiKey, {
      materialUtdrag: transcriptForPrompt.slice(0, 7000),
      beskrivelse: "Intervju/opptak som skal bli en fagjournalistisk sak i Dronemagasinet. Arbeidstittel: " + c.title + (opts.aiNotat ? ". Redaksjonelt notat: " + opts.aiNotat : ""),
      dokumentNavn: [], lenker: [], egenSok: c.title + " " + (opts.aiNotat || "")
    });
  } catch (err) {
    research.feil.push(err.message);
  }
  await logProgress(supabase, c.id, "🔎 Fant " + research.antallVerifisert + (research.antallVerifisert === 1 ? " verifisert ekstern kilde" : " verifiserte eksterne kilder") + " — skriver saken …");

  const fields = await callOpenAI(openaiKey, MODEL, TRANSCRIPT_SYSTEM_PROMPT, userPrompt + "\n\n=====\n\n" + researchBlock(research), WRITER_SCHEMA);
  applyResearchToFields(fields, research);
  stripCitationsFromFields(fields);
  restrictLinksToKnown(fields, research);

  const polishedT = await polishManuscript(openaiKey, MODEL, fields, styleExamples,
    "- Talerattribusjon i sitater må ikke endres eller «forbedres».");
  Object.assign(fields, polishedT.fields);
  restrictLinksToKnown(fields, research);
  await ensureOwnLinks(openaiKey, fields, research);
  Object.assign(fields, await norwegianCaptions(openaiKey, fields));

  // Server-side garanti, samme prinsipp som ensureOriginalSourceListed/
  // ensureQuoteAttribution over — testing viste at "ALLTID"-instruksen i
  // punkt 7 i TRANSCRIPT_SYSTEM_PROMPT ikke alltid faktisk følges av modellen.
  var harSitatKontrollpunkt = (fields.kontrollpunkter || []).some(function (k) {
    return /sitat|attribu|opptak/i.test(k);
  });
  if (!harSitatKontrollpunkt) {
    fields.kontrollpunkter = (fields.kontrollpunkter || []).concat(
      "Dobbeltsjekk sitater og hvem som sier hva mot selve lydopptaket før publisering."
    );
  }

  // Første opplastede bilde = hovedbilde (samme docx-plassering som ved
  // lenke-basert manusgenerering); eventuelle flere limes inn som egne
  // inline-bildemarkører til slutt i teksten (se IMAGE_MARKER_RE) — enkel,
  // forutsigbar plassering v1, redaksjonen flytter dem selv om ønskelig i
  // manus-editoren (samme mekanisme som opplastede manus med bilder).
  var images = opts.imageUrls || [];
  var heroImage = images.length ? await fetchImage(images[0]) : null;
  if (images.length > 1) {
    for (var i = 1; i < images.length; i++) {
      fields.hovedtekst_avsnitt.push("![Bilde fra opptaket](" + images[i] + ")");
    }
  }
  fields.fotoKreditering = heroImage ? "UAS Norway / Dronemagasinet" : "";

  const doc = new Document({ sections: [{ children: await buildDocxParagraphs(fields, heroImage) }] });
  const buffer = await Packer.toBuffer(doc);

  const path = c.id + "/" + Date.now() + ".docx";
  const uploadRes = await supabase.storage.from("manus").upload(path, buffer, {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    upsert: false
  });
  if (uploadRes.error) throw new Error("Kunne ikke laste opp manus: " + uploadRes.error.message);

  const historikkNote = "Manus generert fra lydopptak (AI-førsteutkast)" +
    (opts.flerBiter ? " — opptak i " + opts.antallBiter + " deler, dobbeltsjekk taler-attribusjon" : "") +
    (fields.tidligere_dekning ? " — fant tidligere dekning: " + fields.tidligere_dekning.tittel : "") +
    (fields.usikkerhetsnotat ? " — ⚠️ " + fields.usikkerhetsnotat : "") +
    " — " + fields.kontrollpunkter.length + " kontrollpunkt(er) å avklare før publisering";
  const historikk = [{ ts: new Date().toISOString(), text: historikkNote }].concat(c.historikk || []);

  // audioUrls (signerte, 1 år) legges inn som kildene for saken — det ER
  // kilden/kildene for en lydopptak-basert sak (ett eller flere opplastede
  // opptak), samme prinsipp som en lenke er kilden[0] for lenke-baserte
  // saker. Rører aldri kilder om noe allerede er satt der.
  var kilderUpdate = {};
  if (opts.audioUrls && opts.audioUrls.length && !(c.kilder && c.kilder.length)) kilderUpdate.kilder = opts.audioUrls;

  const updateRes = await supabase.from("cases").update(Object.assign({
    manus_url: path,
    manus_generert_ts: new Date().toISOString(),
    manus_tittel: fields.tittel || "",
    manus_ingress: fields.ingress || "",
    manus_hovedtekst: fields.hovedtekst_avsnitt || [],
    manus_alt_tekst: fields.alt_tekst_bilde || "",
    manus_bilde_url: images.length ? images[0] : "",
    manus_foto: fields.fotoKreditering || "",
    manus_emnefelt: fields.emnefelt || [],
    manus_titler_alternativer: fields.titler_alternativer || [],
    manus_tidligere_dekning: fields.tidligere_dekning || null,
    manus_kilder_brukt: fields.kilder_brukt || [],
    manus_kontrollpunkter: fields.kontrollpunkter || [],
    manus_bilde_er_illustrasjon: false,
    historikk: historikk
  }, kilderUpdate)).eq("id", c.id);
  if (updateRes.error) throw new Error(updateRes.error.message);

  return {
    ok: true, path: path, harBilde: !!heroImage, usikkerhetsnotat: fields.usikkerhetsnotat || null,
    fantTidligereDekning: !!fields.tidligere_dekning, antallKontrollpunkter: fields.kontrollpunkter.length
  };
}

// fetchSourceArticle/fetchImage/buildDocxParagraphs/callOpenAI/HOUSE_STYLE
// eksportert i tillegg til generateManuscript selv — gjenbrukes av
// lib/reviseManuscript.js (AI-notat-revidering direkte i verktøyet) i stedet
// for å duplisere den samme, allerede testede logikken.
module.exports = {
  generateManuscript, generateManuscriptFromTranscript, fetchSourceArticle, fetchImage, buildDocxParagraphs,
  callOpenAI, scaleToMaxWidth, HOUSE_STYLE, MODEL, IMAGE_MARKER_RE, parseImageMarker, restrictLinksToKnown, stripCitationsFromFields, isOwnUrl, ensureOwnLinks, researchBlock, applyResearchToFields, logProgress
};
