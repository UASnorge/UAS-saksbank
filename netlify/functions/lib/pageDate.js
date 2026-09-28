// Finner når en nettartikkel faktisk ble publisert, direkte fra siden —
// vesentlig mer pålitelig enn datoen søkemodellen oppgir (som ofte mangler,
// eller kommer i norsk format som «20.09.2026» som Date() ikke tolker, og
// dermed ga saker med «ukjent dato» og en uverdig aldersgrense).
//
// Prøver, i rekkefølge: meta-tagger (article:published_time o.l.), JSON-LD
// (datePublished), itemprop/time-elementer. Returnerer en Date eller null.

var MONTHS = { januar: 1, februar: 2, mars: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, desember: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, okt: 10, nov: 11, des: 12 };

// Tolker ISO-strenger og vanlige norske formater: «2026-09-20», «20.09.2026»,
// «20. september 2026», «20 sep 2026».
function parseFlexibleDate(raw) {
  if (!raw) return null;
  var s = String(raw).trim();
  var iso = new Date(s);
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(iso.getTime())) return iso;
  var m = s.match(/(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/);
  if (m) {
    var d1 = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 12));
    if (!isNaN(d1.getTime()) && +m[2] >= 1 && +m[2] <= 12) return d1;
  }
  m = s.match(/(\d{1,2})\.?\s+([a-zæøå]+)\.?\s+(\d{4})/i);
  if (m && MONTHS[m[2].toLowerCase()]) {
    var d2 = new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()] - 1, +m[1], 12));
    if (!isNaN(d2.getTime())) return d2;
  }
  return !isNaN(iso.getTime()) ? iso : null;
}

function attr(tag, name) {
  var m = tag.match(new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i"));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

var META_KEYS = ["article:published_time", "og:published_time", "datepublished", "date", "pubdate", "publishdate", "publish-date", "dc.date.issued", "dc.date", "sailthru.date", "article.published", "parsely-pub-date"];

function extractPublishedDate(html) {
  if (!html) return null;
  var head = html.slice(0, 250000);
  var candidates = [];

  // <meta ...>
  (head.match(/<meta[^>]*>/gi) || []).forEach(function (tag) {
    var key = (attr(tag, "property") || attr(tag, "name") || attr(tag, "itemprop") || "").toLowerCase();
    if (META_KEYS.indexOf(key) !== -1) candidates.push(attr(tag, "content"));
  });

  // JSON-LD
  (head.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []).forEach(function (blk) {
    var m = blk.match(/"datePublished"\s*:\s*"([^"]+)"/);
    if (m) candidates.push(m[1]);
  });

  // <time datetime="..."> (med itemprop=datePublished først)
  (head.match(/<time[^>]*>/gi) || []).forEach(function (tag) {
    var dt = attr(tag, "datetime");
    if (!dt) return;
    if (/datePublished/i.test(tag)) candidates.unshift(dt); else candidates.push(dt);
  });

  for (var i = 0; i < candidates.length; i++) {
    var d = parseFlexibleDate(candidates[i]);
    // Ignorer åpenbart urimelige datoer (fremtid > 2 dager, eller før 2000).
    if (d && d.getFullYear() >= 2000 && d.getTime() < Date.now() + 2 * 86400000) return d;
  }
  return null;
}

module.exports = { extractPublishedDate, parseFlexibleDate };
