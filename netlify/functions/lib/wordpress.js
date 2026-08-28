// Klient mot WordPress REST API — Basic Auth via et WordPress Application
// Password (ikke hovedpassordet). Portert fra det allerede testede
// "WordPress Infosak Batch Administrator"-verktøyet (github.com/UASnorge/wordpress,
// netlify/functions/lib/wp.js + create-post.js) — samme ACF-feltnøkler for
// uasnorway.no, samme "kun utkast, aldri automatisk publisert"-prinsipp.
//
// Støtter TO nettsteder (uasnorway.no og dronemag.no), hvert med egne
// WordPress-innlogging og egen (valgfri) ACF-feltoppsett — se SITES under.

// ACF-feltnøkler for "Innlegg"-feltgruppen på uasnorway.no (bekreftet
// 18.08.2026 i wordpress-infosak-verktøyet). Disse styrer den faktiske
// visningen på nettsiden — IKKE WordPress sine native content/excerpt/
// featured_media, som settes i tillegg for Yoast SEO-fallback og andre
// systemer som leser dem. Hold i sync med kilden om feltene endres der.
const UASNORWAY_ACF_FIELD_KEYS = {
  image: "field_58ac635e3fd79", // Bilde
  imageTxt: "field_58ad5800ad8f8", // Bildetekst
  photoCredits: "field_58ad5816549da", // Foto
  byline: "field_58ad63e185d2a", // Byline
  excerpt: "field_58aca286266be", // Ingress
  content: "field_58aca298266bf", // Innhold
};

// dronemag.no ble 28.08.2026 bekreftet av brukeren å ha et WordPress-oppsett
// som er "helt likt" uasnorway.no sitt — bruker derfor de samme, allerede
// bekreftede ACF-feltnøklene som standard. VIKTIG NYANSE: ACF-feltNØKLER
// (field_xxxxx-hashene) genereres normalt unikt per WordPress-installasjon
// selv når feltGRUPPEN er strukturelt identisk (samme feltnavn/-typer) —
// med mindre feltgruppen faktisk ble eksportert/importert mellom sidene.
// Default her er derfor en velbegrunnet, brukerbekreftet ANTAKELSE, ikke en
// uavhengig verifisert nøkkel-for-nøkkel-bekreftelse. Sjekk gjerne én gang
// ved å se om felter faktisk fylles ut riktig i dronemag.no sin wp-admin
// etter første utkast (eller høyreklikk → Inspiser, som i README). Stemmer
// ikke nøklene: sett de seks WP_DRONEMAG_ACF_*-miljøvariablene i Netlify for
// å overstyre — er ÉN av dem satt, brukes det overstyrte settet i sin helhet
// i stedet for uasnorway.no sine nøkler.
function dronemagAcfFieldKeys() {
  var override = {
    image: process.env.WP_DRONEMAG_ACF_IMAGE,
    imageTxt: process.env.WP_DRONEMAG_ACF_IMAGE_TXT,
    photoCredits: process.env.WP_DRONEMAG_ACF_PHOTO_CREDITS,
    byline: process.env.WP_DRONEMAG_ACF_BYLINE,
    excerpt: process.env.WP_DRONEMAG_ACF_EXCERPT,
    content: process.env.WP_DRONEMAG_ACF_CONTENT,
  };
  var anyOverrideSet = Object.keys(override).some(function (k) { return !!override[k]; });
  return anyOverrideSet ? override : UASNORWAY_ACF_FIELD_KEYS;
}

// nettsted (saksbankens felt, "dronemag.no" | "uasnorway.no") → hvilke
// miljøvariabler som skal brukes for URL/innlogging, og ACF-feltnøklene.
const SITES = {
  "uasnorway.no": {
    urlEnv: "WP_UASNORWAY_URL", userEnv: "WP_UASNORWAY_USERNAME", passEnv: "WP_UASNORWAY_APP_PASSWORD",
    acfFieldKeys: UASNORWAY_ACF_FIELD_KEYS,
  },
  "dronemag.no": {
    urlEnv: "WP_DRONEMAG_URL", userEnv: "WP_DRONEMAG_USERNAME", passEnv: "WP_DRONEMAG_APP_PASSWORD",
    get acfFieldKeys() { return dronemagAcfFieldKeys(); },
  },
};

