// "Ny sak → Fra dokument(er)/lenker": redaksjonen laster opp ett eller flere
// dokumenter (PDF, Word, tekst — f.eks. et høringsnotat) og/eller limer inn
// flere lenker, forklarer i fritekst hva materialet inneholder og hva
// sakene skal handle om, og AI skriver ett eller flere førsteutkast.
//
// Flyt (hvert steg logges som fremdrift i sakens historikk):
//  1. Les alt materialet. PDF: tekst trekkes ut lokalt (pdf-parse); skannede
//     PDF-er leses visuelt av modellen. Redaksjonelle BILDER hentes ut av
//     PDF/Word (lib/docImages.js) og fra lenkede artikler (lib/articleImages.js).
//  2. DYP RESEARCH på nettet (lib/materialResearch.js): finner og verifiserer
//     eksterne kilder som gjelder akkurat dette materialet, og henter deres
//     faktiske tekst — kun for nyhetssaker (ikke INFO).
//  3. Ett samlet AI-kall skriver alle sakene (egen vinkel per sak), ser
//     materialet, den eksterne bakgrunnen og bildene, og velger hovedbilde +
//     støttebilder med bildetekst.
//  4. Redaktørrunde (lib/styleGuide.js): språkvask uten å endre fakta.
//  5. Lagring: manus (.docx), kilder (dokument + eksterne kilder faktisk
//     brukt), bilder til lagring, kontrollpunkter.
//
// Ingen oppdiktede fakta: materialet og de hentede kildetekstene er det
// ENESTE faktagrunnlaget. Hull og uklarheter går i kontrollpunkter.

const { Document, Packer } = require("docx");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const { fetchSourceArticle, buildDocxParagraphs, MODEL, restrictLinksToKnown, stripCitationsFromFields, ensureOwnLinks } = require("./manuscript.js");
const { fetchInfoStyleExamples, recordFailureOn, MAX_ANTALL } = require("./contentBatch.js");
const { STYLE_PRINCIPLES, fetchDronemagExamples, styleExamplesBlock, polishManuscript, todayLine, cleanCredit, norwegianCaptions } = require("./styleGuide.js");
const { extractPdfImages, extractDocxImages } = require("./docImages.js");
const { pickArticleImages } = require("./articleImages.js");
const { classifyImage } = require("./imageCheck.js");
const { deepResearch } = require("./materialResearch.js");

const TOTAL_TEXT_BUDGET = 250000; // tegn på tvers av alle dokumenter (~65k tokens)
const MAX_NATIVE_PDF_BYTES = 18 * 1024 * 1024; // skannede PDF-er sendes som fil kun opp til dette
const MIN_CHARS_PER_PAGE = 120; // under dette regnes PDF-en som skannet
const MAX_IMAGE_LIBRARY = 8;

