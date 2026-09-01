// AI-generert manus for en eksisterende sak — se lib/manuscript.js sin
// generateManuscript for selve logikken (henting av kildeartikkel,
// research-drevet AI-skriving via gpt-5-search-api, bilde, docx-bygging).
//
// Kalles fra "Generer manus"-knappen (én sak eller flere valgte) OG fra
// "+ Ny sak → Lim inn lenke" (etter at selve saken allerede er opprettet
// raskt/synkront av create-case-from-link.js) — begge trenger bare caseId.
//
// Background Function, IKKE en vanlig funksjon lenger: et ekte
// gpt-5-search-api-kall (websøk + research) tar av og til lenger enn
// Netlify sin grense for vanlige, synkrone funksjoner — oppdaget i praksis
// (HTTP 504 "Serverfunksjonen svarte ikke som forventet" på "Generer
// manus"-knappen for én enkelt sak, ikke bare ved batch). Samme løsning som
// resten av apps sine trege AI-kall (kildekontroll, websøk-sveip,
// lydopptak-transkribering): svar 202 med en gang, gjør arbeidet i
// bakgrunnen (opptil 15 min), og la resultatet dukke opp live via historikk-
// feltet på saken (Supabase Realtime, allerede koblet opp i frontend) — i
// stedet for at nettleseren venter blokkerende på et synkront svar.
//
// Kalles direkte fra nettleseren (ikke server-til-server) — sjekker derfor
// selv ekte innlogging FØR det kostbare arbeidet starter (lib/authCheck.js).

const { createClient } = require("@supabase/supabase-js");
const { generateManuscript } = require("./lib/manuscript.js");
const { isAuthorizedUser } = require("./lib/authCheck.js");

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Mangler SUPABASE_URL og/eller SUPABASE_SERVICE_ROLE_KEY som miljøvariabler i Netlify.");
  return createClient(url, key);
}

async function recordFailure(supabase, caseId, message) {
  try {
    var current = await supabase.from("cases").select("historikk").eq("id", caseId).maybeSingle();
    var historikk = (current.data && current.data.historikk) || [];
    await supabase.from("cases").update({
      historikk: [{ ts: new Date().toISOString(), text: "❌ Manusgenerering feilet: " + message }].concat(historikk)
    }).eq("id", caseId);
  } catch (err) {
    console.error("Klarte ikke engang å skrive feilmelding til saken:", err);
  }
}

exports.handler = async function (event) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!(await isAuthorizedUser(event))) return { statusCode: 401, body: "" };

  var body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "" }; }
  var caseId = body.caseId;
  if (!caseId) return { statusCode: 400, body: "" };

  var supabase = getSupabase();
  if (!openaiKey) { await recordFailure(supabase, caseId, "OPENAI_API_KEY er ikke satt i Netlify ennå."); return { statusCode: 200, body: "" }; }

  try {
    var result = await generateManuscript(supabase, openaiKey, caseId);
    console.log("generate-manuscript-background fullført for " + caseId + ":", JSON.stringify(result));
  } catch (err) {
    console.error("generate-manuscript-background feilet for " + caseId + ":", err);
    await recordFailure(supabase, caseId, err.message);
  }

  return { statusCode: 200, body: "" };
};
