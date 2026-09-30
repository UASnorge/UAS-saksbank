// AI-assistenten INNI én sak. Erstatter de gamle «AI-vurdering» og «AI-notat»-
// feltene i saken: i stedet for et skjema du fyller ut og en knapp du trykker
// på, snakker du med en assistent som kjenner saken (manus, kilder,
// kontrollpunkter, historikk) og faktisk kan gjøre jobben — research, revidere
// manuset, finne bilder, sjekke kilden, oppdatere sakens felt.
//
// Alle verktøy er avgrenset til DENNE saken (caseId er fast, ikke et argument
// modellen kan velge). Samme sikkerhetsgrenser som den globale assistenten:
// aldri «publisert», aldri «wp-utkast» uten et ekte WordPress-utkast, ingen
// sletting. Kjører som service_role fra en Background Function (research kan
// ta flere minutter) etter at innloggingen er kontrollert.
//
// Grunnregel som ellers i appen: assistenten dikter aldri opp fakta, kilder
// eller URL-er — nye opplysninger kommer kun fra verifisert research
// (lib/materialResearch.js) eller fra sakens egen kilde.

const { runTriage } = require("./triage.js");
const { generateManuscript, MODEL, fetchSourceArticle } = require("./manuscript.js");
const { researchImages } = require("./imageResearch.js");
const { checkSource } = require("./sourceCheck.js");
const { reviseManuscript } = require("./reviseManuscript.js");
const { deepResearch, searchOwnArchive, readExternalSource } = require("./materialResearch.js");
const { STYLE_PRINCIPLES, todayLine } = require("./styleGuide.js");

const MAX_ROUNDS = 8;
const MAX_MANUS_CHARS_IN_CONTEXT = 12000;
const STATUSES = ["ide", "i-arbeid", "wp-utkast", "arkivert", "avvist"];

const SYSTEM_PROMPT = `Du er AI-assistenten INNI én bestemt sak i saksbanken til UAS Norway og Dronemagasinet — en erfaren nyhetsredaktør og researcher som jobber sammen med journalisten om akkurat denne saken. Du snakker norsk (bokmål), kort og konkret, som en kollega — ikke som en chatbot. Du ser sakens status, manus, kilder og kontrollpunkter i SAKSKONTEKST under.

Du har verktøy og skal BRUKE dem i stedet for bare å forklare hvordan noe kan gjøres. Ber journalisten om noe du har verktøy til, gjør du det og sier hva du faktisk gjorde.

HVA DU KAN HJELPE MED (eksempler): gjøre saken lengre/kortere/skarpere, ta med mer bakgrunn, regelverk eller reaksjoner, finne og bygge inn relevante tidligere saker fra Dronemagasinet, faktasjekke manuset mot kilden, foreslå tittelvarianter, gi kritisk tilbakemelding som en nyhetssjef, finne bilder, vurdere kilden, oppdatere sakens felt (neste handling, frist, målgruppe …), lese en lenke journalisten limer inn og bruke den.

REGLER — MANUS OG FAKTA:
- Skal manuset endres: bruk revise_manuscript med en presis instruks som gjengir nøyaktig det journalisten ba om. Du kan ALDRI skrive ny manustekst i chatten og hevde at den ligger i manuset — kun revise_manuscript endrer manuset.
- Trenger endringen NYE opplysninger (mer bakgrunn, reaksjoner, tall, regelverk, sammenligning med Norge): kall FØRST research_topic med et presist spørsmål, og deretter revise_manuscript med bruk_research=true. Uten research bruker revisjonen kun det som allerede står i manus og kilde.
- Spørsmål om saken (faktasjekk, vinkling, tittelforslag, kritikk): svar direkte ut fra SAKSKONTEKST; hent hele manuset (get_manuscript) eller kilden (read_source) ved behov. Ved faktasjekk: sammenlign konkret manus mot kilden og si nøyaktig hva som stemmer og hva som avviker — dikt aldri.
- Limer journalisten inn en lenke: les den med read_url før du bruker eller kommenterer innholdet.
- Nye opplysninger som ikke stammer fra manus, kilde, verifisert research eller en lenke journalisten ga deg, skal ALDRI inn i saken. Er noe usikkert eller mangler: si det.
- Henvisning til egne tidligere saker: bruk search_own_archive for å finne dem (ekte URL-er). Revisjonen lager lenkene — du skal aldri skrive en URL du ikke har fått fra et verktøy.
- Bilder: du kan aldri finne på en bilde-URL. Bytte av bilde skjer kun med en lenke journalisten selv gir (send den med i revise_manuscript-instruksen), eller via research_images (verifiserte forslag som vises i saken).

REGLER — SAKSBEHANDLING:
- Du kan ALDRI sette saken til «publisert». move_status avviser det automatisk — forklar at publisering krever at et menneske åpner saken, krysser av at den er kontrollert og velger godkjenner. «wp-utkast» kan heller ikke settes uten et ekte WordPress-utkast (det skjer via 🌐-knappen i saken).
- Ikke endre status, eier, frist eller andre felt uten at journalisten ber om det.
- Du kan ikke slette saken.

SVARSTIL: oppsummer kort hva du gjorde og hva som er nytt i saken (journalisten ser manuset oppdatere seg i saken). Ved research: si hvilke kilder du fant og hva som var nyttig. Bruk kun det verktøyene faktisk returnerer. Er svaret et råd (tittel, kritikk), gi det direkte og konkret — ikke en lang innledning.

Skriveråd du kan bruke når du gir tilbakemelding på tekst:
${STYLE_PRINCIPLES}`;

