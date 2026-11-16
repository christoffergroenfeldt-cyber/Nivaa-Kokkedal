# Server: Supabase (database + Edge Function)

The NKB app is a copy of the HØBK app. HØBK's Google Sheet + Apps Script backend is replaced by:

| HØBK (Google) | NKB (Supabase) |
|---|---|
| Google Sheet, one tab per table | Postgres, one table per tab, same columns (`supabase/migrations/…_init.sql`) |
| Apps Script web app (`…/exec`) | Edge Function `api` (`https://<project>.supabase.co/functions/v1/api`) — same actions, same JSON |
| Script properties `KEY`, `IDEAS_KEY`, `GH_TOKEN` | Edge Function secrets |
| `MailApp` (≈100 mails/day) | Gmail SMTP with an app password (≈400/day) or Resend |
| Drive folder "nyhedsbilleder" | Storage bucket `nyhedsbilleder` (public) |
| Time trigger `tick()` every 15 min | `pg_cron` calls `?action=tick` every 15 min (`supabase/cron.sql`) |
| `LockService` | Postgres advisory lock (one write at a time, waits max 10 s) |

The app (`index.html`) and the GitHub scripts did not change: they call the URL in `config.json` / `REG_URL` exactly as before.
All tables have Row Level Security on with no policies — only the function (which connects to the database directly) can read them. Nothing is readable with the public key.

## Setup (once)

### 1. Supabase project
1. supabase.com → **New project** (region *Central EU (Frankfurt)*). Note the **project ID** (the `xxxx` in `https://xxxx.supabase.co`).
   The free plan allows 2 active projects per organisation.
2. **SQL Editor** → paste all of `supabase/migrations/20261115000000_init.sql` → **Run**. Creates the tables, the image bucket and turns on `pg_cron` + `pg_net`.

### 2. Edge Function
Dashboard: **Edge Functions → Deploy a new function → Via editor**, name it `api`, create the three files `index.ts`, `db.ts`, `mail.ts` with the contents from `supabase/functions/api/`, then in the function's **Details** turn **Verify JWT** *off*.
(Or with the CLI: `supabase functions deploy api --project-ref <id>` — `supabase/config.toml` already turns JWT off.)

### 3. Edge Function secrets
**Edge Functions → Secrets** (see the list below). No redeploy needed after changing a secret.

### 4. Schedule
**SQL Editor** → `supabase/cron.sql` with your project ID and REG_KEY filled in → **Run**.

### 5. App
`config.json`: `registrationUrl` = `https://<id>.supabase.co/functions/v1/api`, `appUrl` = the app's address (e.g. `https://<owner>.github.io/<repo>/`). Commit → login is live.

### 6. Check
- `…/functions/v1/api?action=version` → `"backend":"supabase"`, `scheduler.token: true`, `triggers: 1`.
- `…/functions/v1/api?action=health` → `mailLeft` > 0.
- GitHub → Actions → *Tjek Supabase-funktionen* → run.

## Secrets

### GitHub (repo → Settings → Secrets and variables → Actions)
| Name | Value | Used by |
|---|---|---|
| `REG_URL` | `https://<id>.supabase.co/functions/v1/api` | tilmeldinger, push, holdkampe, live, testnotifikation |
| `REG_KEY` | a long random key — **the same** as the Supabase secret `REG_KEY` | same |
| `VAPID_PRIVATE` | private VAPID key (the public one is in `config.json`) | push, holdkampe, live |
| `BRUGER` | badmintonplayer.dk username (optional — only used if public pages give no data) | holdkampe |
| `BP_PWD` | badmintonplayer.dk password (optional) | holdkampe |

