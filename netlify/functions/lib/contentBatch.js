// "Bestill innhold" — AI produserer flere INFO-/contentsaker (f.eks. 4 saker
// som skal selge et arrangement) i én runde, skrevet i samme språk og stil
// som Dronemagasinet/UAS Norway sine faktiske, tidligere INFO-saker.
//
// Stilgrunnlaget hentes LIVE fra uasnorway.no (WordPress-kategorien "INFO",
// offentlig REST-API, ingen innlogging nødvendig) — ikke fra en statisk,
// innebygd prompt — slik at tonen følger med når redaksjonen endrer den.
//
// Ett samlet AI-kall for hele batchen (i stedet for ett per sak) er bevisst:
// da ser modellen alle sakene samtidig og kan gi hver sin, tydelig
// forskjellige vinkel i stedet for fire nesten identiske varianter.
//
// Ingen websøk her: dette er salgs-/informasjonstekst basert på det
// redaksjonen selv oppgir (arrangementet, lenke, notat), ikke research.
// Modellen får derfor forbud mot å finne på fakta (priser, datoer,
// foredragsholdere osv.) — manglende opplysninger markeres i stedet.

const { Document, Packer } = require("docx");
const { callOpenAI, fetchSourceArticle, buildDocxParagraphs, MODEL } = require("./manuscript.js");

const MAX_EXAMPLES = 8;
const MAX_EXAMPLE_CHARS = 1400;
const MAX_ANTALL = 8;

function stripTags(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#8211;|&ndash;/g, "–").replace(/&#8217;/g, "’").replace(/&hellip;|&#8230;/g, "…")
    .replace(/\s+/g, " ").trim();
}

// Henter de nyeste INFO-sakene fra uasnorway.no. Feiler stille (tom liste) —
// da skriver modellen kun ut fra den innebygde stilbeskrivelsen i stedet for
// å la hele bestillingen feile på et midlertidig nettverksproblem.
async function fetchInfoStyleExamples() {
  var base = (process.env.WP_UASNORWAY_URL || "https://www.uasnorway.no").replace(/\/+$/, "");
  try {
    var catRes = await fetch(base + "/wp-json/wp/v2/categories?slug=info&_fields=id");
    var cats = catRes.ok ? await catRes.json() : [];
    if (!cats.length) return [];
    var postsRes = await fetch(base + "/wp-json/wp/v2/posts?categories=" + cats[0].id + "&per_page=" + MAX_EXAMPLES + "&orderby=date&order=desc&_fields=title,meta,content");
    if (!postsRes.ok) return [];
    var posts = await postsRes.json();
    return posts.map(function (p) {
      var meta = p.meta || {};
      var ingress = stripTags(meta.excerpt);
      var tekst = stripTags(meta.content || (p.content && p.content.rendered));
      return { tittel: stripTags(p.title && p.title.rendered), ingress: ingress, tekst: tekst.slice(0, MAX_EXAMPLE_CHARS) };
    }).filter(function (e) { return e.tittel && (e.ingress || e.tekst); });
  } catch (err) {
    return [];
  }
}

