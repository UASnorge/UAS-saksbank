// Kun en rask "utløser": kjører hver time (rett etter RSS-pollingen har hatt
// tid til å legge inn nye idéer) og sender én HTTP-forespørsel videre til
// source-gate-background.js, som gjør selve arbeidet (kildekontroll av nye
// RSS-idéer) i bakgrunnen i opptil 15 minutter. Denne funksjonen selv gjør
// ingenting tregt — den skal holde seg godt innenfor Netlifys 30-sekunders
// grense for scheduled functions.
//
// Trenger ingen egne miljøvariabler utover det Netlify allerede setter
// automatisk (URL — se docs.netlify.com/build/functions/environment-variables).

const { schedule } = require("@netlify/functions");

const runTrigger = async function () {
  const baseUrl = process.env.URL;
  if (!baseUrl) {
    console.error("source-gate-trigger: process.env.URL er ikke satt — kan ikke utløse source-gate-background.");
    return { statusCode: 500, body: JSON.stringify({ error: "URL-miljøvariabel mangler." }) };
  }
  try {
    // Background functions svarer 202 nesten umiddelbart selve arbeidet
    // fortsetter server-side etter at dette kallet er ferdig — derfor er det
    // trygt å vente på svaret her.
    const res = await fetch(baseUrl + "/.netlify/functions/source-gate-background", { method: "POST" });
    console.log("source-gate-trigger: utløste source-gate-background, status " + res.status);
    return { statusCode: 200, body: JSON.stringify({ triggered: true, status: res.status }) };
  } catch (err) {
    console.error("source-gate-trigger feilet:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Samme kadens som RSS-pollingen (Steg 6/7 i README). Netlify garanterer
// ingen kjørerekkefølge mellom to uavhengige "@hourly"-funksjoner, så en idé
// som dukker opp rett etter at denne allerede har kjørt denne timen, blir
// først fanget opp av NESTE times kjøring — kildekontroll skjer derfor typisk
// innen 1-2 timer etter at en idé dukker opp, ikke nødvendigvis umiddelbart.
exports.handler = schedule("@hourly", runTrigger);