const TOOLS = [
  { type: "function", function: { name: "get_manuscript", description: "Hent hele manuset (tittel, ingress, full brødtekst, bildetekst, foto, kontrollpunkter, kilder brukt) slik det ligger i saken nå.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "read_source", description: "Hent teksten fra sakens opprinnelige nettside-kilde (første kilde-lenke), til faktasjekk eller når det trengs mer stoff derfra.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "read_url", description: "Les teksten på en nettside eller PDF-lenke (f.eks. en lenke journalisten limte inn). Returnerer et utdrag.", parameters: { type: "object", properties: { url: { type: "string" }, hva_leter_du_etter: { type: "string", description: "Kort: hva du vil finne i siden (brukes til å velge relevante utdrag)." } }, required: ["url"] } } },
  { type: "function", function: { name: "search_own_archive", description: "Søk i Dronemagasinets og UAS Norways eget arkiv (dronemag.no/uasnorway.no) etter tidligere saker om et tema. Gir ekte URL-er. Raskt.", parameters: { type: "object", properties: { sporring: { type: "string", description: "Nøkkelord/tema, f.eks. «svensk politi droner kameraovervåking»." } }, required: ["sporring"] } } },
  { type: "function", function: { name: "research_topic", description: "Dyp research på nettet (flere søkerunder, verifiserte lenker, kildenes egen tekst) om et konkret spørsmål/tema knyttet til saken — f.eks. bakgrunn, regelverk, reaksjoner, tall. Tar 2–3 minutter. Resultatet kan deretter brukes i revise_manuscript med bruk_research=true.", parameters: { type: "object", properties: { sporsmal: { type: "string", description: "Presist: hva skal researches, og hvorfor." } }, required: ["sporsmal"] } } },
  { type: "function", function: { name: "revise_manuscript", description: "Reviderer manuset ut fra en presis instruks (gjør lengre/kortere, ta med X, endre tittel/ingress, bytt bilde til en lenke journalisten oppga, legg inn henvisning til tidligere sak …). Er bruk_research=true, kan revisjonen bygge på research_topic-resultatene fra denne samtalen.", parameters: { type: "object", properties: { instruks: { type: "string", description: "Så presist som mulig gjengitt det journalisten ba om (evt. med lenker de ga)." }, bruk_research: { type: "boolean", description: "true hvis research_topic er kjørt og skal brukes." } }, required: ["instruks"] } } },
  { type: "function", function: { name: "research_images", description: "Finn 3–6 bildealternativer til saken (kontrollerte lenker, rettighetsvurdering; genererer AI-illustrasjoner om ingenting brukbart finnes). Vises i saken under Bildeforslag. Tar et halvt minutt.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "check_source", description: "Kildevurdering: hvem står bak, originalkilde, troverdighet (1–5), med kontrollerte lenker. Vises i saken. Tar et halvt minutt.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "vurder_saken", description: "Kjør redaksjonell AI-vurdering av saken (tema, land, hastegrad, prioriteringsscore, sammendrag).", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "update_case", description: "Oppdater felter på saken (kun når journalisten ber om det). Ikke status — se move_status.", parameters: { type: "object", properties: {
    title: { type: "string" }, sakstype: { type: "string", enum: ["redaksjonell", "content", "ai"] }, hastegrad: { type: "string", enum: ["akutt", "planlagt", "tidlos"] },
    eier: { type: "string" }, frist: { type: "string", description: "YYYY-MM-DD" }, neste_handling: { type: "string" }, kategori: { type: "string" },
    malgruppe: { type: "string" }, oppsummering: { type: "string" }, nettsted: { type: "string", enum: ["dronemag.no", "uasnorway.no"] }
  }, required: [] } } },
  { type: "function", function: { name: "move_status", description: "Flytt saken til en annen status. «publisert» er ikke tillatt; «wp-utkast» kun om et ekte WordPress-utkast finnes.", parameters: { type: "object", properties: { status: { type: "string", enum: STATUSES } }, required: ["status"] } } },
  { type: "function", function: { name: "generate_manuscript", description: "Generer et første manusutkast (research + skriving) for en sak som ennå ikke har manus. Tar 2–4 minutter. Bruk revise_manuscript hvis saken allerede har manus.", parameters: { type: "object", properties: {}, required: [] } } },
  { type: "function", function: { name: "list_events", description: "List kommende UAS Norway-arrangementer.", parameters: { type: "object", properties: {}, required: [] } } }
];

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } }

