// AI-assistent med verktøytilgang til hele saksbanken — kan slå opp, opprette,
// endre, flytte, slette saker, kjøre AI-vurdering, generere manus, og lese
// kilder/eventkalender, alt via samtale på norsk.
//
// Sikkerhetsgrense (ufravikelig, uansett hva brukeren ber om): assistenten kan
// ALDRI sette en sak til status "publisert" eller krysse av STOPP-kontrollen.
// Det skal alltid gå gjennom den enkeltsak-visningen i selve appen, med
// avkrysning og valgt godkjenner — akkurat som resten av verktøyet.
//
// Kjører som den innloggede brukeren (RLS), ikke service_role. Krever
// OPENAI_API_KEY. Verktøyene deler kjernelogikk med ai-triage.js og
// generate-manuscript.js via lib/ — ikke egne, uverifiserte kopier.

const { createClient } = require("@supabase/supabase-js");
const { runTriage } = require("./lib/triage.js");
const { generateManuscript } = require("./lib/manuscript.js");
const { cleanupIrrelevantCases } = require("./lib/cleanup.js");
const { checkSource } = require("./lib/sourceCheck.js");
const { researchImages } = require("./lib/imageResearch.js");
const { reviseManuscript } = require("./lib/reviseManuscript.js");

const MODEL = "gpt-5.5";
const MAX_ROUNDS = 6;
const MOVABLE_STATUSES = ["ide", "godkjent", "i-arbeid", "wp-utkast", "arkivert", "avvist"];

function getSupabaseForUser(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } }
  });
}

