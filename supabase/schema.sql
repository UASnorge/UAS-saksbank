-- UAS Norway Saksbank — databaseskjema
-- Kjør denne i Supabase: Project → SQL Editor → New query → lim inn → Run

-- ── Saker ──────────────────────────────────────────────────────────
create table if not exists cases (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  sakstype text not null default 'redaksjonell',        -- redaksjonell (vises: "Dronemagasin") | content (vises: "INFO") | ai (vises: "Kommentar")
  hastegrad text not null default 'planlagt',            -- akutt | planlagt | tidlos
  status text not null default 'ide',                    -- ide | godkjent | i-arbeid | wp-utkast | publisert | arkivert | avvist
  eier text default 'Ikke tildelt',
  frist date,
  neste_handling text default '',
  kilder jsonb not null default '[]'::jsonb,
  kategori text default '',
  malgruppe text default 'Ikke satt',
  nettsted text not null default 'dronemag.no',
  triage jsonb not null default '{"aktualitet":3,"betydning":3,"innsats":3,"eksklusivitet":3}'::jsonb,
  stopp_godkjent boolean not null default false,
  publisert_av text default '',
  nyhetsbrev_inkludert boolean not null default false,
  historikk jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cases_status_idx on cases (status);

-- Hold updated_at fersk automatisk
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists cases_set_updated_at on cases;
create trigger cases_set_updated_at
  before update on cases
  for each row execute function set_updated_at();

-- ── RSS-kilder som skal overvåkes ─────────────────────────────────
create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  feed_url text not null unique,
  active boolean not null default true,
  last_polled_at timestamptz,
  created_at timestamptz not null default now()
);

-- Eksempelkilde — kun for å bevise at rørledningen fungerer end-to-end.
-- Dette er IKKE en dronerelevant kilde. Bytt ut/slett den og legg inn de
-- RSS-kildene dere faktisk vil overvåke, via Table Editor i Supabase.
-- Bekreft alltid at RSS-tilbudet faktisk finnes og er lisensmessig OK å bruke
-- før dere legger det til her (se README, avsnittet "Legg til RSS-kilder").
insert into sources (name, feed_url) values
  ('Eksempel: NRK toppsaker (bytt ut meg)', 'https://www.nrk.no/toppsaker.rss')
on conflict (feed_url) do nothing;

-- ── Dedup-sporing for RSS-pollingen ────────────────────────────────
create table if not exists seen_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete cascade,
  guid text not null,
  seen_at timestamptz not null default now(),
  unique (source_id, guid)
);

-- ── Row Level Security ─────────────────────────────────────────────
-- Frontend bruker anon-nøkkelen og er underlagt disse reglene.
-- netlify/functions bruker service_role-nøkkelen og omgår RLS helt (kun server-side).

alter table cases enable row level security;
alter table sources enable row level security;
alter table seen_items enable row level security;

drop policy if exists "innloggede kan lese saker" on cases;
create policy "innloggede kan lese saker" on cases
  for select using (auth.role() = 'authenticated');

drop policy if exists "innloggede kan opprette saker" on cases;
create policy "innloggede kan opprette saker" on cases
  for insert with check (auth.role() = 'authenticated');

drop policy if exists "innloggede kan oppdatere saker" on cases;
create policy "innloggede kan oppdatere saker" on cases
  for update using (auth.role() = 'authenticated');

drop policy if exists "innloggede kan slette saker" on cases;
create policy "innloggede kan slette saker" on cases
  for delete using (auth.role() = 'authenticated');

drop policy if exists "innloggede kan lese kilder" on sources;
create policy "innloggede kan lese kilder" on sources
  for select using (auth.role() = 'authenticated');

drop policy if exists "innloggede kan legge til kilder" on sources;
create policy "innloggede kan legge til kilder" on sources
  for insert with check (auth.role() = 'authenticated');

drop policy if exists "innloggede kan oppdatere kilder" on sources;
create policy "innloggede kan oppdatere kilder" on sources
  for update using (auth.role() = 'authenticated');

drop policy if exists "innloggede kan slette kilder" on sources;
create policy "innloggede kan slette kilder" on sources
  for delete using (auth.role() = 'authenticated');

-- Merk: "seen_items" har fortsatt ingen policy for innloggede brukere — det er
-- med vilje, kun rss-poll.js (service_role) skal skrive dit.

