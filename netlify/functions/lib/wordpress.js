// Klient mot WordPress REST API (uasnorway.no) — Basic Auth via et WordPress
// Application Password (ikke hovedpassordet). Portert fra det allerede testede
// "WordPress Infosak Batch Administrator"-verktøyet (github.com/UASnorge/wordpress,
// netlify/functions/lib/wp.js + create-post.js) — samme ACF-feltnøkler, samme
// "kun utkast, aldri automatisk publisert"-prinsipp. Hold denne i sync med den
// kilden om ACF-feltene på uasnorway.no noensinne endres der.
//
// Miljøvariabler: WP_URL, WP_USERNAME, WP_APP_PASSWORD.

// ACF-feltnøkler for "Innlegg"-feltgruppen på uasnorway.no (bekreftet 18.08.2026
// i wordpress-infosak-verktøyet). Disse styrer den faktiske visningen på
// nettsiden — IKKE WordPress sine native content/excerpt/featured_media, som
// settes i tillegg for Yoast SEO-fallback og andre systemer som leser dem.
const ACF_FIELD_KEYS = {
  image: "field_58ac635e3fd79", // Bilde
  imageTxt: "field_58ad5800ad8f8", // Bildetekst
  photoCredits: "field_58ad5816549da", // Foto
  byline: "field_58ad63e185d2a", // Byline
  excerpt: "field_58aca286266be", // Ingress
  content: "field_58aca298266bf", // Innhold
};

function wpBaseUrl() {
  const raw = process.env.WP_URL || "";
  return raw.replace(/\/+$/, "");
}

function assertConfigured() {
  if (!process.env.WP_URL || !process.env.WP_USERNAME || !process.env.WP_APP_PASSWORD) {
    throw new Error("WP_URL / WP_USERNAME / WP_APP_PASSWORD er ikke satt som miljøvariabler i Netlify.");
  }
}

function authHeader() {
  const user = process.env.WP_USERNAME;
  const pass = process.env.WP_APP_PASSWORD;
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return `Basic ${token}`;
}

async function wpFetch(path, options = {}) {
  assertConfigured();
  const url = `${wpBaseUrl()}/wp-json${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: authHeader(), ...(options.headers || {}) },
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

async function getTags(search) {
  const q = search ? `&search=${encodeURIComponent(search)}` : "";
  return wpFetch(`/wp/v2/tags?per_page=100${q}&_fields=id,name,slug`);
}

async function findOrCreateTag(name) {
  const clean = (name || "").trim();
  if (!clean) return null;
  const found = await getTags(clean);
  const exact = found.find((t) => t.name.toLowerCase() === clean.toLowerCase());
  if (exact) return exact.id;
  const created = await wpFetch("/wp/v2/tags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: clean }),
  });
  return created.id;
}

async function resolveTagIds(names) {
  const ids = [];
  for (const name of names || []) {
    const id = await findOrCreateTag(name);
    if (id) ids.push(id);
  }
  return ids;
}

async function uploadMedia({ buffer, filename, mimeType, altText, caption }) {
  const media = await wpFetch("/wp/v2/media", {
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
    await wpFetch(`/wp/v2/media/${media.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }
  return { id: media.id, url: media.source_url };
}

function paragraphsToHtml(paragraphs) {
  return (paragraphs || [])
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .map((p) => "<p>" + p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>")
    .join("\n");
}

// Oppretter et WordPress-innlegg. status er ALLTID "draft" med mindre noe
// eksplisitt (og bevisst) sender inn noe annet — ingen kallere i denne appen
// gjør det. Publisering skjer kun manuelt, i WordPress selv eller i
// wordpress-infosak sin Oversikt-fane, aldri herfra.
async function createDraftPost({ title, ingress, hovedtekstAvsnitt, byline, photoCredit, caption, featuredMediaId, tagNames }) {
  const contentHtml = paragraphsToHtml(hovedtekstAvsnitt);
  const tagIds = await resolveTagIds(tagNames);

  const meta = {
    "_yoast_wpseo_title": title,
    "_yoast_wpseo_metadesc": ingress || "",
    content: contentHtml,
    _content: ACF_FIELD_KEYS.content,
    excerpt: ingress || "",
    _excerpt: ACF_FIELD_KEYS.excerpt,
  };
  if (byline) { meta.byline = byline; meta._byline = ACF_FIELD_KEYS.byline; }
  if (caption) { meta.imageTxt = caption; meta._imageTxt = ACF_FIELD_KEYS.imageTxt; }
  if (photoCredit) { meta.photoCredits = photoCredit; meta._photoCredits = ACF_FIELD_KEYS.photoCredits; }
  if (featuredMediaId) { meta.image = String(featuredMediaId); meta._image = ACF_FIELD_KEYS.image; }

  const post = await wpFetch("/wp/v2/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      content: contentHtml,
      excerpt: ingress || "",
      status: "draft",
      tags: tagIds,
      featured_media: featuredMediaId || undefined,
      meta,
    }),
  });

  return {
    id: post.id,
    editLink: `${wpBaseUrl()}/wp-admin/post.php?post=${post.id}&action=edit`,
  };
}

module.exports = { wpFetch, uploadMedia, resolveTagIds, createDraftPost, ACF_FIELD_KEYS };
