// Kildekontroll-PORT: kjører kildevurdering (lib/sourceCheck.js) automatisk på
// nylig RSS-innhentede idéer, og fjerner dem som får anbefalingen
// "BØR IKKE BRUKES" — FØR redaksjonen noen gang ser dem, på samme måte som
// relevansfilteret (lib/relevance.js + rss-poll.js) allerede fjerner
// ikke-dronerelevante saker før de blir en idé.
//
// Kjøres av netlify/functions/source-gate-background.js (en Background
// Function), trigget av netlify/functions/source-gate-trigger.js (en vanlig
// SCHEDULED function). To separate funksjoner er nødvendig fordi Netlifys
// scheduled functions har en hard grense på 30 sekunder, mens ett eneste
// gpt-5-search-api-kall (ekte websøk) normalt tar 15-30 sekunder alene —
// altfor tregt til å gjøre inne i selve RSS-pollingen eller i en vanlig
// scheduled function. Background functions har derimot opptil 15 minutter,
// og siden kildevurderingene kjøres PARALLELT (Promise.allSettled — hver er
// et I/O-kall, ikke CPU-arbeid), er den reelle ventetiden for et helt parti
// omtrent like lang som den TREGESTE enkeltsjekken, ikke summen av alle.
//
// Rører bevisst KUN saker som (a) fortsatt står i "ide" OG (b) ble oppdaget
// automatisk via RSS OG (c) ikke allerede har en kildevurdering. En sak et
// menneske selv har lagt inn, eller allerede har flyttet videre, røres aldri.

const { checkSource } = require("./sourceCheck.js");

const MAX_PER_RUN = 15;
const RSS_HISTORIKK_RE = /Automatisk oppdaget via RSS-kilde: (.+)$/;

function extractRssFeedName(historikk) {
  var entry = (historikk || []).find(function (h) { return RSS_HISTORIKK_RE.test(h.text || ""); });
  if (!entry) return null;
  var m = entry.text.match(RSS_HISTORIKK_RE);
  return m ? m[1].trim() : null;
}

// supabase: service_role-klient (ingen innlogget bruker å kjøre dette som —
// samme mønster som rss-poll.js).
async function gateNewIdeas(supabase, openaiKey, maxPerRun) {
  var limit = maxPerRun || MAX_PER_RUN;
  var casesRes = await supabase.from("cases").select("*")
    .eq("status", "ide").is("kildevurdering_ts", null)
    .order("created_at").limit(limit + 1);
  if (casesRes.error) throw new Error(casesRes.error.message);

  var all = (casesRes.data || []).filter(function (c) {
    return (c.historikk || []).some(function (h) { return RSS_HISTORIKK_RE.test(h.text || ""); });
  });
  var overflow = Math.max(0, all.length - limit);
  var cases = all.slice(0, limit);

  if (!cases.length) {
    return { sjekket: 0, fjernet: [], beholdt: 0, feilet: [], overflow: overflow };
  }

  var checked = await Promise.allSettled(cases.map(async function (c) {
    var feedName = extractRssFeedName(c.historikk);
    var extraContext = feedName ? "Saken ble automatisk oppdaget via RSS-kilden «" + feedName + "» — ta dette med i vurderingen av avsender/type kilde der det er relevant." : "";
    var result = await checkSource(supabase, openaiKey, c.id, extraContext);
    return { id: c.id, title: c.title, kildevurdering: result.kildevurdering };
  }));

  var fjernet = [], feilet = [], beholdt = 0, toDelete = [];

  checked.forEach(function (r, i) {
    if (r.status === "rejected") {
      feilet.push({ title: cases[i].title, error: r.reason ? r.reason.message : "ukjent feil" });
      return;
    }
    var kv = r.value.kildevurdering;
    if (kv.anbefaling === "BOR_IKKE_BRUKES") {
      toDelete.push(r.value.id);
      fjernet.push({ title: r.value.title, troverdighet_score: kv.troverdighet_score, kort_vurdering: kv.kort_vurdering });
    } else {
      beholdt++;
    }
  });

  if (toDelete.length) {
    var delRes = await supabase.from("cases").delete().in("id", toDelete);
    if (delRes.error) throw new Error("Kunne ikke slette: " + delRes.error.message);
  }

  return { sjekket: cases.length, fjernet: fjernet, beholdt: beholdt, feilet: feilet, overflow: overflow };
}

module.exports = { gateNewIdeas, MAX_PER_RUN, extractRssFeedName };
