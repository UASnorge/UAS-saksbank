// "Ny sak → Fra dokument(er)/lenker": redaksjonen laster opp ett eller flere
// dokumenter (PDF, Word, tekst — f.eks. et høringsnotat) og/eller limer inn
// flere lenker, forklarer i fritekst hva materialet inneholder og hva
// sakene skal handle om, og AI skriver ett eller flere førsteutkast.
//
// Ett samlet AI-kall for hele bestillingen (samme prinsipp som
// lib/contentBatch.js): modellen ser alt materialet samtidig og kan gi hver
// sak sin egen vinkel i stedet for flere nesten like varianter.
//
// PDF: tekst trekkes ut lokalt (pdf-parse) — billig og rask, også for lange
// dokumenter. Er PDF-en skannet (nesten ingen tekst å hente ut), sendes selve
// filen til modellen i stedet, som leser sidene visuelt.
//
// Ingen websøk: faktagrunnlaget er KUN det redaksjonen selv har lastet opp/
// limt inn. Modellen får forbud mot å finne på fakta utover dette —
// usikkerhet og hull går i kontrollpunkter, aldri som bekreftet tekst.

const { Document, Packer } = require("docx");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse/lib/pdf-parse.js");
const { fetchSourceArticle, buildDocxParagraphs, MODEL } = require("./manuscript.js");
const { fetchInfoStyleExamples, recordFailureOn, MAX_ANTALL } = require("./contentBatch.js");

const TOTAL_TEXT_BUDGET = 250000; // tegn på tvers av alle dokumenter (~65k tokens)
const MAX_NATIVE_PDF_BYTES = 18 * 1024 * 1024; // skannede PDF-er sendes som fil kun opp til dette
const MIN_CHARS_PER_PAGE = 120; // under dette regnes PDF-en som skannet