function extOf(path) {
  var m = String(path || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

function displayName(path) {
  var base = String(path || "").split("/").pop() || "";
  return base.replace(/^\d+-\d+-/, "");
}

// Leser ett dokument til { navn, tekst | nativePdf, sider, bilder[] } eller { navn, feil }.
async function readDocument(supabase, path) {
  var navn = displayName(path);
  var dl = await supabase.storage.from("manus").download(path);
  if (dl.error || !dl.data) return { navn: navn, feil: "Kunne ikke laste ned filen fra lagring." };
  var buf = Buffer.from(await dl.data.arrayBuffer());
  var ext = extOf(path);
  try {
    if (ext === "pdf") {
      var sideTekster = [];
      var parsed = await pdfParse(buf, {
        pagerender: function (pageData) {
          return pageData.getTextContent({ normalizeWhitespace: true }).then(function (tc) {
            var t = "", last;
            tc.items.forEach(function (item) { t += (last === undefined || last === item.transform[5] ? "" : "\n") + item.str; last = item.transform[5]; });
            sideTekster.push(t);
            return t;
          });
        }
      });
      var text = (parsed.text || "").replace(/\n{3,}/g, "\n\n").trim();
      var pages = parsed.numpages || 1;
      var bilder = [];
      try { bilder = await extractPdfImages(buf); } catch (e) { bilder = []; }
      if (text.length < Math.max(300, MIN_CHARS_PER_PAGE * pages)) {
        if (buf.length <= MAX_NATIVE_PDF_BYTES) {
          return { navn: navn, nativePdf: buf, sider: pages, bilder: bilder, sideTekster: sideTekster, merknad: "skannet PDF — lest visuelt av AI" };
        }
        return { navn: navn, feil: "PDF-en ser ut til å være skannet (lite tekst), og er for stor til å leses visuelt." };
      }
      return { navn: navn, tekst: text, sider: pages, bilder: bilder, sideTekster: sideTekster };
    }
    if (ext === "docx") {
      var res = await mammoth.extractRawText({ buffer: buf });
      var docxBilder = [];
      try { docxBilder = await extractDocxImages(buf); } catch (e) { docxBilder = []; }
      return { navn: navn, tekst: (res.value || "").trim(), bilder: docxBilder };
    }
    if (ext === "txt" || ext === "md" || ext === "csv") {
      return { navn: navn, tekst: buf.toString("utf8").trim(), bilder: [] };
    }
    return { navn: navn, feil: "Filtypen ." + ext + " støttes ikke (bruk PDF, Word .docx eller tekst)." };
  } catch (err) {
    return { navn: navn, feil: "Kunne ikke lese innholdet: " + err.message };
  }
}

function buildSystemPrompt(sakstype, harEksterneKilder, harBilder) {
  var felles = `

KILDEGRUNNLAG OG ABSOLUTT REGEL — INGEN OPPDIKTEDE FAKTA: basér deg UTELUKKENDE på (a) dokumentene/lenketekstene og redaksjonens forklaring, og (b) utdragene fra EKSTERNE kilder du får oppgitt (nummerert E1, E2 …). Dikt ALDRI opp tall, datoer, frister, navn, sitater, bestemmelser eller konklusjoner som ikke står der. Er noe uklart, mangler eller motsier hverandre, skriv det rett ut i kontrollpunkter (og gjerne som forbehold i teksten) — presenter det aldri som bekreftet.

REDAKSJONENS FORKLARING: brukeren forklarer hva materialet inneholder og hva sakene skal inneholde. Følg denne nøye (antall saker, vinkel, målgruppe, hva som skal vektlegges). Motsier forklaringen materialet, følg materialet og si fra i kontrollpunkter.

FLERE SAKER: lager du flere saker, må hver ha en tydelig FORSKJELLIG vinkel og hoveddel. Ingen to saker skal ha samme tittel, ingress eller åpning. Hver sak må stå på egne bein.

Ingen klikkbare lenker, URL-er eller fotnoter i selve teksten — med ÉN ufravikelig unntak: viser du til en tidligere sak fra Dronemagasinet/UAS Norway (kilder merket EGEN i den eksterne bakgrunnen), skriv en markdown-lenke [lenketekst](URL) med NØYAKTIG den oppgitte URL-en og kildehenvis i prosa («som Dronemagasinet skrev 18. september»). Fet skrift ("**tekst**") kun unntaksvis.` +
  (harBilder ? `

BILDER: du får et nummerert bildebibliotek (Bilde 1, 2 …) hentet fra dokumentene/lenkene, med hvilket dokument/side de kommer fra. For HVER sak: velg hovedbilde (nr) — det bildet som best viser noe konkret om akkurat denne saken (kart, foto, figur, tegning) — eller null hvis ingen passer. Velg 0–2 støttebilder som faktisk tilfører noe, og som ikke er hovedbildet. Et bilde kan brukes i maks ÉN sak. Bruk ALDRI logoer, dekorative bilder, skjermbilder av tabeller du ikke kan lese eller bilder du ikke kan si hva viser. Bildetekst: 1–2 setninger i nyhetsstil. Beskriv hva bildet viser ut fra det du kan SE (lesbare etiketter, former, hva kartet/figuren/fotoet viser) og — for å si HVA figuren er — det som står i figurtekst/overskrift på samme side («Tekst på samme side»), f.eks. «Kart fra høringsnotatet over de omsøkte områdene». Overfør ALDRI detaljer fra brødteksten som ikke er synlige i bildet eller eksplisitt knyttet til akkurat denne figuren (f.eks. ikke nevn et sted eller en sone i bildeteksten med mindre navnet står i bildet). Aldri dikt opp hva noe viser, sted, tidspunkt eller fotograf. Er du usikker, bruk en enklere og mer nøytral beskrivelse. ALLE bildetekster skal være på NORSK (bokmål), også når figuren eller dokumentet er på et annet språk — oversett. kreditering = KUN hvor bildet er hentet fra: avsenderen/nettstedet slik det fremgår (f.eks. «Luftfartstilsynet», «Nordic Unmanned / Luftfartstilsynet», «polisen.se») — aldri ord som «produsentbilde», «illustrasjon» eller «foto:»; fremgår det ikke, skriv dokumentets navn uten filendelse. etter_avsnitt = 0-basert indeks i hovedtekst_avsnitt for avsnittet støttebildet skal stå ETTER (der teksten omtaler det bildet viser; ikke rett etter en mellomtittel).` : "");

  if (sakstype === "content") {
    return `Du er innholdsprodusent for UAS Norway (uasnorway.no) og Dronemagasinet. Du skriver INFO-saker: korte, konkrete informasjons-/handlingsrettede tekster (ingress på 1–2 setninger som gir leseren en grunn til å bry seg, kort brødtekst i 3–6 korte avsnitt, direkte tiltale «du/vi/dere», aktiv form, tydelig handlingsoppfordring til slutt uten selve lenken). Følg de faktiske eksemplene på tidligere INFO-saker du får oppgitt tett i tone, lengde og oppbygging — bruk dem som stilmal, ikke som innhold.` + felles;
  }
  return `Du er journalist i Dronemagasinet (dronemag.no), medlem av Fagpressen og underlagt Redaktørplakaten. Du lager førsteutkast basert på dokumenter/lenker redaksjonen selv har lagt inn — typisk en høring, et regelverksforslag, en søknad, en rapport eller en pressemelding — og bygger dem videre med verifisert ekstern bakgrunn.

- Navngi avsender/dokument i PROSA allerede i første avsnitt (f.eks. «Luftfartstilsynet har sendt på høring …», «ifølge søknaden fra Nordic Unmanned …») og gjenta varierende der det er naturlig. Aldri fremstill innholdet som Dronemagasinets egne funn.
- Forklar hva det betyr i praksis for de som leser Dronemagasinet (droneoperatører, bransjen) KUN ut fra det materialet og kildeutdragene faktisk sier — ikke spekuler.
- Ta med frister, hvem som kan svare, og hvordan, når det står i materialet.
${harEksterneKilder ? `- EKSTERN BAKGRUNN: bruk utdrag fra eksterne kilder (E1, E2 …) til å bygge saken videre: forklar regelverket bak, gi kontekst, ta med relevante reaksjoner eller tidligere vedtak — men KUN det utdraget faktisk sier, og KUN når kilden gjelder samme sak. Navngi kilden i prosa der den brukes («skriver Lovdata», «ifølge forskriften § 20», «sier X til NRK»). Kilder merket EGEN er funnet automatisk i Dronemagasinets/UAS Norways arkiv på nøkkelord og kan være uten relevans: handler en om samme sak/selskap/tema, bruk den som forhistorie og LENK til den (markdown-lenke, se over) — ellers ignorer den. Handler en om NØYAKTIG samme sak eller samme selskap/prosjekt, SKAL saken vise til den med lenke minst én gang. Motsier en ekstern kilde dokumentet, si det åpent. List numrene (brukte_eksterne) til de kildene du faktisk har brukt i teksten — ikke flere.` : "- Ingen eksterne kilder er tilgjengelige denne gangen: hold deg til materialet og sett brukte_eksterne til en tom liste."}
- Struktur: mellomtittel som eget avsnitt med prefiks "## " (2–4 i en middels lang sak, ingen i en veldig kort), direkte sitat som eget avsnitt med prefiks "> " i formatet '> «sitatet» – navn, rolle, kilde' KUN når sitatet ordrett står i materialet eller et kildeutdrag.

` + STYLE_PRINCIPLES + felles;
}

function buildSchema(antall, harBilder) {
  var props = {
    vinkel: { type: "string", description: "Én kort setning: sakens spesifikke vinkel (internt)." },
    emnefelt: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, description: "1–3 korte emneord med store bokstaver." },
    tittel: { type: "string" },
    titler_alternativer: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
    ingress: { type: "string" },
    hovedtekst_avsnitt: { type: "array", items: { type: "string" }, minItems: 2, description: "Mellomtittel: '## Tittel'. Sitat: '> «sitat» – navn, rolle, kilde'. Alt annet: vanlig avsnitt." },
    brukte_eksterne: { type: "array", items: { type: "integer" }, description: "Numrene (E1, E2 …) til eksterne kilder som faktisk er brukt i teksten." },
    kontrollpunkter: { type: "array", items: { type: "string" }, minItems: 1, description: "Konkrete, saksspesifikke ting som må avklares/kontrolleres før publisering." }
  };
  var required = ["vinkel", "emnefelt", "tittel", "titler_alternativer", "ingress", "hovedtekst_avsnitt", "brukte_eksterne", "kontrollpunkter"];
  if (harBilder) {
    props.hovedbilde = {
      type: ["object", "null"], additionalProperties: false,
      properties: { nr: { type: "integer" }, bildetekst: { type: "string" }, kreditering: { type: "string" } },
      required: ["nr", "bildetekst", "kreditering"]
    };
    props.stottebilder = {
      type: "array", maxItems: 2,
      items: {
        type: "object", additionalProperties: false,
        properties: { nr: { type: "integer" }, bildetekst: { type: "string" }, etter_avsnitt: { type: "integer" } },
        required: ["nr", "bildetekst", "etter_avsnitt"]
      }
    };
    required.push("hovedbilde", "stottebilder");
  }
  return {
    name: "dokumentsaker", strict: true,
    schema: {
      type: "object", additionalProperties: false,
      properties: { saker: { type: "array", minItems: antall, maxItems: antall, items: { type: "object", additionalProperties: false, properties: props, required: required } } },
      required: ["saker"]
    }
  };
}

async function callModel(openaiKey, systemPrompt, userContent, schema) {
  var res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + openaiKey },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
      response_format: { type: "json_schema", json_schema: schema }
    })
  });
  if (!res.ok) throw new Error("OpenAI-feil (" + res.status + "): " + (await res.text()).slice(0, 300));
  var data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

