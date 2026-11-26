-- Online-tilmelding i Conventus (26. nov 2026, kun klubber med Conventus — i dag HØBK).
-- Gruppernes status for online-tilmelding gemmes ved hver synkronisering, så appen kan vise "Tilmeld i Conventus" på aktiviteter.
alter table hoebk.conventus_grupper add column if not exists online text default '';
alter table hoebk.conventus_grupper add column if not exists tilmeld_fra text default '';
alter table hoebk.conventus_grupper add column if not exists tilmeld_til text default '';
