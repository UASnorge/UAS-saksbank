// Rask utløser (samme mønster som source-gate-trigger.js): kjører én gang om
// dagen og sender én HTTP-forespørsel videre til web-search-background.js,
// som gjør selve arbeidet (flere websøk-kall) i bakgrunnen i opptil 15
// minutter. Kun daglig, ikke hver time som RSS/kildekontroll — et generelt
// websøk-sveip (i motsetning til å parse en kjent RSS-feed) er et helt nytt
// AI-kall med reell kostnad per kjøring, så det holdes til én gang i døgnet.

const { schedule } = require("@netlify/functions");

const runTrigger = async function () {
  const baseUrl = process.env.URL;
  if (!baseUrl) {
    console.error("web-search-trigger: process.env.URL er ikke satt — kan ikke utløse web-search-background.");
    return { statusCode: 500, body: JSON.stringify({ error: "URL-miljøvariabel mangler." }) };
  }
  try {
    const res = await fetch(baseUrl + "/.netlify/functions/web-search-background", { method: "POST" });
    console.log("web-search-trigger: utløste web-search-background, status " + res.status);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, status: res.status }) };
  } catch (err) {
    console.error("web-search-trigger feilet:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Kl. 05:00 UTC (06:00/07:00 norsk tid avhengig av sommertid) — før arbeidsdagen
// starter, så nye websøk-oppdagede idéer ligger klare når redaksjonen logger på.
exports.handler = schedule("0 5 * * *", runTrigger);
