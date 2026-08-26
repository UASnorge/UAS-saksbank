// Genererer et manus (.docx) for en godkjent idé, i det eksakte formatet
// "WordPress Infosak Batch Administrator" leser (TITTEL/BILDE/ALT-TEKST
// BILDE/FOTO/INGRESS/HOVEDTEKST). Henter kildeartikkelen saken bygger på,
// skriver et faktabasert førsteutkast i Dronemagasinet-stil grunnet KUN på
// den hentede kildeteksten, forsøker å finne kildeartikkelens eget bilde med
// kreditering, og laster manuset opp til Supabase Storage (bucket "manus").
//
// Kalles fra "Generer manus"-knappen når en sak er i "Godkjente idéer" eller
// senere. Krever innlogget bruker (Bearer-token) og OPENAI_API_KEY.
//
// VIKTIG presisjon: dette er et FØRSTEUTKAST. STOPP-regelen i appen gjelder
// uendret — ingenting publiseres uten at et menneske har lest, kontrollert og
// godkjent saken (og dette manuset) først.

const { createClient } = require("@supabase/supabase-js");
const {
  Document, Packer, Paragraph, TextRun, ImageRun
} = require("docx");

const TRIAGE_MODEL_FOR_STYLE = "gpt-5.5";
const MAX_SOURCE_CHARS = 6000;

const HOUSE_STYLE = `Du er journalist i Dronemagasinet (dronemag.no), medlem av Fagpressen og underlagt Redaktørplakaten.
Skriv nøktern, faktabasert norsk fagjournalistikk — kort ingress (1-3 setninger), så brødtekst i korte,
konkrete avsnitt. Bruk aktiv form, unngå synsing. Oppgi alltid hvor informasjon kommer fra når det er naturlig
(f.eks. "ifølge X" eller "skriver Y"). Basér deg UTELUKKENDE på fakta som faktisk står i kildeteksten du får
oppgitt under — finn ALDRI på detaljer, tall, sitater eller navn som ikke står der. Er noe uklart eller mangler
i kildeteksten, skriv det tydelig i feltet "usikkerhetsnotat" i stedet for å gjette i selve teksten.`;

const MANUSCRIPT_SCHEMA = {
  name: "manus",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      tittel: { type: "string" },
      ingress: { type: "string" },
      hovedtekst_avsnitt: { type: "array", items: { type: "string" }, minItems: 1 },
      alt_tekst_bilde: { type: "string" },
      usikkerhetsnotat: { type: ["string", "null"], description: "Kun hvis noe er usikkert/mangler i kilden. Ellers null. Skrives ALDRI inn i selve artikkelteksten." }
    },
    required: ["tittel", "ingress", "hovedtekst_avsnitt", "alt_tekst_bilde", "usikkerhetsnotat"]
  }
};

function getSupabaseForUser(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: "Bearer " + token } }
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMeta(html, prop) {
  var re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', "i");
  var m = html.match(re) || html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + prop + '["\']', "i"));
  return m ? m[1] : null;
}