function caseContext(c, eventRow) {
  var manus = (c.manus_hovedtekst || []).join("\n\n");
  var lines = [
    "SAKSKONTEKST (dagens tilstand):",
    "Tittel: " + c.title, "Status: " + c.status + " · Sakstype: " + c.sakstype + " · Nettsted: " + (c.nettsted || "dronemag.no") + " · Hastegrad: " + c.hastegrad,
    "Eier: " + (c.eier || "Ikke tildelt") + " · Frist: " + (c.frist || "ingen") + " · Målgruppe: " + (c.malgruppe || "ikke satt") + " · Tema: " + (c.tema || "-") + " · Land: " + (c.land || "-"),
    "Neste handling: " + (c.neste_handling || "-"),
    "Kilder: " + ((c.kilder || []).map(function (k) { return /supabase\.co\/storage/.test(k) ? "(opplastet fil)" : k; }).join(" | ") || "ingen"),
    "AI-sammendrag: " + (c.oppsummering || "(ingen)")
  ];
  if (eventRow) lines.push("Koblet til arrangement: " + eventRow.title + " (" + eventRow.starts_on + ", " + eventRow.location + ")");
  if (c.manus_tittel || manus) {
    lines.push("", "MANUS I SAKEN:", "Tittel: " + (c.manus_tittel || ""), "Ingress: " + (c.manus_ingress || ""),
      "Brødtekst" + (manus.length > MAX_MANUS_CHARS_IN_CONTEXT ? " (kortet — bruk get_manuscript for alt)" : "") + ":\n" + manus.slice(0, MAX_MANUS_CHARS_IN_CONTEXT),
      "Bildetekst: " + (c.manus_alt_tekst || "-") + " · Foto: " + (c.manus_foto || "-") + " · Hovedbilde: " + (c.manus_bilde_url ? hostOf(c.manus_bilde_url) : "(ingen)"));
    if ((c.manus_kontrollpunkter || []).length) lines.push("Kontrollpunkter: " + c.manus_kontrollpunkter.join(" | "));
    if ((c.manus_kilder_brukt || []).length) lines.push("Kilder brukt i manuset: " + c.manus_kilder_brukt.map(function (k) { return k.navn + " — " + k.tittel; }).join(" | "));
  } else {
    lines.push("", "Saken har ENNÅ INGEN MANUS.");
  }
  if (c.bildeforslag && c.bildeforslag.alternativer) lines.push("Bildeforslag: " + c.bildeforslag.alternativer.length + " alternativer finnes i saken.");
  var hist = (c.historikk || []).slice(0, 6).map(function (h) { return "- " + String(h.text).slice(0, 180); });
  if (hist.length) lines.push("", "Siste historikk:", hist.join("\n"));
  return lines.join("\n");
}

