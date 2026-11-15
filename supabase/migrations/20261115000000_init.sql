-- NKB-appen: database (erstatter Google Sheet'et i HØBK-udgaven).
-- Én tabel pr. fane i det gamle ark — samme kolonner i samme rækkefølge, så funktionen virker som Apps Script-udgaven.
-- rid = rækkenummer (stigende = rækkefølgen rækkerne blev skrevet i).
-- Alle tabeller har RLS slået til UDEN regler: kun Edge Function'en (som logger på databasen direkte) kan læse og skrive.
-- Appen og browseren kan aldrig læse tabellerne med den offentlige nøgle.

create table if not exists tilmeldinger (
  rid bigserial primary key,
  tidspunkt timestamptz, type text default '', event_id text default '', player_id text default '',
  player_name text default '', status text default '', label text default ''
);
create table if not exists spillere (
  rid bigserial primary key,
  player_id text default '', player_name text default '', email text default '',
  bekraeftet timestamptz, sidst_set timestamptz
);
create table if not exists koder (
  rid bigserial primary key,
  tidspunkt timestamptz, email text default '', kode_hash text default '', player_id text default '',
  player_name text default '', forsoeg integer, brugt boolean, boern text default ''
);
create table if not exists sessioner (
  rid bigserial primary key,
  token_hash text default '', player_id text default '', player_name text default '', email text default '',
  oprettet timestamptz, sidst_brugt timestamptz, aktiv boolean
);
create table if not exists ledere (
  rid bigserial primary key,
  email text default '', navn text default '', hold text default ''
);
create table if not exists opstillinger (
  rid bigserial primary key,
  tidspunkt timestamptz, event_id text default '', hold text default '', status text default '',
  gemt_af text default '', data text default ''
);
create table if not exists foelger (
  rid bigserial primary key,
  email text default '', player_id text default '', player_name text default '', turnering_id text default '',
  titel text default '', tidspunkt timestamptz
);
create table if not exists notifikationer (
  rid bigserial primary key,
  tidspunkt timestamptz, email text default '', emne text default '', turneringer text default ''
);
create table if not exists push (
  rid bigserial primary key,
  email text default '', player_id text default '', endpoint text default '', p256dh text default '',
  auth text default '', tidspunkt timestamptz, enhed text default ''
);
create table if not exists indstillinger (
  rid bigserial primary key,
  email text default '', mail boolean
);
create table if not exists beskeder (
  rid bigserial primary key,
  id text default '', tidspunkt timestamptz, rum text default '', player_id text default '',
  player_name text default '', email text default '', tekst text default '', slettet boolean
);
create table if not exists nyheder (
  rid bigserial primary key,
  id text default '', tidspunkt timestamptz, titel text default '', tekst text default '', til text default '',
  af text default '', slettet boolean, billede text default ''
);
create table if not exists grupper (
  rid bigserial primary key,
  email text default '', player_id text default '', grupper text default ''
);
create table if not exists lydloes (
  rid bigserial primary key,
  email text default '', rum text default ''
);
create table if not exists foraeldre (
  rid bigserial primary key,
  email text default '', foraelder_id text default '', foraelder_navn text default '', barn_id text default '',
  barn_navn text default '', tidspunkt timestamptz
);
create table if not exists aktiviteter (
  rid bigserial primary key,
  id text default '', oprettet timestamptz, navn text default '', beskrivelse text default '', start text default '',
  slut text default '', kalender boolean, til text default '', af text default '', slettet boolean,
  opgaver text default '', soeger_hjaelp boolean, link text default ''
);
create table if not exists opgavetilmeldinger (
  rid bigserial primary key,
  tidspunkt timestamptz, aktivitet_id text default '', opgave_id text default '', email text default '',
  player_id text default '', navn text default '', status text default ''
);
create table if not exists administratorer (
  rid bigserial primary key,
  email text default '', navn text default '', udnaevnt_af text default '', tidspunkt timestamptz
);
create table if not exists medlemmer (
  rid bigserial primary key,
  email text default '', navn text default '', medlemsnr text default '', importeret timestamptz
);
create table if not exists godkendelser (
  rid bigserial primary key,
  tidspunkt timestamptz, email text default '', player_id text default '', navn text default '', rolle text default '',
  status text default '', note text default '', behandlet_af text default '', behandlet timestamptz
);
create table if not exists holdmedlemmer (
  rid bigserial primary key,
  player_id text default '', navn text default '', gruppe text default '', tilfoejet_af text default '', tidspunkt timestamptz
);
create table if not exists push_koe (
  rid bigserial primary key,
  tidspunkt timestamptz, endpoint text default '', p256dh text default '', auth text default '',
  titel text default '', tekst text default '', url text default '', tag text default ''
);
create table if not exists koersel (
  rid bigserial primary key,
  tidspunkt timestamptz, begivenhed text default '', titel text default '', player_id text default '', navn text default '',
  email text default '', valg text default '', pladser integer, opsamling text default '', afgang text default '',
  chauffoer text default '', note text default ''
);
create table if not exists feedback (
  rid bigserial primary key,
  id text default '', tidspunkt timestamptz, email text default '', player_id text default '', navn text default '',
  type text default '', tekst text default '', side text default '', enhed text default '', status text default '',
  svar text default '', svaret_af text default '', svaret timestamptz, admin_chat timestamptz
);
-- Scriptegenskaber og cache (PropertiesService/CacheService i Apps Script)
create table if not exists kv (
  key text primary key, value text not null default '', expires timestamptz
);
-- Driftstal pr. 10 minutter (?action=health) og antal sendte mails pr. dag
create table if not exists stats (
  k text primary key, n integer not null default 0, at timestamptz not null default now()
);

create index if not exists beskeder_rum on beskeder (rum);
create index if not exists koder_email on koder (email);
create index if not exists sessioner_token on sessioner (token_hash);
create index if not exists tilmeldinger_event on tilmeldinger (event_id);
create index if not exists koersel_begivenhed on koersel (begivenhed);

do $$
declare t text;
begin
  foreach t in array array['tilmeldinger','spillere','koder','sessioner','ledere','opstillinger','foelger','notifikationer',
    'push','indstillinger','beskeder','nyheder','grupper','lydloes','foraeldre','aktiviteter','opgavetilmeldinger',
    'administratorer','medlemmer','godkendelser','holdmedlemmer','push_koe','koersel','feedback','kv','stats']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- Offentlig mappe til nyhedsbilleder (erstatter Drive-mappen "HØBK nyhedsbilleder")
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('nyhedsbilleder', 'nyhedsbilleder', true, 3000000, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- Til tidsplanen (supabase/cron.sql): kør tick hvert kvarter
create extension if not exists pg_cron;
create extension if not exists pg_net;
