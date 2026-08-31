// Orkestrerer det generelle websøket (lib/webSearch.js) og oppretter nye
// "Idé"-saker av ekte treff — samme grunnprinsipp som rss-poll.js, bare med
// websøk i stedet for RSS-parsing som kilde til nye kandidater. Kjøres av
// web-search-background.js (Background Function, trigges av
// web-search-trigger.js — se den filen for hvorfor dette er splittet i to,
// samme begrunnelse som source-gate-trigger/-background).

const { checkRelevance } = require("./relevance.js");
const { runTriage } = require("./triage.js");
const { searchCivilianDroneNews, searchDefenseDroneNews, searchWebsiteSource, searchKeywordMentions } = require("./webSearch.js");

var DAYS_BACK = 3; // sveipet kjører daglig — 3 dager gir litt overlapp/buffer, ikke bare "siden i går"
var KEYWORD_BATCH_SIZE = 15; // hold hvert søkekall til en håndterlig liste

function parseDate(s) {
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function chunk(arr, size) {
  var out = [];
  for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function createCaseFromHit(supabase, openaiKey, hit, extraContext, kildeLabel, report) {
  if (!hit.url || !/^https?:\/\//i.test(hit.url)) return;

  var seenRes = await supabase.from("seen_urls").select("url").eq("url", hit.url).maybeSingle();
  if (seenRes.data) return; // allerede sett (av dette eller et tidligere sveip)

  var relevant = true, relevansBegrunnelse = "";
  if (openaiKey) {
    try {
      var verdict = await checkRelevance(openaiKey, hit.tittel, extraContext);
      relevant = verdict.relevant;
      relevansBegrunnelse = verdict.begrunnelse;
    } catch (err) {
      report.feil.push('Relevanssjekk feilet for "' + hit.tittel + '" (prøves igjen neste sveip): ' + err.message);
      return; // ikke marker som sett — prøv igjen neste kjøring
    }
  }

  var insertSeen = await supabase.from("seen_urls").insert({ url: hit.url });
  if (insertSeen.error) return; // race mot en annen samtidig kjøring — hopp over

  if (!relevant) {
    report.hoppetOverIkkeRelevant++;
    return;
  }

  var nowIso = new Date().toISOString();
  var publishedAt = parseDate(hit.publisert_dato);
  var caseRes = await supabase.from("cases").insert({
    title: hit.tittel || "(uten tittel)",
    sakstype: "redaksjonell",
    hastegrad: "planlagt",
    status: "ide",
    eier: "Ikke tildelt",
    neste_handling: "Vurder relevans og eier (oppdaget via websøk: " + kildeLabel + ")",
    kilder: [hit.url],
    nettsted: "dronemag.no",
    triage: { aktualitet: 2, betydning: 2, innsats: 2, eksklusivitet: 1 },
    kilde_publisert_dato: publishedAt ? publishedAt.toISOString() : null,
    historikk: [
      { ts: nowIso, text: "Automatisk oppdaget via websøk: " + kildeLabel + (hit.utgiver ? " (utgiver: " + hit.utgiver + ")" : "") },
      { ts: nowIso, text: "AI: " + hit.kort_hvorfor_relevant }
    ].concat(relevansBegrunnelse ? [{ ts: nowIso, text: "AI-relevanssjekk: " + relevansBegrunnelse }] : [])
  }).select("id").single();

  if (caseRes.error) {
    report.feil.push('Kunne ikke opprette sak fra "' + hit.tittel + '": ' + caseRes.error.message);
    return;
  }

  report.nyeSaker++;
  if (caseRes.data && caseRes.data.id) report.newCaseIds.push(caseRes.data.id);
}

async function runWebSearchSweep(supabase, openaiKey) {
  var report = { sivileTreff: 0, forsvarTreff: 0, nettstedKilderSjekket: 0, sokeordSjekket: 0, nyeSaker: 0, hoppetOverIkkeRelevant: 0, feil: [], newCaseIds: [] };
  if (!openaiKey) return report;

  // 1a. Sivilt/kommersielt sveip
  try {
    var sivile = await searchCivilianDroneNews(openaiKey, DAYS_BACK);
    report.sivileTreff = sivile.length;
    for (var i = 0; i < sivile.length; i++) {
      await createCaseFromHit(supabase, openaiKey, sivile[i], "", "generelt websøk (sivilt)", report);
    }
  } catch (err) {
    report.feil.push("Sivilt websøk feilet: " + err.message);
  }

  // 1b. Forsvar/beredskap-sveip — atskilt fra det sivile søket over med
  // vilje (se lib/webSearch.js) for å garantere en reell blanding, i stedet
  // for å håpe at én prompt-instruks balanserer et enkelt bredt søk.
  try {
    var forsvar = await searchDefenseDroneNews(openaiKey, DAYS_BACK);
    report.forsvarTreff = forsvar.length;
    for (var d = 0; d < forsvar.length; d++) {
      await createCaseFromHit(supabase, openaiKey, forsvar[d], "", "generelt websøk (forsvar/beredskap)", report);
    }
  } catch (err) {
    report.feil.push("Forsvar/beredskap-websøk feilet: " + err.message);
  }

  // 2. Nettsted-kilder uten RSS (sources.type = 'website')
  var websiteRes = await supabase.from("sources").select("*").eq("active", true).eq("type", "website");
  if (!websiteRes.error) {
    for (var s = 0; s < (websiteRes.data || []).length; s++) {
      var site = websiteRes.data[s];
      report.nettstedKilderSjekket++;
      try {
        var siteHits = await searchWebsiteSource(openaiKey, site.feed_url, site.name, DAYS_BACK);
        for (var h = 0; h < siteHits.length; h++) {
          await createCaseFromHit(supabase, openaiKey, siteHits[h], "Kilde: " + site.name, site.name, report);
        }
        await supabase.from("sources").update({ last_polled_at: new Date().toISOString() }).eq("id", site.id);
      } catch (err) {
        report.feil.push(site.name + " (nettsted-søk): " + err.message);
      }
    }
  }

  // 3. Navngitte operatør-/selskapsnavn (watch_keywords)
  var keywordsRes = await supabase.from("watch_keywords").select("term");
  if (!keywordsRes.error && keywordsRes.data && keywordsRes.data.length) {
    var terms = keywordsRes.data.map(function (r) { return r.term; });
    var batches = chunk(terms, KEYWORD_BATCH_SIZE);
    for (var b = 0; b < batches.length; b++) {
      report.sokeordSjekket += batches[b].length;
      try {
        var kwHits = await searchKeywordMentions(openaiKey, batches[b], DAYS_BACK);
        for (var k = 0; k < kwHits.length; k++) {
          var extra = "Nevner en registrert droneoperatør/-selskap UAS Norway følger med på — regn dette som en sterk relevans-indikasjon selv om ordet «drone» ikke står eksplisitt i tittelen.";
          await createCaseFromHit(supabase, openaiKey, kwHits[k], extra, "søkeord (operatørnavn)", report);
        }
      } catch (err) {
        report.feil.push("Søkeord-batch feilet: " + err.message);
      }
    }
  }

  // AI-vurdering med én gang, samme mønster som rss-poll.js.
  if (report.newCaseIds.length) {
    try {
      report.autoTriage = await runTriage(supabase, openaiKey, report.newCaseIds);
    } catch (err) {
      report.feil.push("Automatisk AI-vurdering feilet for hele partiet: " + err.message);
    }
  }

  return report;
}

module.exports = { runWebSearchSweep, DAYS_BACK };
