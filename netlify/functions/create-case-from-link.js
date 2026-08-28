// Tynn HTTP-wrapper rundt lib/importManuscript.js sin createCaseFromLink —
// se den filen for selve logikken. Kalles fra "+ Ny sak"-modalens
// "Lim inn lenke"-fane: oppretter saken og genererer manus automatisk
// (gjenbruker den research-drevne manusgenereringen i lib/manuscript.js).

const { createClient } = require("@supabase/supabase-js");
const { createCaseFromLink } = require("./lib/importManuscript.js");

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
  if (!body.url) return { statusCode: 400, body: JSON.stringify({ error: "Mangler lenke." }) };

  try {
    const result = await createCaseFromLink(supabase, openaiKey, body.url);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