-- ── Sanntid ─────────────────────────────────────────────────────────
-- Gjør at teamet ser hverandres endringer live uten å måtte laste siden på nytt.
-- Sjekk manuelt om "cases" allerede er medlem — "ALTER PUBLICATION ... ADD TABLE"
-- har ingen "IF NOT EXISTS", og siden hele skriptet kjøres som én transaksjon i
-- Supabase sin SQL Editor, ville en feil her rullet tilbake ALT annet i skriptet.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cases'
  ) then
    alter publication supabase_realtime add table cases;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════
-- v2 — AI-vurdering, eventkobling og generert manus
-- Trygt å kjøre denne på nytt / på en database som allerede har v1 —
-- alt under bruker "if not exists" og rører ikke eksisterende data.
-- ═══════════════════════════════════════════════════════════════════

alter table cases add column if not exists oppsummering text default '';
alter table cases add column if not exists manus_url text default '';
alter table cases add column if not exists manus_generert_ts timestamptz;
alter table cases add column if not exists event_id uuid;

-- ── Eventkalender (manuelt vedlikeholdt speil av events.uasnorway.no) ──
-- events.uasnorway.no er en Next.js-app uten åpent API og blokkerer vanlig
-- server-henting (403), så AI-vurderingen kan ikke lese kalenderen live.
-- Oppdater denne tabellen manuelt via Table Editor når kalenderen endres.
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  event_type text not null default 'other', -- conference | course | webinar | exercise
  location text default '',
  starts_on date,
  duration_days int default 1,
  url text default '',
  created_at timestamptz not null default now(),
  unique (title, starts_on)
);

-- Postgres har ingen "ADD CONSTRAINT IF NOT EXISTS" — sjekk manuelt for å
-- kunne kjøre dette skriptet flere ganger uten feil.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cases_event_id_fkey'
  ) then
    alter table cases
      add constraint cases_event_id_fkey foreign key (event_id) references events(id) on delete set null;
  end if;
end $$;

insert into events (title, event_type, location, starts_on, duration_days, url) values
  ('Drone for nybegynnere', 'webinar', 'Online', '2026-09-14', 1, 'https://events.uasnorway.no/events/Drone-for-nybegynnere'),
  ('Spesifikk kategori og SORA 2.5', 'webinar', 'Online', '2026-09-24', 1, 'https://events.uasnorway.no/events/spesifikk-kategori-og-sora-2-5'),
  ('LiDAR & Fotogrammetri', 'course', 'Grimstad', '2026-10-06', 2, 'https://events.uasnorway.no/events'),
  ('Dronekurs for offentlig sektor', 'conference', 'Kristiansand', '2026-10-13', 3, 'https://events.uasnorway.no/events'),
  ('Nordic Energy Summit', 'conference', 'Malmö, Sverige', '2026-10-28', 2, 'https://events.uasnorway.no/events'),
  ('Dronekurs for brann & redning', 'course', 'Kristiansand brannstasjon', '2026-11-11', 2, 'https://events.uasnorway.no/events'),
  ('Security Summit 2027', 'conference', 'Malmö, Sverige', '2027-01-27', 2, 'https://events.uasnorway.no/events'),
  ('UNC 2027', 'conference', 'Microsoft, Oslo', '2027-02-16', 2, 'https://events.uasnorway.no/events')
on conflict (title, starts_on) do nothing;

alter table events enable row level security;
drop policy if exists "innloggede kan lese events" on events;
create policy "innloggede kan lese events" on events
  for select using (auth.role() = 'authenticated');
drop policy if exists "innloggede kan administrere events" on events;
create policy "innloggede kan administrere events" on events
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ── Lagring for genererte manus (.docx i UAS Norways malformat) ────────
insert into storage.buckets (id, name, public)
  values ('manus', 'manus', false)
  on conflict (id) do nothing;

drop policy if exists "innloggede kan lese manus" on storage.objects;
create policy "innloggede kan lese manus" on storage.objects
  for select using (bucket_id = 'manus' and auth.role() = 'authenticated');

drop policy if exists "innloggede kan laste opp manus" on storage.objects;
create policy "innloggede kan laste opp manus" on storage.objects
  for insert with check (bucket_id = 'manus' and auth.role() = 'authenticated');

drop policy if exists "innloggede kan oppdatere manus" on storage.objects;
create policy "innloggede kan oppdatere manus" on storage.objects
  for update using (bucket_id = 'manus' and auth.role() = 'authenticated');

drop policy if exists "innloggede kan slette manus" on storage.objects;
create policy "innloggede kan slette manus" on storage.objects
  for delete using (bucket_id = 'manus' and auth.role() = 'authenticated');

-- ═══════════════════════════════════════════════════════════════════
-- v3 — Strukturerte manusfelt (for WordPress-utkast) + WP-kobling
-- ═══════════════════════════════════════════════════════════════════

