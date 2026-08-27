// Delt relevans-sjekk — brukt av rss-poll.js (filtrer FØR en sak opprettes)
// og cleanup-irrelevant.js (rydd i saker som allerede ligger i "Idé").
//
// Billig/rask modell med vilje — dette er en enkel ja/nei-klassifisering som
// kjøres på hvert eneste RSS-treff, volum trumfer nøyaktighet på siste tiendedel.

const RELEVANCE_MODEL = "gpt-5.4-nano";

const RELEVANCE_CRITERIA = `Du avgjør om en sak er relevant for Dronemagasinet (dronemag.no) og UAS Norway.

RELEVANT hvis tittelen (eller teksten du får) inneholder en tydelig referanse til: drone(r), UAS, UAV,
ubemannet luft-/sjø-/bakkesystem, en kjent droneprodusent eller -aktør (DJI, Skydio, Parrot, Anduril o.l.),
motdrone/antidrone-teknologi, eVTOL/avansert luftmobilitet, droneregelverk, dronebransjen/droneindustrien,
eller UAS Norways egne kurs/arrangementer — SELV OM tittelen er kort og ikke gir full kontekst. Et tydelig nøkkelord i tittelen er nok
til å regne saken som relevant; ikke krev at hele saken er utdypet i tittelen alene. Eksempler som SKAL
regnes som relevante ut fra tittel alene: "1000 rådyr reddet av droner i år", "DJI tester ny eVTOL-drone på
Mount Everest".

IKKE relevant = saken har INGEN nevneverdig kobling til droner/UAS i det hele tatt — generelt forsvarsstoff
uten dronevinkel, generell politikk/budsjett, generelle nyheter, eller annen teknologi uten drone-tilknytning
— selv om kilden av og til skriver om droner. Eksempel: "Forsvaret trener med allierte på Jan Mayen" (ingen
dronenevnelse) skal regnes som IKKE relevant.

Ved reell tvil uten noe drone-/UAS-nøkkelord: regn som IKKE relevant. Men tilstedeværelse av et eksplisitt
nøkkelord (droner, UAS, UAV, dronefly, motdrone/antidrone, eVTOL, en kjent droneprodusent) avgjør — da er
saken relevant selv med en kort eller uklar tittel for øvrig.`;

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
