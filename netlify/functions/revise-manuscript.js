// Tynn HTTP-wrapper rundt lib/reviseManuscript.js — se den filen for selve
// logikken (AI-drevet revidering av et allerede generert manus, ut fra et
// fritekst AI-notat fra redaksjonen).
//
// Kalles fra "Oppdater med AI"-knappen i manusredigeringen på saken. Krever
// innlogget bruker (Bearer-token) og OPENAI_API_KEY.

const { createClient } = require("@supabase/supabase-js");
const { reviseManuscript } = require("./lib/reviseManuscript.js");

function getSupabaseForUser(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } }
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: JSON.stringify({ error: "Kun POST er støttet." }) };

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: "Mangler innlogging." }) };

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return { statusCode: 500, body: JSON.stringify({ error: "OPENAI_API_KEY er ikke satt i Netlify ennå." }) };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "SUPABASE_URL/SUPABASE_ANON_KEY mangler som miljøvariabler." }) };
  }

  const supabase = getSupabaseForUser(token);
  const userRes = await supabase.auth.getUser(token);
  if (userRes.error || !userRes.data.user) return { statusCode: 401, body: JSON.stringify({ error: "Ugyldig eller utløpt innlogging." }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "Ugyldig forespørsel." }) }; }
  if (!body.caseId) return { statusCode: 400, body: JSON.stringify({ error: "Mangler caseId." }) };
  if (!body.aiNotat) return { statusCode: 400, body: JSON.stringify({ error: "Mangler AI-notat." }) };

  try {
    const result = await reviseManuscript(supabase, openaiKey, body.caseId, body.aiNotat);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