-- Samme innhold som .docx-manuset, men som strukturerte felt — slik at
-- "Publiser til WordPress" ikke trenger å parse .docx-filen på nytt, og slik
-- at manglende felt kan sjekkes FØR noe sendes til WordPress.
alter table cases add column if not exists manus_tittel text default '';
alter table cases add column if not exists manus_ingress text default '';
alter table cases add column if not exists manus_hovedtekst jsonb default '[]'::jsonb;
alter table cases add column if not exists manus_alt_tekst text default '';
alter table cases add column if not exists manus_bilde_url text default '';
alter table cases add column if not exists manus_foto text default '';

-- Kobling til det opprettede WordPress-utkastet.
alter table cases add column if not exists wp_post_id integer;
alter table cases add column if not exists wp_edit_link text default '';
alter table cases add column if not exists wp_status text default '';

-- ═══════════════════════════════════════════════════════════════════
-- v4 — Kildevurdering ("kildekontrollør") + bilderesearch, på forespørsel
-- ═══════════════════════════════════════════════════════════════════

-- Fullt strukturert resultat fra netlify/functions/lib/sourceCheck.js —
-- inkluderer AI-ens kildekontroll OG serverens egne, faktiske HTTP-sjekker av
-- hver oppgitte lenke (lenke_verifisering). Se den filen for feltbetydning.
alter table cases add column if not exists kildevurdering jsonb;
alter table cases add column if not exists kildevurdering_ts timestamptz;

-- Fullt strukturert resultat fra netlify/functions/lib/imageResearch.js —
-- hvert alternativ har et "verifisering"-underobjekt som viser om den
-- foreslåtte bildelenken faktisk ble bekreftet med en ekte HTTP-forespørsel
-- (eller hentet automatisk fra kildesiden som fallback), aldri kun antatt.
alter table cases add column if not exists bildeforslag jsonb;
alter table cases add column if not exists bildeforslag_ts timestamptz;

-- ═══════════════════════════════════════════════════════════════════
-- v5 — Forenklet statusflyt, kilde-publiseringsdato, AI-notat på manus
-- ═══════════════════════════════════════════════════════════════════

-- "utkast-klart" er fjernet som eget steg — manus genereres og redigeres nå
-- direkte i "i-arbeid", og "wp-utkast" nås kun via selve
-- WordPress-publiseringen (se blockedStatusChangeReason i public/index.html
-- og move_case_status i assistant-chat.js). Flytt eksisterende saker i det
-- gamle steget over til "i-arbeid" — kjøres trygt flere ganger, treffer 0
-- rader etter første kjøring.
update cases set status = 'i-arbeid' where status = 'utkast-klart';

-- Datoen SAKEN opprinnelig ble publisert HOS KILDEN (fra RSS-feedens egen
-- pubDate/isoDate, ikke tidspunktet saken kom inn i saksbanken) — brukes til
-- å (a) aldri hente inn saker som allerede er eldre enn to måneder, (b)
-- automatisk arkivere "Idé"-saker som blir stående og blir eldre enn to
-- måneder, og (c) gruppere "Idé"-kolonnen på måned. Kan være null (manuelt
-- lagt inn tips, eller en RSS-feed uten publiseringsdato på elementet).
alter table cases add column if not exists kilde_publisert_dato timestamptz;

-- Fritekstnotat redaksjonen kan skrive til AI-en når de reviderer et manus
-- direkte i verktøyet (f.eks. "gjør saken lenger", "ta bilde herifra") — se
-- netlify/functions/lib/reviseManuscript.js. Selve notatet lagres IKKE i
-- historikken (det er en instruks, ikke en hendelse), kun siste verdi.
alter table cases add column if not exists manus_ai_notat text default '';

-- ═══════════════════════════════════════════════════════════════════
-- v6 — Manus som faktisk redaksjonelt arbeid, ikke bare omskriving
-- ═══════════════════════════════════════════════════════════════════
-- Etter tilbakemelding om at førsteutkastet kun omskrev én artikkel:
-- generateManuscript (lib/manuscript.js) gjør nå ekte research
-- (gpt-5-search-api) — finner og navngir kilden korrekt, søker etter
-- primærkilder, søker Dronemagasinets eget arkiv etter tidligere dekning,
-- og sjekker om nyere kilder oppdaterer/motsier fakta i kildeartikkelen.
-- manus_hovedtekst (fra v3) beholder samme datatype (jsonb-liste med
-- avsnitt-strenger) for å unngå en brytende migrering — mellomtitler
-- markeres med et innledende "## ", sitatblokker med "> ", begge tolket av
-- både lib/manuscript.js (docx) og lib/wordpress.js (HTML ved publisering).

