// "+ Ny sak → Bestill innhold": produserer flere INFO-/contentsaker i én
// runde (se lib/contentBatch.js). Frontend oppretter først N plassholder-
// saker (så redaksjonen ser fremdrift med en gang), og sender deres IDer hit —
// denne funksjonen fyller dem med ferdig førsteutkast.
//
// Background Function (filnavn MÅ ende på "-background"), samme mønster og
// begrunnelse som generate-manuscript-background.js: et AI-kall som skriver
// flere saker på rad kan ta lenger enn grensen for vanlige funksjoner.
// Kalles direkte fra nettleseren — sjekker derfor ekte innlogging først.

const { createClient } = require("@supabase/supabase-js");
const { generateContentBatch, recordFailureOn, MAX_ANTALL } = require("./lib/contentBatch.js");
const { isAuthorizedUser } = require("./lib/authCheck.js");

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Mangler SUPABASE_URL og/eller SUPABASE_SERVICE_ROLE_KEY som miljøvariabler i Netlify.");
  return createClient(url, key);
}

exports.handler = async function (event) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!(await isAuthorizedUser(event))) return { statusCode: 401, body: "" };

  var body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "" }; }
  var caseIds = Array.isArray(body.caseIds) ? body.caseIds.filter(function (x) { return typeof x === "string"; }).slice(0, MAX_ANTALL) : [];
  var oppdrag = typeof body.oppdrag === "string" ? body.oppdrag.trim() : "";
  if (!caseIds.length || !oppdrag) return { statusCode: 400, body: "" };

  var supabase = getSupabase();
  async function failAll(msg) { for (var i = 0; i < caseIds.length; i++) await recordFailureOn(supabase, caseIds[i], msg); }

  if (!openaiKey) { await failAll("OPENAI_API_KEY er ikke satt i Netlify ennå."); return { statusCode: 200, body: "" }; }

  try {
    var ev = null;
    if (body.eventId) {
      var evRes = await supabase.from("events").select("*").eq("id", body.eventId).maybeSingle();
      ev = evRes.data || null;
    }
    var infoUrl = typeof body.infoUrl === "string" && /^https?:\/\//i.test(body.infoUrl.trim()) ? body.infoUrl.trim() : "";
    var result = await generateContentBatch(supabase, openaiKey, {
      caseIds: caseIds, oppdrag: oppdrag, event: ev, infoUrl: infoUrl,
      ekstra: typeof body.ekstra === "string" ? body.ekstra.trim() : ""
    });
    console.log("generate-content-batch-background fullført:", JSON.stringify(result));
  } catch (err) {
    console.error("generate-content-batch-background feilet:", err);
    await failAll(err.message);
  }
  return { statusCode: 200, body: "" };
};
