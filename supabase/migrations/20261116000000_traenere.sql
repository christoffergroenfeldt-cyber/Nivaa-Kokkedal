-- Trænere og øvelsesbank (16. nov 2026). Kør i SQL Editor efter init-migrationen.
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
