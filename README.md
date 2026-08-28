# UAS Norway — Saksbank

Delt redaksjonell saksbank med automatisk RSS-innhenting, AI-drevet triage/kildekontroll/manus, og WordPress-publisering. Statisk frontend (ingen build-steg) + Netlify-funksjoner + Supabase som delt database og innlogging.

**Arbeidsflyt:** Idé → Godkjente idéer → I arbeid (manus genereres/redigeres/AI-revideres her) → WP-utkast opprettet (ekte WordPress-utkast) → Publisert (STOPP-kontroll). Relevans- og kildekontroll skjer automatisk FØR en RSS-sak i det hele tatt blir en idé; AI-vurdering kjøres automatisk ved innhenting; saker eldre enn 2 måneder arkiveres automatisk. Se Steg 9-15 under for detaljene.

**Fortsatt ikke koblet på:** Mailchimp-sending, Doffin, automatisk eventkalender-synk (events.uasnorway.no har intet åpent API — se `events`-tabellen), omtaleovervåkning.

**⚠️ Husk etter hver oppdatering:** kjør hele `supabase/schema.sql` på nytt i Supabase sin SQL Editor (Project → SQL Editor → lim inn hele filen → Run). Den er skrevet for å alltid være trygg å kjøre i sin helhet på nytt — den legger kun til det som mangler, sletter eller endrer aldri eksisterende data. Nyeste versjoner er v5 (forenklet statusflyt, `kilde_publisert_dato`) og v6 (research-felt på manus: emnefelt, tidligere dekning, kilder brukt, kontrollpunkter).

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

## Steg 12 — Publiser til WordPress (utkast) — begge nettsteder

Porter fra det allerede eksisterende «WordPress Infosak Batch Administrator»-verktøyet (samme ACF-felt for uasnorway.no, samme «kun utkast»-prinsipp) — se `netlify/functions/lib/wordpress.js` for hvor koblingen kommer fra. Støtter **begge** nettstedene deres — appen ser på saken sitt eget «Nettsted»-felt (dronemag.no/uasnorway.no) og velger riktig WordPress-installasjon automatisk. Du trenger bare sette opp nøklene for det nettstedet du faktisk skal teste/bruke først.

1. I WordPress **for hvert nettsted** (uasnorway.no og/eller dronemag.no, hver har sin egen wp-admin): **Brukere → Din profil → Application Passwords** → opprett en ny, gjerne kalt noe som «UAS Saksbank» (egen, separat fra det wordpress-infosak allerede bruker).
2. Legg til miljøvariablene i Netlify (kun settet for nettstedet/-ene dere setter opp nå):

   | Nettsted | Nøkler |
   |---|---|
   | uasnorway.no | `WP_UASNORWAY_URL` (`https://www.uasnorway.no`), `WP_UASNORWAY_USERNAME`, `WP_UASNORWAY_APP_PASSWORD` |
   | dronemag.no | `WP_DRONEMAG_URL` (`https://www.dronemag.no`), `WP_DRONEMAG_USERNAME`, `WP_DRONEMAG_APP_PASSWORD` |

   → trigger ny deploy etterpå.
3. Kjør `supabase/schema.sql` på nytt i Supabase (v3-delen nederst legger til strukturerte manusfelt + WP-kobling på `cases` — idempotent, som resten av filen).
4. Åpne en sak med generert manus → **«🌐 Publiser til WordPress (utkast)»**. Mangler saken tittel, ingress, hovedtekst eller bilde, stoppes den FØR noe sendes til WordPress, med en tydelig feilmelding om nøyaktig hva som mangler. Samme handling finnes som batch i verktøylinjen for valgte saker.

### Om dronemag.no bruker egendefinerte visningsfelt (ukjent ennå)

uasnorway.no bruker Advanced Custom Fields (ACF) for selve visningen — det er *bekreftet*, feltnøklene ligger hardkodet i `lib/wordpress.js`. Om dronemag.no gjør det samme er **ikke bekreftet**, og jeg har bevisst ikke gjettet på feltnavn. Inntil videre opprettes dronemag.no-utkast med kun WordPress sine standardfelt (tittel/innhold/ingress/hovedbilde) — trygt, men saken vises kanskje ikke helt likt som en manuelt lagt inn sak om temaet faktisk bruker egendefinerte felt der.

