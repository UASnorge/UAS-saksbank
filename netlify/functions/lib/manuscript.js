// Delt kjernelogikk for AI-generert manus. Brukt av generate-manuscript.js
// (kalt fra "Generer manus"-knappen) og assistant-chat.js (kalt som verktøy
// av AI-assistenten) — samme, allerede testede logikk.
//
// VIKTIG, etter redaksjonell tilbakemelding: dette skal være faktisk
// redaksjonelt arbeid, ikke bare en omskriving av én artikkel. Bruker derfor
// gpt-5-search-api (søkekapabelt, samme som kildevurdering/bilderesearch) til
// å: navngi og lenke avsenderen korrekt, finne primærkilder bak påstandene,
// søke Dronemagasinets EGET arkiv etter tidligere dekning av samme sak,
// og sjekke om nyere kilder oppdaterer eller motsier fakta i kildeartikkelen
// — i stedet for kun å lese én fastlåst artikkeltekst og skrive den om.
//
// Samme "grunnregel" som resten av søke-baserte funksjoner (kildevurdering,
// bilderesearch): AI-en dikter ALDRI opp en URL — enhver lenke den oppgir
// (kilder_brukt, tidligere_dekning) verifiseres her med en ekte HTTP-
// forespørsel (lib/linkCheck.js) før den presenteres som en ekte kilde.

const { Document, Packer, Paragraph, TextRun, ImageRun } = require("docx");
const { verifyUrls } = require("./linkCheck.js");

const MODEL = "gpt-5.5"; // brukt av lib/reviseManuscript.js (rask tekstrevidering, ikke ny research)
const RESEARCH_MODEL = "gpt-5-search-api"; // brukt her, til selve førsteutkastet — ekte websøk
const MAX_SOURCE_CHARS = 6000;

const HOUSE_STYLE = `Du er journalist i Dronemagasinet (dronemag.no), medlem av Fagpressen og underlagt Redaktørplakaten.
Skriv nøktern, faktabasert norsk fagjournalistikk — kort ingress (1-3 setninger), så brødtekst i korte,
konkrete avsnitt. Bruk aktiv form, unngå synsing. Oppgi alltid hvor informasjon kommer fra når det er naturlig
(f.eks. "ifølge X" eller "skriver Y"). Basér deg UTELUKKENDE på fakta som faktisk står i kildeteksten du får
oppgitt under — finn ALDRI på detaljer, tall, sitater eller navn som ikke står der. Er noe uklart eller mangler
i kildeteksten, skriv det tydelig i feltet "usikkerhetsnotat" i stedet for å gjette i selve teksten.`;