### Supabase (Edge Functions → Secrets)
| Name | Required | Value |
|---|---|---|
| `REG_KEY` | yes | same as GitHub `REG_KEY`. Also salts login codes and sessions — changing it logs everyone out |
| `APP_URL` | yes | the app's address with `/` at the end. Used in push links, mails and to read `data/holdkampe.json` |
| `SMTP_USER` | yes* | the club's Gmail address (2-step verification on) |
| `SMTP_PASS` | yes* | a Gmail **app password** (Google account → Security → App passwords) |
| `GH_TOKEN` | yes | fine-grained GitHub token, only this repo, permission *Actions: Read and write* — starts the workflows |
| `GH_REPO` | yes | `owner/repo` |
| `ADMIN_PLAYER_IDS` | recommended | badmintonplayer.dk player id(s) of the club's fixed administrator(s), comma-separated |
| `ADMIN_EMAIL_SHA256` | optional | fixed administrators by email: `printf '%s' 'name@example.dk' \| sha256sum` |
| `SUPER_ADMIN_SHA256` | optional | head administrator (default: the app's creator, same as in HØBK) |
| `IDEAS_KEY` | optional | read-only key for the admin chat (`?action=ideas&key=…`) |
| `MAIL_DAILY_LIMIT` | optional | max mails per day (default 400 with Gmail, 100 with Resend) |
| `MAIL_FROM` | optional | sender address (Gmail: leave out) |
| `RESEND_API_KEY` | alt.* | instead of Gmail: Resend API key (needs a domain with DNS access; set `MAIL_FROM`) |
| `CLUB_NAME`, `CLUB_SHORT`, `TR_GROUPS` | optional | default `Nivå Kokkedal Badmintonklub`, `NKB`, `Ungdom,Senior,Veteran,Motionist` |
| `APPROVAL_ENABLED`, `APPROVAL_SINCE`, `APPROVAL_MEMBER_CHECK`, `TEAMS_FROM_LEADERS` | optional | approval flow (off) and team lists (on), as in HØBK's `APPROVAL` |

\* Either `SMTP_USER` + `SMTP_PASS` or `RESEND_API_KEY`. Supabase blocks ports 25 and 587, so Gmail is used on port 465.
`SUPABASE_URL`, `SUPABASE_DB_URL` and the service key are provided by Supabase automatically.

## Updating the server
Edit the files in `supabase/functions/api/` and push to `main`: the workflow **Udgiv Supabase-funktionen** (`.github/workflows/deploy-supabase.yml`) deploys `api` and checks that `?action=version` matches. It needs the repo secret `SUPABASE_ACCESS_TOKEN` (supabase.com → Account → Access Tokens). It can also be run by hand from Actions. (Without the workflow: dashboard editor or `supabase functions deploy api`.) Bump `SCRIPT_VERSION` in `index.ts`.

Migrations so far (run each once, in order): `20261115000000_init.sql`, `20261116000000_traenere.sql` (trainers and exercise bank, server 2026-11-16.1), `20261116100000_hoebk.sql` (HØBK in schema `hoebk`).

## Several clubs in one project (HØBK)

The free plan allows two active projects, so HØBK (Hørsholm Badminton Klub) runs in this project too, on the same server code:
- Function **`hoebk`** (`supabase/functions/hoebk/main.ts`) sets `globalThis.__CLUB = 'hoebk'` before loading `../api/index.ts`.
- Its tables live in schema **`hoebk`** (not exposed through the REST API). NKB keeps `public`.
- Settings: secrets with the prefix `HOEBK_` (e.g. `HOEBK_APP_URL`), or rows `cfg:<NAME>` in `hoebk.kv` (used today: `APP_URL`, `CLUB_NAME`, `CLUB_SHORT`, `ADMIN_PLAYER_IDS`, `TR_GROUPS`, `GH_REPO`, `MAIL_RELAY_URL`, `CONVENTUS_RELAY_URL`, plus `REG_KEY`, `IDEAS_KEY`, `GH_TOKEN` that came with the import). `SUPABASE_*` secrets are shared.
- Mail and Conventus go through HØBK's Google Apps Script (`relayMail`, `relayConventus`, key = REG_KEY), so mails still come from the club's Gmail.
- Schedule: pg_cron job `hoebk-tick` calls `…/functions/v1/hoebk?action=tick&key=` with the key read from `hoebk.kv`.
- The deploy workflow deploys both `api` and `hoebk`.
New columns/tables: add a new file in `supabase/migrations/` and run it in the SQL Editor; add the column to `TABS` in `db.ts` (same order as in the table).

## Viewing data
**Table Editor** in Supabase shows every table (the old sheet tabs). Do not edit `rid`. Login codes and sessions are stored only as hashes.

## Testing locally
`MAIL_DRYRUN=1` writes mails to the log instead of sending them. Run with `deno run -A supabase/functions/api/index.ts` and the env vars `SUPABASE_DB_URL`, `REG_KEY`, `APP_URL`.
