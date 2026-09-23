// Delt relevans-sjekk — brukt av rss-poll.js (filtrer FØR en sak opprettes)
// og cleanup-irrelevant.js (rydd i saker som allerede ligger i "Idé").
//
// Billig/rask modell med vilje — dette er en enkel ja/nei-klassifisering som
// kjøres på hvert eneste RSS-treff, volum trumfer nøyaktighet på siste tiendedel.

// Oppgradert fra gpt-5.4-nano til gpt-5.4-mini: nano viste seg ustabil
// (varierende svar mellom identiske kjøringer) på den to-delte
// dronekobling+redaksjonell-linje-vurderingen under — for viktig en
// portvakt (avgjør hva som i det hele tatt blir en "idé") til å la stå
// med den ustabiliteten, selv om det koster litt mer per sjekk.
const RELEVANCE_MODEL = "gpt-5.4-mini";

const RELEVANCE_CRITERIA = `Du avgjør om en sak er relevant for Dronemagasinet (dronemag.no) og UAS Norway — i to steg.

STEG 1 — dronekobling: tittelen (eller teksten du får) må inneholde en tydelig referanse til: drone(r), UAS, UAV,
ubemannet luft-/sjø-/bakkesystem, en kjent droneprodusent eller -aktør (DJI, Skydio, Parrot, Anduril o.l.),
motdrone/antidrone-teknologi, eVTOL/avansert luftmobilitet, droneregelverk, dronebransjen/droneindustrien,
eller UAS Norways egne kurs/arrangementer — SELV OM tittelen er kort og ikke gir full kontekst. Et tydelig nøkkelord i tittelen er nok
til å regne saken som relevant her; ikke krev at hele saken er utdypet i tittelen alene. Eksempler som SKAL bestå
steg 1: "1000 rådyr reddet av droner i år", "DJI tester ny eVTOL-drone på Mount Everest". Mangler et slikt nøkkelord
helt (f.eks. "Forsvaret trener med allierte på Jan Mayen" — ingen dronenevnelse), er saken IKKE relevant — stopp her.

STEG 2 — redaksjonell linje (kun for saker som besto steg 1): Standardsvaret er relevant=true. Sett relevant=false
KUN i disse tre tilfellene:
1. Utenlandsk (ikke-nordisk) militær/forsvar/våpen-dronebruk — saken handler om et ikke-nordisk lands forsvar,
   militære, etterretning, våpendroner, kampdroner eller en C-UAS-/motdrone-kontrakt, ENTEN hos et navngitt
   ikke-nordisk land ELLER hos en kjent ikke-nordisk forsvars-/militærprodusent (f.eks. General Atomics/GA-ASI,
   Anduril, Lockheed Martin, Northrop Grumman, Elbit Systems, DroneShield, Shield AI) — selv om landet ikke er
   eksplisitt nevnt i tittelen, telles disse som utenlandsk forsvarsindustri.
2. Amerikansk droneregelverk uten nordisk kobling — saken handler om FAA, FCC eller lignende amerikansk
   myndighets regelverksprosess, OG er ikke samtidig en EASA-sak (EASA gjelder direkte for Norge og er alltid relevant).
3. Utenlandsk droneleveringstjeneste i utlandet — saken handler om Zipline, Amazon Prime Air, Wing, Flytrex,
   Matternet e.l. sin utrulling i et annet land enn Norge/Norden.

Alt annet er relevant=true — også norske forsvars-/politi-/sikkerhetssaker (Nammo, Kongsberg, FFI, Forsvaret,
Politiet), alt sivilt/kommersielt uansett land, og tvetydige eller korte titler uten tydelig utenlandsk avsender.
Er du usikker på om et av de tre unntakene over faktisk stemmer: behold relevant=true.`;

const RELEVANCE_SCHEMA = {
  name: "relevans",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      relevant: { type: "boolean" },
      begrunnelse: { type: "string" }
    },
    required: ["relevant", "begrunnelse"]
  }
};

async function checkRelevance(openaiKey, title, extra) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + openaiKey },
    body: JSON.stringify({
      model: RELEVANCE_MODEL,
      messages: [
        { role: "system", content: RELEVANCE_CRITERIA },
        { role: "user", content: "Tittel: " + title + (extra ? "\n" + extra : "") }
      ],
      response_format: { type: "json_schema", json_schema: RELEVANCE_SCHEMA }
    })
  });
  if (!res.ok) {
    throw new Error("OpenAI-feil (" + res.status + "): " + (await res.text()).slice(0, 200));
  }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

module.exports = { checkRelevance };