-- 1-3 korte emneord/kategori-tagger, f.eks. ["FORSVAR", "C-UAS"].
alter table cases add column if not exists manus_emnefelt jsonb default '[]'::jsonb;

-- To alternative titler ved siden av manus_tittel (som er den anbefalte).
alter table cases add column if not exists manus_titler_alternativer jsonb default '[]'::jsonb;

-- Egen tidligere dekning (Dronemagasinet/UAS Norway) som faktisk ble funnet
-- OG verifisert (ekte HTTP-sjekk) — {tittel, url} — eller null om ingen
-- relevant tidligere sak ble funnet. Vises som en egen "TIDLIGERE DEKNING"-
-- boks i manuset.
alter table cases add column if not exists manus_tidligere_dekning jsonb;

-- ALLE kilder faktisk brukt i researchen — {navn, tittel, url} — hver URL
-- verifisert med en ekte HTTP-forespørsel før den regnes med. Vises som en
-- klikkbar kildeliste bakerst i utkastet, IKKE sendt til WordPress.
alter table cases add column if not exists manus_kilder_brukt jsonb default '[]'::jsonb;

-- Redaksjonell kontrollsjekkliste — konkrete, saksspesifikke åpne spørsmål
-- AI-en selv identifiserte (aldri late som noe er avklart når det ikke er
-- det). Vises som en tydelig merket "INTERNT — FJERNES FØR PUBLISERING"-
-- seksjon, IKKE sendt til WordPress.
alter table cases add column if not exists manus_kontrollpunkter jsonb default '[]'::jsonb;

-- Sant hvis hovedbildet er et generisk/produsent-illustrasjonsfoto som IKKE
-- er bekreftet å vise den faktiske, konkrete situasjonen saken omtaler.
alter table cases add column if not exists manus_bilde_er_illustrasjon boolean default false;

-- ═══════════════════════════════════════════════════════════════════
-- v7 — Stikkord/kategori/byline må velges manuelt før WordPress-publisering
-- ═══════════════════════════════════════════════════════════════════
-- Etter tilbakemelding: dette skal ALDRI utledes stille fra andre felt —
-- redaksjonen velger dem selv, per sak, rett før "Publiser til WordPress".

-- WordPress-STIKKORD (tags) — fast liste: "Dronemagasinet" | "INFO" | "Kommentar".
alter table cases add column if not exists wp_stikkord text default '';

-- WordPress-KATEGORI (categories) — fast liste: "INFO" | "Dronemagasinet" | "Aktuelt".
alter table cases add column if not exists wp_kategori text default '';

-- Byline til WordPress-utkastet — fritekst (IKKE en fast liste), men
-- frontend viser tidligere brukte verdier på tvers av alle saker som
-- forslag (HTML <datalist>), slik at man vanligvis kan velge i stedet for
-- å skrive på nytt hver gang.
alter table cases add column if not exists wp_byline text default '';

-- ═══════════════════════════════════════════════════════════════════
-- v8 — Kategori: kan velge FLERE, ikke bare én
-- ═══════════════════════════════════════════════════════════════════
-- wp_kategori var opprinnelig én enkelt tekststreng — gjøres om til en
-- jsonb-liste (samme mønster som manus_emnefelt/manus_kilder_brukt), siden
-- en sak kan tilhøre flere WordPress-kategorier samtidig. Migreringen kjøres
-- KUN når kolonnen faktisk fortsatt er tekst (ikke idempotent i seg selv —
-- wrappet i en betinget sjekk, samme mønster som andre ikke-additive
-- endringer lenger opp i denne filen), slik at hele filen fortsatt trygt kan
-- kjøres på nytt.
do $$
begin
  if (select data_type from information_schema.columns where table_name = 'cases' and column_name = 'wp_kategori') = 'text' then
    alter table cases alter column wp_kategori drop default;
    alter table cases alter column wp_kategori type jsonb using (
      case when wp_kategori is null or wp_kategori = '' then '[]'::jsonb
           else jsonb_build_array(wp_kategori) end
    );
    alter table cases alter column wp_kategori set default '[]'::jsonb;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════
