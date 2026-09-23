// Rask utløser (samme mønster som source-gate-trigger.js): kjører to ganger om
// dagen og sender én HTTP-forespørsel videre til web-search-background.js,
// som gjør selve arbeidet (flere websøk-kall) i bakgrunnen i opptil 15
// minutter. To faste tidspunkt, ikke hver time som RSS/kildekontroll — et
// generelt websøk-sveip (i motsetning til å parse en kjent RSS-feed) er et
// helt nytt sett AI-kall med reell kostnad per kjøring. seen_urls/seen_items
// sørger for at samme sak aldri opprettes to ganger selv om begge kjøringene
// søker i et overlappende tidsvindu — kjøring nr. 2 fanger kun det som er
// ferskt siden morgenkjøringen.

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

// Kl. 05:00 og 11:00 UTC (06:00/07:00 og 12:00/13:00 norsk tid avhengig av
// sommertid) — én kjøring før arbeidsdagen starter, og én rundt lunsj, etter
// eksplisitt ønske om websøk både før jobb og ved 12-tiden.
exports.handler = schedule("0 5,11 * * *", runTrigger);
