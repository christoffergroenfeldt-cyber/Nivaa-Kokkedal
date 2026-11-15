-- Kør ÉN gang i Supabase → SQL Editor, efter at funktionen "api" er udgivet og REG_KEY er sat.
-- Erstat PROJEKT-ID og DIN_REG_KEY. Starter GitHub-kørslerne (resultater, tilmeldinger, push) hvert kvarter
-- og advarer i admin-chatten, hvis appen rammer en grænse (som tick() i Apps Script-udgaven).
select cron.schedule(
  'nkb-tick',
  '*/15 * * * *',
  $$ select net.http_get(
       url := 'https://PROJEKT-ID.supabase.co/functions/v1/api?action=tick&key=DIN_REG_KEY',
       timeout_milliseconds := 30000) $$
);
-- Tjek:   select * from cron.job;      Stop:   select cron.unschedule('nkb-tick');