function extOf(path) {
  var m = String(path || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

function displayName(path) {
  var base = String(path || "").split("/").pop() || "";
  // Fjern opplastings-prefikset (tidsstempel-indeks-) som frontend legger på.
  return base.replace(/^\d+-\d+-/, "");
}

// Leser ett dokument til { navn, tekst } eller { navn, nativePdf } (skannet).
async function readDocument(supabase, path) {
  var navn = displayName(path);
  var dl = await supabase.storage.from("manus").download(path);
  if (dl.error || !dl.data) return { navn: navn, feil: "Kunne ikke laste ned filen fra lagring." };
  var buf = Buffer.from(await dl.data.arrayBuffer());
  var ext = extOf(path);
  try {
    if (ext === "pdf") {
      var parsed = await pdfParse(buf);
      var text = (parsed.text || "").replace(/\n{3,}/g, "\n\n").trim();
      var pages = parsed.numpages || 1;
      if (text.length < Math.max(300, MIN_CHARS_PER_PAGE * pages)) {
        if (buf.length <= MAX_NATIVE_PDF_BYTES) {
          return { navn: navn, nativePdf: buf, sider: pages, merknad: "skannet PDF — lest visuelt av AI" };
        }
        return { navn: navn, feil: "PDF-en ser ut til å være skannet (lite tekst), og er for stor til å leses visuelt." };
      }
      return { navn: navn, tekst: text, sider: pages };
    }
    if (ext === "docx") {
      var res = await mammoth.extractRawText({ buffer: buf });
      return { navn: navn, tekst: (res.value || "").trim() };
    }
    if (ext === "txt" || ext === "md" || ext === "csv") {
      return { navn: navn, tekst: buf.toString("utf8").trim() };
    }
    return { navn: navn, feil: "Filtypen ." + ext + " støttes ikke (bruk PDF, Word .docx eller tekst)." };
  } catch (err) {
    return { navn: navn, feil: "Kunne ikke lese innholdet: " + err.message };
  }
}

function buildSystemPrompt(sakstype, examples) {
  var felles = `

KILDEGRUNNLAG OG ABSOLUTT REGEL — INGEN OPPDIKTEDE FAKTA: basér deg UTELUKKENDE på materialet du får (dokumenter, lenketekster og redaksjonens egen forklaring). Dikt ALDRI opp tall, datoer, frister, navn, sitater, bestemmelser eller konklusjoner som ikke står der. Er noe uklart, mangler eller motsier hverandre i materialet, skriv det rett ut i kontrollpunkter (og gjerne som forbehold i teksten) — presenter det aldri som bekreftet.

REDAKSJONENS FORKLARING: brukeren forklarer hva dokumentene inneholder og hva sakene skal inneholde. Følg denne nøye (antall saker, vinkel, målgruppe, hva som skal vektlegges). Motsier forklaringen materialet, følg materialet og si fra i kontrollpunkter.

FLERE SAKER: lager du flere saker, må hver ha en tydelig FORSKJELLIG vinkel og hoveddel (f.eks. én om hva som foreslås, én om hva det betyr for droneoperatører, én om fristen og hvordan man svarer — tilpass til det materialet faktisk gir grunnlag for). Ingen to saker skal ha samme tittel, ingress eller åpning. Hver sak må stå på egne bein.

Skriv på norsk (bokmål). Ingen klikkbare lenker, URL-er eller fotnoter i selve teksten. Fet skrift ("**tekst**") kun unntaksvis.`;

  if (sakstype === "content") {
    return `Du er innholdsprodusent for UAS Norway (uasnorway.no) og Dronemagasinet. Du skriver INFO-saker: korte, konkrete informasjons-/handlingsrettede tekster (ingress på 1–2 setninger som gir leseren en grunn til å bry seg, kort brødtekst i 3–6 korte avsnitt, direkte tiltale «du/vi/dere», aktiv form, tydelig handlingsoppfordring til slutt uten selve lenken). Følg de faktiske eksemplene på tidligere INFO-saker du får oppgitt tett i tone, lengde og oppbygging — bruk dem som stilmal, ikke som innhold.` + felles +
      (examples.length ? "" : "\n(Eksempler kunne ikke hentes — følg stilbeskrivelsen over.)");
  }
  return `Du er journalist i Dronemagasinet (dronemag.no), medlem av Fagpressen og underlagt Redaktørplakaten. Skriv nøktern, faktabasert norsk fagjournalistikk: kort ingress (1–3 setninger) og brødtekst i korte, konkrete avsnitt, aktiv form, ingen synsing. Du lager førsteutkast basert på dokumenter/lenker redaksjonen selv har lagt inn — typisk en høring, et regelverksforslag, en rapport eller en pressemelding.

- Navngi avsender/dokument i PROSA allerede i første avsnitt (f.eks. «Luftfartstilsynet foreslår i et høringsnotat at …», «ifølge rapporten fra …») og gjenta varierende der det er naturlig. Aldri fremstill innholdet som Dronemagasinets egne funn.
- Forklar hva forslaget/innholdet betyr i praksis for de som leser Dronemagasinet (droneoperatører, bransjen) KUN ut fra det materialet faktisk sier — ikke spekuler.
- Ta med frister, hvem som kan svare, og hvordan, når det står i materialet.
- Struktur: mellomtittel som eget avsnitt med prefiks "## " (2–4 i en middels lang sak, ingen i en veldig kort), direkte sitat som eget avsnitt med prefiks "> " i formatet '> «sitatet» – navn, rolle, kilde' KUN når sitatet ordrett står i materialet.` + felles;
}

function buildSchema(antall) {
  return {
    name: "dokumentsaker",
    strict: true,
    schema: {
      type: "object", additionalProperties: false,
      properties: {
        saker: {
          type: "array", minItems: antall, maxItems: antall,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              vinkel: { type: "string", description: "Én kort setning: sakens spesifikke vinkel (internt)." },
              emnefelt: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, description: "1–3 korte emneord med store bokstaver." },
              tittel: { type: "string" },
              titler_alternativer: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
              ingress: { type: "string" },
              hovedtekst_avsnitt: { type: "array", items: { type: "string" }, minItems: 2, description: "Mellomtittel: '## Tittel'. Sitat: '> «sitat» – navn, rolle, kilde'. Alt annet: vanlig avsnitt." },
              alt_tekst_bilde: { type: "string", description: "Forslag til alt-tekst for et passende bilde." },
              kontrollpunkter: { type: "array", items: { type: "string" }, minItems: 1, description: "Konkrete, saksspesifikke ting som må avklares/kontrolleres før publisering." }
            },
            required: ["vinkel", "emnefelt", "tittel", "titler_alternativer", "ingress", "hovedtekst_avsnitt", "alt_tekst_bilde", "kontrollpunkter"]
          }
        }
      },
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

// opts: { caseIds, docPaths[], links[], beskrivelse, sakstype ("redaksjonell"|"content"), nettsted }
async function generateCasesFromMaterial(supabase, openaiKey, opts) {
  var caseIds = (opts.caseIds || []).slice(0, MAX_ANTALL);
  var antall = caseIds.length;
  if (!antall) throw new Error("Ingen saker å produsere.");
  var sakstype = opts.sakstype === "content" ? "content" : "redaksjonell";

  // 1. Les alt materialet
  var docs = [];
  for (var d = 0; d < (opts.docPaths || []).length; d++) docs.push(await readDocument(supabase, opts.docPaths[d]));
  var lesteDocs = docs.filter(function (x) { return !x.feil; });
  var docFeil = docs.filter(function (x) { return x.feil; });

  var linkTekster = [];
  var linkKilder = [];
  for (var l = 0; l < (opts.links || []).length; l++) {
    var art = await fetchSourceArticle(opts.links[l]);
    if (art.ok && art.text) {
      linkTekster.push({ url: opts.links[l], navn: art.siteName || opts.links[l], tittel: art.title || "", tekst: art.text });
      linkKilder.push(opts.links[l]);
    } else {
      docFeil.push({ navn: opts.links[l], feil: "Kunne ikke hente lenken (" + (art.reason || "ukjent feil") + ")." });
    }
  }

  if (!lesteDocs.length && !linkTekster.length) {
    throw new Error("Fikk ikke lest noe av materialet: " + docFeil.map(function (f) { return f.navn + " — " + f.feil; }).join("; "));
  }

  // 2. Fordel tekstbudsjettet (kutter jevnt hvis det totalt blir for langt)
  var tekstDocs = lesteDocs.filter(function (x) { return x.tekst; });
  var totalChars = tekstDocs.reduce(function (n, x) { return n + x.tekst.length; }, 0);
  var kuttet = [];
  if (totalChars > TOTAL_TEXT_BUDGET) {
    var share = Math.floor(TOTAL_TEXT_BUDGET / tekstDocs.length);
    tekstDocs.forEach(function (x) {
      if (x.tekst.length > share) { x.tekst = x.tekst.slice(0, share); kuttet.push(x.navn); }
    });
  }

  var examples = sakstype === "content" ? await fetchInfoStyleExamples() : [];

  // 3. Bygg prompten (tekstdeler + eventuelle skannede PDF-er som filer)
  var tekstBlokk =
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
    (examples.length
      ? "\n\nEKSEMPLER PÅ TIDLIGERE INFO-SAKER FRA uasnorway.no (stilmal for tone, lengde og oppbygging):\n\n" +
        examples.map(function (e, i) { return "[Eksempel " + (i + 1) + "]\nTittel: " + e.tittel + "\nIngress: " + e.ingress + "\nTekst: " + e.tekst; }).join("\n\n")
      : "");

  var userContent = [{ type: "text", text: tekstBlokk }];
  lesteDocs.filter(function (x) { return x.nativePdf; }).forEach(function (x) {
    userContent.push({ type: "file", file: { filename: x.navn, file_data: "data:application/pdf;base64," + x.nativePdf.toString("base64") } });
  });

  var result = await callModel(openaiKey, buildSystemPrompt(sakstype, examples), userContent, buildSchema(antall));
  var saker = result.saker || [];

  // 4. Signerte lenker til opplastede dokumenter som saks-kilder (etter lenkene —
  // resten av appen leser kilder[0] som en nettside-URL)
  var docKilder = [];
  for (var k = 0; k < (opts.docPaths || []).length; k++) {
    var signed = await supabase.storage.from("manus").createSignedUrl(opts.docPaths[k], 60 * 60 * 24 * 365);
    if (!signed.error && signed.data) docKilder.push(signed.data.signedUrl);
  }
  var kilder = linkKilder.concat(docKilder);

  var materialNotat = "Basert på " + lesteDocs.length + " dokument(er)" + (linkTekster.length ? " og " + linkTekster.length + " lenke(r)" : "") +
    (kuttet.length ? " — OBS: lange dokumenter ble kortet ned (" + kuttet.join(", ") + "), sjekk at ingenting viktig falt utenfor" : "") +
    (docFeil.length ? " — kunne IKKE lese: " + docFeil.map(function (f) { return f.navn; }).join(", ") : "");

  var lagret = 0, feilet = 0;
  for (var i = 0; i < caseIds.length; i++) {
    var s = saker[i];
    var caseId = caseIds[i];
    if (!s) { feilet++; await recordFailureOn(supabase, caseId, "AI leverte ikke alle de bestilte sakene."); continue; }
    try {
      var kontrollpunkter = (s.kontrollpunkter || []).slice();
      if (kuttet.length) kontrollpunkter.push("Lange dokumenter ble kortet ned før AI leste dem (" + kuttet.join(", ") + ") — kontroller mot originalen.");
      docFeil.forEach(function (f) { kontrollpunkter.push("Kunne ikke lese «" + f.navn + "»: " + f.feil); });

      var fields = {
        emnefelt: s.emnefelt || [], tittel: s.tittel, alt_tekst_bilde: s.alt_tekst_bilde || "", bilde_er_illustrasjon: false,
        fotoKreditering: "", ingress: s.ingress, hovedtekst_avsnitt: s.hovedtekst_avsnitt,
        titler_alternativer: s.titler_alternativer, kilder_brukt: [], kontrollpunkter: kontrollpunkter, tidligere_dekning: null
      };
      var doc = new Document({ sections: [{ children: await buildDocxParagraphs(fields, null) }] });
      var buffer = await Packer.toBuffer(doc);
      var path = caseId + "/" + Date.now() + ".docx";
      var up = await supabase.storage.from("manus").upload(path, buffer, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", upsert: false
      });
      if (up.error) throw new Error("Kunne ikke laste opp manus: " + up.error.message);

      var cur = await supabase.from("cases").select("historikk").eq("id", caseId).maybeSingle();
      var historikk = [{
        ts: new Date().toISOString(),
        text: "Sak produsert av AI fra opplastet materiale (" + (i + 1) + " av " + antall + ") — vinkel: " + s.vinkel + " — " + materialNotat +
          " — " + kontrollpunkter.length + " kontrollpunkt(er) å avklare før publisering"
      }].concat((cur.data && cur.data.historikk) || []);

      var upd = await supabase.from("cases").update({
        title: s.tittel, oppsummering: s.vinkel, kilder: kilder,
        manus_url: path, manus_generert_ts: new Date().toISOString(),
        manus_tittel: s.tittel, manus_ingress: s.ingress, manus_hovedtekst: s.hovedtekst_avsnitt,
        manus_alt_tekst: s.alt_tekst_bilde || "", manus_bilde_url: "", manus_foto: "",
        manus_emnefelt: s.emnefelt || [], manus_titler_alternativer: s.titler_alternativer,
        manus_tidligere_dekning: null, manus_kilder_brukt: [], manus_kontrollpunkter: kontrollpunkter,
        manus_bilde_er_illustrasjon: false, historikk: historikk
      }).eq("id", caseId);
      if (upd.error) throw new Error(upd.error.message);
      lagret++;
    } catch (err) {
      feilet++;
      await recordFailureOn(supabase, caseId, err.message);
    }
  }
  return { lagret: lagret, feilet: feilet, dokumenterLest: lesteDocs.length, lenkerLest: linkTekster.length, uleste: docFeil.length, kuttet: kuttet.length };
}

module.exports = { generateCasesFromMaterial, readDocument };