Slik sjekker dere det:
1. Åpne et eksisterende innlegg i dronemag.no sin wp-admin
2. Høyreklikk på hvert visningsfelt (Bilde, Bildetekst, Foto, Byline, Ingress, Innhold) → **«Inspiser»** i nettleseren
3. Se etter `data-name`-attributtet på elementet (samme fremgangsmåte som ble brukt for å finne uasnorway.no sine feltnavn)
4. Finner dere egendefinerte felt: fyll inn de seks `WP_DRONEMAG_ACF_*`-miljøvariablene i `.env.example` med riktige feltnøkler → trigger ny deploy. Finner dere ingen: ikke gjør noe, standardfeltene fungerer fint som de er.

**Ufravikelig grense, samme som ellers i appen:** oppretter alltid status `draft` i WordPress — aldri `publish`, uansett hvilket av de to nettstedene. Selve publiseringen skjer fortsatt manuelt, enten direkte i WordPress eller i Oversikt-fanen i wordpress-infosak-verktøyet, med et menneske som faktisk har lest gjennom saken. Dette er en egen, separat kontroll fra saksbankens interne STOPP-regel for status «Publisert» — de erstatter ikke hverandre.

## Steg 13 — Kildevurdering og bilderesearch (på forespørsel, per sak)

To nye knapper inne på hver sak, bygget etter to detaljerte redaksjonelle spesifikasjoner dere ga: **🔍 Kjør kildevurdering** og **🖼️ Finn bilder**. Begge bruker `gpt-5-search-api` (et søkekapabelt OpenAI-verktøy) til å faktisk gjøre research, ikke bare gjette — kjøres på forespørsel per sak (samme avveining som AI-vurdering/manusgenerering: et websøk-kall tar litt tid og har en kostnad, så det skjer ikke automatisk på alle 100+ idéer).

Ingen ny miljøvariabel — bruker samme `OPENAI_API_KEY` som resten. Kjør `supabase/schema.sql` på nytt (v4-delen legger til `kildevurdering`/`bildeforslag`-feltene på `cases`, idempotent som resten av filen).

**🔍 Kildevurdering** (`lib/sourceCheck.js`) — undersøker hvem som faktisk står bak saken (utgiver vs. originalkilde), finner originalkilden med direkte lenke, sjekker om saken egentlig er en gammel hendelse som fremstår som ny, gir en troverdighetsscore 1–5 for avsenderen, og lister røde flagg (manglende originalkilde, produktpåstander kun fra leverandør, flere nettsteder som bare kopierer samme svake kilde, osv.). Ender i en tydelig redaksjonell anbefaling: ✅ Trygg / 🟡 Bør verifiseres / 🟠 Kun tips / 🔴 Bør ikke brukes.

**🖼️ Finn bilder** (`lib/imageResearch.js`) — foreslår 3–6 bildealternativer i prioritert rekkefølge (originalkildens eget pressemateriale først, så offisielle mediebanker, så andre produsent-pressebilder, så åpne lisenser sist) med full rettighetskontroll per bilde (kategori 🟢A/🟢B dokumentert brukbart, 🟡C uklare vilkår, 🟠D/🔴E ikke bruksklart) og en tydelig advarsel om at andre nyhetsmedier (NRK, VG, BBC, Reuters …) aldri regnes som et fritt bildebibliotek — bare som spor til den egentlige rettighetshaveren.

**Viktig, ikke bare kosmetisk:** under testing viste det seg at selv et godt søkekapabelt AI-verktøy kan dikte opp en spesifikk bilde-URL som ser ekte ut, mens siden den fant bildet på er ekte. Derfor stoler ingen av knappene på AI-ens egen påstand om at en lenke fungerer eller at et bilde er tilgjengelig — **appen selv sjekker hver oppgitte lenke med en ekte HTTP-forespørsel** (`lib/linkCheck.js`) før noe vises som bekreftet. For bilder: feiler den oppgitte bildelenken den ekte sjekken, forsøker appen automatisk å hente et bilde fra kildesiden i stedet (samme `og:image`-teknikk som manusgenereringen allerede bruker); lykkes ikke det heller, vises alternativet fortsatt (skjules aldri stille — det kan være et nyttig forskningsspor), men tydelig merket «BRUKSRETT/BILDE IKKE VERIFISERT» i stedet for å late som det er klart til bruk.

Begge er også tilgjengelige som verktøy for AI-assistenten (`check_source`/`research_images` i Steg 11) — spør den «kjør kildevurdering på saken om …» eller «finn bilder til saken om …».

## Steg 14 — Automatisk kildekontroll FØR en RSS-idé i det hele tatt vises