function cleanCaption(t) {
  return String(t || "").replace(/[\[\]\n\r]+/g, " ").replace(/\s+/g, " ").trim();
}

// opts: { caseIds, docPaths[], links[], beskrivelse, sakstype ("redaksjonell"|"content"), nettsted }
async function generateCasesFromMaterial(supabase, openaiKey, opts) {
  var caseIds = (opts.caseIds || []).slice(0, MAX_ANTALL);
  var antall = caseIds.length;
  if (!antall) throw new Error("Ingen saker å produsere.");
  var sakstype = opts.sakstype === "content" ? "content" : "redaksjonell";

  // Fremdriftslogg i sakenes historikk (vises live i verktøyet).
  async function progress(text) {
    await Promise.all(caseIds.map(async function (id) {
      try {
        var cur = await supabase.from("cases").select("historikk").eq("id", id).maybeSingle();
        await supabase.from("cases").update({ historikk: [{ ts: new Date().toISOString(), text: text }].concat((cur.data && cur.data.historikk) || []) }).eq("id", id);
      } catch (e) {}
    }));
  }

  // 1. Les alt materialet
  await progress("📄 Leser dokumenter og lenker …");
  var docs = [];
  for (var d = 0; d < (opts.docPaths || []).length; d++) docs.push(await readDocument(supabase, opts.docPaths[d]));
  var lesteDocs = docs.filter(function (x) { return !x.feil; });
  var feilede = docs.filter(function (x) { return x.feil; });

  var linkTekster = [];
  var linkKilder = [];
  var bibliotek = []; // { nr, buffer, type, width, height, kilde, side, url? }
  for (var l = 0; l < (opts.links || []).length; l++) {
    var art = await fetchSourceArticle(opts.links[l]);
    if (art.ok && art.text) {
      linkTekster.push({ url: opts.links[l], navn: art.siteName || opts.links[l], tittel: art.title || "", tekst: art.text });
      linkKilder.push(opts.links[l]);
      try {
        var lb = await pickArticleImages(opts.links[l], art.html, 1, { verify: async function (img) { return (await classifyImage(openaiKey, img, { tittel: String(opts.beskrivelse || "").slice(0, 140) })).ok; } });
        lb.forEach(function (img) { bibliotek.push({ buffer: img.buffer, type: img.type, width: img.width, height: img.height, kilde: art.siteName || opts.links[l], side: null, originalUrl: img.url, bildeAlt: img.caption || img.alt || "" }); });
      } catch (e) {}
    } else {
      feilede.push({ navn: opts.links[l], feil: "Kunne ikke hente lenken (" + (art.reason || "ukjent feil") + ")." });
    }
  }

  if (!lesteDocs.length && !linkTekster.length) {
    throw new Error("Fikk ikke lest noe av materialet: " + feilede.map(function (f) { return f.navn + " — " + f.feil; }).join("; "));
  }

  lesteDocs.forEach(function (dk) {
    (dk.bilder || []).forEach(function (img) {
      var sideTekst = img.page && dk.sideTekster && dk.sideTekster[img.page - 1] ? dk.sideTekster[img.page - 1].replace(/\s+/g, " ").trim().slice(0, 600) : "";
      bibliotek.push({ buffer: img.buffer, type: img.type, width: img.width, height: img.height, kilde: dk.navn, side: img.page, hash: img.hash, sideTekst: sideTekst });
    });
  });
  bibliotek.sort(function (a, b) { return b.width * b.height - a.width * a.height; });
  bibliotek = bibliotek.slice(0, MAX_IMAGE_LIBRARY);

  // 2. Tekstbudsjett
  var tekstDocs = lesteDocs.filter(function (x) { return x.tekst; });
  var totalChars = tekstDocs.reduce(function (n, x) { return n + x.tekst.length; }, 0);
  var kuttet = [];
  if (totalChars > TOTAL_TEXT_BUDGET) {
    var share = Math.floor(TOTAL_TEXT_BUDGET / tekstDocs.length);
    tekstDocs.forEach(function (x) {
      if (x.tekst.length > share) { x.tekst = x.tekst.slice(0, share); kuttet.push(x.navn); }
    });
  }

  // 3. Dyp research (kun nyhetssaker)
  var research = { kilder: [], antallFunnet: 0, antallVerifisert: 0, feil: [] };
  if (sakstype === "redaksjonell") {
    await progress("🔎 Søker dypt på nettet etter eksterne kilder om akkurat dette materialet (tar 2–3 minutter) …");
    var utdrag = tekstDocs.map(function (x) { return "[" + x.navn + "]\n" + x.tekst.slice(0, 5000); })
      .concat(linkTekster.map(function (x) { return "[" + x.navn + " — " + x.tittel + "]\n" + x.tekst.slice(0, 3000); })).join("\n\n").slice(0, 9000);
    try {
      research = await deepResearch(openaiKey, {
        materialUtdrag: utdrag || "(skannet dokument — se navn og forklaring)", beskrivelse: opts.beskrivelse,
        dokumentNavn: lesteDocs.map(function (x) { return x.navn; }), lenker: linkKilder,
        egenSok: opts.beskrivelse + " " + utdrag.slice(0, 500)
      });
    } catch (err) {
      research.feil.push(err.message);
    }
    await progress("🔎 Fant " + research.antallVerifisert + (research.antallVerifisert === 1 ? " verifisert ekstern kilde" : " verifiserte eksterne kilder") + (research.antallFunnet > research.antallVerifisert ? " (" + (research.antallFunnet - research.antallVerifisert) + " forkastet — lenken virket ikke)" : "") + (research.feil.length ? " — ⚠️ " + research.feil.length + " søkerunde(r) feilet: " + research.feil[0].slice(0, 120) : "") + " — skriver sakene …");
  } else {
    await progress("✍️ Skriver sakene …");
  }

  // 4. Bilder til lagring (signerte lenker) — gjør dem tilgjengelige for modellen og for saken
  var bildeBase = caseIds[0] + "/materiale-" + Date.now();
  for (var b = 0; b < bibliotek.length; b++) {
    var img = bibliotek[b];
    img.nr = b + 1;
    var path = bildeBase + "-bilde" + img.nr + "." + (img.type === "png" ? "png" : img.type === "webp" ? "webp" : "jpg");
    var up = await supabase.storage.from("manus").upload(path, img.buffer, { contentType: img.type === "png" ? "image/png" : img.type === "webp" ? "image/webp" : "image/jpeg", upsert: false });
    if (!up.error) {
      var sg = await supabase.storage.from("manus").createSignedUrl(path, 60 * 60 * 24 * 365);
      if (!sg.error && sg.data) img.url = sg.data.signedUrl;
    }
  }
  bibliotek = bibliotek.filter(function (x) { return x.url; });
  var harBilder = bibliotek.length > 0;

  // 5. Skriverunden
  var examples = sakstype === "content" ? await fetchInfoStyleExamples() : await fetchDronemagExamples();
  var tekstBlokk =
    todayLine() + "\n\n" +
    "REDAKSJONENS FORKLARING (hva materialet inneholder og hva sakene skal inneholde):\n" + opts.beskrivelse + "\n\n" +
    "ANTALL SAKER SOM SKAL PRODUSERES: " + antall + "\n\n" +
    "MATERIALE:\n" +
    tekstDocs.map(function (x, i) {
      return "[Dokument " + (i + 1) + ": " + x.navn + (x.sider ? " (" + x.sider + " sider)" : "") + "]\n" + x.tekst;
    }).join("\n\n=====\n\n") +
    (linkTekster.length ? "\n\n" + linkTekster.map(function (x, i) {
      return "[Lenke " + (i + 1) + ": " + x.navn + (x.tittel ? " — " + x.tittel : "") + " (" + x.url + ")]\n" + x.tekst;
    }).join("\n\n=====\n\n") : "") +
    (lesteDocs.some(function (x) { return x.nativePdf; })
      ? "\n\n(Skannede PDF-er er vedlagt som filer under: " + lesteDocs.filter(function (x) { return x.nativePdf; }).map(function (x) { return x.navn; }).join(", ") + ")" : "") +
    (research.kilder.length
      ? "\n\nEKSTERN BAKGRUNN (verifiserte kilder funnet ved websøk; utdragene er kildenes egen tekst — bruk KUN det utdragene sier, og kun der kilden gjelder samme sak):\n\n" +
        research.kilder.map(function (k) {
          return "[E" + k.nr + (k.egen ? " — EGEN (Dronemagasinet/UAS Norway)" : "") + ": " + k.kilde_navn + " — " + k.tittel + " (" + k.type + ")" + (k.egen ? " URL: " + k.url : "") + "]\n" + (k.tekst ? "UTDRAG: " + k.tekst : "(kunne ikke lese fulltekst — ikke bruk denne til fakta)");
        }).join("\n\n")
      : "") +
    "\n\n" + (examples.length
      ? (sakstype === "content"
          ? "EKSEMPLER PÅ TIDLIGERE INFO-SAKER FRA uasnorway.no (stilmal for tone, lengde og oppbygging):\n\n" +
            examples.map(function (e, i) { return "[Eksempel " + (i + 1) + "]\nTittel: " + e.tittel + "\nIngress: " + e.ingress + "\nTekst: " + e.tekst; }).join("\n\n")
          : styleExamplesBlock(examples))
      : "");

  var userContent = [{ type: "text", text: tekstBlokk }];
  lesteDocs.filter(function (x) { return x.nativePdf; }).forEach(function (x) {
    userContent.push({ type: "file", file: { filename: x.navn, file_data: "data:application/pdf;base64," + x.nativePdf.toString("base64") } });
  });
  if (harBilder) {
    userContent.push({ type: "text", text: "\nBILDEBIBLIOTEK (velg hovedbilde/støttebilder fra disse, bruk nr):" });
    bibliotek.forEach(function (im) {
      userContent.push({ type: "text", text: "Bilde " + im.nr + " — fra «" + im.kilde + "»" + (im.side ? ", side " + im.side : "") + (im.bildeAlt ? " (alt/bildetekst i kilden: " + im.bildeAlt.slice(0, 160) + ")" : "") + ", " + im.width + "×" + im.height + " px." + (im.sideTekst ? " Tekst på samme side i dokumentet (kontekst — kan brukes til å forstå hva figuren er, f.eks. figurtekst/overskrift): «" + im.sideTekst + "»" : "") });
      userContent.push({ type: "image_url", image_url: { url: im.url, detail: "high" } });
    });
  }

  var result = await callModel(openaiKey, buildSystemPrompt(sakstype, research.kilder.length > 0, harBilder), userContent, buildSchema(antall, harBilder));
  var saker = result.saker || [];

  // 6. Dokumentene som kilder (signerte lenker; etter eventuelle lenker — resten av
  // appen leser kilder[0] som en nettside-URL)
  var docKilder = [];
  for (var k = 0; k < (opts.docPaths || []).length; k++) {
    var signed = await supabase.storage.from("manus").createSignedUrl(opts.docPaths[k], 60 * 60 * 24 * 365);
    if (!signed.error && signed.data) docKilder.push({ navn: displayName(opts.docPaths[k]), url: signed.data.signedUrl });
  }
  var kilderUrls = linkKilder.concat(docKilder.map(function (x) { return x.url; }));

  var materialNotat = "Basert på " + lesteDocs.length + " dokument(er)" + (linkTekster.length ? " og " + linkTekster.length + " lenke(r)" : "") +
    (kuttet.length ? " — OBS: lange dokumenter ble kortet ned (" + kuttet.join(", ") + ")" : "") +
    (feilede.length ? " — kunne IKKE lese: " + feilede.map(function (f) { return f.navn; }).join(", ") : "");

  await progress("✍️ Redigerer språk og lagrer …");

  var brukteBilder = {}; // nr -> true (hvert bilde maks i én sak)
  var lagret = 0, feilet = 0;
  for (var i = 0; i < caseIds.length; i++) {
    var s = saker[i];
    var caseId = caseIds[i];
    if (!s) { feilet++; await recordFailureOn(supabase, caseId, "AI leverte ikke alle de bestilte sakene."); continue; }
    try {
      var kontrollpunkter = (s.kontrollpunkter || []).slice();
      var avsnitt = (s.hovedtekst_avsnitt || []).slice();

      // Bilder: hero + støttebilder (validert mot biblioteket, maks én sak per bilde)
      var byNr = {};
      bibliotek.forEach(function (im) { byNr[im.nr] = im; });
      var hero = null, heroInfo = null;
      if (s.hovedbilde && byNr[s.hovedbilde.nr] && !brukteBilder[s.hovedbilde.nr]) {
        hero = byNr[s.hovedbilde.nr]; heroInfo = s.hovedbilde; brukteBilder[hero.nr] = true;
      }
      var stotte = (s.stottebilder || []).filter(function (sb) {
        if (!byNr[sb.nr] || brukteBilder[sb.nr]) return false;
        brukteBilder[sb.nr] = true; return true;
      });
      // Sett inn bakfra, så tidligere indekser ikke forskyves
      stotte.slice().sort(function (a, b) { return b.etter_avsnitt - a.etter_avsnitt; }).forEach(function (sb) {
        var pos = Math.max(0, Math.min(avsnitt.length - 1, sb.etter_avsnitt));
        while (pos < avsnitt.length - 1 && /^## /.test(avsnitt[pos])) pos++; // ikke rett etter en mellomtittel
        avsnitt.splice(pos + 1, 0, "![" + cleanCaption(sb.bildetekst) + "](" + byNr[sb.nr].url + ")");
      });
      if (hero || stotte.length) {
        var bildeKilder = {};
        [hero].concat(stotte.map(function (sb) { return byNr[sb.nr]; })).filter(Boolean).forEach(function (im) { bildeKilder[im.kilde] = true; });
        kontrollpunkter.push("Bildene er hentet fra materialet (" + Object.keys(bildeKilder).join(", ") + ") — avklar bruksrett og kreditering med avsender før publisering, og kontroller at bildetekstene stemmer med det bildene faktisk viser.");
      }

      // Redaktørrunde (språkvask) — bevarer tall, sitater, kildehenvisninger og bildemarkører
      var fields = {
        emnefelt: s.emnefelt || [], tittel: s.tittel, alt_tekst_bilde: heroInfo ? cleanCaption(heroInfo.bildetekst) : "", bilde_er_illustrasjon: false,
        fotoKreditering: heroInfo ? cleanCaption(heroInfo.kreditering) : "", ingress: s.ingress, hovedtekst_avsnitt: avsnitt,
        titler_alternativer: s.titler_alternativer, kilder_brukt: [], kontrollpunkter: kontrollpunkter, tidligere_dekning: null
      };
      var polished = await polishManuscript(openaiKey, MODEL, fields, sakstype === "content" ? [] : examples,
        sakstype === "content" ? "- Behold INFO-tonen: kort, direkte, med handlingsoppfordring til slutt." :
        "- Avsender/dokument skal fortsatt navngis i prosa i første avsnitt, og eksterne kilder navngis der de brukes.");
      Object.assign(fields, polished.fields);
      stripCitationsFromFields(fields);
      restrictLinksToKnown(fields, research);
      await ensureOwnLinks(openaiKey, fields, research);
      fields.fotoKreditering = cleanCredit(fields.fotoKreditering) || (hero ? cleanCredit(String(hero.kilde || "").replace(/\.[a-z0-9]{2,4}$/i, "")) : "");
      Object.assign(fields, await norwegianCaptions(openaiKey, fields));

      // Kilder brukt: dokument(er) + eksterne kilder som faktisk ble brukt
      var linkSet = {}; linkKilder.forEach(function (u) { linkSet[u.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase()] = true; });
      var brukte = (s.brukte_eksterne || []).map(function (nr) { return research.kilder.filter(function (x) { return x.nr === nr; })[0]; }).filter(Boolean)
        .filter(function (x) { return !linkSet[x.url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase()]; });
      var typeNavn = { primaerkilde: "Primærkilde", nyhetsomtale: "Omtale", bakgrunn: "Bakgrunn", tidligere_dekning: "Tidligere dekning" };
      var egenBrukt = brukte.filter(function (bk) { return bk.egen; })[0];
      fields.tidligere_dekning = egenBrukt ? { tittel: egenBrukt.tittel, url: egenBrukt.url } : null;
      fields.kilder_brukt = docKilder.map(function (dk) { return { navn: "Opplastet dokument", tittel: dk.navn, url: dk.url, url_virker: true }; })
        .concat(linkTekster.map(function (lt) { return { navn: lt.navn, tittel: lt.tittel || lt.url, url: lt.url, url_virker: true }; }))
        .concat(brukte.map(function (bk) { return { navn: (typeNavn[bk.type] || "Ekstern") + " — " + bk.kilde_navn, tittel: bk.tittel, url: bk.url, url_virker: true }; }));
      if (brukte.length) fields.kontrollpunkter.push("Saken bygger på " + brukte.length + (brukte.length === 1 ? " ekstern kilde" : " eksterne kilder") + " funnet ved websøk (se kildelisten) — kontroller viktige påstander mot originalene før publisering.");
      else if (sakstype === "redaksjonell") fields.kontrollpunkter.push(research.antallVerifisert ? "Ingen av de eksterne kildene ble ansett relevante nok til å brukes — saken bygger kun på materialet." : "Søket fant ingen verifiserte eksterne kilder — saken bygger kun på materialet.");
      if (kuttet.length) fields.kontrollpunkter.push("Lange dokumenter ble kortet ned før AI leste dem (" + kuttet.join(", ") + ") — kontroller mot originalen.");
      feilede.forEach(function (f) { fields.kontrollpunkter.push("Kunne ikke lese «" + f.navn + "»: " + f.feil); });

      var doc = new Document({ sections: [{ children: await buildDocxParagraphs(fields, hero && (hero.type === "jpg" || hero.type === "png") ? { buffer: hero.buffer, type: hero.type, width: hero.width, height: hero.height } : null) }] });
      var buffer = await Packer.toBuffer(doc);
      var manusPath = caseId + "/" + Date.now() + ".docx";
      var upDoc = await supabase.storage.from("manus").upload(manusPath, buffer, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", upsert: false
      });
      if (upDoc.error) throw new Error("Kunne ikke laste opp manus: " + upDoc.error.message);

      var cur = await supabase.from("cases").select("historikk").eq("id", caseId).maybeSingle();
      var historikk = [{
        ts: new Date().toISOString(),
        text: "Sak produsert av AI fra opplastet materiale (" + (i + 1) + " av " + antall + ") — vinkel: " + s.vinkel + " — " + materialNotat +
          (sakstype === "redaksjonell" ? " — " + brukte.length + " av " + research.antallVerifisert + " verifiserte eksterne kilder brukt" : "") +
          (hero ? " — hovedbilde og " + stotte.length + " støttebilde(r) hentet fra materialet" : (harBilder ? " — ingen av bildene i materialet passet som hovedbilde" : " — ingen redaksjonelle bilder funnet i materialet, bruk «Finn bilder»")) +
          (polished.polished ? " — språkvasket av redaktørrunden" : (polished.forkastet ? " — redaktørrunden ble forkastet (" + polished.forkastet + ")" : "")) +
          " — " + fields.kontrollpunkter.length + " kontrollpunkt(er) å avklare før publisering"
      }].concat((cur.data && cur.data.historikk) || []);

      var upd = await supabase.from("cases").update({
        title: fields.tittel, oppsummering: s.vinkel, kilder: kilderUrls,
        manus_url: manusPath, manus_generert_ts: new Date().toISOString(),
        manus_tittel: fields.tittel, manus_ingress: fields.ingress, manus_hovedtekst: fields.hovedtekst_avsnitt,
        manus_alt_tekst: fields.alt_tekst_bilde || "", manus_bilde_url: hero ? hero.url : "", manus_foto: fields.fotoKreditering || "",
        manus_emnefelt: fields.emnefelt || [], manus_titler_alternativer: fields.titler_alternativer,
        manus_tidligere_dekning: fields.tidligere_dekning || null, manus_kilder_brukt: fields.kilder_brukt, manus_kontrollpunkter: fields.kontrollpunkter,
        manus_bilde_er_illustrasjon: false, historikk: historikk
      }).eq("id", caseId);
      if (upd.error) throw new Error(upd.error.message);
      lagret++;
    } catch (err) {
      feilet++;
      await recordFailureOn(supabase, caseId, err.message);
    }
  }
  return {
    lagret: lagret, feilet: feilet, dokumenterLest: lesteDocs.length, lenkerLest: linkTekster.length, uleste: feilede.length,
    kuttet: kuttet.length, bilderIBibliotek: bibliotek.length, eksterneKilder: research.antallVerifisert
  };
}

module.exports = { generateCasesFromMaterial, readDocument };
