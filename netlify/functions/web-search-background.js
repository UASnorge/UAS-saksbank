// Selve arbeidet for det generelle websøk-sveipet — se lib/webSearchSweep.js
// for logikken. Trigges av web-search-trigger.js. IKKE kall denne direkte fra
// frontend — bruker service_role, ingen innlogget bruker å knytte kallet til
// (samme prinsipp som rss-poll.js og source-gate-background.js).
//
// Filnavnet MÅ ende på "-background" — se source-gate-background.js for
// hvorfor (Netlifys navnekonvensjon for Background Functions).

const { createClient } = require("@supabase/supabase-js");
const { runWebSearchSweep } = require("./lib/webSearchSweep.js");

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
    console.log("web-search-background: hoppet over — OPENAI_API_KEY er ikke satt ennå.");
    return { statusCode: 200, body: "" };
  }

  try {
    const supabase = getSupabase();
    const report = await runWebSearchSweep(supabase, openaiKey);
    console.log("Websøk-sveip fullført:", JSON.stringify(report));
  } catch (err) {
    console.error("Websøk-sveip feilet:", err);
  }
  return { statusCode: 200, body: "" };
};
