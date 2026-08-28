// Kjører automatisk hver time (se schedule nederst) og ved manuelt kall.
// Henter alle aktive RSS-kilder fra Supabase, finner nye saker (basert på
// guid/lenke) og legger dem inn i "cases" med status "ide" — allerede
// AI-vurdert (triage) med én gang, klare til å godkjennes.
//
// Bruker service_role-nøkkelen — denne funksjonen kjører kun server-side på
// Netlify og eksponerer aldri nøkkelen til nettleseren.

const { schedule } = require("@netlify/functions");
const Parser = require("rss-parser");
const { createClient } = require("@supabase/supabase-js");
const { checkRelevance } = require("./lib/relevance.js");
const { runTriage } = require("./lib/triage.js");
const { archiveOldIdeas, DEFAULT_MAX_AGE_MONTHS } = require("./lib/ageGate.js");

const parser = new Parser({ timeout: 15000 });

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Mangler SUPABASE_URL og/eller SUPABASE_SERVICE_ROLE_KEY som miljøvariabler i Netlify."
    );
  }
  return createClient(url, key);
}

// rss-parser normaliserer til item.isoDate når feeden har en gyldig dato —
// item.pubDate er rå originaltekst og brukes kun som fallback (Date-
// konstruktøren tolker de vanlige RSS-datoformatene, men ikke alltid).
function parsePublishedDate(item) {
  var raw = item.isoDate || item.pubDate;
  if (!raw) return null;
  var d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function monthsAgo(n) {
  var d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

async function pollAllSources(supabase) {
  const { data: sources, error } = await supabase
    .from("sources")
    .select("*")
    .eq("active", true);

  if (error) throw new Error("Kunne ikke hente kildeliste: " + error.message);

  const openaiKey = process.env.OPENAI_API_KEY;
  const ageCutoff = monthsAgo(DEFAULT_MAX_AGE_MONTHS);
  const report = { kilderSjekket: 0, nyeSaker: 0, hoppetOverIkkeRelevant: 0, hoppetOverForGammel: 0, feil: [] };
  const newCaseIds = [];

  for (const source of sources || []) {
    report.kilderSjekket++;
    let feed;
    try {
      feed = await parser.parseURL(source.feed_url);
    } catch (err) {
      report.feil.push(`${source.name}: ${err.message}`);
      continue;
    }

    // Nyeste 25 saker per kilde per kjøring er rikelig for et team på denne
    // størrelsen og hindrer at en stor, ukjent feed oversvømmer saksbanken.
    const items = (feed.items || []).slice(0, 25);

    for (const item of items) {
      const guid = item.guid || item.link || item.title;
      if (!guid) continue;

      const { data: existing } = await supabase
        .from("seen_items")
        .select("id")
        .eq("source_id", source.id)
        .eq("guid", guid)
        .maybeSingle();

      if (existing) continue;

      const title = (item.title || "(uten tittel)").trim();
      const publishedAt = parsePublishedDate(item);

      // For gammel til å i det hele tatt bli en idé — samme prinsipp som
      // relevans- og kildekontrollen: ALDRI opprett saken i utgangspunktet,
      // ikke rydd den bort etterpå. Ukjent dato (publishedAt === null)
      // blokkeres IKKE her — vi skal ikke anta at ukjent = gammel.
      if (publishedAt && publishedAt < ageCutoff) {
        const { error: seenErr } = await supabase.from("seen_items").insert({ source_id: source.id, guid });
        if (seenErr) continue;
        report.hoppetOverForGammel++;
        continue;
      }

      // Sjekk relevans FØR noe lagres som "sett" — feiler kallet (nettverk/
      // API-feil), skal saken prøves på nytt neste kjøring, ikke gå tapt for
      // godt. Kun en fullført vurdering (uansett utfall) markeres som sett.
      let relevant = true;
      let relevansBegrunnelse = "";
      if (openaiKey) {
        try {
          const verdict = await checkRelevance(openaiKey, title, source.name ? "Kilde: " + source.name : "");
          relevant = verdict.relevant;
          relevansBegrunnelse = verdict.begrunnelse;
        } catch (err) {
          report.feil.push(`Relevanssjekk feilet for "${title}" (prøves igjen neste kjøring): ${err.message}`);
          continue; // ikke marker som sett — prøv igjen neste time
        }
      }

      const { error: seenErr } = await supabase
        .from("seen_items")
        .insert({ source_id: source.id, guid });
      // Om innsetting feiler pga. race (to kjøringer samtidig), hopp over —
      // det betyr at en annen kjøring allerede har registrert denne.
      if (seenErr) continue;

      if (!relevant) {
        report.hoppetOverIkkeRelevant++;
        continue;
      }

      const nowIso = new Date().toISOString();
      // Kilder: artikkelens egen lenke først (kilder[0] — det er den resten
      // av appen, f.eks. kildevurdering/manusgenerering, alltid leser), og
      // deretter selve RSS-feeden som en egen, synlig og redigerbar kilde-
      // rad, slik at det alltid er tydelig hvilken feed saken kom inn via —
      // ikke bare i historikken, men i selve Kilder-listen på saken.
      const kilder = [item.link || source.feed_url];
      if (source.feed_url && source.feed_url !== kilder[0]) kilder.push(source.feed_url);

      const { data: inserted, error: caseErr } = await supabase.from("cases").insert({
        title: title,
        sakstype: "redaksjonell",
        hastegrad: "planlagt",
        status: "ide",
        eier: "Ikke tildelt",
        neste_handling: `Vurder relevans og eier (oppdaget via RSS: ${source.name})`,
        kilder: kilder,
        nettsted: "dronemag.no",
        triage: { aktualitet: 2, betydning: 2, innsats: 2, eksklusivitet: 1 },
        kilde_publisert_dato: publishedAt ? publishedAt.toISOString() : null,
        historikk: [
          { ts: nowIso, text: `Automatisk oppdaget via RSS-kilde: ${source.name}` }
        ].concat(relevansBegrunnelse ? [{ ts: nowIso, text: "AI-relevanssjekk: " + relevansBegrunnelse }] : []),
      }).select("id").single();

      if (caseErr) {
        report.feil.push(`Kunne ikke opprette sak fra "${title}": ${caseErr.message}`);
        continue;
      }

      report.nyeSaker++;
      if (inserted && inserted.id) newCaseIds.push(inserted.id);
    }

    await supabase
      .from("sources")
      .update({ last_polled_at: new Date().toISOString() })
      .eq("id", source.id);
  }

  // AI-vurdering (triage) med én gang saken kommer inn, ikke først når noen
  // trykker "Kjør AI-vurdering" manuelt — samme mønster som relevanssjekken
  // over. runTriage gjør egen batching/parallellisering og feiler aldri
  // hele pollingen selv om enkelte vurderinger skulle feile.
  if (openaiKey && newCaseIds.length) {
    try {
      report.autoTriage = await runTriage(supabase, openaiKey, newCaseIds);
    } catch (err) {
      report.feil.push(`Automatisk AI-vurdering feilet for hele partiet: ${err.message}`);
    }
  }

  // Arkiver "Idé"-saker som har blitt liggende og er blitt for gamle — ren
  // datosjekk, ingen AI-kall, trygt å ta med her (se lib/ageGate.js).
  try {
    report.autoArkivert = await archiveOldIdeas(supabase);
  } catch (err) {
    report.feil.push(`Automatisk arkivering av gamle idéer feilet: ${err.message}`);
  }

  return report;
}

const runPoll = async function () {
  try {
    const supabase = getSupabase();
    const report = await pollAllSources(supabase);
    console.log("RSS-poll fullført:", JSON.stringify(report));
    return { statusCode: 200, body: JSON.stringify(report) };
  } catch (err) {
    console.error("RSS-poll feilet:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Kjør hver time. Norsk redaksjonelt volum (~10 tips/dag totalt, ifølge
// avklaringssvarene) trenger ikke hyppigere polling — juster ved behov.
exports.handler = schedule("@hourly", runPoll);