const SYSTEM_PROMPT = `Du er innholdsprodusent for UAS Norway (uasnorway.no) og Dronemagasinet. Du skriver INFO-saker: korte, konkrete informasjons-/salgstekster som skal få leseren til å handle (melde seg på, bestille billett, sende inn forslag, lese mer) — uten å høres ut som reklame.

STIL — følg de faktiske eksemplene du får oppgitt (tidligere INFO-saker fra uasnorway.no) tett: samme tone, samme lengde, samme oppbygging. Typiske trekk:
- Ingress på 1–2 setninger som gir leseren en grunn til å bry seg og nevner det viktigste (hva/når/frist), ofte formulert som et spørsmål eller en direkte henvendelse.
- Kort brødtekst (typisk 3–6 korte avsnitt, samlet ca. 500–800 tegn for arrangementssaker), direkte tiltale ("du", "vi", "dere"), aktiv form, konkrete spørsmål og praktiske detaljer, ingen svulstige superlativer eller floskler.
- Avslutt med en tydelig handlingsoppfordring i siste avsnitt (f.eks. "Les mer og meld deg på", "Velg billett og meld deg på her") — selve lenken legges inn av redaksjonen, skriv kun oppfordringen.
Ikke kopier setninger fra eksemplene — bruk dem som stilmal, ikke som innhold.

ABSOLUTT REGEL — INGEN OPPDIKTEDE FAKTA: bruk KUN opplysninger som står i oppdraget, arrangementsinformasjonen eller kildeteksten du får. Dikt ALDRI opp priser, datoer, frister, foredragsholdere, partnere, tall, sitater eller programpunkter. Trenger teksten en opplysning du ikke har, skriv en tydelig plassholder i hakeparentes (f.eks. "[PRIS]", "[FRIST]") og legg et konkret punkt i kontrollpunkter om at den må fylles inn/avklares.

FLERE SAKER I ÉN BESTILLING: når du skal lage flere saker, må hver sak ha en tydelig FORSKJELLIG vinkel og hoveddel (f.eks. én om pris/frist og hvorfor bestille nå, én om programmet/temaet, én rettet mot en bestemt målgruppe, én om hvem som deltar/partnere — tilpass til det oppdraget faktisk gir grunnlag for). Ingen to saker skal ha samme tittel, ingress eller åpning. Hver sak må stå på egne bein.

Skriv alt på norsk (bokmål). Fet skrift ("**tekst**") kun unntaksvis.`;

function buildSchema(antall) {
  return {
    name: "innholdssaker",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        saker: {
          type: "array", minItems: antall, maxItems: antall,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              vinkel: { type: "string", description: "Én kort setning: hva som er denne sakens spesifikke vinkel/hensikt (til intern bruk)." },
              tittel: { type: "string" },
              titler_alternativer: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
              ingress: { type: "string" },
              hovedtekst_avsnitt: { type: "array", items: { type: "string" }, minItems: 2 },
              kontrollpunkter: { type: "array", items: { type: "string" }, minItems: 1, description: "Konkrete ting redaksjonen må fylle inn/avklare før publisering (plassholdere, lenker, tall)." }
            },
            required: ["vinkel", "tittel", "titler_alternativer", "ingress", "hovedtekst_avsnitt", "kontrollpunkter"]
          }
        }
      },
      required: ["saker"]
    }
  };
}

async function recordFailureOn(supabase, caseId, message) {
  try {
    var cur = await supabase.from("cases").select("historikk").eq("id", caseId).maybeSingle();
    var historikk = (cur.data && cur.data.historikk) || [];
    await supabase.from("cases").update({
      historikk: [{ ts: new Date().toISOString(), text: "❌ Innholdsproduksjon feilet: " + message }].concat(historikk)
    }).eq("id", caseId);
  } catch (err) {
    console.error("Klarte ikke skrive feilmelding til sak " + caseId + ":", err);
  }
}