// Systemprompt for selve FØRSTEUTKASTET — vesentlig mer krevende enn
// HOUSE_STYLE over, fordi dette er der research faktisk skal skje.
const RESEARCH_SYSTEM_PROMPT = `Du er journalist i Dronemagasinet (dronemag.no), medlem av Fagpressen og underlagt Redaktørplakaten. Du har fått en kildeartikkel (og eventuelt et tidligere AI-sammendrag) om en sak redaksjonen vurderer å skrive om. Din jobb er IKKE å omskrive kildeartikkelen — det er å gjøre det redaksjonelle grunnarbeidet en journalist normalt ville gjort før publisering, og levere et gjennomarbeidet, dokumentert utkast.

Gjør FAKTISK, i denne rekkefølgen:

1. IDENTIFISER KILDEN KORREKT OG NAVNGI DEN I PROSA — DETTE ER OBLIGATORISK, UANSETT HVOR MANGE ANDRE KILDER DU FINNER. Du får oppgitt navnet på kildemediet nedenfor (f.eks. "NRK") — dette ER kildeartikkelen denne konkrete saken bygger på. Selv om du under research finner andre, kanskje bedre primærkilder (myndighetens egen pressemelding, produsentens nettside osv.) — det ERSTATTER ALDRI plikten til å navngi og kreditere kildemediet for opplysningene/sitatet som faktisk kommer derfra. Krav, ufravikelig:
   - Kildemediet skal navngis eksplisitt i PROSA allerede i FØRSTE avsnitt av hovedtekst_avsnitt (f.eks. "NRK skriver at ..." / "Det kommer frem i en sak fra NRK ..."), og gjentas med varierte formuleringer der det er naturlig ("skriver NRK", "ifølge NRK", "sier X, rolle, til NRK") — ikke samme frase i hvert avsnitt.
   - Kildemediet skal ALLTID stå som eget element i kilder_brukt-listen, med den nøyaktige kildelenken du fikk oppgitt — dette gjelder selv om du finner andre, «bedre» kilder i tillegg.
   - Inneholder saken en sitatblokk (prefiks "> "), skal den ALLTID avsluttes med "– navn, rolle, til [nøyaktig kildemedium]" — ALDRI "til Dronemagasinet", og ALDRI uten et navngitt kildemedium der sitatet faktisk kommer fra kildeartikkelen.
   - La ALDRI et sitat et annet medium har innhentet fremstå som om Dronemagasinet selv har intervjuet personen.

VIKTIG OM KILDEHENVISNING I TEKSTEN: sett ALDRI inn klikkbare lenker, parenteser med URL-er, eller referanse-fotnoter midt i brødteksten (f.eks. ALDRI noe i stil med "... (dronemag.no)" eller "[tekst](url)" inni en setning). All kildehenvisning i selve artikkelteksten skjer UTELUKKENDE i prosaform ("ifølge NRK", "skriver Forsvarsmateriell i en pressemelding") — de faktiske, klikkbare lenkene hører KUN hjemme i kilder_brukt-listen, ikke i løpeteksten. Dette er en ferdig redigert artikkel, ikke et forskningsnotat.

2. FINN PRIMÆRKILDEN. Skill mellom den som PUBLISERER saken og den OPPRINNELIGE kilden til opplysningene (myndighet, produsent, pressemelding, kontraktskunngjøring osv.). Søk aktivt etter denne primærkilden og bruk den — ikke bare gjenta det publikasjonen skrev.

3. SØK DRONEMAGASINETS/UAS NORWAYS EGET ARKIV. Søk faktisk (f.eks. "site:dronemag.no [selskap/teknologi/anskaffelse]") etter tidligere dekning av samme selskap, teknologi, anskaffelse/prosjekt, personer eller myndighet. Finner du en relevant tidligere sak: bruk den til å forklare HVA SOM FAKTISK ER NYTT nå (ikke bare gjenta at anskaffelsen finnes), og oppgi den som tidligere_dekning. Finner du ingenting relevant, sett tidligere_dekning til null — ikke dikt opp en tidligere sak.

4. FAKTASJEKK MOT NYERE KILDER. Søk etter om noe i kildeartikkelen faktisk er blitt oppdatert, presisert eller motsagt av en NYERE kilde (f.eks. en senere pressemelding, en annen base/lokasjon som har fått samme system, en avklaring av status). Oppdater teksten deretter, og vær eksplisitt i selve brødteksten når noe i kildeartikkelen viste seg å være utdatert eller upresist.

5. IKKE GJETT — MARKÉR USIKKERHET TYDELIG I TEKSTEN. Er noe uklart (nøyaktig hvilken effektor/komponent, om noe er operativt eller under innføring, om to steder faktisk har identisk konfigurasjon, hvem som egentlig var "først"), skriv det rett ut i brødteksten ("dette bør avklares", "kildene dokumenterer ikke...", "det er ikke bekreftet at...") — presenter det ALDRI som bekreftet fakta. Unngå kategoriske formuleringer ("skyter ned", "først i Norge", "tatt i bruk") med mindre en primærkilde faktisk bekrefter det presist.

6. STRUKTUR. Bygg avsnittslisten (hovedtekst_avsnitt) som en ordnet liste der:
   - et vanlig avsnitt er bare teksten
   - en mellomtittel skrives som eget listeelement med prefiks "## " (f.eks. "## Del av et større system") — bruk 2-4 mellomtitler i en middels lang sak, aldri i en veldig kort
   - et direkte sitat med god kildeverdi skrives som eget listeelement med prefiks "> " i formatet '> «sitatet» – navn, rolle, til Kilde' (kun når kildeartikkelen faktisk inneholder et sitat verdt å fremheve — dikt aldri opp et sitat)

7. BILDE. Vurder om bildet fra kildeartikkelen er et generisk produsent-/arkivbilde som IKKE er bekreftet å vise den faktiske, konkrete situasjonen saken handler om (typisk for produkt-/pressebilder brukt til å illustrere en spesifikk hendelse) — sett bilde_er_illustrasjon til true i så fall, og skriv det tydelig i alt-teksten.

8. KILDER BRUKT. List ALLE kildene du faktisk har brukt (kildeartikkelen selv, primærkilder du fant, eventuell egen tidligere dekning) med ekte, funnet URL-er. ALDRI oppgi en URL du ikke faktisk har funnet/sett — det er bedre å utelate en kilde enn å dikte opp lenken til den.

9. KONTROLLPUNKTER. List konkrete, SAKSSPESIFIKKE åpne spørsmål redaksjonen bør avklare før publisering (ikke generiske floskler) — inkluder relevante påminnelser om god praksis der de faktisk er aktuelle for denne saken (presis tittel, riktig sitatpraksis/kildehenvisning, bekreftet bildebruk/kreditering, om en egen kommentar fra en relevant part bør innhentes).

GRUNNREGEL, som i alt annet søkebasert arbeid her: skriv ALDRI noe som om det er bekreftet uten at du faktisk har funnet det. Er noe usikkert, si det — ikke fyll hull med antakelser.`;

