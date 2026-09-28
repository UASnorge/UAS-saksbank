// AI-assistenten inni en sak (se lib/caseAssistant.js). Background Function
// (filnavn MÅ ende på "-background"): research og manusrevisjon kan ta flere
// minutter, langt over grensen for vanlige funksjoner. Svarer 202 med en gang;
// samtalen skrives til cases.assistent_chat og dukker opp live i saken
// (Realtime), akkurat som resten av appen oppdaterer seg.
//
// Samtalen er delt for teamet (lagres på saken). assistent_opptatt hindrer at to
// bestillinger kjører samtidig på samme sak — og settes alltid tilbake til
// false til slutt, også ved feil.

const { createClient } = require("@supabase/supabase-js");
const { getAuthorizedUser } = require("./lib/authCheck.js");
const { runCaseAssistant } = require("./lib/caseAssistant.js");

const MAX_KEPT_MESSAGES = 60;
const STALE_BUSY_MS = 15 * 60 * 1000;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Mangler SUPABASE_URL og/eller SUPABASE_SERVICE_ROLE_KEY som miljøvariabler i Netlify.");
  return createClient(url, key);
}

exports.handler = async function (event) {
  const user = await getAuthorizedUser(event);
  if (!user) return { statusCode: 401, body: "" };

  var body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "" }; }
  var caseId = body.caseId;
  var message = typeof body.message === "string" ? body.message.trim().slice(0, 4000) : "";
  if (!caseId || !message) return { statusCode: 400, body: "" };

  var supabase = getSupabase();
  var cur = await supabase.from("cases").select("assistent_chat, assistent_opptatt, assistent_opptatt_ts").eq("id", caseId).maybeSingle();
  if (cur.error || !cur.data) return { statusCode: 404, body: "" };

  var busySince = cur.data.assistent_opptatt_ts ? new Date(cur.data.assistent_opptatt_ts).getTime() : 0;
  if (cur.data.assistent_opptatt && Date.now() - busySince < STALE_BUSY_MS) return { statusCode: 200, body: "" }; // jobber allerede

  var history = Array.isArray(cur.data.assistent_chat) ? cur.data.assistent_chat : [];
  var withUser = history.concat([{ role: "user", text: message, ts: new Date().toISOString(), by: user.email }]).slice(-MAX_KEPT_MESSAGES);
  await supabase.from("cases").update({ assistent_chat: withUser, assistent_opptatt: true, assistent_opptatt_ts: new Date().toISOString() }).eq("id", caseId);

  var reply, handlinger = [];
  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error("OPENAI_API_KEY er ikke satt i Netlify ennå.");
    var out = await runCaseAssistant(supabase, openaiKey, caseId, history, message);
    reply = out.reply; handlinger = out.handlinger;
  } catch (err) {
    console.error("case-assistant-background feilet for " + caseId + ":", err);
    reply = "❌ Beklager, noe gikk galt: " + err.message;
  }

  // Les samtalen på nytt (saken kan ha fått nye felter/historikk underveis), legg til svaret, og frigi.
  var fresh = await supabase.from("cases").select("assistent_chat").eq("id", caseId).maybeSingle();
  var chat = (fresh.data && Array.isArray(fresh.data.assistent_chat) ? fresh.data.assistent_chat : withUser)
    .concat([{ role: "assistant", text: reply, ts: new Date().toISOString(), handlinger: handlinger }]).slice(-MAX_KEPT_MESSAGES);
  await supabase.from("cases").update({ assistent_chat: chat, assistent_opptatt: false, assistent_opptatt_ts: null }).eq("id", caseId);
  return { statusCode: 200, body: "" };
};
