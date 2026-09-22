// Delt kjernelogikk for AI-vurdering av idéer. Brukt av både ai-triage.js
// (kalt direkte fra "Kjør AI-vurdering"-knappen) og assistant-chat.js
// (kalt som verktøy av AI-assistenten) — samme, allerede testede logikk,
// ikke to divergerende kopier.

const OPENAI_MODEL = "gpt-5.4-mini";
const MAX_PER_RUN = 15;

const HOUSE_STYLE = `Du er redaksjonell rådgiver for Dronemagasinet (dronemag.no) og UAS Norway (uasnorway.no).
Dronemagasinet er et fagpressemedlem som skriver faktabasert, nøktern norsk fagjournalistikk om droner.

VIKTIG, redaksjonell grunnregel: Dronemagasinet er IKKE et forsvarsmagasin. Ren militær/forsvarsdekning
(forsvarsanskaffelser, forsvarsstrategi, NATO-øvelser, C-UAS-kontrakter, generell internasjonal krigsdekning
med droner — Ukraina, Midtøsten osv.) skal ha LAV aktualitet/betydning-score og forekomme SJELDEN — dette er
en bevisst, uttalt redaksjonell linje ("helst så lite forsvar som mulig"), ikke en tilfeldighet. Analyse av
faktisk publiserte saker viser at nesten ingen slike saker noensinne blir til en artikkel.

Det redaksjonen faktisk skriver mest om (skal ha HØY aktualitet/betydning når relevant), i prioritert
rekkefølge: (1) norske/nordiske politi- og sikkerhetshendelser med droner (droneforbud ved arrangementer,
politiets egen dronebruk, PST, ulovlig flyging, luftromskrenkelser) — den klart største kategorien i praksis,
(2) norsk/nordisk regelverk og infrastruktur (Luftfartstilsynet, EASA, Avinor, registreringsplikt, høringer),
(3) sivil/kommersiell bruk i Norge/Norden (landbruksdroner, dronelevering/logistikk, kartlegging/inspeksjon,
viltredning, arrangementsflyging), (4) norske droneselskaper (lansering, krise, konkurs, svindel). Internasjonale
saker (ikke-nordiske) skal kun få høy score når de er en vesentlig EASA-regelendring eller en stor,
allmenngyldig produktnyhet — ikke bare fordi de handler om droner. De skriver også LITE om forbrukerdrone-
anmeldelser (produkttest-aktige artikler).

Du setter i tillegg ETT tema-merke per sak, til bruk i et filter/kategoriseringspanel — velg det som passer BEST (ikke flere), ut fra hovedvinkelen i saken:
- POLITI_SIKKERHET: politi, PST, droneforbud/luftromsrestriksjoner, sikkerhetshendelser, ulovlig droneflyging — IKKE ren militær/forsvarsanskaffelse (se FORSVAR_MILITAERT).
- FORSVAR_MILITAERT: ren militær/forsvarsdekning (forsvarsanskaffelser, forsvarsstrategi, NATO/øvelser, C-UAS-kontrakter, krigsdekning) — brukes SJELDEN, kun når saken faktisk ikke passer bedre i POLITI_SIKKERHET eller et sivilt tema. Husk grunnregelen over: dette skal IKKE være en default-bøtte for "alt med sikkerhetsvinkel".
- REGELVERK_LUFTFART: regelverk, sertifisering, luftromsintegrasjon, høringer, Luftfartstilsynet/EASA/Avinor/andre myndigheter.
- TEKNOLOGI_PRODUKT: ny drone/komponent/programvare, produktlansering, teknisk gjennombrudd — uten at forsvar eller landbruk er hovedvinkelen.
- LANDBRUK: landbruksdroner, sprøyting, jordbruk.
- INDUSTRI_KARTLEGGING: kartlegging, inspeksjon, anlegg/bygg, industri, geodata.
- LOGISTIKK_LEVERING: dronelevering, logistikk, transport.
- SELSKAP_MARKED: selskapsnyheter, finansiering, marked, oppkjøp, børs, konkurs/svindel — uten at et konkret produkt/en konkret teknologi er hovedvinkelen.
- ULYKKE_HENDELSE: ulykker, kræsj (ikke-politi/sikkerhet), rettssaker som ikke er selskapssvindel.
- ARRANGEMENT_UTDANNING: kurs, konferanser, utdanning, webinarer (typisk samme saker som får sakstype "content").
- ANNET: passer ikke tydelig i noen av de over.

Du setter i tillegg ETT land-merke — hvilket land/region saken HOVEDSAKELIG handler om/utspiller seg i (ikke bare hvor utgiveren er fra): NORGE, DANMARK, SVERIGE eller FINLAND for de nordiske landene. For alt annet: forsøk ALLTID å si noe mer presist enn bare "internasjonalt" når det faktisk fremgår av saken — bruk EUROPA (øvrige europeiske land, f.eks. Tyskland, Frankrike, Storbritannia, Nederland, EU-nivå), USA, eller ASIA (f.eks. Kina, Japan, Sør-Korea). Sett kun INTERNASJONALT som SISTE utvei, når saken genuint ikke har noen tydelig enkelt-region/land som hovedvinkel (f.eks. en global bransjetrend, et selskap aktivt i mange verdensdeler samtidig, eller et rent produkt uten stedsangivelse). Unngå INTERNASJONALT der et konkret land/verdensdel faktisk fremgår av tittelen/konteksten — det skal være unntaket, ikke standardvalget.

Tre sakstyper skal kunne skilles tydelig:
- "redaksjonell" (vises som "Dronemagasin"): ordinær redaksjonell nyhetssak for dronemag.no/uasnorway.no.
- "content" (vises som "INFO"): saken passer bedre som informasjon knyttet til et konkret UAS Norway-kurs,
  webinar eller konferanse enn som fri nyhetssak — typisk fordi temaet er noe de allerede underviser i eller
  arrangerer noe om. Skal bare velges når det faktisk finnes et treffende arrangement i listen du får oppgitt.
- "ai" (vises som "Kommentar"): saken egner seg bedre som en kommentar/meningssak enn en nøytral nyhetssak —
  typisk bransjekritikk, analyse eller debattinnlegg-aktig vinkel, ikke en ren nyhetshendelse.`;