const MANUSCRIPT_SCHEMA = {
  name: "manus",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      tittel: { type: "string" },
      ingress: { type: "string" },
      hovedtekst_avsnitt: { type: "array", items: { type: "string" }, minItems: 1 },
      alt_tekst_bilde: { type: "string" },
      usikkerhetsnotat: { type: ["string", "null"], description: "Kun hvis noe er usikkert/mangler i kilden. Ellers null. Skrives ALDRI inn i selve artikkelteksten." }
    },
    required: ["tittel", "ingress", "hovedtekst_avsnitt", "alt_tekst_bilde", "usikkerhetsnotat"]
  }
};

const RESEARCH_SCHEMA = {
  name: "manus_research",
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
        description: "Ordnet avsnittsliste. Mellomtittel: '## Tittel'. Sitatblokk: '> «sitat» – navn, rolle, til Kilde'. Alt annet: vanlig brødtekstavsnitt."
      },
      alt_tekst_bilde: { type: "string" },
      bilde_er_illustrasjon: { type: "boolean", description: "true hvis bildet er et generisk produsent-/arkivbilde som IKKE er bekreftet å vise den faktiske situasjonen saken handler om." },
      tidligere_dekning: {
        type: ["object", "null"], additionalProperties: false,
        properties: { tittel: { type: "string" }, url: { type: "string" } },
        required: ["tittel", "url"],
        description: "Tidligere sak fra dronemag.no/uasnorway.no om samme sak/selskap/teknologi, funnet ved faktisk arkivsøk. Null hvis ingen relevant sak finnes — aldri oppdiktet."
      },
      kilder_brukt: {
        type: "array", minItems: 1,
        items: {
          type: "object", additionalProperties: false,
          properties: { navn: { type: "string" }, tittel: { type: "string" }, url: { type: "string" } },
          required: ["navn", "tittel", "url"]
        },
        description: "Alle kilder faktisk brukt, med ekte, funnet URL-er — aldri oppdiktet."
      },
      kontrollpunkter: {
        type: "array", minItems: 1, items: { type: "string" },
        description: "Konkrete, saksspesifikke åpne spørsmål/ting som bør avklares før publisering."
      },
      usikkerhetsnotat: { type: ["string", "null"] }
    },
    required: ["emnefelt", "tittel", "titler_alternativer", "ingress", "hovedtekst_avsnitt", "alt_tekst_bilde",
      "bilde_er_illustrasjon", "tidligere_dekning", "kilder_brukt", "kontrollpunkter", "usikkerhetsnotat"]
  }
};

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
    return { ok: true, text: text, imageUrl: ogImage, siteName: siteName || new URL(url).hostname, title: title };
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
// RESEARCH_SYSTEM_PROMPT). Fjernes derfor alltid server-side, uansett om
// promptet ble fulgt eller ikke — ekte kildehenvisning skal kun stå i
// kilder_brukt-listen og i selve prosaen ("ifølge NRK"), aldri som en
// klikkbar lenke inni en artikkel-setning.
function stripInlineCitations(text) {
  return String(text || "")
    .replace(/\s*\(\[[^\]]*\]\(https?:\/\/[^\s)]+\)\)/g, "")
    .replace(/\s*\[[^\]]*\]\(https?:\/\/[^\s)]+\)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

