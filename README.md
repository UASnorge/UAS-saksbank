# UAS Norway — Saksbank

Delt redaksjonell saksbank med automatisk RSS-innhenting. Statisk frontend (ingen build-steg) + Netlify-funksjon som poller RSS-kilder + Supabase som delt database og innlogging.

**Nå koblet på og verifisert:** RSS-innhenting (delt saksbank, live innlogging), massimport av RSS-kilder, og AI-vurdering + AI-generert manus via OpenAI. AI-delene er testet direkte mot den ekte OpenAI-API-en (strukturert JSON-svar) og docx-strukturen er verifisert til å matche malen "WordPress Infosak Batch Administrator" nøyaktig (feltrekkefølge, bilde rett under BILDE:-linjen, tom linje mellom avsnitt).

**Fortsatt ikke koblet på:** selve WordPress-opplastingen (skjer i det eksisterende Infosak-verktøyet, dere laster opp `.docx`-en dit selv), Mailchimp-sending, Doffin, eventkalender-synk (events.uasnorway.no har intet åpent API — se `events`-tabellen), omtaleovervåkning. Se banneret "Om piloten" i selve verktøyet for full status.

---

## Steg 1 — Opprett Supabase-prosjektet (databasen)

1. Gå til [supabase.com](https://supabase.com) → opprett konto/logg inn → **New project**.
2. Velg navn (f.eks. `uas-saksbank`), passord (trengs sjelden, lagre det et sted trygt) og region (velg `eu-central` for lavest ping fra Norge).
3. Når prosjektet er klart: åpne **SQL Editor** → **New query** → lim inn hele innholdet i [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   - Dette oppretter tabellene `cases`, `sources`, `seen_items`, setter opp tilgangsregler (RLS), og legger inn én eksempel-RSS-kilde (NRK toppsaker) bare for å bevise at rørledningen fungerer — bytt den ut, se steg 6.
4. Gå til **Authentication → Providers** og bekreft at **Email** er aktivert (er det som regel som standard). Vi bruker "magic link" (innloggingslenke på e-post), ikke passord.
5. Gå til **Authentication → URL Configuration** og sett **Site URL** til Netlify-adressen dere får i steg 4 (kan oppdateres senere når dere vet den).

## Steg 2 — Hent nøklene

Gå til **Project Settings → API**. Du trenger tre verdier:

| Nøkkel | Brukes hvor | Hemmelig? |
|---|---|---|
| `Project URL` | Begge steder | Nei |
| `anon` `public` key | `public/index.html` (frontend) | Nei — beskyttes av RLS-reglene, ikke av hemmelighold |
| `service_role` key | Netlify-funksjonen (`rss-poll.js`) | **Ja — aldri i frontend eller Git** |

## Steg 3 — Koble frontend til Supabase

Åpne [`public/index.html`](public/index.html), finn disse to linjene nær toppen av `<script>`-blokken og fyll inn dine egne verdier:

```js
var SUPABASE_URL = "https://DITT-PROSJEKT.supabase.co";
var SUPABASE_ANON_KEY = "DIN-ANON-KEY";
```

## Steg 4 — Push til GitHub og koble til Netlify

```bash
cd uas-saksbank
git add -A
git commit -m "Første versjon av saksbank"
git remote add origin https://github.com/DITT-BRUKERNAVN/uas-saksbank.git
git push -u origin main
```

Deretter i Netlify: **Add new site → Import an existing project** → velg GitHub-repoet. Netlify finner `netlify.toml` automatisk (publish-mappe `public/`, funksjoner i `netlify/functions/`) — ingen build-kommando trengs siden dette er en ren statisk side.

## Steg 5 — Sett miljøvariabler i Netlify

**Site settings → Environment variables**, legg til:

- `SUPABASE_URL` → samme som i steg 2
- `SUPABASE_ANON_KEY` → `anon`-nøkkelen fra steg 2 (samme verdi som i `public/index.html`)
- `SUPABASE_SERVICE_ROLE_KEY` → `service_role`-nøkkelen fra steg 2 (kun til `rss-poll.js` — ikke bruk denne som `SUPABASE_ANON_KEY`)

Deploy siden på nytt etter at variablene er lagt til (**Deploys → Trigger deploy**).

## Steg 6 — Legg til RSS-kildene dere faktisk vil overvåke

Åpne saksbanken i nettleseren → **Kilder**-knappen øverst. Der kan dere legge til mange på én gang, ikke bare én og én:

- Lim inn én lenke per linje, valgfritt med navn foran: `Luftfartstilsynet | https://eksempel.no/rss`
- Eller lim inn en hel **OPML-eksport** (standardformatet for feed-lister — Feedly, Inoreader og de fleste RSS-lesere kan eksportere til dette under innstillinger/import-eksport)

Trykk **Importer kilder**. Hver lenke sjekkes automatisk mot den ekte feeden før den lagres — ugyldige eller nedlagte feeder vises i feilrapporten i stedet for å bli lagret som søppel. Maks 30 kilder behandles per import; lim inn i flere omganger ved større lister. Eksempelraden i `schema.sql` (NRK toppsaker) er kun for å bevise at rørledningen virker — slett den fra samme panel når dere har lagt inn egne kilder.

Noen typiske kandidater å sjekke om finnes som RSS (bekreft URL og lisensvilkår selv — importfunksjonen forteller dere om lenken faktisk virker, men ikke om dere har lov til å bruke innholdet):

- Luftfartstilsynet sine nyheter/pressemeldinger
- Avinor sine pressemeldinger
- EASA (europeisk luftfartsmyndighet)
- Relevante internasjonale dronenettsteder dere allerede følger manuelt

`rss-poll.js` henter automatisk **alle kilder markert som aktive**, hver time. Kryss av/av direkte i Kilder-panelet for å skru en kilde av midlertidig uten å slette den.

## Steg 7 — Test at RSS-henting faktisk fungerer

Vent til funksjonen kjører automatisk (hver time), eller trigg den manuelt:

```bash
npm install -g netlify-cli   # engangsoppsett
netlify login
netlify functions:invoke rss-poll --no-identity
```

Sjekk deretter **Table Editor → cases** i Supabase — nye rader med status `ide` og en `neste_handling` som starter med "Vurder relevans og eier (oppdaget via RSS: …)" skal dukke opp. De vises også i saksbanken i nettleseren med en "RSS"-merkelapp på kortet.

## Steg 8 — Logg inn og test som team

Åpne Netlify-adressen → skriv inn e-postadressen din → sjekk innboksen for lenken → du er inne. Gjenta med en kollegas e-post for å bekrefte at dere ser den samme saksbanken og samme RSS-funn.

## Steg 9 — AI-vurdering og manusgenerering (OpenAI)

Krever at `supabase/schema.sql` er kjørt på nytt (v2-delen nederst i filen legger til `oppsummering`, `manus_url`, `events`-tabellen og en privat Storage-bucket kalt `manus` — trygt å kjøre hele filen på nytt, den rører ikke eksisterende data).

1. Legg til én miljøvariabel til i Netlify: `OPENAI_API_KEY` → nøkkelen fra [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Trigger en ny deploy etterpå.
2. **Kjør AI-vurdering (nye idéer)** i toppmenyen vurderer alle saker i «Idé»-kolonnen samtidig: setter sakstype (Dronemagasin/INFO/Kommentar), hastegrad, prioriteringsscore, et kort sammendrag, og — for INFO-saker — kobler til riktig kommende arrangement fra `events`-tabellen. De mest aktuelle sorteres automatisk øverst i hver kolonne.
3. Når en sak flyttes til **Godkjente idéer** (eller senere), dukker en **«Generer manus»**-knapp opp inne på saken. Den henter kildeartikkelen, skriver et førsteutkast i Dronemagasinet-stil (kun basert på fakta fra kilden — usikre opplysninger flagges, aldri diktet opp), forsøker å finne kildeartikkelens eget bilde med kreditering, og laster opp et `.docx` i nøyaktig formatet «WordPress Infosak Batch Administrator» leser.
4. **Last ned manus** henter `.docx`-filen — last den opp i det eksisterende WordPress-importverktøyet deres. Manuset er alltid et førsteutkast: les gjennom, korriger, og sett inn bilde manuelt hvis det ikke ble funnet automatisk, før dere laster det opp.

**Eventkalenderen** (`events`-tabellen) er vedlikeholdt manuelt siden events.uasnorway.no blokkerer automatisk henting (403 på vanlig sideoppslag). Oppdater den via Supabase Table Editor når nye kurs/konferanser legges til.

## Steg 10 — Relevansfilter: kun dronesaker

RSS-innhentingen kjører nå automatisk en AI-relevanssjekk på hvert eneste treff **før** en sak i det hele tatt opprettes — saker uten en tydelig drone-/UAS-kobling havner aldri i «Idé». Testet mot 14 overskrifter (både ekte Dronemagasinet-saker og åpenbart urelaterte) med 14/14 riktig klassifisering — se `netlify/functions/lib/relevance.js` for de nøyaktige kriteriene.

For å rydde i det som allerede ligger i «Idé» fra før filteret ble slått på: trykk **🧹 Fjern ikke-relevante (AI)** i toppmenyen. Den vurderer alle idéer på nytt og sletter de som ikke handler om droner — du får en rapport med tittel og begrunnelse for hver som fjernes. Rører kun status «Idé»; saker dere allerede har godkjent eller jobbet videre med, lar den stå urørt uansett.

## Steg 11 — AI-assistent (chat)

Trykk **💬 Assistent** i toppmenyen. En samtale-assistent med verktøytilgang til hele saksbanken — den kan slå opp saker, opprette nye, endre felter, flytte status, slette, kjøre AI-vurdering og generere manus, alt via vanlig norsk tekst i stedet for å klikke seg gjennom grensesnittet. Eksempler: «hva står i Idé nå?», «opprett en sak om ny motdrone-teknologi», «godkjend saken om antidrone-radar og generer manus for den».

**Ufravikelig grense:** assistenten kan aldri sette en sak til status Publisert — det krever alltid at et menneske åpner saken i appen selv, krysser av STOPP-kontrollen og velger godkjenner. Dette er hardkodet i verktøyet den bruker (`move_case_status`), ikke bare en instruks den kan overtales til å ignorere — testet eksplisitt med et forsøk på å overstyre den, se commit-historikken for `assistant-chat.js`.

Bruker samme `OPENAI_API_KEY` som resten av AI-funksjonene — ingen ekstra oppsett om du allerede har gjort steg 9.

---

## Prosjektstruktur

```
uas-saksbank/
├── public/index.html          Hele frontend — kanban, liste, saksskjema, STOPP-gate
├── netlify/functions/
│   ├── rss-poll.js             Kjører hver time, henter RSS → nye saker i "Idé" (relevansfiltrert)
│   ├── add-sources.js          Masseimport av RSS-kilder (lenkeliste eller OPML)
│   ├── ai-triage.js            AI-vurdering: kategori, hastegrad, score, sammendrag, eventkobling
│   ├── generate-manuscript.js  AI-generert .docx-manus i UAS Norways malformat
│   ├── cleanup-irrelevant.js   Rydder bort ikke-dronerelevante idéer fra "Idé"
│   ├── assistant-chat.js       AI-chat med verktøytilgang til hele saksbanken
│   └── lib/
│       ├── relevance.js        Delt AI-relevanssjekk (rss-poll + cleanup)
│       ├── triage.js           Delt AI-vurderingslogikk (ai-triage + assistant-chat)
│       └── manuscript.js       Delt manusgenerering (generate-manuscript + assistant-chat)
├── supabase/schema.sql        Databasetabeller + tilgangsregler (v1 + v2)
├── netlify.toml                Netlify-konfig (publish-mappe, funksjonsmappe)
└── .env.example                Mal for lokale miljøvariabler
```

## Neste steg (krever tilganger jeg ikke har ennå)

- **Mailchimp:** API-nøkkel, for å bygge nyhetsbrevutkastet direkte i Mailchimp i stedet for kopier/lim
- **Doffin, omtaleovervåkning:** egne pollefunksjoner, samme arkitektur som RSS
- **Automatisk eventkalender-synk:** krever enten et API fra events.uasnorway.no (finnes ikke i dag) eller at noen der åpner for det — inntil videre vedlikeholdes `events`-tabellen manuelt
- **Ekte WordPress REST API-tilgang** er ikke nødvendig — dere har allerede «WordPress Infosak Batch Administrator» som leser `.docx`-manusene appen genererer