async function callOpenAI(apiKey, systemPrompt, userPrompt, schema) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_schema", json_schema: schema }
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("OpenAI-feil (" + res.status + "): " + text.slice(0, 300));
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

const TRIAGE_SCHEMA = {
  name: "triage_vurdering",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sakstype: { type: "string", enum: ["redaksjonell", "content", "ai"] },
      tema: {
        type: "string",
        enum: ["POLITI_SIKKERHET", "FORSVAR_MILITAERT", "REGELVERK_LUFTFART", "TEKNOLOGI_PRODUKT", "LANDBRUK", "INDUSTRI_KARTLEGGING",
          "LOGISTIKK_LEVERING", "SELSKAP_MARKED", "ULYKKE_HENDELSE", "ARRANGEMENT_UTDANNING", "ANNET"]
      },
      land: { type: "string", enum: ["NORGE", "DANMARK", "SVERIGE", "FINLAND", "EUROPA", "USA", "ASIA", "INTERNASJONALT"] },
      hastegrad: { type: "string", enum: ["akutt", "planlagt", "tidlos"] },
      aktualitet: { type: "integer", minimum: 1, maximum: 5 },
      betydning: { type: "integer", minimum: 1, maximum: 5 },
      innsats: { type: "integer", minimum: 1, maximum: 5 },
      eksklusivitet: { type: "integer", minimum: 1, maximum: 5 },
      oppsummering: { type: "string", description: "2-4 setninger på norsk om hvorfor saken er/ikke er aktuell." },
      arrangement_tittel: { type: ["string", "null"], description: "Eksakt tittel på arrangementet fra listen, kun hvis sakstype er content. Ellers null." },
      begrunnelse: { type: "string", description: "Kort, én setning, til historikklogg." }
    },
    required: ["sakstype", "tema", "land", "hastegrad", "aktualitet", "betydning", "innsats", "eksklusivitet", "oppsummering", "arrangement_tittel", "begrunnelse"]
  }
};

