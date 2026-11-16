-- HØBK (Hørsholm Badminton Klub) i samme Supabase-projekt som NKB: egne tabeller i schema "hoebk" (16. nov 2026).
-- Samme tabeller som NKB (init + trænere) plus Conventus-kopien. Serverfunktionen "hoebk" (supabase/functions/hoebk/) bruger kun dette schema.
-- Schemaet er IKKE udstillet i Supabase' REST-API, og RLS er slået til uden regler: kun Edge Function'en kan læse og skrive.
create schema if not exists hoebk;
revoke all on schema hoebk from public, anon, authenticated;
set search_path to hoebk;

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


create table if not exists traenere (
  rid bigserial primary key,
  email text default '', navn text default '', grupper text default '', udnaevnt_af text default '', tidspunkt timestamptz
);
create table if not exists oevelser (
  rid bigserial primary key,
  id text default '', oprettet timestamptz, titel text default '', niveauer text default '', fokus text default '',
  spillere text default '', varighed text default '', opstilling text default '', beskrivelse text default '',
  variationer text default '', link text default '', af text default '', email text default '', slettet boolean, opdateret timestamptz
);
alter table traenere enable row level security;
alter table oevelser enable row level security;

create table if not exists conventus (
  rid bigserial primary key,
  conventus_id text default '', navn text default '', grupper text default '', leder_af text default '', hentet timestamptz
);
create table if not exists conventus_grupper (
  rid bigserial primary key,
  gruppe_id text default '', titel text default '', type text default '', aktivitet text default '', aktiv text default '',
  periode_fra text default '', periode_til text default '', pris text default '', medlemmer integer, ledere integer, hentet timestamptz,
  afdeling text default '', traeningshold text default ''
);
alter table conventus enable row level security;
alter table conventus_grupper enable row level security;
reset search_path;

-- Billeder til HØBK-nyheder (gamle billeder ligger stadig i Google Drive og vises derfra)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hoebk-nyhedsbilleder', 'hoebk-nyhedsbilleder', true, 3000000, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
