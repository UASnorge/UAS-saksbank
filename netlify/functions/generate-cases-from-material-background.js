// "+ Ny sak → Fra dokument(er)/lenker": produserer ett eller flere førsteutkast
// fra opplastede dokumenter (PDF/Word/tekst) og/eller flere lenker, styrt av
// redaksjonens fritekst-forklaring (se lib/documentCases.js). Frontend laster
// filene rett til lagring, oppretter plassholder-saker og sender IDer + stier
// hit — denne funksjonen fyller plassholderne.
//
// Background Function (filnavn MÅ ende på "-background"), samme mønster og
// begrunnelse som generate-content-batch-background.js. Kalles direkte fra
// nettleseren — sjekker derfor ekte innlogging først.

const { createClient } = require("@supabase/supabase-js");
const { generateCasesFromMaterial } = require("./lib/documentCases.js");
const { recordFailureOn, MAX_ANTALL } = require("./lib/contentBatch.js");
const { isAuthorizedUser } = require("./lib/authCheck.js");

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Mangler SUPABASE_URL og/eller SUPABASE_SERVICE_ROLE_KEY som miljøvariabler i Netlify.");
  return createClient(url, key);
}

function strArray(v, max) {
  return Array.isArray(v) ? v.filter(function (x) { return typeof x === "string" && x.trim(); }).map(function (x) { return x.trim(); }).slice(0, max) : [];
}

exports.handler = async function (event) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!(await isAuthorizedUser(event))) return { statusCode: 401, body: "" };

  var body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, body: "" }; }
  var caseIds = strArray(body.caseIds, MAX_ANTALL);
  var docPaths = strArray(body.docPaths, 20).filter(function (p) { return p.indexOf("..") === -1; });
  var links = strArray(body.links, 20).filter(function (u) { return /^https?:\/\//i.test(u); });
  var beskrivelse = typeof body.beskrivelse === "string" ? body.beskrivelse.trim() : "";
  if (!caseIds.length || !beskrivelse || (!docPaths.length && !links.length)) return { statusCode: 400, body: "" };

  var supabase = getSupabase();
  async function failAll(msg) { for (var i = 0; i < caseIds.length; i++) await recordFailureOn(supabase, caseIds[i], msg); }

  if (!openaiKey) { await failAll("OPENAI_API_KEY er ikke satt i Netlify ennå."); return { statusCode: 200, body: "" }; }

  try {
    var result = await generateCasesFromMaterial(supabase, openaiKey, {
      caseIds: caseIds, docPaths: docPaths, links: links, beskrivelse: beskrivelse,
      sakstype: body.sakstype === "content" ? "content" : "redaksjonell"
    });
    console.log("generate-cases-from-material-background fullført:", JSON.stringify(result));
  } catch (err) {
    console.error("generate-cases-from-material-background feilet:", err);
    await failAll(err.message);
  }
  return { statusCode: 200, body: "" };
};