// Kort visningstekst per verktøykall (vises som små merkelapper i chatten).
function actionLabel(name, args, result) {
  var feil = result && result.error;
  var map = {
    read_url: "Leste " + hostOf(args.url || ""),
    search_own_archive: "Søkte i eget arkiv",
    research_topic: "Researchet: " + String(args.sporsmal || "").slice(0, 70) + (result && result.kilder ? " (" + result.kilder.length + " kilder)" : ""),
    revise_manuscript: "Reviderte manuset",
    research_images: "Foreslo bilder",
    check_source: "Kjørte kildevurdering",
    vurder_saken: "Vurderte saken",
    update_case: "Oppdaterte " + Object.keys(args || {}).join(", "),
    move_status: "Flyttet til «" + (args.status || "") + "»",
    generate_manuscript: "Genererte manus"
  };
  return map[name] ? { tool: name, label: map[name], ok: !feil } : null;
}

async function executeTool(ctx, name, args) {
  var supabase = ctx.supabase, openaiKey = ctx.openaiKey, caseId = ctx.caseId;
  switch (name) {
    case "get_manuscript": {
      var r = await supabase.from("cases").select("manus_tittel, manus_ingress, manus_hovedtekst, manus_alt_tekst, manus_foto, manus_bilde_url, manus_kontrollpunkter, manus_kilder_brukt").eq("id", caseId).maybeSingle();
      if (r.error || !r.data) return { error: "Fant ikke saken." };
      return { tittel: r.data.manus_tittel, ingress: r.data.manus_ingress, brodtekst: (r.data.manus_hovedtekst || []).join("\n\n"), bildetekst: r.data.manus_alt_tekst, foto: r.data.manus_foto,
        kontrollpunkter: r.data.manus_kontrollpunkter, kilder_brukt: (r.data.manus_kilder_brukt || []).map(function (k) { return k.navn + " — " + k.tittel + " " + k.url; }) };
    }
    case "read_source": {
      var cr = await supabase.from("cases").select("kilder").eq("id", caseId).maybeSingle();
      var url = ((cr.data && cr.data.kilder) || []).filter(function (k) { return /^https?:\/\//i.test(k) && !/supabase\.co\/storage/.test(k); })[0];
      if (!url) return { error: "Saken har ingen nettside-kilde registrert." };
      var art = await fetchSourceArticle(url);
      return art.ok ? { url: url, medium: art.siteName, tittel: art.title, tekst: art.text } : { error: "Kunne ikke hente kilden (" + art.reason + ")." };
    }
    case "read_url": {
      if (!/^https?:\/\//i.test(args.url || "")) return { error: "Ugyldig URL." };
      var txt = await readExternalSource(args.url, args.hva_leter_du_etter || "");
      return txt ? { url: args.url, utdrag: txt } : { error: "Kunne ikke lese siden (utilgjengelig, blokkert eller for lite tekst)." };
    }
    case "search_own_archive": {
      var hits = await searchOwnArchive(args.sporring || "", { max: 6 });
      return { treff: hits.map(function (h) { return { tittel: h.tittel, url: h.url, publisert: h.publisert, utdrag: (h.tekst || "").slice(0, 300) }; }) };
    }
    case "research_topic": {
      var cr2 = await supabase.from("cases").select("title, oppsummering, manus_hovedtekst, kilder").eq("id", caseId).maybeSingle();
      var c2 = cr2.data || {};
      var sourceUrl = (c2.kilder || []).filter(function (k) { return /^https?:\/\//i.test(k) && !/supabase\.co\/storage/.test(k); })[0];
      var res = await deepResearch(openaiKey, {
        materialUtdrag: ((c2.title || "") + "\n" + (c2.manus_hovedtekst || []).join("\n")).slice(0, 8000),
        beskrivelse: "Spørsmål/tema som skal researches til saken «" + c2.title + "»: " + args.sporsmal,
        dokumentNavn: [], lenker: sourceUrl ? [sourceUrl] : [], egenSok: args.sporsmal + " " + (c2.title || "")
      });
      // Fletter inn i samtalens researchgrunnlag med løpende E-numre.
      var offset = ctx.research.kilder.reduce(function (m, k) { return Math.max(m, k.nr); }, 0);
      var have = {}; ctx.research.kilder.forEach(function (k) { have[k.url] = true; });
      res.kilder.forEach(function (k) { if (have[k.url]) return; k.nr = ++offset; ctx.research.kilder.push(k); });
      return {
        antall_verifiserte_kilder: res.antallVerifisert, feil: res.feil,
        kilder: ctx.research.kilder.map(function (k) { return { nr: k.nr, type: k.type, egen: !!k.egen, kilde: k.kilde_navn, tittel: k.tittel, url: k.url, utdrag: (k.tekst || "").slice(0, 350) }; })
      };
    }
    case "revise_manuscript": {
      var out = await reviseManuscript(supabase, openaiKey, caseId, args.instruks,
        { research: args.bruk_research && ctx.research.kilder.length ? ctx.research : null });
      ctx.manusEndret = true;
      return { ok: true, hva_ble_endret: out.hvaBleEndret, bilde: out.bildeMerknad, usikkerhet: out.usikkerhetsnotat, ny_tittel: out.manus.tittel, ny_ingress: out.manus.ingress, antall_avsnitt: out.manus.hovedtekst.length };
    }
    case "research_images": {
      var ri = await researchImages(supabase, openaiKey, caseId);
      var bf = ri.bildeforslag;
      return { antall: bf.alternativer.length, brukbare: bf.alternativer.filter(function (a) { return a.verifisering && a.verifisering.lenke_virker && !a.er_logo; }).length,
        ai_illustrasjoner: bf.alternativer.filter(function (a) { return a.ai_generert; }).length, beste_valg: bf.beste_valg_index === null ? null : (bf.alternativer[bf.beste_valg_index] || {}).motiv,
        merknad: "Forslagene vises i saken under Bildeforslag." };
    }
    case "check_source": {
      var ck = await checkSource(supabase, openaiKey, caseId);
      var kv = ck.kildevurdering || {};
      return { troverdighet: kv.troverdighet_score, label: kv.troverdighet_label, anbefaling: kv.anbefaling, merknad: "Full vurdering vises i saken under Kildevurdering." };
    }
    case "vurder_saken": {
      return await runTriage(supabase, openaiKey, [caseId]);
    }
    case "update_case": {
      var allowed = ["title", "sakstype", "hastegrad", "eier", "frist", "neste_handling", "kategori", "malgruppe", "oppsummering", "nettsted"];
      var fields = {};
      allowed.forEach(function (k) { if (args[k] !== undefined) fields[k] = args[k]; });
      if (!Object.keys(fields).length) return { error: "Ingen felter å oppdatere." };
      var up = await supabase.from("cases").update(fields).eq("id", caseId);
      return up.error ? { error: up.error.message } : { ok: true, oppdatert: Object.keys(fields) };
    }
    case "move_status": {
      if (args.status === "publisert") return { error: "Ikke tillatt: publisering krever at et menneske åpner saken, krysser av STOPP-kontrollen og velger godkjenner." };
      if (STATUSES.indexOf(args.status) === -1) return { error: "Ukjent status." };
      var cs = await supabase.from("cases").select("status, historikk, wp_post_id").eq("id", caseId).maybeSingle();
      if (!cs.data) return { error: "Fant ikke saken." };
      if (args.status === "wp-utkast" && cs.data.status !== "wp-utkast" && !cs.data.wp_post_id) {
        return { error: "Ikke tillatt: det finnes ikke noe faktisk WordPress-utkast. Bruk «🌐 Publiser til WordPress»-knappen i saken." };
      }
      var hist = [{ ts: new Date().toISOString(), text: "Status endret (saks-assistent): " + cs.data.status + " → " + args.status }].concat(cs.data.historikk || []);
      var mv = await supabase.from("cases").update({ status: args.status, historikk: hist }).eq("id", caseId);
      return mv.error ? { error: mv.error.message } : { ok: true, ny_status: args.status };
    }
    case "generate_manuscript": {
      var has = await supabase.from("cases").select("manus_tittel, manus_hovedtekst").eq("id", caseId).maybeSingle();
      if (has.data && (has.data.manus_tittel || (has.data.manus_hovedtekst || []).length)) return { error: "Saken har allerede manus — bruk revise_manuscript." };
      var g = await generateManuscript(supabase, openaiKey, caseId);
      ctx.manusEndret = true;
      return { ok: true, antall_kontrollpunkter: g.antallKontrollpunkter, fant_tidligere_dekning: g.fantTidligereDekning, har_bilde: g.harBilde };
    }
    case "list_events": {
      var ev = await supabase.from("events").select("title, event_type, location, starts_on, duration_days").gte("starts_on", new Date().toISOString().slice(0, 10)).order("starts_on");
      return ev.error ? { error: ev.error.message } : { events: ev.data || [] };
    }
    default:
      return { error: "Ukjent verktøy: " + name };
  }
}

async function callModel(openaiKey, messages) {
  var res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + openaiKey },
    body: JSON.stringify({ model: MODEL, messages: messages, tools: TOOLS, tool_choice: "auto" })
  });
  if (!res.ok) throw new Error("OpenAI-feil (" + res.status + "): " + (await res.text()).slice(0, 300));
  return res.json();
}

// history: tidligere meldinger [{role:'user'|'assistant', text}] (uten den nye).
async function runCaseAssistant(supabase, openaiKey, caseId, history, userMessage) {
  var cr = await supabase.from("cases").select("*").eq("id", caseId).maybeSingle();
  if (cr.error || !cr.data) throw new Error("Fant ikke saken.");
  var eventRow = null;
  if (cr.data.event_id) { var er = await supabase.from("events").select("*").eq("id", cr.data.event_id).maybeSingle(); eventRow = er.data || null; }

  var convo = [{ role: "system", content: SYSTEM_PROMPT + "\n\n" + todayLine() + "\n\n" + caseContext(cr.data, eventRow) }]
    .concat((history || []).filter(function (m) { return (m.role === "user" || m.role === "assistant") && m.text; })
      .slice(-16).map(function (m) { return { role: m.role, content: m.text }; }))
    .concat([{ role: "user", content: userMessage }]);

  var ctx = { supabase: supabase, openaiKey: openaiKey, caseId: caseId, research: { kilder: [], antallFunnet: 0, antallVerifisert: 0, feil: [] }, manusEndret: false };
  var handlinger = [];

  for (var round = 0; round < MAX_ROUNDS; round++) {
    var data = await callModel(openaiKey, convo);
    var msg = data.choices[0].message;
    convo.push(msg);
    if (!msg.tool_calls || !msg.tool_calls.length) return { reply: msg.content || "(tomt svar)", handlinger: handlinger };

    for (var i = 0; i < msg.tool_calls.length; i++) {
      var call = msg.tool_calls[i];
      var args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch (e) {}
      var result;
      try { result = await executeTool(ctx, call.function.name, args); }
      catch (err) { result = { error: err.message }; }
      var lbl = actionLabel(call.function.name, args, result);
      if (lbl) handlinger.push(lbl);
      convo.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 7000) });
    }
  }
  return { reply: "Jeg brukte for mange steg på dette og stoppet — be om noe mer avgrenset, så tar jeg det derfra.", handlinger: handlinger };
}

module.exports = { runCaseAssistant, executeTool, SYSTEM_PROMPT, TOOLS };