const SYSTEM_PROMPT = `Du er AI-assistenten inni saksbanken til UAS Norway og Dronemagasinet — en redaksjonell
kanban-app for droneideer, fra tips til publisering. Du snakker norsk, kort og konkret.

Du har verktøy til å slå opp, opprette, endre, flytte og slette saker, kjøre AI-vurdering, generere manus,
og lese RSS-kilder og eventkalenderen. Bruk verktøy aktivt i stedet for å gjette — brukeren kan spørre om
hva som helst i saksbanken, og forvente at du faktisk sjekker i stedet for å anta.

Ber brukeren om å rydde bort/fjerne flere eller alle ikke-relevante idéer samtidig: bruk ALLTID
cleanup_irrelevant_cases som gjør hele jobben i ett kall. Ikke list opp saker selv og kall delete_case
gjentatte ganger for hver enkelt — det er tregt, bruker unødvendig mange runder, og kan tidsavbrytes.

check_source og research_images gjør ekte websøk og kan ta et halvt minutt hver — bruk dem på én eller
noen få navngitte saker om gangen, ikke i en lang løkke over mange saker i én samtale (det kan
tidsavbrytes). Begge kontrollerer selv, med ekte HTTP-forespørsler, at lenkene de foreslår faktisk
fungerer, før resultatet vises — gjenta ALDRI en lenke fra disse verktøyene som "bekreftet" eller "fri
bruk" i svaret ditt til brukeren med mindre verktøyresultatet faktisk sier det.

ÉN REGEL ER UFRAVIKELIG, uansett hva brukeren ber deg om: du kan ALDRI sette en sak til status "publisert".
move_case_status avviser dette forsøket automatisk — forklar da brukeren at publisering krever at et
menneske åpner saken i appen, krysser av at de har kontrollert den, og velger en godkjenner. Ikke prøv
omveier (f.eks. update_case) for å oppnå det samme.

Tilsvarende kan du heller ikke sette en sak til "wp-utkast" med mindre den allerede har et ekte
WordPress-utkast — det ville løyet om at noe finnes i WordPress som faktisk ikke gjør det. Vil brukeren
opprette et WordPress-utkast, forklar at det skjer via selve "🌐 Publiser til WordPress"-knappen i appen
(assistenten kan ikke gjøre det på vegne av brukeren).

Manusarbeidsflyt: å generere manus (generate_manuscript) flytter automatisk saken fra "Godkjente idéer" til
"I arbeid" — det er tilsiktet, ikke noe du trenger å gjøre separat med move_case_status. Ber brukeren om å
endre noe i et allerede generert manus (f.eks. "gjør saken lenger", "ta med mer fra kilden", "bytt bilde til
denne lenken"), bruk revise_manuscript med et presist AI-notat som gjengir akkurat det brukeren ba om —
ikke skriv om manuset selv i update_case, det feltet finnes ikke der.

Når du utfører en handling (oppretter, endrer, flytter, sletter, kjører AI-vurdering, genererer manus):
oppsummer kort og tydelig hva du faktisk gjorde, på norsk, etter at verktøyet er kjørt. Ikke fabriker
resultater — bruk kun det verktøyene faktisk returnerer.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_cases",
      description: "List saker, valgfritt filtrert på status og/eller tekstsøk i tittel. Returnerer et sammendrag per sak, ikke alle felt.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ide", "godkjent", "i-arbeid", "wp-utkast", "publisert", "arkivert", "avvist"] },
          search: { type: "string", description: "Fritekstsøk i tittel (delvis treff, case-insensitive)." },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_case",
      description: "Hent alle detaljer om én sak, inkludert historikk, sammendrag og kilder.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    }
  },
  {
    type: "function",
    function: {
      name: "create_case",
      description: "Opprett en ny sak/idé. Havner alltid i status 'ide'.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          sakstype: { type: "string", enum: ["redaksjonell", "content", "ai"], description: "redaksjonell=Dronemagasin, content=INFO, ai=Kommentar" },
          hastegrad: { type: "string", enum: ["akutt", "planlagt", "tidlos"] },
          kilder: { type: "array", items: { type: "string" } },
          neste_handling: { type: "string" }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_case",
      description: "Oppdater felter på en eksisterende sak. Bruk IKKE til å endre status eller publisere — se move_case_status.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          sakstype: { type: "string", enum: ["redaksjonell", "content", "ai"] },
          hastegrad: { type: "string", enum: ["akutt", "planlagt", "tidlos"] },
          eier: { type: "string" },
          frist: { type: "string", description: "YYYY-MM-DD" },
          neste_handling: { type: "string" },
          kategori: { type: "string" },
          malgruppe: { type: "string" },
          oppsummering: { type: "string" }
        },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "move_case_status",
      description: "Flytt en sak til en annen status. 'publisert' er IKKE tillatt her — avvises alltid. 'wp-utkast' avvises også med mindre saken allerede har et ekte WordPress-utkast — se systeminstruksen.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, status: { type: "string" } },
        required: ["id", "status"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_case",
      description: "Slett en sak permanent. Bruk kun når brukeren tydelig ber om det.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
    }
  },
  {
    type: "function",
    function: {
      name: "run_ai_triage",
      description: "Kjør AI-vurdering (kategori, hastegrad, prioriteringsscore, sammendrag, eventkobling) på én eller flere saker.",
      parameters: { type: "object", properties: { caseIds: { type: "array", items: { type: "string" } } }, required: ["caseIds"] }
    }
  },
  {
    type: "function",
    function: {
      name: "generate_manuscript",
      description: "Generer et AI-førsteutkast (.docx-manus) for én sak. Saken bør være i status 'godkjent' eller senere. Flytter automatisk saken til 'I arbeid' om den fortsatt sto i 'Godkjente idéer'.",
      parameters: { type: "object", properties: { caseId: { type: "string" } }, required: ["caseId"] }
    }
  },
  {
    type: "function",
    function: {
      name: "revise_manuscript",
      description: "Rediger et ALLEREDE generert manus basert på en konkret instruks fra brukeren (AI-notat) — f.eks. gjøre det lengre, ta med mer fra kilden, eller bytte bilde til en URL brukeren selv oppgir. Dikter aldri opp en ny bilde-URL selv — bruker kun én brukeren faktisk oppga, og verifiserer den (ekte HTTP-sjekk) før den godtas.",
      parameters: {
        type: "object",
        properties: { caseId: { type: "string" }, aiNotat: { type: "string", description: "Instruksen fra brukeren, så presist gjengitt som mulig." } },
        required: ["caseId", "aiNotat"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cleanup_irrelevant_cases",
      description: "Sjekk ALLE saker i status 'ide' mot drone-/UAS-relevans og slett de som ikke er relevante, i ÉN samlet operasjon. Bruk ALLTID denne når brukeren ber om å rydde/fjerne flere eller alle ikke-relevante idéer samtidig — ikke prøv å vurdere og slette saker én og én selv, det er tregt og kan tidsavbrytes ved mange saker (maks 60 behandles per kjøring; kjør på nytt om det er flere).",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "check_source",
      description: "Kjør kildevurdering på én sak — undersøker hvem som står bak saken, finner originalkilden, og kontrollerer FAKTISK (ekte HTTP-forespørsler) at lenkene fungerer, før den gir en troverdighetsscore (1-5) og en anbefaling. Tar litt tid (websøk). Bruk når brukeren ber om å sjekke/verifisere en kilde.",
      parameters: { type: "object", properties: { caseId: { type: "string" } }, required: ["caseId"] }
    }
  },
  {
    type: "function",
    function: {
      name: "research_images",
      description: "Finn 3-6 rettighetsavklarte bildealternativer for en sak. Hver foreslått bildelenke kontrolleres FAKTISK (ekte HTTP-forespørsel) før den presenteres — en lenke som ikke faktisk virker vises alltid tydelig merket, aldri som brukbar. Tar litt tid (websøk). Bruk når brukeren ber om bildeforslag til en sak.",
      parameters: { type: "object", properties: { caseId: { type: "string" } }, required: ["caseId"] }
    }
  },
  {
    type: "function",
    function: {
      name: "list_sources",
      description: "List RSS-kildene som overvåkes.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "list_events",
      description: "List kommende UAS Norway-arrangementer (kurs/konferanser/webinarer).",
      parameters: { type: "object", properties: {}, required: [] }
    }
  }
];

function summarizeCase(c) {
  return {
    id: c.id, title: c.title, status: c.status, sakstype: c.sakstype, hastegrad: c.hastegrad,
    eier: c.eier, frist: c.frist, oppsummering: c.oppsummering
  };
}

async function executeTool(supabase, openaiKey, name, args) {
  switch (name) {
    case "list_cases": {
      var q = supabase.from("cases").select("*").order("created_at", { ascending: false }).limit(Math.min(args.limit || 20, 50));
      if (args.status) q = q.eq("status", args.status);
      if (args.search) q = q.ilike("title", "%" + args.search + "%");
      var res = await q;
      if (res.error) return { error: res.error.message };
      return { cases: (res.data || []).map(summarizeCase) };
    }
    case "get_case": {
      var res = await supabase.from("cases").select("*").eq("id", args.id).maybeSingle();
      if (res.error) return { error: res.error.message };
      if (!res.data) return { error: "Fant ingen sak med id " + args.id };
      return { case: res.data };
    }
    case "create_case": {
      if (!args.title) return { error: "Mangler tittel." };
      var nowIso = new Date().toISOString();
      var payload = {
        title: args.title,
        sakstype: args.sakstype || "redaksjonell",
        hastegrad: args.hastegrad || "planlagt",
        status: "ide",
        eier: "Ikke tildelt",
        neste_handling: args.neste_handling || "",
        kilder: args.kilder || [],
        historikk: [{ ts: nowIso, text: "Sak opprettet via AI-assistent" }]
      };
      var res = await supabase.from("cases").insert(payload).select().single();
      if (res.error) return { error: res.error.message };
      return { case: summarizeCase(res.data) };
    }
    case "update_case": {
      if (!args.id) return { error: "Mangler id." };
      var fields = Object.assign({}, args);
      delete fields.id;
      if (!Object.keys(fields).length) return { error: "Ingen felter å oppdatere." };
      var res = await supabase.from("cases").update(fields).eq("id", args.id).select().maybeSingle();
      if (res.error) return { error: res.error.message };
      return { case: res.data ? summarizeCase(res.data) : null };
    }
    case "move_case_status": {
      if (args.status === "publisert") {
        return { error: "Ikke tillatt: publisering krever at et menneske åpner saken i appen, krysser av STOPP-kontrollen og velger godkjenner. Kan ikke gjøres via assistenten." };
      }
      if (MOVABLE_STATUSES.indexOf(args.status) === -1) {
        return { error: "Ukjent status: " + args.status + ". Gyldige: " + MOVABLE_STATUSES.join(", ") };
      }
      var caseRes = await supabase.from("cases").select("status, historikk, title, wp_post_id").eq("id", args.id).maybeSingle();
      if (caseRes.error || !caseRes.data) return { error: "Fant ikke saken." };
      if (args.status === "wp-utkast" && caseRes.data.status !== "wp-utkast" && !caseRes.data.wp_post_id) {
        return { error: "Ikke tillatt: dette ville markert saken som om et WordPress-utkast finnes, uten at det faktisk gjør det. Be brukeren bruke «🌐 Publiser til WordPress»-knappen i appen i stedet — den oppretter det ekte utkastet." };
      }
      var historikk = [{ ts: new Date().toISOString(), text: "Status endret (AI-assistent): " + caseRes.data.status + " → " + args.status }].concat(caseRes.data.historikk || []);
      var res = await supabase.from("cases").update({ status: args.status, historikk: historikk }).eq("id", args.id);
      if (res.error) return { error: res.error.message };
      return { ok: true, title: caseRes.data.title, nyStatus: args.status };
    }
    case "delete_case": {
      var caseRes = await supabase.from("cases").select("title").eq("id", args.id).maybeSingle();
      var res = await supabase.from("cases").delete().eq("id", args.id);
      if (res.error) return { error: res.error.message };
      return { ok: true, title: caseRes.data ? caseRes.data.title : args.id };
    }
    case "run_ai_triage": {
      try {
        var result = await runTriage(supabase, openaiKey, args.caseIds || []);
        return result;
      } catch (err) {
        return { error: err.message };
      }
    }
    case "generate_manuscript": {
      try {
        var result = await generateManuscript(supabase, openaiKey, args.caseId);
        return result;
      } catch (err) {
        return { error: err.message };
      }
    }
    case "revise_manuscript": {
      try {
        return await reviseManuscript(supabase, openaiKey, args.caseId, args.aiNotat);
      } catch (err) {
        return { error: err.message };
      }
    }
    case "cleanup_irrelevant_cases": {
      try {
        return await cleanupIrrelevantCases(supabase, openaiKey);
      } catch (err) {
        return { error: err.message };
      }
    }
    case "check_source": {
      try {
        return await checkSource(supabase, openaiKey, args.caseId);
      } catch (err) {
        return { error: err.message };
      }
    }
    case "research_images": {
      try {
        return await researchImages(supabase, openaiKey, args.caseId);
      } catch (err) {
        return { error: err.message };
      }
    }
    case "list_sources": {
      var res = await supabase.from("sources").select("name, feed_url, active, last_polled_at").order("name");
      if (res.error) return { error: res.error.message };
      return { sources: res.data || [] };
    }
    case "list_events": {
      var res = await supabase.from("events").select("title, event_type, location, starts_on, duration_days")
        .gte("starts_on", new Date().toISOString().slice(0, 10)).order("starts_on");
      if (res.error) return { error: res.error.message };
      return { events: res.data || [] };
    }
    default:
      return { error: "Ukjent verktøy: " + name };
  }
}

async function callOpenAI(openaiKey, messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + openaiKey },
    body: JSON.stringify({ model: MODEL, messages: messages, tools: TOOLS, tool_choice: "auto" })
  });
  if (!res.ok) throw new Error("OpenAI-feil (" + res.status + "): " + (await res.text()).slice(0, 300));
  return res.json();
}

async function runAssistant(supabase, openaiKey, history, userMessage) {
  var convo = [{ role: "system", content: SYSTEM_PROMPT }]
    .concat((history || []).filter(function (m) { return m.role === "user" || m.role === "assistant"; }))
    .concat([{ role: "user", content: userMessage }]);

  var actionsLog = [];

  for (var round = 0; round < MAX_ROUNDS; round++) {
    var data = await callOpenAI(openaiKey, convo);
    var msg = data.choices[0].message;
    convo.push(msg);

    if (!msg.tool_calls || !msg.tool_calls.length) {
      return { reply: msg.content || "", actions: actionsLog };
    }

    for (var i = 0; i < msg.tool_calls.length; i++) {
      var call = msg.tool_calls[i];
      var args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch (e) {}
      var result;
      try {
        result = await executeTool(supabase, openaiKey, call.function.name, args);
      } catch (err) {
        result = { error: err.message };
      }
      actionsLog.push({ tool: call.function.name, args: args, result: result });
      convo.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 4000) });
    }
  }

  return { reply: "Jeg brukte for mange steg på dette og stoppet — prøv å be om noe mer avgrenset.", actions: actionsLog };
}

// Eksportert for testbarhet (se test i PR-beskrivelse/commit) — Netlify bruker kun exports.handler.
module.exports.runAssistant = runAssistant;
module.exports.executeTool = executeTool;

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
  if (!body.message) return { statusCode: 400, body: JSON.stringify({ error: "Mangler melding." }) };

  try {
    const result = await runAssistant(supabase, openaiKey, body.history || [], body.message);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
