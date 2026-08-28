// Arkiverer automatisk "Idé"-saker som er blitt for gamle — målt fra når
// SAKEN opprinnelig ble publisert HOS KILDEN (kilde_publisert_dato), ikke når
// den kom inn i saksbanken. Mangler en sak den datoen (manuelt tips, eller en
// RSS-feed uten dato på elementet), brukes created_at som beste anslag i
// stedet for aldri å arkivere den.
//
// Arkiverer (status "arkivert"), sletter ALDRI — reversibelt, og saken er
// fortsatt søkbar i listevisning om noen trenger å sjekke tilbake senere.
// Rører bevisst KUN status "ide" — saker et menneske allerede har godkjent
// eller jobbet videre med, skal ikke forsvinne bare fordi nyheten er gammel.
//
// Ingen AI-kall — ren datosjekk — trygt å kjøre synkront inni rss-poll.js
// (ingen Background Function nødvendig, i motsetning til kildekontrollen).

const DEFAULT_MAX_AGE_MONTHS = 2;

function monthsAgo(n) {
  var d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

// supabase: service_role- eller RLS-klient — begge fungerer, samme som resten
// av lib/-modulene.
async function archiveOldIdeas(supabase, maxAgeMonths) {
  var cutoff = monthsAgo(maxAgeMonths || DEFAULT_MAX_AGE_MONTHS);

  var casesRes = await supabase.from("cases").select("id, title, kilde_publisert_dato, created_at, historikk").eq("status", "ide");
  if (casesRes.error) throw new Error(casesRes.error.message);

  var toArchive = (casesRes.data || []).filter(function (c) {
    var effective = c.kilde_publisert_dato || c.created_at;
    if (!effective) return false;
    var d = new Date(effective);
    return !isNaN(d.getTime()) && d < cutoff;
  });

  if (!toArchive.length) return { arkivert: [], feilet: [] };

  var arkivert = [], feilet = [];
  var results = await Promise.allSettled(toArchive.map(async function (c) {
    var historikk = [{
      ts: new Date().toISOString(),
      text: "Automatisk arkivert — saken er eldre enn " + (maxAgeMonths || DEFAULT_MAX_AGE_MONTHS) + " måneder og ble aldri jobbet videre med"
    }].concat(c.historikk || []);
    var res = await supabase.from("cases").update({ status: "arkivert", historikk: historikk }).eq("id", c.id);
    if (res.error) throw new Error(res.error.message);
    return { id: c.id, title: c.title };
  }));

  results.forEach(function (r, i) {
    if (r.status === "fulfilled") arkivert.push(r.value);
    else feilet.push({ title: toArchive[i].title, error: r.reason ? r.reason.message : "ukjent feil" });
  });

  return { arkivert: arkivert, feilet: feilet };
}

module.exports = { archiveOldIdeas, DEFAULT_MAX_AGE_MONTHS };
