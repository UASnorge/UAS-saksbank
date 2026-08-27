// Rydder bort idéer som ikke handler om droner/UAS — kalt fra "🧹 Fjern
// ikke-relevante (AI)"-knappen i toppmenyen. Kjører AI-relevanssjekk over
// alle saker med status "ide" og sletter de som ikke er relevante.
//
// Rører bevisst KUN status "ide" — saker et menneske allerede har godkjent
// eller jobbet videre med, lar vi stå urørt uansett hva AI-en mener nå.
//
// Krever innlogget bruker (Bearer-token). Sletter SOM den brukeren (RLS),
// ikke med service_role — samme mønster som resten av funksjonene.

const { createClient } = require("@supabase/supabase-js");
const { checkRelevance } = require("./lib/relevance.js");

const MAX_PER_RUN = 60;

function getSupabaseForUser(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } }
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Kun POST er støttet." }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: "Mangler innlogging." }) };

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return { statusCode: 500, body: JSON.stringify({ error: "OPENAI_API_KEY er ikke satt i Netlify." }) };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "SUPABASE_URL/SUPABASE_ANON_KEY mangler som miljøvariabler." }) };
  }

  const supabase = getSupabaseForUser(token);
  const userRes = await supabase.auth.getUser(token);
  if (userRes.error || !userRes.data.user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Ugyldig eller utløpt innlogging." }) };
  }

  const casesRes = await supabase.from("cases").select("*").eq("status", "ide").limit(MAX_PER_RUN);
  if (casesRes.error) return { statusCode: 500, body: JSON.stringify({ error: casesRes.error.message }) };
  const cases = casesRes.data || [];

  if (!cases.length) {
    return { statusCode: 200, body: JSON.stringify({ fjernet: [], beholdt: 0, feilet: [] }) };
  }

  const checked = await Promise.allSettled(cases.map(async function (c) {
    var kildeInfo = c.kilder && c.kilder.length ? "Kilde: " + c.kilder[0] : "";
    var verdict = await checkRelevance(openaiKey, c.title, kildeInfo);
    return { id: c.id, title: c.title, relevant: verdict.relevant, begrunnelse: verdict.begrunnelse };
  }));

  var fjernet = [], feilet = [], beholdt = 0;
  var toDelete = [];

  checked.forEach(function (r, i) {
    if (r.status === "rejected") {
      feilet.push({ title: cases[i].title, error: r.reason ? r.reason.message : "ukjent feil" });
      return;
    }
    if (r.value.relevant) { beholdt++; return; }
    toDelete.push(r.value.id);
    fjernet.push({ title: r.value.title, begrunnelse: r.value.begrunnelse });
  });

  if (toDelete.length) {
    var delRes = await supabase.from("cases").delete().in("id", toDelete);
    if (delRes.error) {
      return { statusCode: 500, body: JSON.stringify({ error: "Kunne ikke slette: " + delRes.error.message }) };
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ fjernet: fjernet, beholdt: beholdt, feilet: feilet, sjekket: cases.length })
  };
};