function stripCitationsFromFields(fields) {
  fields.tittel = stripInlineCitations(fields.tittel);
  fields.ingress = stripInlineCitations(fields.ingress);
  fields.hovedtekst_avsnitt = (fields.hovedtekst_avsnitt || []).map(function (p) {
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
  return [new Paragraph({ children: [new TextRun({ text: text })] })];
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
  for (var i = 0; i < fields.hovedtekst_avsnitt.length; i++) {
    var resolved = await paragraphsFromMarkedText(fields.hovedtekst_avsnitt[i]);
    resolved.forEach(function (p) { paras.push(p); });
    if (i < fields.hovedtekst_avsnitt.length - 1) paras.push(new Paragraph({ children: [] }));
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

async function verifySourceLinks(fields) {
  var urls = (fields.kilder_brukt || []).map(function (k) { return k.url; });
  if (fields.tidligere_dekning) urls.push(fields.tidligere_dekning.url);
  var results = await verifyUrls(urls);

  fields.kilder_brukt = (fields.kilder_brukt || []).map(function (k) {
    var r = results[k.url];
    return Object.assign({}, k, { url_virker: !!(r && r.ok) });
  });

  if (fields.tidligere_dekning) {
    var r = results[fields.tidligere_dekning.url];
    // "Tidligere dekning" er en sterk, tillitsbærende påstand (at vi faktisk
    // har dekket dette før) — presenteres ALDRI som en egen boks med mindre
    // lenken faktisk er bekreftet. Feiler den, faller den heller inn i den
    // vanlige (tydelig merkede) kildelisten i stedet for å forsvinne sporløst.
    if (!r || !r.ok) {
      fields.kilder_brukt.push(Object.assign({}, fields.tidligere_dekning, { navn: "Dronemagasinet (tidligere dekning, ikke bekreftet)", url_virker: false }));
      fields.tidligere_dekning = null;
    }
  }
  return fields;
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

  const userPrompt =
    "Sakstittel (arbeidstittel, du kan forbedre den): " + c.title + "\n" +
    "Tidligere AI-sammendrag: " + (c.oppsummering || "(ingen)") + "\n" +
    (eventContext ? eventContext + "\n" : "") +
    "Kildelenke: " + (sourceUrl || "(ingen)") + "\n" +
    (source.ok && source.siteName ? "KILDEMEDIET (navngi dette eksplisitt i teksten — se punkt 1): " + source.siteName + "\n" : "") +
    "Destinasjonsnettsted for saken: " + (c.nettsted || "dronemag.no") + " — søk uansett primært i dronemag.no sitt arkiv etter tidligere dekning (det er der den redaksjonelle journalistikken skjer), også om saken skal publiseres på uasnorway.no.\n\n" +
    (source.ok
      ? "Hentet kildetekst (dette er UTGANGSPUNKTET for research, ikke noe som bare skal skrives om):\n" + source.text
      : "Kildeteksten kunne ikke hentes automatisk (" + source.reason + "). Søk selv opp saken basert på tittelen og sammendraget over, og sett usikkerhetsnotat til at kilden må sjekkes manuelt før publisering om du ikke finner den.");

  const fields = await callOpenAI(openaiKey, RESEARCH_MODEL, RESEARCH_SYSTEM_PROMPT, userPrompt, RESEARCH_SCHEMA);
  stripCitationsFromFields(fields);
  if (source.ok) {
    ensureOriginalSourceListed(fields, sourceUrl, source.siteName, c.title);
    ensureQuoteAttribution(fields, source.siteName);
  }
  await verifySourceLinks(fields);

  let image = null;
  if (source.ok && source.imageUrl) {
    image = await fetchImage(source.imageUrl);
  }
  fields.fotoKreditering = image && source.siteName ? source.siteName + (fields.bilde_er_illustrasjon ? " (produsentbilde/illustrasjon)" : "") : "";

  const doc = new Document({ sections: [{ children: await buildDocxParagraphs(fields, image) }] });
  const buffer = await Packer.toBuffer(doc);

  const path = c.id + "/" + Date.now() + ".docx";
  const uploadRes = await supabase.storage.from("manus").upload(path, buffer, {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    upsert: false
  });
  if (uploadRes.error) throw new Error("Kunne ikke laste opp manus: " + uploadRes.error.message);

  const historikkNote = "Manus generert (AI-førsteutkast med research)" +
    (fields.tidligere_dekning ? " — fant tidligere dekning: " + fields.tidligere_dekning.tittel : "") +
    (fields.usikkerhetsnotat ? " — ⚠️ " + fields.usikkerhetsnotat : "") +
    (image ? "" : " — ingen bilde funnet automatisk, må settes inn manuelt") +
    " — " + fields.kontrollpunkter.length + " kontrollpunkt(er) å avklare før publisering";
  const historikkEntries = [{ ts: new Date().toISOString(), text: historikkNote }];

  // Arbeidsflyt: å generere manus er starten på det redaksjonelle arbeidet —
  // saken flyttes derfor automatisk fra "Godkjente idéer" til "I arbeid" her
  // (der selve manusredigeringen skjer i verktøyet), i stedet for å kreve et
  // eget manuelt statusbytte i tillegg. Rører aldri en sak som allerede har
  // kommet lenger (i-arbeid/wp-utkast/publisert) eller ligger i "Idé" uten å
  // være godkjent ennå.
  const statusUpdate = {};
  if (c.status === "godkjent") {
    statusUpdate.status = "i-arbeid";
    historikkEntries.push({ ts: new Date().toISOString(), text: "Status endret automatisk (manus generert): Godkjente idéer → I arbeid" });
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
    manus_bilde_url: (source.ok && source.imageUrl) ? source.imageUrl : "",
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

// fetchSourceArticle/fetchImage/buildDocxParagraphs/callOpenAI/HOUSE_STYLE
// eksportert i tillegg til generateManuscript selv — gjenbrukes av
// lib/reviseManuscript.js (AI-notat-revidering direkte i verktøyet) i stedet
// for å duplisere den samme, allerede testede logikken.
module.exports = {
  generateManuscript, fetchSourceArticle, fetchImage, buildDocxParagraphs,
  callOpenAI, scaleToMaxWidth, HOUSE_STYLE, MODEL, IMAGE_MARKER_RE, parseImageMarker
};
