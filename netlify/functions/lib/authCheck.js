// Delt innloggingssjekk for Background Functions som kalles DIREKTE fra
// nettleseren (ikke server-til-server som rss-poll.js/source-gate-*/
// web-search-*, som stoler på at kun Netlify sin egen scheduler kaller dem).
// Selve arbeidet i disse funksjonene gjøres uansett med service_role (siden
// Background Functions ikke har noen mottaker som venter på et RLS-feilsvar
// underveis) — denne sjekken er kun en port FØR det kostbare (ekte OpenAI-
// kall) arbeidet starter, slik at ikke hvem som helst kan trigge det.

const { createClient } = require("@supabase/supabase-js");

async function isAuthorizedUser(event) {
  var authHeader = event.headers.authorization || event.headers.Authorization || "";
  var token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  var url = process.env.SUPABASE_URL;
  var anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return false;
  var client = createClient(url, anonKey, { global: { headers: { Authorization: "Bearer " + token } } });
  var userRes = await client.auth.getUser(token);
  return !(userRes.error || !userRes.data || !userRes.data.user);
}

// Som isAuthorizedUser, men returnerer selve brukeren ({ email }) — brukt av
// funksjoner som skal vise HVEM som gjorde noe (f.eks. saks-assistenten).
async function getAuthorizedUser(event) {
  var authHeader = event.headers.authorization || event.headers.Authorization || "";
  var token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  var url = process.env.SUPABASE_URL;
  var anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  var client = createClient(url, anonKey, { global: { headers: { Authorization: "Bearer " + token } } });
  var userRes = await client.auth.getUser(token);
  if (userRes.error || !userRes.data || !userRes.data.user) return null;
  return { email: userRes.data.user.email || "" };
}

module.exports = { isAuthorizedUser, getAuthorizedUser };
