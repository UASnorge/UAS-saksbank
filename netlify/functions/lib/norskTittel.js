// Alle sakstitler i saksbanken skal være på norsk (bokmål) — kilder kommer på
// svensk, finsk, dansk, engelsk osv. Brukes ved opprettelse av saker (RSS,
// websøk, «Lim inn lenke») og til å rette opp eksisterende titler.
//
// Er tittelen allerede norsk, returneres den UENDRET. Egennavn, produktnavn,
// forkortelser (UAS, EASA, NATO …) og tall beholdes. Feiler oversettelsen
// (nett/API/kreditt), brukes originaltittelen — en sak skal aldri gå tapt
// eller stoppe opp på grunn av en tittel.

const MODEL = "gpt-5.4-mini";

const SYSTEM = `Du er språkvasker for en norsk nyhetsredaksjon (Dronemagasinet). For HVER tittel du får:
- Er den allerede på norsk (bokmål eller nynorsk): returner den NØYAKTIG uendret.
- Er den på svensk, dansk, finsk, engelsk, tysk eller annet språk: oversett til naturlig, nøktern norsk bokmål i nyhetsstil.
- Behold egennavn (personer, selskaper, steder, produkter), forkortelser (UAS, EASA, NATO, CUAS …), modellnavn og tall uendret.
- Ikke legg til, fjern eller tolk fakta. Ikke gjør tittelen mer spennende. Ikke legg til anførselstegn eller prefiks.
Returner like mange titler som du fikk, i samme rekkefølge.`;

function sameAfterNormalize(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// titles: string[] → [{ tittel, original, oversatt }] (samme rekkefølge).
async function norskeTitler(openaiKey, titles) {
  var fallback = titles.map(function (t) { return { tittel: t, original: t, oversatt: false }; });
  if (!openaiKey || !titles.length) return fallback;
  try {
    var res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + openaiKey },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: JSON.stringify(titles) }],
        response_format: { type: "json_schema", json_schema: { name: "titler", strict: true, schema: {
          type: "object", additionalProperties: false,
          properties: { titler: { type: "array", items: { type: "string" } } }, required: ["titler"]
        } } }
      })
    });
    if (!res.ok) return fallback;
    var out = JSON.parse((await res.json()).choices[0].message.content).titler;
    if (!Array.isArray(out) || out.length !== titles.length) return fallback;
    return titles.map(function (orig, i) {
      var nyTittel = String(out[i] || "").trim();
      // Tom, eller urimelig mye lengre/kortere enn originalen → stol ikke på den.
      if (!nyTittel || nyTittel.length > orig.length * 2.5 + 20 || nyTittel.length < orig.length / 3) return fallback[i];
      return { tittel: nyTittel, original: orig, oversatt: !sameAfterNormalize(nyTittel, orig) };
    });
  } catch (err) {
    return fallback;
  }
}

async function norskTittel(openaiKey, title) {
  return (await norskeTitler(openaiKey, [title]))[0];
}

// Historikk-oppføring som bevarer originaltittelen når den er oversatt.
function originalTittelHistorikk(result, ts) {
  return result && result.oversatt ? [{ ts: ts, text: "Tittel oversatt til norsk — original fra kilden: «" + result.original + "»" }] : [];
}

module.exports = { norskTittel, norskeTitler, originalTittelHistorikk };
