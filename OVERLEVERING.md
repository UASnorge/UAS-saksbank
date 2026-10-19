# Saksbank — overlevering til ny Claude-konto

Sist oppdatert: 19.10.2026. Skrevet for å kunne fortsette utviklingen av saksbanken uten tilgang til den forrige Claude-kontoens chatthistorikk.
Dette dokumentet + `CLAUDE.md` + selve kildekoden + `chat-logg/` (renset samtalelogg) er alt som trengs.

> Hemmeligheter (passord/nøkler) står IKKE her og skal aldri limes inn i delte mapper. Se «Sikkerhet» nederst.

---

## 1. Hva saksbanken er

Et delt redaksjonelt verktøy for **UAS Norway / Dronemagasinet** (dronemag.no, uasnorway.no):

1. **Finner saker automatisk** — RSS-kilder (hver time) og generelt websøk (kl. 05 og 11 UTC), med relevansfilter, aldersgrense, kildekontroll og AI-vurdering.
2. **Lar teamet behandle dem** — liste- og kolonnevisning, godkjenn/avvis, sortering, filter (tema/land/sakstype).
3. **Lager manus med AI** — research på nettet, faktasjekk, kildevurdering, bilderesearch, redigering direkte i saken, AI-assistent per sak.
4. **Tar imot egne materiale** — lenke, .docx-manus, lydopptak (transkriberes), PowerPoint/PDF, dokumenter, «skriv selv».
5. **Lager WordPress-utkast** (aldri automatisk publisering) på begge nettsteder, og oppdager selv når utkast er publisert.

Brukere: redaksjonen (innlogging kun @uasnorway.no, magic link / Microsoft). Språk i UI og kommentarer: norsk bokmål.

## 2. Hvor alt bor (infrastruktur er uavhengig av Claude-kontoen)