// opts: { caseIds (forhåndsopprettede plassholder-saker, én per ønsket sak),
//         oppdrag, event (rad fra events eller null), infoUrl, ekstra, nettsted }
async function generateContentBatch(supabase, openaiKey, opts) {
  var caseIds = (opts.caseIds || []).slice(0, MAX_ANTALL);
  var antall = caseIds.length;
  if (!antall) throw new Error("Ingen saker å produsere.");

  var examples = await fetchInfoStyleExamples();

  var kilder = [];
  var kildeTekster = [];
  var urls = [];
  if (opts.event && opts.event.url) urls.push({ url: opts.event.url, label: "Arrangementets nettside" });
  if (opts.infoUrl) urls.push({ url: opts.infoUrl, label: "Lenke oppgitt av redaksjonen" });
  for (var u = 0; u < urls.length; u++) {
    var art = await fetchSourceArticle(urls[u].url);
    if (art.ok && art.text) {
      kilder.push(urls[u].url);
      kildeTekster.push(urls[u].label + " (" + urls[u].url + "):\n" + art.text);
    }
  }

  var ev = opts.event;
  var userPrompt =
    "OPPDRAG FRA REDAKSJONEN:\n" + opts.oppdrag + "\n\n" +
    "ANTALL SAKER SOM SKAL PRODUSERES: " + antall + "\n\n" +
    (ev ? "ARRANGEMENT:\n- Navn: " + ev.title + "\n- Type: " + ev.event_type + "\n- Sted: " + ev.location + "\n- Startdato: " + ev.starts_on + "\n- Antall dager: " + ev.duration_days + (ev.url ? "\n- Nettside: " + ev.url : "") + "\n\n" : "") +
    (opts.ekstra ? "EKSTRA RETNING (målgruppe/vinkler/tone/budskap):\n" + opts.ekstra + "\n\n" : "") +
    (kildeTekster.length ? "KILDETEKST (eneste tillatte faktagrunnlag utover det over):\n" + kildeTekster.join("\n\n---\n\n") + "\n\n" : "") +
    (examples.length
      ? "EKSEMPLER PÅ TIDLIGERE INFO-SAKER FRA uasnorway.no (bruk som stilmal for tone, lengde og oppbygging):\n\n" +
        examples.map(function (e, i) {
          return "[Eksempel " + (i + 1) + "]\nTittel: " + e.tittel + "\nIngress: " + e.ingress + "\nTekst: " + e.tekst;
        }).join("\n\n")
      : "(Kunne ikke hente eksempler fra uasnorway.no akkurat nå — følg stilbeskrivelsen i systemprompten.)");

  var result = await callOpenAI(openaiKey, MODEL, SYSTEM_PROMPT, userPrompt, buildSchema(antall));
  var saker = result.saker || [];

  var lagret = 0, feilet = 0;
  for (var i = 0; i < caseIds.length; i++) {
    var s = saker[i];
    var caseId = caseIds[i];
    if (!s) { feilet++; await recordFailureOn(supabase, caseId, "AI leverte ikke alle de bestilte sakene."); continue; }
    try {
      var fields = {
        emnefelt: [],
        tittel: s.tittel,
        alt_tekst_bilde: "",
        bilde_er_illustrasjon: false,
        fotoKreditering: "",
        ingress: s.ingress,
        hovedtekst_avsnitt: s.hovedtekst_avsnitt,
        titler_alternativer: s.titler_alternativer,
        kilder_brukt: [],
        kontrollpunkter: s.kontrollpunkter,
        tidligere_dekning: null
      };
      var doc = new Document({ sections: [{ children: await buildDocxParagraphs(fields, null) }] });
      var buffer = await Packer.toBuffer(doc);
      var path = caseId + "/" + Date.now() + ".docx";
      var up = await supabase.storage.from("manus").upload(path, buffer, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", upsert: false
      });
      if (up.error) throw new Error("Kunne ikke laste opp manus: " + up.error.message);

      var cur = await supabase.from("cases").select("historikk, kilder").eq("id", caseId).maybeSingle();
      var historikk = [{
        ts: new Date().toISOString(),
        text: "Innholdssak produsert av AI (" + (i + 1) + " av " + antall + ") — vinkel: " + s.vinkel +
          (examples.length ? " — stil hentet fra " + examples.length + " tidligere INFO-saker" : " — OBS: fikk ikke hentet stileksempler") +
          " — " + s.kontrollpunkter.length + " kontrollpunkt(er) å avklare før publisering"
      }].concat((cur.data && cur.data.historikk) || []);

      var upd = await supabase.from("cases").update({
        title: s.tittel,
        oppsummering: s.vinkel,
        kilder: kilder.length ? kilder : ((cur.data && cur.data.kilder) || []),
        manus_url: path,
        manus_generert_ts: new Date().toISOString(),
        manus_tittel: s.tittel,
        manus_ingress: s.ingress,
        manus_hovedtekst: s.hovedtekst_avsnitt,
        manus_alt_tekst: "",
        manus_bilde_url: "",
        manus_foto: "",
        manus_emnefelt: [],
        manus_titler_alternativer: s.titler_alternativer,
        manus_tidligere_dekning: null,
        manus_kilder_brukt: [],
        manus_kontrollpunkter: s.kontrollpunkter,
        manus_bilde_er_illustrasjon: false,
        historikk: historikk
      }).eq("id", caseId);
      if (upd.error) throw new Error(upd.error.message);
      lagret++;
    } catch (err) {
      feilet++;
      await recordFailureOn(supabase, caseId, err.message);
    }
  }
  return { lagret: lagret, feilet: feilet, eksemplerBrukt: examples.length };
}

module.exports = { generateContentBatch, fetchInfoStyleExamples, recordFailureOn, MAX_ANTALL };