Utover knappen i Steg 13 (som du selv trykker på), kjører appen nå kildevurderingen **automatisk** på alle nye RSS-oppdagede idéer — og fjerner dem helt fra «Idé» dersom AI-kontrollen konkluderer med «🔴 Bør ikke brukes», akkurat som relevansfilteret (Steg 10) allerede fjerner ikke-dronerelevante saker før de blir en idé. Tanken er den samme: dere skal aldri måtte bruke tid på å vurdere en sak som allerede er avklart som lite troverdig.

Ingen ny miljøvariabel og ingen ny knapp å trykke på — dette kjører av seg selv, forutsatt at `OPENAI_API_KEY` allerede er satt (Steg 9).

**Hvorfor to nye funksjoner, ikke bare lagt inn i RSS-pollingen (Steg 6/7)?** Netlifys vanlige "scheduled functions" (som RSS-pollingen bruker) har en hard grense på 30 sekunder — og et eneste ekte websøk-kall for kildevurdering tar normalt 15–30 sekunder alene. Det ville vært for tregt/skjørt å gjøre inni selve RSS-pollingen, spesielt med flere nye idéer i samme kjøring. Løsningen er den samme to-funksjons-arkitekturen Netlify selv anbefaler for denne typen jobb:

- `source-gate-trigger.js` — en vanlig, rask scheduled function (kjører hver time, akkurat som RSS-pollingen) som bare sender ett HTTP-kall videre og returnerer umiddelbart.
- `source-gate-background.js` — en **Background Function** (kjenner du igjen på "-background" i filnavnet) med opptil 15 minutters kjøretid, som gjør selve arbeidet: henter nye "Idé"-saker som kom inn via RSS og ikke er kildevurdert ennå (maks 15 om gangen — flere tas neste time), kjører kildevurdering på dem parallelt, og sletter dem som får «Bør ikke brukes».

**Viktig om timing:** Netlify garanterer ingen kjørerekkefølge mellom to uavhengige timelige funksjoner, så en splitter ny idé kan i verste fall vente til NESTE times kjøring før den blir kildekontrollert — regn med kildekontroll innen 1–2 timer etter at en RSS-idé dukker opp, ikke nødvendigvis med det samme. Saker et menneske selv har lagt inn manuelt (ikke via RSS), eller allerede har flyttet videre fra «Idé», røres aldri av denne automatikken.

Idéer som blir liggende (fordi de får en mer usikker anbefaling enn «Bør ikke brukes» — «Kun tips», «Bør verifiseres» eller «Trygg») viser den fulle kildevurderingsrapporten inne på saken, akkurat som om du hadde trykket knappen selv (Steg 13) — dere slipper bare å trykke på den for RSS-saker.

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
│   ├── publish-to-wordpress.js Oppretter WordPress-UTKAST fra en sak sitt manus
│   ├── check-source.js         Kildevurdering (troverdighet, originalkilde, lenkekontroll)
│   ├── research-images.js      Bilderesearch (rettighetsavklarte bildealternativer)
│   ├── source-gate-trigger.js  Rask scheduled function — utløser kildekontroll-pass hver time
│   ├── source-gate-background.js  Background function — kjører faktisk kildekontroll på nye RSS-idéer
│   └── lib/
│       ├── relevance.js        Delt AI-relevanssjekk (rss-poll + cleanup)
│       ├── triage.js           Delt AI-vurderingslogikk (ai-triage + assistant-chat)
│       ├── manuscript.js       Delt manusgenerering (generate-manuscript + assistant-chat)
│       ├── wordpress.js        WordPress REST API-klient (portert fra wordpress-infosak)
│       ├── sourceCheck.js      Delt kildevurdering (check-source + assistant-chat + sourceGate)
│       ├── sourceGate.js       Automatisk kildekontroll-fjerning av nye RSS-idéer
│       ├── imageResearch.js    Delt bilderesearch (research-images + assistant-chat)
│       └── linkCheck.js        Ekte HTTP-verifisering av lenker (brukt av begge over)
├── supabase/schema.sql        Databasetabeller + tilgangsregler (v1–v4)
├── netlify.toml                Netlify-konfig (publish-mappe, funksjonsmappe)
└── .env.example                Mal for lokale miljøvariabler
```

## Neste steg (krever tilganger jeg ikke har ennå)

- **Mailchimp:** API-nøkkel, for å bygge nyhetsbrevutkastet direkte i Mailchimp i stedet for kopier/lim
- **Doffin, omtaleovervåkning:** egne pollefunksjoner, samme arkitektur som RSS
- **Automatisk eventkalender-synk:** krever enten et API fra events.uasnorway.no (finnes ikke i dag) eller at noen der åpner for det — inntil videre vedlikeholdes `events`-tabellen manuelt