async function fetchSourceArticle(url) {
  try {
    var res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; UASNorwaySaksbank/1.0)" } });
    if (!res.ok) return { ok: false, reason: "HTTP " + res.status };
    var html = await res.text();
    var ogImage = extractMeta(html, "og:image");
    var siteName = extractMeta(html, "og:site_name");
    var text = stripHtml(html).slice(0, MAX_SOURCE_CHARS);
    return { ok: true, text: text, imageUrl: ogImage, siteName: siteName || new URL(url).hostname };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function fetchImage(url) {
  try {
    var res = await fetch(url);
    if (!res.ok) return null;
    var contentType = res.headers.get("content-type") || "";
    var type = contentType.indexOf("png") !== -1 ? "png" : (contentType.indexOf("jpeg") !== -1 || contentType.indexOf("jpg") !== -1) ? "jpg" : null;
    if (!type) return null;
    var buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return null; // ikke ta med urimelig store bilder
    var dims = sniffImageDimensions(buf, type) || { width: 900, height: 550 };
    return { buffer: buf, type: type, width: dims.width, height: dims.height };
  } catch (err) {
    return null;
  }
}

function sniffImageDimensions(buf, type) {
  try {
    if (type === "png" && buf.length > 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (type === "jpg") {
      var i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        var marker = buf[i + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        var segLen = buf.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
    }
  } catch (err) {}
  return null;
}

function scaleToMaxWidth(w, h, maxW) {
  if (w <= maxW) return { width: w, height: h };
  var ratio = maxW / w;
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

async function callOpenAI(apiKey, model, systemPrompt, userPrompt, schema) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify({
      model: model,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      response_format: { type: "json_schema", json_schema: schema }
    })
  });
  if (!res.ok) throw new Error("OpenAI-feil (" + res.status + "): " + (await res.text()).slice(0, 300));
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

function buildDocxParagraphs(fields, image) {
  var paras = [];
  function field(label, value) {
    paras.push(new Paragraph({ children: [
      new TextRun({ text: label + ": ", bold: true }),
      new TextRun({ text: value || "" })
    ] }));
  }

  field("TITTEL", fields.tittel);
  paras.push(new Paragraph({ children: [new TextRun({ text: "BILDE:", bold: true })] }));
  if (image) {
    var size = scaleToMaxWidth(image.width, image.height, 900);
    paras.push(new Paragraph({ children: [new ImageRun({ type: image.type, data: image.buffer, transformation: size })] }));
  } else {
    paras.push(new Paragraph({ children: [new TextRun({ text: "(Ikke funnet automatisk — sett inn manuelt før opplasting)", italics: true })] }));
  }
  field("ALT-TEKST BILDE", fields.alt_tekst_bilde);
  field("FOTO", fields.fotoKreditering);
  field("INGRESS", fields.ingress);
  paras.push(new Paragraph({ children: [new TextRun({ text: "HOVEDTEKST:", bold: true })] }));
  fields.hovedtekst_avsnitt.forEach(function (p, i) {
    paras.push(new Paragraph({ children: [new TextRun({ text: p })] }));
    if (i < fields.hovedtekst_avsnitt.length - 1) paras.push(new Paragraph({ children: [] }));
  });
  return paras;
}

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
  if (!body.caseId) return { statusCode: 400, body: JSON.stringify({ error: "Mangler caseId." }) };

  const caseRes = await supabase.from("cases").select("*").eq("id", body.caseId).maybeSingle();
  if (caseRes.error || !caseRes.data) return { statusCode: 404, body: JSON.stringify({ error: "Fant ikke saken." }) };
  const c = caseRes.data;

  let eventContext = "";
  if (c.event_id) {
    const evRes = await supabase.from("events").select("*").eq("id", c.event_id).maybeSingle();
    if (evRes.data) {
      eventContext = "Denne saken er en INFO-sak koblet til arrangementet «" + evRes.data.title + "» (" +
        evRes.data.event_type + ", " + evRes.data.location + ", " + evRes.data.starts_on + "). Nevn arrangementet naturlig i teksten.";
    }
  }

  const sourceUrl = c.kilder && c.kilder.length ? c.kilder[0] : null;
  const source = sourceUrl ? await fetchSourceArticle(sourceUrl) : { ok: false, reason: "ingen kildelenke registrert" };

  const userPrompt =
    "Sakstittel (arbeidstittel, du kan forbedre den): " + c.title + "\n" +
    "Tidligere AI-sammendrag: " + (c.oppsummering || "(ingen)") + "\n" +
    (eventContext ? eventContext + "\n" : "") +
    "Kildelenke: " + (sourceUrl || "(ingen)") + "\n\n" +
    (source.ok
      ? "Hentet kildetekst (bruk KUN fakta herfra):\n" + source.text
      : "Kildeteksten kunne ikke hentes automatisk (" + source.reason + "). Skriv et kort, forsiktig utkast basert kun på tittelen og sammendraget over, og sett usikkerhetsnotat til at kilden må sjekkes manuelt før publisering.");

  const fields = await callOpenAI(openaiKey, TRIAGE_MODEL_FOR_STYLE, HOUSE_STYLE, userPrompt, MANUSCRIPT_SCHEMA);

  let image = null;
  if (source.ok && source.imageUrl) {
    image = await fetchImage(source.imageUrl);
  }
  fields.fotoKreditering = image && source.siteName ? source.siteName : "";

  const doc = new Document({ sections: [{ children: buildDocxParagraphs(fields, image) }] });
  const buffer = await Packer.toBuffer(doc);

  const path = c.id + "/" + Date.now() + ".docx";
  const uploadRes = await supabase.storage.from("manus").upload(path, buffer, {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    upsert: false
  });
  if (uploadRes.error) return { statusCode: 500, body: JSON.stringify({ error: "Kunne ikke laste opp manus: " + uploadRes.error.message }) };

  const historikkNote = "Manus generert (AI-førsteutkast)" + (fields.usikkerhetsnotat ? " — ⚠️ " + fields.usikkerhetsnotat : "") + (image ? "" : " — ingen bilde funnet automatisk, må settes inn manuelt");
  const historikk = [{ ts: new Date().toISOString(), text: historikkNote }].concat(c.historikk || []);

  const updateRes = await supabase.from("cases").update({
    manus_url: path,
    manus_generert_ts: new Date().toISOString(),
    historikk: historikk
  }).eq("id", c.id);
  if (updateRes.error) return { statusCode: 500, body: JSON.stringify({ error: updateRes.error.message }) };

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, path: path, harBilde: !!image, usikkerhetsnotat: fields.usikkerhetsnotat || null })
  };
};
