// Delt hjelpefunksjon for å FAKTISK verifisere at en URL fungerer, med en
// ekte HTTP-forespørsel — ikke bare stole på at en AI-modell sier den har
// sjekket noe. Brukt av både kildevurdering (lib/sourceCheck.js) og
// bilderesearch (lib/imageResearch.js), som begge har en ufravikelig
// "grunnregel" i sine spesifikasjoner: aldri fremstill noe som kontrollert
// uten at det faktisk er kontrollert. Dette ble konkret nødvendig etter at
// gpt-5-search-api viste seg å kunne dikte opp spesifikke bilde-URL-er som så
// troverdige ut, men som ga 404 ved faktisk sjekk.
//
// Prøver HEAD først (billigst — laster ikke ned innholdet), faller tilbake
// til GET (med Range-header for å unngå å laste ned hele responsen) hvis
// serveren avviser HEAD (405/403 er vanlig for en del mediebanker/CDN-er).

const TIMEOUT_MS = 8000;
const USER_AGENT = "Mozilla/5.0 (compatible; UASNorwaySaksbank-Kildekontroll/1.0)";

async function attemptFetch(url, method) {
  var ac = new AbortController();
  var timer = setTimeout(function () { ac.abort(); }, TIMEOUT_MS);
  try {
    var headers = { "User-Agent": USER_AGENT };
    if (method === "GET") headers.Range = "bytes=0-4000";
    var res = await fetch(url, { method: method, redirect: "follow", signal: ac.signal, headers: headers });
    return { res: res };
  } catch (err) {
    return { err: err };
  } finally {
    clearTimeout(timer);
  }
}

// Returnerer { checked, ok, status, error }. checked=false betyr at det ikke
// engang var en gyldig URL å teste (ikke det samme som en feilet test).
async function verifyUrl(url) {
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return { checked: false, ok: false, status: null, error: "Ingen gyldig URL oppgitt" };
  }
  var head = await attemptFetch(url, "HEAD");
  if (head.res && head.res.status !== 405 && head.res.status !== 403) {
    return { checked: true, ok: head.res.ok, status: head.res.status, error: null };
  }
  var get = await attemptFetch(url, "GET");
  if (get.res) {
    return { checked: true, ok: get.res.ok, status: get.res.status, error: null };
  }
  var errMsg = (get.err && get.err.message) || (head.err && head.err.message) || "ukjent feil";
  return { checked: true, ok: false, status: null, error: String(errMsg).slice(0, 150) };
}

// Sjekker et sett med URL-er parallelt og returnerer et oppslag url → resultat.
async function verifyUrls(urls) {
  var unique = Array.from(new Set((urls || []).filter(Boolean)));
  var results = {};
  await Promise.all(unique.map(async function (u) {
    results[u] = await verifyUrl(u);
  }));
  return results;
}

module.exports = { verifyUrl, verifyUrls };