| Del | Detalj |
|---|---|
| Kildekode | GitHub `UASnorge/UAS-saksbank`, gren `main` |
| Hosting + serverfunksjoner | Netlify, site `uas-saksbank` (id `5b9adca9-7dac-4046-8ea4-0af3c7f9f358`, konto-slug `uasnorge`), live https://uas-saksbank.netlify.app. Deployer automatisk ved push til `main` (ca. 1 min) |
| Database + innlogging + fillagring | Supabase-prosjekt `ftuqxdblzgrsehzeduow` (https://ftuqxdblzgrsehzeduow.supabase.co). Lagringsbøtte `manus` (privat) |
| AI | OpenAI (modeller i koden: `gpt-5.4-mini` m.fl., `gpt-5-search-api` til websøk/research, `gpt-4o-transcribe-diarize` til lyd, `gpt-image-1` til AI-illustrasjoner) |
| WordPress | uasnorway.no og dronemag.no via REST API + Application Password |
| Kontaktperson for tilgang | es@uasnorway.no |

Netlify-miljøvariabler (kun navn): `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`WP_UASNORWAY_URL/_USERNAME/_APP_PASSWORD`, `WP_DRONEMAG_URL/_USERNAME/_APP_PASSWORD`. (Valgfritt: `WP_DRONEMAG_ACF_*`.) Mal: `oppsett/miljøvariabler-mal.env`.

## 3. Kom i gang på en ny Claude-konto

1. Installer Claude Code (eller bruk skrivebordsappen) og logg inn med den nye kontoen.
2. Hent koden: `git clone https://github.com/UASnorge/UAS-saksbank.git` (du trenger tilgang til GitHub-organisasjonen UASnorge).
   Alternativt: pakk ut `kildekode/` fra denne mappen, eller gjenopprett full historikk fra `kildekode-git/saksbank-full-historikk.bundle` (`git clone saksbank-full-historikk.bundle saksbank`).
3. `npm install` i prosjektmappen.
4. Lag `.env` i prosjektroten (gitignored) med to verdier — resten ligger som Netlify-miljøvariabler:
   - `SUPABASE_DB_URL` — Supabase → prosjektet → «Connect» → URI → «Reveal»/reset database-passord.
   - `NETLIFY_AUTH_TOKEN` — Netlify → User settings → Applications → Personal access tokens → New token.
5. Start Claude i prosjektmappen. `CLAUDE.md` leses automatisk. Forslag til første melding:
   > «Les CLAUDE.md og OVERLEVERING.md. Du overtar videreutviklingen av saksbanken. Sjekk at `git status` er rent, at `npm install` er gjort og at du kan lese Netlify-deploys via API-et med tokenet i .env. Si hva som er status, og spør meg hva jeg vil gjøre først.»
6. Uten egen konfigurasjon trenger du ikke `netlify dev`; arbeidsflyten er: endre → test (se `CLAUDE.md`) → commit → push → verifiser deploy via Netlify API.

Skal en HELT ny, uavhengig kopi settes opp (nye Supabase/Netlify/OpenAI-kontoer): følg `README.md` steg 1–5 og `oppsett/LES-MEG.md`, kjør `npm run db:migrate`, sett miljøvariablene.

## 4. Filkart

```
public/index.html                 Hele frontend (én IIFE). state.ui = all UI-tilstand. render() tegner alt på nytt.
netlify/functions/                Endepunkter og planlagte jobber (se tabell under)
netlify/functions/lib/            Delt logikk (AI, research, bilder, PDF/PPT, WordPress …)
supabase/schema.sql               Hele skjemaet, idempotent (v1 … v16)
scripts/run-schema.js             `npm run db:migrate`
netlify.toml                      Bundler-oppsett; pdf-parse/ffmpeg-static som external_node_modules
CLAUDE.md / OVERLEVERING.md       Instruks og denne overleveringen
```

### Serverfunksjoner
| Fil | Rolle |
|---|---|
| `rss-poll.js` | **Hver time.** Henter RSS-kilder, relevansfilter, aldersgrense, oppretter Idé-saker (tittel oversettes til norsk), AI-vurdering (triage), arkiverer gamle idéer |
| `web-search-trigger.js` → `web-search-background.js` | **05:00 og 11:00 UTC.** Generelt websøk (sivil/industri/politikk/nordisk/forsvar + søkeord) → Idé-saker |
| `source-gate-trigger.js` → `source-gate-background.js` | **Hver time.** Automatisk kildekontroll av nye RSS-idéer |
| `check-wp-published.js` | **Hver time.** Sjekker WP-utkast mot WordPress; flytter til «Publisert» hvis publisert direkte i WP |
| `generate-manuscript-background.js` | Manusgenerering (research + skriving) for én sak |
| `generate-cases-from-material-background.js` | «Fra dokument/lenker» → 1–8 saker |
| `generate-content-batch-background.js` | «Bestill innhold» (INFO-saker i uasnorway.no-stil) |
| `transcribe-audio-background.js` | Lydopptak → transkripsjon → manus; leser også presentasjoner (pptx/PDF) |
| `case-assistant-background.js` | AI-assistenten inni en sak (verktøy: research, revidere manus, bilder, vedlegg …) |
| `assistant-chat.js` | Global chat-assistent |
| `publish-to-wordpress.js` | Lager WP-utkast (ACF-felt, stikkord, kategori, byline; bilde valgfritt) |
| `research-images.js`, `check-source.js`, `ai-triage.js`, `revise-manuscript.js`, `import-manuscript.js`, `create-case-from-link.js`, `add-sources.js`, `add-keywords.js` | Tynne HTTP-innganger mot lib-logikk |

Viktige lib-filer: `manuscript.js` (skrivepipeline), `materialResearch.js` (dyp research), `imageResearch.js` + `attachmentImages.js` (bilder, inkl. kart/figurer i PDF-vedlegg),
`caseAssistant.js`, `reviseManuscript.js`, `caseAttachments.js` + `pptx.js` + `documentCases.js` + `docImages.js` (dokumentlesing),
`transcribe.js`, `wordpress.js`, `norskTittel.js`, `errors.js`, `styleGuide.js` (redaksjonell stil), `triage.js`, `relevance.js`, `ageGate.js`, `webSearch*.js`.

## 5. Databasen

Tabeller: `cases` (kjernen), `sources` (RSS-kilder), `seen_items` / `seen_urls` (dedupe), `events` (UAS Norway-arrangementer), `watch_keywords`.
`cases` har bl.a.: `status`, `title`, `triage` (aktualitet/betydning/innsats/eksklusivitet), `tema`, `land`, `kilder[]`, `historikk[]` (nyest først),
`manus_*`-felt (tittel, ingress, hovedtekst[], alt-tekst, foto, bilde-URL, kontrollpunkter, kilder brukt …), `bildeforslag`, `kildevurdering`,
`wp_post_id/wp_edit_link/wp_stikkord/wp_kategori/wp_byline`, `assistent_chat/assistent_opptatt`, `kilde_publisert_dato`, `vedlegg` (jsonb, v16).
RLS: innloggede brukere leser/skriver; serverfunksjoner bruker service_role. Live-oppdatering via Supabase Realtime (frontend har i tillegg 10 s-polling mens en assistent-jobb kjører).
Endringer i skjemaet: legg til `alter table … add column if not exists …` nederst i `supabase/schema.sql` og kjør `npm run db:migrate` (eller direkte via `pg` med `SUPABASE_DB_URL`).

## 6. Funksjonsoversikt (slik appen er nå)

**Arbeidsflyt/statuser:** Idé → I arbeid → WP-utkast opprettet → Publisert (+ Arkivert, Avvist). Godkjenn = flytter rett til «I arbeid» og starter manusgenerering. «Avvis» finnes på alle trinn.
**Visning:** Liste (standard, tabell med status-faner Alle/Idé/I arbeid/WP-utkast/Publisert, Land-kolonne, kompakte handlingsknapper) og Kolonner (kort med kollaps/åpne alle). Valget huskes i nettleseren.
**Sortering:** Nyeste aktivitet (default, siste historikk-hendelse), mest populær/relevant (score), publisert hos kilde, frist, eldste. «Ny»-merke i 24 t.
**Ny sak:** 🔗 Lim inn lenke · 📄 Last opp manus (.docx) · 🎙️ Lydopptak (+ presentasjon pptx/PDF) · ✍️ Skriv selv (full manuell sak, ingen AI) · 💡 Tips · 📎 Fra dokument/lenker · 🎯 Bestill innhold.
**Manus i saken:** redigerbart, forstørret visning med AI-assistent ved siden av («Forhåndsvis manus» → «Vis normalt» går til forsiden). Assistenten jobber i bakgrunnen; popup nede til venstre viser «jobber/ferdig» også på forsiden.
**Vedlegg i sak:** 📎 Legg ved fil (pptx/PDF/docx/tekst, store filer deles i deler); assistenten leser dem (`les_vedlegg`) og revisjonen bruker dem som faktagrunnlag.
**Bilder:** «Finn bilder» (verifiserte lenker, rettighetskategori A–E, AI-illustrasjon som siste utvei) + **kart/figurer fra PDF-vedlegg på kildesiden** (typisk høringer), kreditert avsender. «Bruk som hovedbilde i saken».
**WordPress:** utkast på begge nettsteder; bilde kun i ACF «Bilde»; bilde valgfritt; stikkord/kategori/byline påkrevd; selvoppdagelse av publisering.
**Språk:** nye titler oversettes til norsk; feilmeldinger er norske og forklarende (f.eks. tom OpenAI-kreditt).
**Lyd/PowerPoint:** lyd transkriberes i 8-min biter, 3 parallelt, med retry; PowerPoint slankes i nettleseren (bilder/video fjernes) og leses (lysbilder + talernotater); PDF-presentasjoner leses side for side.

## 7. Prinsipper (bruker har bedt om disse eksplisitt)

- Ingen oppdiktede fakta/kilder/URL-er. «STOPP-kontroll» før publisering. Assistenter publiserer aldri.
- Rettighetsdisiplin for bilder; riktig kreditering (avsender/fotograf). «Ikke et forsvarsmagasin»-linjen for tema.
- Redaksjonen bestemmer stikkord/kategori/byline selv — aldri utledet stille.
- Bruker ønsker kort, direkte kommunikasjon på norsk, og at Claude handler selv når retningen er klar.

## 8. Hva som er gjort i den siste store økten (okt. 2026)

Grupper (se `endringslogg-git.txt` for alle commits):
- **Redesign:** liste som default med full funksjon, Avvis-knapp, samlet sortering, kollaps av kort, hover-fiks (usynlige knapper), «Godkjent»-steget fjernet, status-faner, Land-kolonne, kompakt tittelkolonne (avkortet, full tittel ved hover), visningsvalg huskes.
- **Assistent:** i forhåndsvisning av manus; bakgrunnsvarsler nede til venstre; vedlegg i sak; `les_vedlegg`.
- **Nytt:** auto-oppdagelse av WP-publisering; kart/figurer fra PDF-vedlegg (Arendal-høringen som eksempel); norske titler; «Skriv selv»; lyd/PowerPoint/PDF (store filer, deler, slanking); WP-utkast uten bilde og uten «Fremhevet bilde».
- **Feilretting:** Kategori-avkrysning som gled i hverandre; `fetch failed` på lange lydopptak; lydlenke ikke koblet til sak ved feil; sparsomme slide-PDF-er regnet som skannet; manglende `netlify.toml`-oppføring.
- **Driftsrettinger gjort på data:** migrert «godkjent»-saker til «i-arbeid»; kjørt manus for 5 saker etter OpenAI-kreditt-feil; oversatt 47 titler; lagt kart inn i Arendal-saken; koblet lydopptak til to saker; kjørt KTV-saken fra lydopptak.

## 9. Åpne punkter / kjente forhold

- **Thomas Olsen-saken** («Foredrag med Thomas Olsen») har fortsatt ikke manus: lydopptaket (`lydopptak/1791898118922-opptak1.m4a`) er koblet som kilde, men transkribering feilet før rettelsen. Kan kjøres på nytt (samme mønster som `transcribe-audio-background`).
- **Plassholder-sak** `a72d5b29…` («⏳ Sak 1 av 1 fra 2 dokument(er) — produseres …») er rester av en mislykket dokumentimport — slett og lag på nytt via «Fra dokument/lenker».
- **To Arendal-saker:** `a5389570…` (riktig høringskilde, kartet er lagt inn) og `55c4e6f1…` (peker på søk i høringsoversikten) — vurder å arkivere den siste.
- **Eksisterende WP-utkast** laget før endringen har «Fremhevet bilde» satt; kan fjernes manuelt (eller via skript mot WP REST med `featured_media: 0`).
- **OpenAI-kreditt**: ble tom én gang (alle AI-funksjoner stoppet). Slå på automatisk påfyll/varsel hos OpenAI.
- Delt lyd (> 50 MB) får ingen samlet avspillingslenke som kilde (bare note i historikken).
- «Generer nytt førsteutkast» bruker ikke vedlegg ennå (kun revisjon/assistent gjør det).
- Talerdeling i lange opptak er ikke konsistent på tvers av biter — manus merkes med kontrollpunkt om å sjekke attribusjon.
- `README.md` beskriver oppsett steg for steg og er delvis eldre enn funksjonene over — stol på denne filen og koden ved avvik.
- Idéer brukeren har antydet: bedre mobilvisning, PowerPoint-bilder som støttebilder, vedlegg til «Generer manus».

## 10. Sikkerhet — GJØR DETTE ved overføring

Under arbeidet har noen hemmeligheter (databasepassord via `SUPABASE_DB_URL`, Netlify-token, Supabase service_role-nøkkel) vært innom Claude-økter/loggene på den gamle kontoen.
Anbefalt ved kontobytte:
1. Roter **Netlify personal access token** (lag nytt, slett gammelt).
2. Tilbakestill **Supabase database-passord** (Project Settings → Database) og oppdater `SUPABASE_DB_URL`.
3. Vurder å rotere **service_role-nøkkelen** (Supabase → Project Settings → API; husk å oppdatere Netlify-variabelen `SUPABASE_SERVICE_ROLE_KEY` og redeploye).
4. Vurder ny **OpenAI API-nøkkel** og nye **WordPress Application Passwords**, og oppdater Netlify.
5. Ikke legg `.env` eller rå chatt-logger (`.jsonl`) i delte mapper — de kan inneholde disse verdiene. Mappen `chat-logg/` her er renset.

## 11. Slik jobber Claude best med deg (observert)

- Skriv gjerne kort og direkte; Claude bør svare kort, på norsk, og si tydelig hva som er testet vs. ikke testet.
- Claude kan committe/pushe etter verifiserte endringer og kjøre migrasjoner på produksjonsdatabasen (stående tillatelse gitt av eier), men skal alltid si fra.
- Ved «det virker ikke»: be om ordlyden i feilmeldingen, og husk først å laste siden på nytt (Cmd+Shift+R).
