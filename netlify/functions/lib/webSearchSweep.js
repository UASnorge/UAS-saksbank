// Orkestrerer det generelle websøket (lib/webSearch.js) og oppretter nye
// "Idé"-saker av ekte treff — samme grunnprinsipp som rss-poll.js, bare med
// websøk i stedet for RSS-parsing som kilde til nye kandidater. Kjøres av
// web-search-background.js (Background Function, trigges av
// web-search-trigger.js — se den filen for hvorfor dette er splittet i to,
// samme begrunnelse som source-gate-trigger/-background).

const { checkRelevance } = require("./relevance.js");
const { runTriage } = require("./triage.js");
const { verifyUrl } = require("./linkCheck.js");
const {
  searchCivilianDroneNews, searchIndustryDroneNews, searchPolicySecurityDroneNews, searchNordicRegulatoryNews, searchDefenseDroneNews,
  searchWebsiteSource, searchKeywordMentions
} = require("./webSearch.js");

// Nettsteder vi selv publiserer på — gpt-5-search-api har vist seg å av og
// til "finne" en sak som egentlig er egen, tidligere publisert
// dronemag.no/uasnorway.no-artikkel gjenkjent fra treningsdata, fremstilt
// som et ferskt, eksternt funn. Slike treff skal aldri bli en ny "idé".
var OWN_DOMAINS = ["dronemag.no", "uasnorway.no"];

function isOwnDomain(u) {
  try {
    var host = new URL(u).hostname.replace(/^www\./, "");
    return OWN_DOMAINS.some(function (d) { return host === d || host.endsWith("." + d); });
  } catch (e) {
    return false;
  }
}

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

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// gpt-5-search-api deler en org-omfattende TPM-kvote (tokens per minutt) med
// resten av appen. Et fullt sveip gjør 10+ søkekall etter hverandre (seks
// faste bukter + én per nettsted-kilde + én per søkeord-batch) — uten en
// liten pause mellom hvert kall traff produksjonskjøringen 429-feil på 7 av 9
// nettsted-kilder i praksis (oppdaget live under feilsøking 2026-09-23).
var SEARCH_CALL_DELAY_MS = 3000;