// supabase: en klient autentisert SOM en innlogget bruker (RLS gjelder).
async function runTriage(supabase, openaiKey, caseIds) {
  caseIds = (caseIds || []).filter(Boolean);
  if (!caseIds.length) return { vurdert: 0, feilet: [], overflow: 0 };
  const overflow = Math.max(0, caseIds.length - MAX_PER_RUN);
  caseIds = caseIds.slice(0, MAX_PER_RUN);

  const [casesRes, eventsRes] = await Promise.all([
    supabase.from("cases").select("*").in("id", caseIds),
    supabase.from("events").select("title, event_type, location, starts_on, duration_days")
      .gte("starts_on", new Date().toISOString().slice(0, 10)).order("starts_on")
  ]);
  if (casesRes.error) throw new Error(casesRes.error.message);

  const events = eventsRes.data || [];
  const eventsList = events.length
    ? events.map(function (e) { return "- " + e.title + " (" + e.event_type + ", " + e.location + ", " + e.starts_on + ")"; }).join("\n")
    : "(ingen kommende arrangementer registrert)";

  const vurdert = [], feilet = [];

  const results = await Promise.allSettled((casesRes.data || []).map(async function (c) {
    const userPrompt =
      "Kommende UAS Norway-arrangementer:\n" + eventsList + "\n\n" +
      "Sak som skal vurderes:\n" +
      "Tittel: " + c.title + "\n" +
      "Nettsted: " + c.nettsted + "\n" +
      "Kilde(r): " + (c.kilder && c.kilder.length ? c.kilder.join(", ") : "(ingen)") + "\n" +
      "Notat/neste handling: " + (c.neste_handling || "(ingen)");

    const result = await callOpenAI(openaiKey, HOUSE_STYLE, userPrompt, TRIAGE_SCHEMA);

    let eventId = null;
    if (result.sakstype === "content" && result.arrangement_tittel) {
      const match = events.find(function (e) { return e.title === result.arrangement_tittel; });
      if (match) {
        const { data: full } = await supabase.from("events").select("id").eq("title", match.title).eq("starts_on", match.starts_on).maybeSingle();
        if (full) eventId = full.id;
      }
    }

    const historikk = [{
      ts: new Date().toISOString(),
      text: "AI-vurdering: " + result.begrunnelse
    }].concat(c.historikk || []);

    const update = {
      sakstype: result.sakstype,
      tema: result.tema,
      land: result.land,
      hastegrad: result.hastegrad,
      triage: { aktualitet: result.aktualitet, betydning: result.betydning, innsats: result.innsats, eksklusivitet: result.eksklusivitet },
      oppsummering: result.oppsummering,
      event_id: eventId,
      historikk: historikk
    };

    const updateRes = await supabase.from("cases").update(update).eq("id", c.id);
    if (updateRes.error) throw new Error(updateRes.error.message);
    return { id: c.id, title: c.title, sakstype: result.sakstype, hastegrad: result.hastegrad };
  }));

  results.forEach(function (r, i) {
    const c = (casesRes.data || [])[i];
    if (r.status === "fulfilled") vurdert.push(r.value);
    else feilet.push({ id: c ? c.id : "?", title: c ? c.title : "?", error: r.reason ? r.reason.message : "ukjent feil" });
  });

  return { vurdert: vurdert, feilet: feilet, overflow: overflow };
}

module.exports = { runTriage };
