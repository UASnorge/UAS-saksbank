# UAS Norway — Saksbank

Delt redaksjonell saksbank med automatisk RSS-innhenting. Statisk frontend (ingen build-steg) + Netlify-funksjon som poller RSS-kilder + Supabase som delt database og innlogging.

**Testet i denne omgang:** RSS-parsing er verifisert til å fungere mot en ekte feed (se `netlify/functions/rss-poll.js`). Databasekobling, innlogging og selve Netlify-driften er ikke testet live ennå, siden det krever et Supabase- og Netlify-prosjekt som ikke finnes fra før.

**Fortsatt ikke koblet på:** WordPress-utkast, Mailchimp-sending, AI-triage, Doffin, eventkalender, omtaleovervåkning. Se banneret "Om piloten" i selve verktøyet for full status.

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
- `SUPABASE_SERVICE_ROLE_KEY` → `service_role`-nøkkelen fra steg 2 (ikke `anon`-nøkkelen her!)

Deploy siden på nytt etter at variablene er lagt til (**Deploys → Trigger deploy**).

## Steg 6 — Legg til RSS-kildene dere faktisk vil overvåke

I Supabase: **Table Editor → sources**. Slett eksempelraden (NRK) og legg inn egne rader med `name` og `feed_url`. Noen typiske kandidater å sjekke om finnes som RSS (bekreft URL og lisensvilkår selv før dere legger dem inn — jeg har kun verifisert at NRK-eksempelet fungerer, ikke disse):

- Luftfartstilsynet sine nyheter/pressemeldinger
- Avinor sine pressemeldinger
- EASA (europeisk luftfartsmyndighet)
- Relevante internasjonale dronenettsteder dere allerede følger manuelt

`rss-poll.js` henter automatisk **alle rader der `active = true`**, hver time.

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

---

## Prosjektstruktur

```
uas-saksbank/
├── public/index.html          Hele frontend — kanban, liste, saksskjema, STOPP-gate
├── netlify/functions/
│   └── rss-poll.js            Kjører hver time, henter RSS → nye saker i "Idé"
├── supabase/schema.sql        Databasetabeller + tilgangsregler
├── netlify.toml                Netlify-konfig (publish-mappe, funksjonsmappe)
└── .env.example                Mal for lokale miljøvariabler
```

## Neste steg (krever tilganger jeg ikke har ennå)

- **WordPress:** REST API-tilgang + testmiljø, for å faktisk sende utkast (ikke bare statusetikett)
- **Mailchimp:** API-nøkkel, for å bygge nyhetsbrevutkastet direkte i Mailchimp i stedet for kopier/lim
- **Claude API-nøkkel:** for AI-genererte triage-forslag og førsteutkast — kan legges til som en egen Netlify-funksjon etter samme mønster som `rss-poll.js`
- **Doffin, eventkalender, omtaleovervåkning:** egne pollefunksjoner, samme arkitektur som RSS
