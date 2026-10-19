# Saksbank (UAS Norway / Dronemagasinet) — prosjektinstruks for Claude

Les også `OVERLEVERING.md` (utfyllende) og `README.md` (opprinnelig oppsettguide, delvis eldre).

## Hva dette er
Delt redaksjonelt arbeidsverktøy: finner dronesaker automatisk (RSS + websøk), lar teamet vurdere/godkjenne dem,
lager manus med AI (research, kildevurdering, bilder), og lager WordPress-utkast for dronemag.no og uasnorway.no.
Brukerne er redaksjonen; de skriver kort og direkte på norsk og forventer at du handler selv når retningen er klar.

## Arkitektur (ingen byggesteg, ingen rammeverk)
- `public/index.html` — HELE frontend i én fil (én IIFE, vanlig JS + CSS). Henter data direkte fra Supabase (anon-nøkkel + innlogget bruker, RLS).
- `netlify/functions/*.js` — serverfunksjoner. Filer som ender på `-background.js` er Background Functions (opptil 15 min).
  `schedule()` brukes for planlagte jobber. Delt logikk ligger i `netlify/functions/lib/`.
- `supabase/schema.sql` — hele databaseskjemaet, idempotent (`add column if not exists`). Kjøres med `npm run db:migrate` (krever `SUPABASE_DB_URL` i `.env`).
- Hosting: Netlify (site `uas-saksbank`, id `5b9adca9-7dac-4046-8ea4-0af3c7f9f358`, konto-slug `uasnorge`) — deployer automatisk fra GitHub `main`.
- Repo: github.com/UASnorge/UAS-saksbank. Live: https://uas-saksbank.netlify.app.

## Arbeidsflyt (slik det har fungert)
1. Endre kode lokalt. Syntakssjekk: `node --check` på hver endrede serverfil; for frontend trekk ut det innebygde `<script>` og kjør `node --check`.
2. Test på ekte: serverlogikk med mockede OpenAI/Supabase-kall eller mot ekte nettsider/PDF; UI i nettleseren med en liten test-harness
   (kopi av `public/index.html` der Supabase-klienten er byttet med en fake i minnet, servert med `python3 -m http.server`).
3. Commit (norsk melding, forklar HVORFOR) og `git push origin main`. Brukeren har gitt stående tillatelse til å committe/pushe etter verifisert endring.
4. Verifiser deploy: poll Netlify API `GET /api/v1/sites/<id>/deploys?per_page=1` til `state` er `ready` (Bearer `NETLIFY_AUTH_TOKEN` fra `.env`).
5. Rapporter kort på norsk: hva som er gjort, hva som er testet, hva som IKKE er testet.

## Hemmeligheter
- Lokal `.env` (gitignored) har bare `SUPABASE_DB_URL` og `NETLIFY_AUTH_TOKEN`. ALDRI skriv ut, logg eller commit verdier.
- Produksjonsnøkler ligger som Netlify-miljøvariabler: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`,
  `WP_UASNORWAY_*`, `WP_DRONEMAG_*`. Har du Netlify-tokenet kan de leses via API til engangsbruk i et skript (brukeren er kjent med og har godtatt dette
  mønsteret; si alltid fra til brukeren når du gjør det, og skriv aldri verdiene i chatten).
- Midlertidige skript som trenger nøkler: legg dem i `scripts/_tmp-*.js`, kjør, og SLETT dem (ikke commit).

## Designregler som ikke må brytes
- Statuser: `ide → i-arbeid → wp-utkast → publisert` (+ sidestatuser `arkivert`, `avvist`). «Godkjent» finnes ikke lenger som eget steg.
- «Publisert» krever STOPP-kontroll av et menneske (kryss + godkjenner). Assistenter kan aldri sette `publisert`, og `wp-utkast` bare med et ekte WP-utkast.
- AI skal aldri dikte opp fakta, kilder, sitater, URL-er eller bilde-URL-er. Nye opplysninger kun fra manus, kilde, vedlegg, verifisert research eller lenke redaksjonen ga.
- Bilder: bruksrett A/B kun med dokumentasjon; ellers C/D/E med tydelig advarsel. Kreditering skal alltid være riktig (avsender/fotograf).
- WordPress-utkast: bildet legges KUN i ACF-feltet «Bilde» (aldri «Fremhevet bilde»). Bilde er valgfritt; stikkord, kategori og byline er obligatoriske.
- Alle sakstitler skal være på norsk (oversettes ved opprettelse; originalen bevares i historikk).
- Feilmeldinger som vises til redaksjonen skal være forståelige norsk (se `lib/errors.js`).

## Kjente fallgruver
- OpenAI-kreditt tom → alle AI-funksjoner feiler med 429 `insufficient_quota`. Ikke en kodefeil; kontoen må fylles på.
- Supabase Storage avviser filer > 50 MB. Store filer deles i 40 MB-deler i nettleseren (`uploadLargeFile`) og settes sammen på serveren.
- Node-fetch avbryter etter 5 min uten svar-hoder; derfor 8-min lydbiter, parallell transkribering og retry (`lib/transcribe.js`).
- `pdf-parse` må stå i `external_node_modules` i `netlify.toml` for hver funksjon som bruker den (uten det mangler motorfiler i produksjon).
- Hele UI tegnes på nytt (`render()`) ved hver live-oppdatering; skjemaer som brukeren skriver i må ha tilstand i `state.ui` (se `writeDraft`).
- Åpne nettleserfaner beholder gammel JS til de lastes på nytt (Cmd+Shift+R) — nevn det når en rettelse «ikke virker».
- Sjekk alltid `git status` før commit; `netlify.toml` ble en gang glemt fordi bare mapper ble lagt til.

## Stil
- UI-tekst og kommentarer på norsk (bokmål). Kommentarer kun når HVORFOR ikke er åpenbart.
- Ikke legg til funksjoner utover det som ble bedt om; ikke gjør brede refaktoreringer uten å bli bedt.
