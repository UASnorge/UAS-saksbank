// Selve arbeidet for automatisk kildekontroll av nye RSS-idéer — se
// lib/sourceGate.js for logikken og begrunnelsen for hvorfor dette er en
// Background Function (opptil 15 minutter) og ikke en vanlig scheduled
// function (hard grense på 30 sekunder — for kort til et eneste
// gpt-5-search-api-websøk, langt mindre flere).
//
// Trigges av source-gate-trigger.js (en vanlig scheduled function som kun
// sender en rask HTTP-forespørsel hit og returnerer). IKKE kall denne
// direkte fra frontend — den bruker service_role og har ingen innlogget
// bruker å knytte kallet til, akkurat som rss-poll.js.
//
// VIKTIG: filnavnet MÅ ende på "-background" for at Netlify skal behandle
// denne som en Background Function (den eldre, fortsatt støttede
// navnekonvensjonen — matcher resten av prosjektets CommonJS/exports.handler-
// stil, i stedet for den nyere "export const config = { background: true }"-
// stilen som krever ESM).

const { createClient } = require("@supabase/supabase-js");
const { gateNewIdeas } = require("./lib/sourceGate.js");

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Mangler SUPABASE_URL og/eller SUPABASE_SERVICE_ROLE_KEY som miljøvariabler i Netlify.");
  }
  return createClient(url, key);
}

exports.handler = async function () {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.log("source-gate-background: hoppet over — OPENAI_API_KEY er ikke satt ennå.");
    return { statusCode: 200, body: "" };
  }

  try {
    const supabase = getSupabase();
    const report = await gateNewIdeas(supabase, openaiKey);
    console.log("Automatisk kildekontroll fullført:", JSON.stringify(report));
  } catch (err) {
    // Background functions har ingen klient som venter på svaret — logg
    // feilen tydelig i Netlify sine funksjonslogger i stedet.
    console.error("Automatisk kildekontroll feilet:", err);
  }
  return { statusCode: 200, body: "" };
};
