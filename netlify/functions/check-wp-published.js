// Kjører automatisk hver time (se schedule nederst) — sjekker alle saker som
// står som «WP-utkast opprettet» (og faktisk har et wp_post_id) mot
// WordPress sin EGEN status for det innlegget. Er innlegget publisert i
// WordPress — f.eks. fordi en redaktør publiserte det direkte der, uten å gå
// via STOPP-kontrollen i saksbanken — flyttes saken automatisk til
// «Publisert», slik at saksbanken alltid gjenspeiler virkeligheten i stedet
// for å stille vise et utdatert steg.
//
// Fabrikkerer ALDRI stopp_godkjent/publisert_av her — vi vet ikke hvem som
// eventuelt godkjente/kontrollerte innlegget i WordPress, så de feltene
// røres bevisst ikke, kun status og historikk.

const { schedule } = require("@netlify/functions");
const { createClient } = require("@supabase/supabase-js");
const { getPostStatus } = require("./lib/wordpress.js");

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Mangler SUPABASE_URL og/eller SUPABASE_SERVICE_ROLE_KEY som miljøvariabler i Netlify.");
  }
  return createClient(url, key);
}

async function checkAll(supabase) {
  const { data: cases, error } = await supabase
    .from("cases")
    .select("id, title, nettsted, wp_post_id, wp_edit_link, historikk")
    .eq("status", "wp-utkast")
    .not("wp_post_id", "is", null);

  if (error) throw new Error("Kunne ikke hente WP-utkast-saker: " + error.message);

  const report = { sjekket: 0, flyttetTilPublisert: 0, feil: [] };

  for (const c of cases || []) {
    report.sjekket++;
    let post;
    try {
      post = await getPostStatus(c.nettsted, c.wp_post_id);
    } catch (err) {
      report.feil.push(`${c.title}: ${err.message}`);
      continue;
    }
    if (post.status !== "publish") continue;

    const nowIsoStr = new Date().toISOString();
    const historikk = [{
      ts: nowIsoStr,
      text: `Automatisk oppdaget: saken er publisert på ${c.nettsted} (${post.link || c.wp_edit_link || "lenke mangler"}) — status flyttet til «Publisert»`
    }].concat(c.historikk || []);

    const { error: updErr } = await supabase
      .from("cases")
      .update({ status: "publisert", historikk })
      .eq("id", c.id);

    if (updErr) { report.feil.push(`${c.title}: kunne ikke oppdatere status (${updErr.message})`); continue; }
    report.flyttetTilPublisert++;
  }

  return report;
}

const runCheck = async function () {
  try {
    const supabase = getSupabase();
    const report = await checkAll(supabase);
    console.log("WP-publiseringssjekk fullført:", JSON.stringify(report));
    return { statusCode: 200, body: JSON.stringify(report) };
  } catch (err) {
    console.error("WP-publiseringssjekk feilet:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Sjekk hver time — samme frekvens som RSS-pollingen (rss-poll.js), mer enn
// nok for et team på denne størrelsen.
exports.handler = schedule("@hourly", runCheck);