async function createCaseFromHit(supabase, openaiKey, hit, extraContext, kildeLabel, report) {
  if (!hit.url || !/^https?:\/\//i.test(hit.url)) return;
  if (isOwnDomain(hit.url)) return; // egen, allerede publisert sak — ikke en ny "idé"

  var seenRes = await supabase.from("seen_urls").select("url").eq("url", hit.url).maybeSingle();
  if (seenRes.data) return; // allerede sett (av dette eller et tidligere sveip)

  // Ekte HTTP-sjekk FØR noe annet — gpt-5-search-api kan dikte opp
  // troverdig utseende URL-er (samme svakhet som lib/linkCheck.js sin
  // begrunnelse beskriver for bilde-URL-er). En sak bygget på en lenke som
  // ikke faktisk finnes, er verre enn ingen sak.
  var urlCheck = await verifyUrl(hit.url);
  if (!urlCheck.ok) {
    var seenBad = await supabase.from("seen_urls").insert({ url: hit.url });
    if (!seenBad.error) report.hoppetOverUrlFeilet++;
    return;
  }

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
  var report = {
    sivileTreff: 0, industriTreff: 0, politiSikkerhetTreff: 0, regelverkTreff: 0, forsvarTreff: 0,
    nettstedKilderSjekket: 0, sokeordSjekket: 0, nyeSaker: 0, hoppetOverIkkeRelevant: 0, hoppetOverUrlFeilet: 0, feil: [], newCaseIds: []
  };
  if (!openaiKey) return report;

  // 1. Sivilt/kommersielt sveip (norsk/nordisk)
  try {
    var sivile = await searchCivilianDroneNews(openaiKey, DAYS_BACK);
    report.sivileTreff = sivile.length;
    for (var i = 0; i < sivile.length; i++) {
      await createCaseFromHit(supabase, openaiKey, sivile[i], "", "generelt websøk (sivilt)", report);
    }
  } catch (err) {
    report.feil.push("Sivilt websøk feilet: " + err.message);
  }

  // 1b. Bransje/industri (norsk) — dedikert, bredt søk i norsk fagpresse for
  // UAS Norway sine egne medlemmer. Se lib/webSearch.js sin begrunnelse
  // (elektro247.no/Nomadic Drones-eksempelet som glapp i det generelle søket).
  await sleep(SEARCH_CALL_DELAY_MS);
  try {
    // Litt bredere tidsvindu enn resten av sveipet (7 vs. 3 dager) — norsk
    // nisje-fagpresse publiserer sjeldnere enn de store nyhetssidene, så et
    // 3-dagersvindu ga for tynt utvalg i praksis.
    var industri = await searchIndustryDroneNews(openaiKey, 7);
    report.industriTreff = industri.length;
    for (var ind = 0; ind < industri.length; ind++) {
      await createCaseFromHit(supabase, openaiKey, industri[ind], "", "generelt websøk (bransje/industri)", report);
    }
  } catch (err) {
    report.feil.push("Bransje/industri-websøk feilet: " + err.message);
  }

  // 2. Politi/sikkerhet (norsk/nordisk) — den STØRSTE kategorien i praksis,
  // se lib/triage.js sin begrunnelse. Atskilt fra forsvar/militært under.
  await sleep(SEARCH_CALL_DELAY_MS);
  try {
    var politi = await searchPolicySecurityDroneNews(openaiKey, DAYS_BACK);
    report.politiSikkerhetTreff = politi.length;
    for (var p = 0; p < politi.length; p++) {
      await createCaseFromHit(supabase, openaiKey, politi[p], "", "generelt websøk (politi/sikkerhet)", report);
    }
  } catch (err) {
    report.feil.push("Politi/sikkerhet-websøk feilet: " + err.message);
  }

  // 3. Regelverk/infrastruktur (norsk/nordisk — Luftfartstilsynet/EASA/Avinor)
  await sleep(SEARCH_CALL_DELAY_MS);
  try {
    var regelverk = await searchNordicRegulatoryNews(openaiKey, DAYS_BACK);
    report.regelverkTreff = regelverk.length;
    for (var r = 0; r < regelverk.length; r++) {
      await createCaseFromHit(supabase, openaiKey, regelverk[r], "", "generelt websøk (regelverk/infrastruktur)", report);
    }
  } catch (err) {
    report.feil.push("Regelverk-websøk feilet: " + err.message);
  }

  // 4. Forsvar/militært — holdes bevisst MEGET smalt (maks 2 treff per
  // kjøring, se lib/webSearch.js). "Vi er ikke et forsvarsmagasin" —
  // beholdt som egen, atskilt funksjon nettopp for å kunne holdes smal,
  // i stedet for å blandes inn i et bredere søk og drukne det i volum.
  await sleep(SEARCH_CALL_DELAY_MS);
  try {
    var forsvar = await searchDefenseDroneNews(openaiKey, DAYS_BACK);
    report.forsvarTreff = forsvar.length;
    for (var d = 0; d < forsvar.length; d++) {
      await createCaseFromHit(supabase, openaiKey, forsvar[d], "", "generelt websøk (forsvar/militært)", report);
    }
  } catch (err) {
    report.feil.push("Forsvar/militært-websøk feilet: " + err.message);
  }

  // 5. Nettsted-kilder uten RSS (sources.type = 'website') — valgfritt, ikke en forutsetning
  await sleep(SEARCH_CALL_DELAY_MS);
  var websiteRes = await supabase.from("sources").select("*").eq("active", true).eq("type", "website");
  if (!websiteRes.error) {
    for (var s = 0; s < (websiteRes.data || []).length; s++) {
      if (s > 0) await sleep(SEARCH_CALL_DELAY_MS);
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

  // 6. Navngitte søkeord/temaer (watch_keywords) — selskapsnavn, men også
  // generelle temaer/forskrifter/høringer redaksjonen ønsker tett
  // oppfølging av. Dette er ment å kunne fungere som en fullverdig
  // ingest-mekanisme på egen hånd, ikke bare et tillegg til kildelisten.
  var keywordsRes = await supabase.from("watch_keywords").select("term");
  if (!keywordsRes.error && keywordsRes.data && keywordsRes.data.length) {
    var terms = keywordsRes.data.map(function (r) { return r.term; });
    var batches = chunk(terms, KEYWORD_BATCH_SIZE);
    for (var b = 0; b < batches.length; b++) {
      await sleep(SEARCH_CALL_DELAY_MS);
      report.sokeordSjekket += batches[b].length;
      try {
        var kwHits = await searchKeywordMentions(openaiKey, batches[b], DAYS_BACK);
        for (var k = 0; k < kwHits.length; k++) {
          var extra = "Treff på et søkeord/tema UAS Norway følger med på — regn dette som en sterk relevans-indikasjon selv om ordet «drone» ikke står eksplisitt i tittelen.";
          await createCaseFromHit(supabase, openaiKey, kwHits[k], extra, "søkeord", report);
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