-- v9 — Kun @uasnorway.no kan logge inn (Auth Hook: "Before user created")
-- ═══════════════════════════════════════════════════════════════════
-- Funksjonen selv gjør ingenting før den er koblet inn i Supabase sitt
-- Auth Hook-system (KAN IKKE gjøres via SQL, kun i dashbordet — se README):
-- Authentication → Auth Hooks → "Before user created" → Postgres function →
-- velg public.restrict_signup_by_email_domain → Save.
--
-- Rammer KUN nye brukere (magic link til en e-post som ikke finnes i
-- auth.users fra før) — eksisterende innloggede brukere påvirkes ikke.
-- ALLOWED_DOMAINS under styrer hvilke domener som slipper gjennom; utvid
-- listen direkte i koden under ved behov (f.eks. dronemag.no).
create or replace function public.restrict_signup_by_email_domain(event jsonb)
returns jsonb
language plpgsql
as $$
declare
  allowed_domains text[] := array['uasnorway.no'];
  email text;
  domain text;
begin
  email := lower(coalesce(event->'user'->>'email', ''));
  domain := split_part(email, '@', 2);

  if domain = any(allowed_domains) then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'message', 'Kun e-post fra @uasnorway.no kan logge inn i denne saksbanken.',
      'http_code', 403
    )
  );
end;
$$;

grant execute
  on function public.restrict_signup_by_email_domain
  to supabase_auth_admin;

revoke execute
  on function public.restrict_signup_by_email_domain
  from authenticated, anon, public;

-- ═══════════════════════════════════════════════════════════════════
-- v10 — Generelt websøk: nettsted-kilder uten RSS, søkeord/operatører,
-- dedup for søketreff
-- ═══════════════════════════════════════════════════════════════════
-- "sources" fikk opprinnelig kun RSS-feeder. Et nettsted uten egen RSS-feed
-- (f.eks. aftenposten.no) blir nå IKKE avvist av add-sources.js lenger — det
-- lagres i stedet som type 'website' og overvåkes av det nye websøket
-- (lib/webSearch.js) i stedet for rss-parser.
alter table sources add column if not exists type text not null default 'rss';
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sources_type_check'
  ) then
    alter table sources add constraint sources_type_check check (type in ('rss', 'website'));
  end if;
end $$;

-- Operatør-/selskapsnavn (KUN bedrifter, ikke privatpersoner — håndheves
-- redaksjonelt, ikke teknisk) som websøket aktivt leter etter omtale av,
-- selv i saker som ikke eksplisitt nevner "drone" i teksten.
create table if not exists watch_keywords (
  id uuid primary key default gen_random_uuid(),
  term text not null unique,
  created_at timestamptz not null default now()
);

alter table watch_keywords enable row level security;

drop policy if exists "innloggede kan lese søkeord" on watch_keywords;
create policy "innloggede kan lese søkeord" on watch_keywords
  for select using (auth.role() = 'authenticated');

drop policy if exists "innloggede kan legge til søkeord" on watch_keywords;
create policy "innloggede kan legge til søkeord" on watch_keywords
  for insert with check (auth.role() = 'authenticated');

drop policy if exists "innloggede kan slette søkeord" on watch_keywords;
create policy "innloggede kan slette søkeord" on watch_keywords
  for delete using (auth.role() = 'authenticated');

-- Dedup for websøket — egen fra "seen_items" (som er RSS-spesifikk og bundet
-- til én bestemt kilderad) siden et treff fra det generelle sveipet eller et
-- søkeordtreff ikke nødvendigvis hører til én bestemt "sources"-rad.
create table if not exists seen_urls (
  url text primary key,
  seen_at timestamptz not null default now()
);

-- Ingen policy for innloggede brukere her heller — kun web-search-background.js
-- (service_role) skal skrive hit, samme prinsipp som "seen_items".

-- ═══════════════════════════════════════════════════════════════════
-- v11 — Tema-tagging på idéer (filter/kategorisering)
-- ═══════════════════════════════════════════════════════════════════
-- Satt automatisk av AI-vurderingen (lib/triage.js — kjøres allerede
-- automatisk på RSS-/websøk-oppdagede idéer, og manuelt via "Kjør
-- AI-vurdering"), til bruk i det nye filter-panelet i frontend
-- (public/index.html). Fast sett med verdier (ikke fritekst) — nødvendig
-- for at et avkrysningsfilter faktisk skal gi mening.
alter table cases add column if not exists tema text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cases_tema_check') then
    alter table cases add constraint cases_tema_check check (tema is null or tema in (
      'FORSVAR_BEREDSKAP', 'REGELVERK_LUFTFART', 'TEKNOLOGI_PRODUKT', 'LANDBRUK',
      'INDUSTRI_KARTLEGGING', 'LOGISTIKK_LEVERING', 'SELSKAP_MARKED', 'ULYKKE_HENDELSE',
      'ARRANGEMENT_UTDANNING', 'ANNET'
    ));
  end if;
end $$;
