// Masseimport av RSS-kilder. Kalles fra "Kilder"-panelet i frontend.
//
// Tar imot enten:
//  - én lenke per linje (valgfritt "Navn | https://lenke"-format), eller
//  - en limt inn OPML-eksport (fra Feedly, Inoreader, el.l. — <outline xmlUrl="…">)
//
// For hver kandidat: sjekker om den faktisk er en gyldig RSS/Atom-feed FØR den
// lagres (akkurat som vi oppdaget at én foreslått Luftfartstilsynet-URL i praksis
// var død — dette fanger den typen feil automatisk i stedet for å lagre søppel).
//
// Er den IKKE en gyldig feed (f.eks. https://www.aftenposten.no/, som ikke har
// noen RSS-feed på akkurat den URL-en), avvises den IKKE lenger — den lagres i
// stedet som en "website"-kilde (type='website') og overvåkes av det generelle
// websøket (lib/webSearch.js / web-search-background.js) i stedet for RSS.
//
// Krever innlogget bruker (Supabase-sesjon sendt som Bearer-token). Bruker IKKE
// service_role — innsettingen skjer som den innloggede brukeren, styrt av RLS-
// policyene i supabase/schema.sql (samme rettigheter som resten av appen).

const Parser = require("rss-parser");
const { createClient } = require("@supabase/supabase-js");

const parser = new Parser({ timeout: 10000 });

const MAX_PER_IMPORT = 30; // hold én kjøring godt innenfor Netlify sin tidsgrense

function parseOpml(text) {
  var results = [];
  var re = /<outline\b[^>]*>/gi;
  var match;
  while ((match = re.exec(text))) {
    var tag = match[0];
    var urlMatch = tag.match(/xmlUrl=(["'])(.*?)\1/i);
    if (!urlMatch) continue;
    var titleMatch = tag.match(/(?:title|text)=(["'])(.*?)\1/i);
    results.push({
      url: decodeXmlEntities(urlMatch[2].trim()),
      name: titleMatch ? decodeXmlEntities(titleMatch[2].trim()) : ""
    });
  }
  return results;
}

function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function parsePlainList(text) {
  return text
    .split(/\r?\n/)
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line && line[0] !== "#"; })
    .map(function (line) {
      var pipeIdx = line.indexOf("|");
      if (pipeIdx !== -1) {
        return { name: line.slice(0, pipeIdx).trim(), url: line.slice(pipeIdx + 1).trim() };
      }
      return { name: "", url: line };
    });
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Kun POST er støttet." }) };
  }

  var authHeader = event.headers.authorization || event.headers.Authorization || "";
  var token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: "Mangler innlogging." }) };
  }

  var supabaseUrl = process.env.SUPABASE_URL;
  var anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server mangler SUPABASE_URL / SUPABASE_ANON_KEY som miljøvariabler i Netlify." })
    };
  }

  var supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: "Bearer " + token } }
  });

  var userRes = await supabase.auth.getUser(token);
  if (userRes.error || !userRes.data || !userRes.data.user) {
    return { statusCode: 401, body: JSON.stringify({ error: "Ugyldig eller utløpt innlogging. Last siden på nytt og prøv igjen." }) };
  }

  var body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Ugyldig forespørsel." }) };
  }

  var text = String(body.text || "").trim();
  if (!text) {
    return { statusCode: 400, body: JSON.stringify({ error: "Lim inn minst én RSS-lenke eller en OPML-eksport." }) };
  }

  var isOpml = /<opml[\s>]|<outline\b/i.test(text);
  var candidates = (isOpml ? parseOpml(text) : parsePlainList(text)).filter(function (c) {
    return /^https?:\/\//i.test(c.url);
  });

  if (!candidates.length) {
    return { statusCode: 400, body: JSON.stringify({ error: "Fant ingen gyldige lenker (må starte med http:// eller https://)." }) };
  }

  var overflow = Math.max(0, candidates.length - MAX_PER_IMPORT);
  candidates = candidates.slice(0, MAX_PER_IMPORT);

  var existingRes = await supabase.from("sources").select("feed_url");
  if (existingRes.error) {
    return { statusCode: 500, body: JSON.stringify({ error: "Kunne ikke lese eksisterende kilder: " + existingRes.error.message }) };
  }
  var existingUrls = new Set((existingRes.data || []).map(function (r) { return r.feed_url; }));

  // Valider alle kandidatene PARALLELT — ellers kan 20-30 sekvensielle
  // nettverkskall (inkl. trege/døde feeder) sprenge Netlify sin tidsgrense.
  var checked = await Promise.allSettled(
    candidates.map(async function (cand) {
      if (existingUrls.has(cand.url)) return { status: "skipped", url: cand.url };
      try {
        var feed = await parser.parseURL(cand.url);
        return { status: "valid", url: cand.url, name: cand.name || feed.title || cand.url, type: "rss" };
      } catch (err) {
        // Ikke en gyldig RSS/Atom-feed — men fortsatt en gyldig, nåbar URL?
        // Legg den da til som en "website"-kilde i stedet for å avvise den.
        // Kun ekte nettverksfeil (domenet finnes ikke, tidsavbrudd) avvises helt.
        try {
          var headRes = await fetch(cand.url, { method: "GET", redirect: "follow" });
          if (!headRes.ok) throw new Error("HTTP " + headRes.status);
          return { status: "valid", url: cand.url, name: cand.name || new URL(cand.url).hostname, type: "website" };
        } catch (fetchErr) {
          return { status: "failed", url: cand.url, error: "Verken en gyldig RSS-feed eller et nåbart nettsted: " + err.message };
        }
      }
    })
  );

  var added = [], skipped = [], failed = [];

  for (var i = 0; i < checked.length; i++) {
    var r = checked[i].value || { status: "failed", url: candidates[i].url, error: "Ukjent feil" };
    if (r.status === "skipped") { skipped.push(r.url); continue; }
    if (r.status === "failed") { failed.push({ url: r.url, error: r.error }); continue; }

    var insertRes = await supabase.from("sources").insert({ name: r.name, feed_url: r.url, active: true, type: r.type });
    if (insertRes.error) failed.push({ url: r.url, error: insertRes.error.message });
    else added.push({ url: r.url, name: r.name, type: r.type });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ added: added, skipped: skipped, failed: failed, overflow: overflow })
  };
};
