// Innholdssjekk av et bilde med syn: er dette et REDAKSJONELT bilde som kan
// være hovedbilde til saken (foto/illustrasjon/kart/figur av noe konkret), eller
// en logo, merkevaregrafikk, ikon, standard delingsbilde eller skjermbilde?
//
// Hvorfor: å filtrere på URL/filnavn (lib/imageUtils.looksGenericUrl) er ikke nok.
// Aftenposten sitt og:image er merkevare-logoen «A» med lydbølger på en anonym
// Schibsted-CDN-URL uten ordet «logo» noe sted — den endte som hovedbilde på en
// sak. Bare å se på selve bildet avslører den slags.
//
// Feiler bevisst «lukket» der det gjelder: kan ikke bildet vurderes, regnes det
// IKKE som godkjent for strict-bruk (f.eks. og:image-fallback).

const CHECK_MODEL = "gpt-5.4-mini";
const MAX_INLINE_BYTES = 3 * 1024 * 1024;

const SCHEMA = {
  name: "bildevurdering",
  strict: true,
  schema: {
    type: "object", additionalProperties: false,
    properties: {
      kategori: { type: "string", enum: ["redaksjonelt_bilde", "logo_eller_merkevare", "generisk_grafikk_eller_ikon", "skjermbilde_eller_tekstbilde", "annet"] },
      viser: { type: "string", description: "Kort, på norsk: hva bildet faktisk viser." },
      egnet_som_hovedbilde: { type: "boolean" }
    },
    required: ["kategori", "viser", "egnet_som_hovedbilde"]
  }
};

const SYSTEM = `Du vurderer om et bilde kan brukes som HOVEDBILDE til en norsk nyhetssak i et fagmedium om droner.

Kategorier:
- redaksjonelt_bilde: et ekte foto, kart (også kartutsnitt med markerte områder/soner), figur, tegning eller illustrasjon av noe konkret (person, drone, sted, hendelse, utstyr, geografisk område).
- logo_eller_merkevare: en logo, ordmerke, bokstavsymbol, medie-/organisasjons-/selskapsmerke, eller et standard delings-/OG-bilde med en merkevare på flat bakgrunn (typisk et symbol midt på en ensfarget flate) — SELV OM det er pent og stort.
- generisk_grafikk_eller_ikon: ikon, piktogram, abstrakt dekorasjon, plassholder.
- skjermbilde_eller_tekstbilde: skjermbilde av en nettside/app, tabell, dokumentside eller sitatkort/tekstplakat (et KART er ikke et skjermbilde i denne betydningen).
- annet.

egnet_som_hovedbilde = true KUN for redaksjonelt_bilde som ikke åpenbart viser noe helt urelatert til sakens tema. En logo (f.eks. en avis' eller etats logo) er ALDRI egnet, uansett sak.`;

// image: { buffer, type } (foretrukket) og/eller { url }. ctx: { tittel }.
// Returnerer { ok, kategori, viser, vurdert } — vurdert=false betyr at sjekken selv feilet.
async function classifyImage(openaiKey, image, ctx) {
  try {
    var imageUrl;
    if (image.buffer && image.buffer.length <= MAX_INLINE_BYTES) {
      var mime = image.type === "png" ? "image/png" : image.type === "webp" ? "image/webp" : image.type === "gif" ? "image/gif" : "image/jpeg";
      imageUrl = "data:" + mime + ";base64," + image.buffer.toString("base64");
    } else {
      imageUrl = image.url;
    }
    if (!imageUrl) return { ok: false, vurdert: false, kategori: "annet", viser: "" };
    var res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + openaiKey },
      body: JSON.stringify({
        model: CHECK_MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: [
            { type: "text", text: "Sakens tittel: " + ((ctx && ctx.tittel) || "(ukjent)") + ". Vurder bildet under." },
            { type: "image_url", image_url: { url: imageUrl, detail: "low" } }
          ] }
        ],
        response_format: { type: "json_schema", json_schema: SCHEMA }
      })
    });
    if (!res.ok) return { ok: false, vurdert: false, kategori: "annet", viser: "" };
    var out = JSON.parse((await res.json()).choices[0].message.content);
    return { ok: out.kategori === "redaksjonelt_bilde" && out.egnet_som_hovedbilde, vurdert: true, kategori: out.kategori, viser: out.viser };
  } catch (err) {
    return { ok: false, vurdert: false, kategori: "annet", viser: "" };
  }
}

module.exports = { classifyImage };
