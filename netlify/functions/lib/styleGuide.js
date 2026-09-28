// Felles redaksjonell skrivestil for alle AI-skrevne saker (manus fra lenke,
// lydopptak, dokumenter). To deler:
//
//  1. HÅNDVERKSREGLER i nyhetsjournalistikk-tradisjonen som Aftenposten
//     representerer (nyhetstrekanten, konkret og aktivt språk, tydelig tittel
//     med verb, informative mellomtitler, tilbakeholdent med adjektiver og
//     synsing, presis kildehenvisning) — formulert som prinsipper, ikke som
//     etterligning av noen bestemt tekst.
//  2. DRONEMAGASINETS EGEN STEMME, hentet LIVE fra dronemag.no: nyere saker
//     skrevet av de faste journalistene (ikke AI-genererte). Modellen får
//     dem som eksempler på tone, rytme og oppbygging, slik at nye saker
//     leses som en del av samme magasin.
//
// I tillegg en "redaktørrunde" (polishManuscript) som leser utkastet på nytt
// med kun ett oppdrag: gjøre teksten bedre etter reglene over UTEN å endre
// fakta, tall, navn, sitater eller kildehenvisninger.

const MAX_EXAMPLES = 4;
const MAX_EXAMPLE_CHARS = 3200;
const HUMAN_AUTHORS = /torgersen|martinsen/i; // faste journalister — ikke saker merket ChatGPT/KI
const AI_MARKER = /chat\s*gp?t|gtp|\bki\b|\bai\b/i;

var cachedExamples = null;
var cachedAt = 0;

