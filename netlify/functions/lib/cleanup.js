// Delt kjernelogikk for å rydde bort ikke-dronerelevante idéer. Brukt av
// cleanup-irrelevant.js (kalt fra "🧹 Fjern ikke-relevante"-knappen) og
// assistant-chat.js (kalt som ETT verktøy av AI-assistenten, i stedet for at
// den prøver å vurdere/slette mange saker enkeltvis via chat — det er nettopp
// det som en gang fikk en runde med 148 saker til å tidsavbrytes).
//
// Rører bevisst KUN status "ide" — saker et menneske allerede har godkjent
// eller jobbet videre med, lar vi stå urørt uansett hva AI-en mener nå.

const { checkRelevance } = require("./relevance.js");

const MAX_PER_RUN = 60;

// supabase: en klient autentisert SOM en innlogget bruker (RLS gjelder).
async function cleanupIrrelevantCases(supabase, openaiKey) {
  const casesRes = await supabase.from("cases").select("*").eq("status", "ide").order("created_at").limit(MAX_PER_RUN + 1);
  if (casesRes.error) throw new Error(casesRes.error.message);
  let cases = casesRes.data || [];
  const overflow = Math.max(0, cases.length - MAX_PER_RUN);
  cases = cases.slice(0, MAX_PER_RUN);

  if (!cases.length) {
    return { fjernet: [], beholdt: 0, feilet: [], sjekket: 0, overflow: 0 };
  }

  const checked = await Promise.allSettled(cases.map(async function (c) {
    var kildeInfo = c.kilder && c.kilder.length ? "Kilde: " + c.kilder[0] : "";
    var verdict = await checkRelevance(openaiKey, c.title, kildeInfo);
    return { id: c.id, title: c.title, relevant: verdict.relevant, begrunnelse: verdict.begrunnelse };
  }));

  var fjernet = [], feilet = [], beholdt = 0, toDelete = [];

  checked.forEach(function (r, i) {
    if (r.status === "rejected") {
      feilet.push({ title: cases[i].title, error: r.reason ? r.reason.message : "ukjent feil" });
      return;
    }
    if (r.value.relevant) { beholdt++; return; }
    toDelete.push(r.value.id);
    fjernet.push({ title: r.value.title, begrunnelse: r.value.begrunnelse });
  });

  if (toDelete.length) {
    var delRes = await supabase.from("cases").delete().in("id", toDelete);
    if (delRes.error) throw new Error("Kunne ikke slette: " + delRes.error.message);
  }

  return { fjernet: fjernet, beholdt: beholdt, feilet: feilet, sjekket: cases.length, overflow: overflow };
}

module.exports = { cleanupIrrelevantCases, MAX_PER_RUN };
