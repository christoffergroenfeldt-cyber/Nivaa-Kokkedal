-- Invitationer til appen (17. nov 2026, kun klubber med Conventus — i dag HØBK).
-- Conventus-kopien får medlemmets e-mail (bruges kun på serveren: kobling til appens brugere og invitationer — sendes aldrig til appen).
-- "invitationer" er køen: administratoren vælger hold, serveren lægger én række pr. e-mailadresse, og tick sender ca. 30 pr. dag.
alter table hoebk.conventus add column if not exists email text default '';
create table if not exists hoebk.invitationer (
  rid bigserial primary key,
  oprettet timestamptz, email text default '', conventus_ids text default '', navne text default '', hold text default '',
  emne text default '', tekst text default '', status text default '', sendt timestamptz, fejl text default '', af text default ''
);
alter table hoebk.invitationer enable row level security;