function stripTags(s) {
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&laquo;/g, "«").replace(/&raquo;/g, "»").replace(/&#8211;|&ndash;/g, "–").replace(/&#8217;/g, "’")
    .replace(/&#8220;|&#8221;/g, '"').replace(/&hellip;|&#8230;/g, "…")
    .replace(/\s+/g, " ").trim();
}

// Trekker ut ingress + brødtekst (med "## " foran mellomtitler) fra en
// dronemag.no-artikkelside. Bildetekster og delingsknapper hoppes over.
function parseDronemagArticle(html) {
  var author = (html.match(/<em class="author">([\s\S]*?)<\/em>/) || [])[1];
  var ingress = (html.match(/<em class="slogan">([\s\S]*?)<\/em>/) || [])[1];
  var start = html.indexOf('<article class="text-wrap"');
  var end = html.indexOf("</article>", start);
  if (start === -1 || end === -1) return null;
  var body = html.slice(start, end);
  var afterMeta = body.indexOf('class="social-networks"');
  if (afterMeta !== -1) body = body.slice(body.indexOf("</div>", afterMeta));
  var parts = [];
  var re = /<(h2|h3|p)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  var m;
  while ((m = re.exec(body))) {
    if (/wp-caption-text/.test(m[0])) continue;
    var text = stripTags(m[2]);
    if (!text) continue;
    parts.push(m[1].toLowerCase() === "p" ? text : "## " + text);
  }
  return { author: stripTags(author), ingress: stripTags(ingress), body: parts.join("\n\n") };
}

// Nyere saker fra dronemag.no skrevet av de faste journalistene. Feiler stille
// (tom liste) — skrivereglene under gjelder uansett. Bufres i minnet en time
// slik at en batch med flere saker ikke henter dem på nytt for hver sak.
async function fetchDronemagExamples() {
  if (cachedExamples && Date.now() - cachedAt < 3600 * 1000) return cachedExamples;
  var base = (process.env.WP_DRONEMAG_URL || "https://www.dronemag.no").replace(/\/+$/, "");
  try {
    var res = await fetch(base + "/wp-json/wp/v2/posts?categories=18&per_page=24&orderby=date&order=desc&_fields=link,title");
    if (!res.ok) return [];
    var list = await res.json();
    var pages = await Promise.all(list.map(async function (p) {
      try {
        var r = await fetch(p.link, { headers: { "User-Agent": "Mozilla/5.0 (compatible; UASNorwaySaksbank/1.0)" } });
        if (!r.ok) return null;
        var a = parseDronemagArticle(await r.text());
        if (!a) return null;
        a.tittel = stripTags(p.title && p.title.rendered);
        return a;
      } catch (e) { return null; }
    }));
    var good = pages.filter(function (a) {
      return a && HUMAN_AUTHORS.test(a.author) && !AI_MARKER.test(a.author) && a.ingress &&
        a.body.length > 1400 && a.body.length < 7000;
    });
    // Variasjon: ta saker fra begge journalister om mulig.
    var picked = [], seenAuthors = {};
    good.forEach(function (a) { if (picked.length < MAX_EXAMPLES && !seenAuthors[a.author]) { picked.push(a); seenAuthors[a.author] = true; } });
    good.forEach(function (a) { if (picked.length < MAX_EXAMPLES && picked.indexOf(a) === -1) picked.push(a); });
    cachedExamples = picked.map(function (a) {
      return { tittel: a.tittel, forfatter: a.author, ingress: a.ingress, tekst: a.body.slice(0, MAX_EXAMPLE_CHARS) };
    });
    cachedAt = Date.now();
    return cachedExamples;
  } catch (err) {
    return [];
  }
}

const STYLE_PRINCIPLES = `SKRIVESTIL — nyhetsjournalistikk på norsk, i tradisjonen til de beste norske nyhetsdeskene (Aftenposten-nivå), i Dronemagasinets egen stemme:

TITTEL
- Sier konkret hva som har skjedd eller hva saken er, med subjekt og aktivt verb («Luftfartstilsynet vil la operatører søke om rammetillatelse»). 6–12 ord.
- Ikke overdriv sakens status: et forslag er et forslag, en søknad er en søknad, en høring er en høring — bruk aldri verb som antyder at noe er vedtatt, godkjent eller gjennomført når det ikke er det («søker om», «foreslår», «vil ha» — ikke «åpner», «innfører», «får»).
- Ingen clickbait, ingen tåkete kolon-titler, ingen spørsmålstitler med mindre spørsmålet er genuint sakens kjerne. Ikke gjenta ingressen ordrett.

INGRESS (1–2 setninger, maks ca. 40 ord)
- Nyhetstrekanten: det viktigste først — hvem gjør hva, og hvorfor det angår leseren nå. Ta med det ene konkrete tallet/datoen/fristen som betyr mest.
- Første avsnitt i teksten skal IKKE gjenta ingressen, men bygge videre: hvem sier/skriver dette, og hva er det nærmere innholdet.

LEDD OG UTVALG
- Første avsnitt forklarer saken på vanlig norsk for en leser som IKKE har lest dokumentet eller kilden: hva skjer, hvem er berørt, hva er det nye. Ikke begynn med «I søknaden datert …», «Dokumentet sier …» eller «Ifølge høringsnotatet …» som første ord — kilden navngis i første eller andre avsnitt, men leder ikke setningen.
- VELG UT, ikke gjengi. Et dokument på 10 sider gir ikke en sak på 10 sider. Ta med det som endrer leserens forståelse eller handlingsrom; utelat interne detaljer (delnummer, prosedyredetaljer, alle koordinater) med mindre de er selve nyheten.
- LENGDE: en vanlig nyhetssak er 250–450 ord (ca. 1 800–3 200 tegn), en større sak med flere vinkler inntil ca. 650 ord. Lengre er nesten alltid dårligere. Praktiske opplysninger (frist, adresse, saksnummer) samles kort til slutt.

BRØDTEKST
- Bygg som en omvendt pyramide: viktigst først, deretter forklaring, bakgrunn og reaksjoner. Sett det viktigste for leseren (droneoperatører, bransjen) i andre eller tredje avsnitt: «Hva betyr dette i praksis?»
- Korte avsnitt (1–3 setninger). Varier setningslengde; sikt mot under 25 ord per setning, uten å bli hakkete.
- Konkret fremfor abstrakt: navn, tall, steder, datoer, beløp. Forklar fagbegrep og forkortelser første gang (BVLOS, SORA, U-space), kort og uten å være nedlatende.
- Aktive verb, ikke substantivering og byråkratspråk («innfører» — ikke «gjennomfører en innføring av»; «søke» — ikke «inngi søknad»).
- Vær tilbakeholden med adjektiver og superlativer («spennende», «revolusjonerende», «historisk» er forbudt uten dekning). La fakta bære teksten. Ingen synsing i egen stemme.
- Sitater brukes når de sier noe faktaene ikke sier alene (mening, begrunnelse, følelse) — ikke for å gjengi fakta. Kort sitat, tydelig attribuert: «sier X, rolle».
- Ingen egne prognoser, forventninger eller spekulasjon («sannsynligvis», «trolig», «neste steg blir», «kan komme til å») — kun det en navngitt kilde faktisk sier om fremtiden, med kilden nevnt.
- ALDRI meta-kommentarer om materialet eller redaksjonens arbeid i selve teksten («materialet Dronemagasinet har fått oppgir ikke …», «det fremgår ikke av dokumentene vi har»). Hull i grunnlaget hører hjemme i kontrollpunkter, ikke i tittel, ingress eller brødtekst. Mangler en opplysning leseren trenger (f.eks. frist), skriv kort og nøytralt «Fristen er ikke opplyst» lenger ned — aldri som ingress eller mellomtittel.
- Vis usikkerhet og motstridende opplysninger åpent («det er ikke opplyst hvor mange», «kildene sier ulikt»). Skill klart mellom hva som er bekreftet, foreslått og antatt.
- Hver mellomtittel (2–4 i en middels lang sak) skal fortelle noe konkret om avsnittet under («Frist 15. november», «Gebyret settes til 4 500 kroner») — aldri generiske ord som «Bakgrunn» eller «Konklusjon».
- Avslutt med det leseren kan gjøre eller hva som skjer videre (frist, neste milepæl, hvem som bestemmer) — ikke med en oppsummering, moralisering eller floskel.

SPRÅK
- Bokmål. Norske anførselstegn «slik». Datoer «15. november 2026», tall med mellomrom som tusenskille («4 500 kroner»), «prosent» i løpende tekst.
- Unngå anglisismer og PR-språk («game changer», «løsninger», «satsing» uten innhold). Skriv «droner» og «droneoperatører» naturlig, uten unødvendig engelsk.
- Kildehenvisning i prosa, presist og varierende: «ifølge høringsnotatet», «skriver Luftfartstilsynet», «sier X til Y».`;

// Modellene kjenner ikke dagens dato — uten den skriver de «fristen er 31.
// oktober» om en frist som er utløpt, eller «vil ha innspill» i en tittel om
// en høring som er avsluttet. Legges derfor i alle skriveprompter.
var MONTHS_NB = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
function todayLine() {
  var d = new Date();
  return "DAGENS DATO: " + d.getDate() + ". " + MONTHS_NB[d.getMonth()] + " " + d.getFullYear() +
    " — bruk riktig tidsform: frister og hendelser som allerede har passert omtales i fortid (og en tittel/ingress skal ikke love noe som er over, f.eks. «vil ha innspill» når fristen har gått ut).";
}

function styleExamplesBlock(examples) {
  if (!examples || !examples.length) return "";
  return "EKSEMPLER PÅ DRONEMAGASINETS EGEN SKRIVEMÅTE (nyere saker av faste journalister — bruk som mal for tone, rytme, nøkternhet og oppbygging; ikke kopier formuleringer eller innhold):\n\n" +
    examples.map(function (e, i) {
      return "[Eksempel " + (i + 1) + " — " + e.forfatter + "]\nTittel: " + e.tittel + "\nIngress: " + e.ingress + "\nTekst:\n" + e.tekst;
    }).join("\n\n———\n\n");
}

const POLISH_SCHEMA = {
  name: "redigert_sak",
  strict: true,
  schema: {
    type: "object", additionalProperties: false,
    properties: {
      tittel: { type: "string" },
      titler_alternativer: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
      ingress: { type: "string" },
      hovedtekst_avsnitt: { type: "array", items: { type: "string" }, minItems: 1 },
      endringer: { type: "string", description: "1–2 setninger: hva du forbedret (til intern logg)." }
    },
    required: ["tittel", "titler_alternativer", "ingress", "hovedtekst_avsnitt", "endringer"]
  }
};

// Redaktørrunde: leser utkastet som en kritisk nyhetssjef og skriver det om
// til bedre norsk nyhetsprosa etter STYLE_PRINCIPLES — uten å endre fakta.
// Feiler stille og returnerer originalen (en mislykket polering skal aldri
// velte hele sakgenereringen).
async function polishManuscript(openaiKey, model, fields, examples, extraRules) {
  try {
    var system =
      "Du er nyhetssjef på et norsk nyhetsdesk (Aftenposten-nivå) og redigerer et førsteutkast for Dronemagasinet. Du får tittel, ingress og brødtekst. Oppdraget er å gjøre teksten vesentlig bedre nyhetsjournalistikk etter skriveprinsippene under — skarpere tittel og ingress, bedre rytme og struktur, konkrete og informative mellomtitler, færre floskler og adjektiver, tydeligere hva-betyr-dette-for-leseren.\n\n" +
      "UFRAVIKELIGE SPERRER:\n" +
      "- Du skal IKKE endre, legge til eller fjerne FAKTA: alle tall, datoer, frister, navn, steder, beløp, bestemmelser og påstander må være nøyaktig de samme som i utkastet. Ikke tilfør ny kunnskap fra egen hukommelse.\n" +
      "- Sitater (avsnitt som starter med \"> \") beholdes ordrett med samme attribusjon. Kildehenvisninger i prosa («ifølge …», «skriver …») beholdes — særlig navngivningen av kildemedium/dokument i første avsnitt.\n" +
      "- Usikkerhetsforbehold («ikke opplyst», «må avklares», «ikke bekreftet») beholdes.\n" +
      "- Bildemarkører (avsnitt som starter med \"![\") beholdes uendret og på samme sted i rekkefølgen.\n" +
      "- Tittel og ingress må ikke overdrive sakens status: forslag/søknad/høring skal ikke fremstilles som vedtatt eller besluttet. Behold verbene fra utkastet med mindre de er upresise.\n" +
      "- Mellomtitler skrives som eget avsnitt med prefiks \"## \", sitater med \"> \". Ingen klikkbare lenker eller URL-er i teksten. Fet skrift kun unntaksvis.\n" +
      "- Stram inn oppblåste eller gjentakende passasjer (utkastet skal helst bli kortere, aldri lengre enn originalen). Du kan utelate uviktige detaljer, men ALDRI tall/datoer/frister som står i tittel eller ingress, og ALDRI tilføy nye tall.\n" +
      "- Sørg for at første avsnitt forklarer saken på vanlig norsk uten å begynne med «I søknaden…»/«Ifølge…», og at kilden navngis i første eller andre avsnitt.\n" +
      (extraRules ? extraRules + "\n" : "") +
      "\n" + STYLE_PRINCIPLES;

    var user =
      todayLine() + "\n\n" +
      (examples && examples.length ? styleExamplesBlock(examples) + "\n\n=====\n\n" : "") +
      "UTKAST SOM SKAL REDIGERES:\n\nTittel: " + fields.tittel + "\nIngress: " + fields.ingress + "\n\nBrødtekst (ett avsnitt per linje, blank linje mellom):\n" +
      (fields.hovedtekst_avsnitt || []).join("\n\n");

    var res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + openaiKey },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: POLISH_SCHEMA }
      })
    });
    if (!res.ok) return { fields: fields, polished: false };
    var data = await res.json();
    var out = JSON.parse(data.choices[0].message.content);
    if (!out.tittel || !out.ingress || !out.hovedtekst_avsnitt || !out.hovedtekst_avsnitt.length) return { fields: fields, polished: false };

    // Sikkerhetsnett: redigeringen får utelate detaljer, men aldri tilføre
    // eller endre tall — og tall i tittel/ingress må bevares.
    function numbers(t) { return (String(t).match(/\d[\d\s.,]*\d|\d/g) || []).map(function (n) { return n.replace(/[\s.,]/g, ""); }).filter(function (n) { return n.length >= 2; }); }
    var origAll = numbers([fields.tittel, fields.ingress].concat(fields.hovedtekst_avsnitt || []).join(" "));
    var origKey = numbers([fields.tittel, fields.ingress].join(" "));
    var outAll = numbers([out.tittel, out.ingress].concat(out.hovedtekst_avsnitt).join(" "));
    var outFlat = [out.tittel, out.ingress].concat(out.hovedtekst_avsnitt).join(" ").replace(/[\s.,]/g, "");
    var nyeTall = outAll.filter(function (n) { return origAll.indexOf(n) === -1; });
    if (nyeTall.length) return { fields: fields, polished: false, forkastet: "nye/endrede tall: " + nyeTall.slice(0, 5).join(", ") };
    var mistet = origKey.filter(function (n) { return outFlat.indexOf(n) === -1; });
    if (mistet.length) return { fields: fields, polished: false, forkastet: "mistet nøkkeltall: " + mistet.slice(0, 5).join(", ") };
    // For mye kortere = sannsynligvis tapt innhold.
    var lenBefore = (fields.hovedtekst_avsnitt || []).join(" ").length, lenAfter = out.hovedtekst_avsnitt.join(" ").length;
    if (lenAfter < lenBefore * 0.55) return { fields: fields, polished: false, forkastet: "for mye kuttet" };

    // Bildemarkører og antall sitater må være bevart.
    function count(arr, re) { return (arr || []).filter(function (p) { return re.test(p); }).length; }
    if (count(out.hovedtekst_avsnitt, /^!\[/) !== count(fields.hovedtekst_avsnitt, /^!\[/) ||
        count(out.hovedtekst_avsnitt, /^> /) !== count(fields.hovedtekst_avsnitt, /^> /)) {
      return { fields: fields, polished: false, forkastet: "bildemarkører/sitater endret" };
    }

    var merged = Object.assign({}, fields, {
      tittel: out.tittel, titler_alternativer: out.titler_alternativer,
      ingress: out.ingress, hovedtekst_avsnitt: out.hovedtekst_avsnitt
    });
    return { fields: merged, polished: true, endringer: out.endringer };
  } catch (err) {
    return { fields: fields, polished: false };
  }
}

module.exports = { todayLine, STYLE_PRINCIPLES, fetchDronemagExamples, styleExamplesBlock, polishManuscript, parseDronemagArticle };