function getSiteConfig(nettsted) {
  const site = SITES[nettsted];
  if (!site) throw new Error("Ukjent nettsted: " + nettsted + ". Støttet: " + Object.keys(SITES).join(", "));
  const url = process.env[site.urlEnv];
  const user = process.env[site.userEnv];
  const pass = process.env[site.passEnv];
  if (!url || !user || !pass) {
    throw new Error(site.urlEnv + " / " + site.userEnv + " / " + site.passEnv + " er ikke satt som miljøvariabler i Netlify (kreves for å publisere til " + nettsted + ").");
  }
  return {
    baseUrl: url.replace(/\/+$/, ""),
    authHeader: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"),
    acfFieldKeys: site.acfFieldKeys, // kan være null (dronemag.no uten kjente ACF-felt) — håndteres i createDraftPost
  };
}

async function wpFetch(site, path, options = {}) {
  const url = `${site.baseUrl}/wp-json${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: site.authHeader, ...(options.headers || {}) },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const msg = (data && data.message) || `WP-feil ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function getTags(site, search) {
  const q = search ? `&search=${encodeURIComponent(search)}` : "";
  return wpFetch(site, `/wp/v2/tags?per_page=100${q}&_fields=id,name,slug`);
}

async function findOrCreateTag(site, name) {
  const clean = (name || "").trim();
  if (!clean) return null;
  const found = await getTags(site, clean);
  const exact = found.find((t) => t.name.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.id;
  const created = await wpFetch(site, "/wp/v2/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: clean }),
  });
  return created.id;
}

async function resolveTagIds(site, names) {
  const ids = [];
  for (const name of names || []) {
    const id = await findOrCreateTag(site, name);
    if (id) ids.push(id);
  }
  return ids;
}

// Kategorier (WordPress sin egen, innebygde "categories"-taksonomi) — samme
// mønster som stikkord/tags over, men en egen endepunkt/taksonomi i WP.
// Redaksjonen velger denne selv per sak, aldri utledet stille fra noe annet.
async function getCategories(site, search) {
  const q = search ? `&search=${encodeURIComponent(search)}` : "";
  return wpFetch(site, `/wp/v2/categories?per_page=100${q}&_fields=id,name,slug`);
}

async function findOrCreateCategory(site, name) {
  const clean = (name || "").trim();
  if (!clean) return null;
  const found = await getCategories(site, clean);
  const exact = found.find((c) => c.name.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.id;
  const created = await wpFetch(site, "/wp/v2/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: clean }),
  });
  return created.id;
}

async function resolveCategoryIds(site, names) {
  const ids = [];
  for (const name of names || []) {
    const id = await findOrCreateCategory(site, name);
    if (id) ids.push(id);
  }
  return ids;
}

async function uploadMedia(site, { buffer, filename, mimeType, altText, caption }) {
  const media = await wpFetch(site, "/wp/v2/media", {
    method: "POST",
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    },
    body: buffer,
  });
  if (altText || caption) {
    const patch = {};
    if (altText) patch.alt_text = altText;
    if (caption) patch.caption = caption;
    await wpFetch(site, `/wp/v2/media/${media.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }
  return { id: media.id, url: media.source_url };
}

function escapeHtmlText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Samme bildemarkør-konvensjon som lib/manuscript.js (duplisert her bevisst,
// ikke krysset inn fra manuscript.js — de to lib-modulene er ellers
// uavhengige av hverandre): "![alt-tekst](url)" for et ekstra bilde midt i
// saken, utover selve hovedbildet.
const WP_IMAGE_MARKER_RE = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/;

// Laster ALLE bildemarkører i avsnittslisten opp til WordPress sitt eget
// mediebibliotek FØR innlegget opprettes — publiserte artikler skal aldri
// hot-linke til en ekstern/midlertidig URL (f.eks. en Supabase-signert lenke
// som en gang utløper), samme prinsipp som hovedbildet allerede laster opp
// via uploadMediaForSite i stedet for å lenke direkte til kildesiden.
// Returnerer et oppslag original-URL → ekte, varig WordPress-bilde-URL.
async function uploadInlineImages(site, paragraphs) {
  const map = {};
  for (const p of paragraphs || []) {
    const m = String(p || "").trim().match(WP_IMAGE_MARKER_RE);
    if (!m || map[m[2]]) continue;
    const url = m[2];
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const contentType = res.headers.get("content-type") || "image/jpeg";
      const buffer = Buffer.from(await res.arrayBuffer());
      const ext = contentType.indexOf("png") !== -1 ? "png" : "jpg";
      const media = await uploadMedia(site, { buffer, filename: "bilde." + ext, mimeType: contentType, altText: m[1] || "" });
      map[url] = media.url;
    } catch (err) {
      // Lenken kunne ikke hentes/lastes opp — beholder original-URL-en i
      // HTML-en under (bedre enn å miste bildet helt), men den kan i
      // verste fall utløpe senere. Feiler aldri hele publiseringen for dette.
    }
  }
  return map;
}

// Manus-avsnitt kan inneholde tre markører: "## " for en mellomtittel, "> "
// for et fremhevet sitat (begge satt av lib/manuscript.js sin research-
// drevne generering), og "![alt](url)" for et ekstra bilde midt i saken
// (f.eks. hentet fra et opplastet manus, se lib/importManuscript.js) —
// tolkes her til <h3>/<blockquote>/<img>, med imageUrlMap brukt til å bytte
// ut URL-en med den ekte, opplastede WordPress-bilde-URL-en.
function paragraphsToHtml(paragraphs, imageUrlMap) {
  imageUrlMap = imageUrlMap || {};
  return (paragraphs || [])
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .map((p) => {
      if (p.indexOf("## ") === 0) return "<h3>" + escapeHtmlText(p.slice(3)) + "</h3>";
      if (p.indexOf("> ") === 0) return "<blockquote>" + escapeHtmlText(p.slice(2)) + "</blockquote>";
      const imgMatch = p.match(WP_IMAGE_MARKER_RE);
      if (imgMatch) {
        const resolvedUrl = imageUrlMap[imgMatch[2]] || imgMatch[2];
        return '<img src="' + escapeHtmlText(resolvedUrl) + '" alt="' + escapeHtmlText(imgMatch[1] || "") + '" />' +
          (imgMatch[1] ? '<em>' + escapeHtmlText(imgMatch[1]) + '</em>' : "");
      }
      return "<p>" + escapeHtmlText(p) + "</p>";
    })
    .join("\n");
}

// Oppretter et WordPress-innlegg på det gitte nettstedet. status er ALLTID
// "draft" — ingen kallere i denne appen sender noe annet. Publisering skjer
// kun manuelt, i WordPress selv eller i wordpress-infosak sin Oversikt-fane.
async function createDraftPost(nettsted, { title, ingress, hovedtekstAvsnitt, byline, photoCredit, caption, featuredMediaId, tagNames, categoryNames }) {
  const site = getSiteConfig(nettsted);
  // Ekstra bilder midt i saken (utover selve hovedbildet) lastes opp til
  // WordPress sitt eget mediebibliotek FØR innholdet bygges, slik at de
  // aldri hot-lenker til en midlertidig/ekstern URL i det publiserte innlegget.
  const imageUrlMap = await uploadInlineImages(site, hovedtekstAvsnitt);
  const contentHtml = paragraphsToHtml(hovedtekstAvsnitt, imageUrlMap);
  const tagIds = await resolveTagIds(site, tagNames);
  const categoryIds = await resolveCategoryIds(site, categoryNames);

  const meta = {
    "_yoast_wpseo_title": title,
    "_yoast_wpseo_metadesc": ingress || "",
  };
  // Bruk hovedbildet som "Sosialt bilde" (Yoast SEO sin Opptreden i sosiale
  // medier-fane) også, ikke bare som WordPress sitt vanlige hovedbilde —
  // samme mekanisme (meta-felt) som _yoast_wpseo_title/_metadesc over, som
  // allerede er bekreftet virkende i denne appen.
  if (featuredMediaId) meta["_yoast_wpseo_opengraph-image-id"] = String(featuredMediaId);
  const acf = site.acfFieldKeys;
  if (acf) {
    // Egendefinerte felt styrer selve visningen på siden (bekreftet for
    // uasnorway.no) — sett disse i tillegg til WordPress sine standardfelt.
    meta.content = contentHtml; meta._content = acf.content;
    meta.excerpt = ingress || ""; meta._excerpt = acf.excerpt;
    if (byline) { meta.byline = byline; meta._byline = acf.byline; }
    if (caption) { meta.imageTxt = caption; meta._imageTxt = acf.imageTxt; }
    if (photoCredit) { meta.photoCredits = photoCredit; meta._photoCredits = acf.photoCredits; }
    if (featuredMediaId) { meta.image = String(featuredMediaId); meta._image = acf.image; }
  }

  const post = await wpFetch(site, "/wp/v2/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      content: contentHtml,
      excerpt: ingress || "",
      status: "draft",
      tags: tagIds,
      categories: categoryIds.length ? categoryIds : undefined,
      featured_media: featuredMediaId || undefined,
      meta,
    }),
  });

  return {
    id: post.id,
    editLink: `${site.baseUrl}/wp-admin/post.php?post=${post.id}&action=edit`,
    usedAcfFields: !!acf,
  };
}

async function uploadMediaForSite(nettsted, args) {
  const site = getSiteConfig(nettsted);
  return uploadMedia(site, args);
}

module.exports = { getSiteConfig, uploadMediaForSite, createDraftPost, UASNORWAY_ACF_FIELD_KEYS };
