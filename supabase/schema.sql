-- UAS Norway Saksbank — databaseskjema
-- Kjør denne i Supabase: Project → SQL Editor → New query → lim inn → Run

-- ── Saker ──────────────────────────────────────────────────────────
create table if not exists cases (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  sakstype text not null default 'redaksjonell',        -- redaksjonell (vises: "Dronemagasin") | content (vises: "INFO") | ai (vises: "Kommentar")
  hastegrad text not null default 'planlagt',            -- akutt | planlagt | tidlos
  status text not null default 'ide',                    -- ide | godkjent | i-arbeid | utkast-klart | wp-utkast | publisert | arkivert | avvist
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
-- Om denne linjen feiler ("already member"), er det allerede aktivert — helt greit.
alter publication supabase_realtime add table cases;

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
