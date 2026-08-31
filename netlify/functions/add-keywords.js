// Masseimport av søkeord — i praksis navn på registrerte droneoperatører/
// -selskaper UAS Norway ønsker at websøket (lib/webSearch.js) aktivt leter
// etter fersk omtale av, selv i saker som ikke eksplisitt nevner "drone".
//
// KUN bedriftsnavn skal legges inn her, ikke privatpersoner — dette
// håndheves redaksjonelt (av den som limer inn listen), ikke teknisk av
// funksjonen, som ikke har noen pålitelig måte å skille firmanavn fra
// personnavn på.
//
// Samme mønster som add-sources.js: én linje per navn, krever innlogget
// bruker, innsetting skjer som den brukeren (RLS gjelder, ikke service_role).

const { createClient } = require("@supabase/supabase-js");

const MAX_PER_IMPORT = 200;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Kun POST er støttet." }) };
  }

  var authHeader = event.headers.authorization || event.headers.Authorization || "";
  var token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: "Mangler innlogging." }) };
  }

  var supabaseUrl = process.env.SUPABASE_URL;
  var anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server mangler SUPABASE_URL / SUPABASE_ANON_KEY som miljøvariabler i Netlify." }) };
  }

  var supabase = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: "Bearer " + token } } });

  var userRes = await supabase.auth.getUser(token);
  if (userRes.error || !userRes.data || !userRes.data.user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Ugyldig eller utløpt innlogging. Last siden på nytt og prøv igjen." }) };
  }

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Ugyldig forespørsel." }) };
  }

  var text = String(body.text || "").trim();
  if (!text) {
    return { statusCode: 400, body: JSON.stringify({ error: "Lim inn minst ett selskapsnavn, ett per linje." }) };
  }

  var terms = text.split(/\r?\n/)
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line && line[0] !== "#"; });

  var seen = new Set();
  terms = terms.filter(function (t) {
    var key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!terms.length) {
    return { statusCode: 400, body: JSON.stringify({ error: "Fant ingen navn å legge til." }) };
  }

  var overflow = Math.max(0, terms.length - MAX_PER_IMPORT);
  terms = terms.slice(0, MAX_PER_IMPORT);

  var existingRes = await supabase.from("watch_keywords").select("term");
  if (existingRes.error) {
    return { statusCode: 500, body: JSON.stringify({ error: "Kunne ikke lese eksisterende søkeord: " + existingRes.error.message }) };
  }
  var existingLower = new Set((existingRes.data || []).map(function (r) { return r.term.toLowerCase(); }));

  var added = [], skipped = [], failed = [];
  for (var i = 0; i < terms.length; i++) {
    var term = terms[i];
    if (existingLower.has(term.toLowerCase())) { skipped.push(term); continue; }
    var insertRes = await supabase.from("watch_keywords").insert({ term: term });
    if (insertRes.error) failed.push({ term: term, error: insertRes.error.message });
    else added.push(term);
  }

  return { statusCode: 200, body: JSON.stringify({ added: added, skipped: skipped, failed: failed, overflow: overflow }) };
};
