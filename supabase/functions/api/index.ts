// @ts-nocheck
/**
 * NKB-appens server — Supabase Edge Function "api".
 * Port af HØBK's Google Apps Script (apps-script/Code.gs, version 2026-11-12.2) med Postgres i stedet for Google Sheet.
 * Samme adresse-kontrakt som før, så appen (index.html) og GitHub-scripts virker uændret:
 *   POST {action: …}  (Content-Type text/plain, JSON i body)  ·  GET ?action=…
 * Se docs/SUPABASE.md for opsætning og secrets.
 */
import {
  append, appendMany, bump, CLUB_ID, reloadCfg, count, data, del, env, load, prop, runRequest, SCHEMA, set, setProp, sql, statCleanup, statGet, tail, TABS, withLock,
} from "./db.ts";
import { mailLeft, sendMail } from "./mail.ts";

const SCRIPT_VERSION = '2026-11-16.2';   // vises af ?action=version
const CLUB = env('CLUB_NAME', 'Nivå Kokkedal Badmintonklub');
const SHORT = env('CLUB_SHORT', 'NKB');
const APP_URL = env('APP_URL').replace(/\/?$/, '/');
let KEY = env('REG_KEY');   // samme nøgle som GitHub-secret REG_KEY — bruges også som salt til koder og sessioner
const TYPES = { match: ['ja', 'nej', 'maaske', 'ryd'], training: ['ja', 'nej', 'ryd'] };
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
// Faste administratorer: badmintonplayer-spiller-id'er (den FØRSTE e-mail der bekræfter navnet ejer rollen)
const ADMIN_PLAYER_IDS = list(env('ADMIN_PLAYER_IDS'));
// … eller SHA-256 af e-mailen med små bogstaver:  printf '%s' 'navn@eksempel.dk' | sha256sum
const ADMIN_EMAIL_SHA256 = list(env('ADMIN_EMAIL_SHA256')).map((x) => x.toLowerCase());
// Hovedadministrator: appens skaber og ansvarlige — kan ikke fjernes fra appen og vises ikke i lister
const SUPER_ADMIN_SHA256 = list(env('SUPER_ADMIN_SHA256', '61b300daa9a1d0d7ce2848c73b1207e5c2c98dd5a93a2b66884f460ef587b90f')).map((x) => x.toLowerCase());
const CODE_MINUTES = 15, MAX_CODES_PER_HOUR = 4, MAX_TRIES = 5, SESSION_DAYS = 365;

// ---------- hjælpere ----------
function clean_(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); }
const safe_ = (s) => s;   // (Sheets: formel-injektion — ikke et problem i Postgres)
async function sha256hex_(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}
const hash_ = (s) => sha256hex_(KEY + '|' + s);
function validEmail_(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }
function uuid_() { return crypto.randomUUID().replace(/-/g, ''); }
function ts_(d) { return d instanceof Date ? d.getTime() : (new Date(d).getTime() || 0); }
function newId_(p) { return p + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }
function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function text_(s, max) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
function cph(d: Date, withTime: boolean) {   // 'YYYY-MM-DD' eller 'YYYY-MM-DDTHH:MM' i dansk tid
  const s = d.toLocaleString('sv-SE', { timeZone: 'Europe/Copenhagen', hour12: false });   // "2026-11-15 13:05:09"
  return withTime ? s.slice(0, 10) + 'T' + s.slice(11, 16) : s.slice(0, 10);
}
function cphHour(d: Date) { return Number(d.toLocaleString('en-GB', { timeZone: 'Europe/Copenhagen', hour: '2-digit', hour12: false })) % 24; }
function cphMidnight(d: Date) {   // starten af dagen i dansk tid som Date
  const day = cph(d, false);
  for (const off of ['+01:00', '+02:00']) { const x = new Date(day + 'T00:00:00' + off); if (cph(x, false) === day && cphHour(x) === 0) return x; }
  return new Date(day + 'T00:00:00Z');
}
const keyOk = (k) => !!KEY && String(k || '') === KEY;
const em_ = (x) => String(x || '').toLowerCase().trim();

async function session_(token) {
  if (!token) return null;
  const h = await hash_('t:' + token), L = await load('Sessioner');
  for (let i = 0; i < L.rows.length; i++) {
    const r = L.rows[i];
    if (r[0] === h && r[6] === true) {
      if ((Date.now() - ts_(r[4])) / 86400000 > SESSION_DAYS) return null;
      if (Date.now() - ts_(r[5]) > 600000) await set('Sessioner', L.ids[i], 5, [new Date()]);   // "sidst brugt" højst hvert 10. minut
      return { id: L.ids[i], playerId: String(r[1]), playerName: String(r[2]), email: String(r[3]) };
    }
  }
  return null;
}

// ---------- login ----------
async function request_(b) {
  const email = clean_(b.email, 120).toLowerCase(), pid = clean_(b.playerId, 80), pname = clean_(b.playerName, 80);
  if (!validEmail_(email)) return { ok: false, error: 'Ugyldig e-mail' };
  if (!pid || !pname) return { ok: false, error: 'Vælg dit navn' };
  const kids = /^p:/.test(pid) ? cleanKids_(b.children) : [];
  if (/^p:/.test(pid) && !kids.length) return { ok: false, error: 'Vælg dit barn' };
  return withLock(async () => {
    const hourAgo = Date.now() - 3600000;
    const recent = (await data('Koder')).filter((r) => r[1] === email && ts_(r[0]) > hourAgo).length;
    if (recent >= MAX_CODES_PER_HOUR) return { ok: false, error: 'For mange koder — prøv igen om en time' };
    if (await mailLeft() < 1) { await stat_('mailblocked'); return { ok: false, error: 'Klubbens e-mail-kvote er brugt lige nu — prøv igen om nogle timer' }; }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await append('Koder', [new Date(), email, await hash_('c:' + email + ':' + code), pid, pname, 0, false, kids.length ? JSON.stringify(kids) : '']);
    await sendMail({
      to: email, subject: 'Din ' + SHORT + '-kode: ' + code,
      body: 'Hej ' + pname.split(' ')[0] + '\n\nDin kode til ' + SHORT + '-appen er: ' + code +
        '\n\nKoden gælder i ' + CODE_MINUTES + ' minutter. Har du ikke bedt om den, kan du se bort fra denne mail.\n\n' + CLUB,
    });
    return { ok: true };
  });
}

async function verify_(b) {
  const email = clean_(b.email, 120).toLowerCase(), code = clean_(b.code, 10).replace(/\D/g, '');
  if (!validEmail_(email) || code.length !== 6) return { ok: false, error: 'Forkert kode' };
  return withLock(async () => {
    const L = await load('Koder'), limit = Date.now() - CODE_MINUTES * 60000, want = await hash_('c:' + email + ':' + code);
    for (let i = L.rows.length - 1; i >= 0; i--) {
      const r = L.rows[i];
      if (r[1] !== email || r[6] === true || ts_(r[0]) < limit) continue;
      if (Number(r[5]) >= MAX_TRIES) return { ok: false, error: 'For mange forsøg — bed om en ny kode' };
      if (r[2] !== want) { await set('Koder', L.ids[i], 5, [Number(r[5] || 0) + 1]); return { ok: false, error: 'Forkert kode' }; }
      await set('Koder', L.ids[i], 6, [true]);
      return startSession_(email, String(r[3]), String(r[4]), r[7]);
    }
    return { ok: false, error: 'Koden er udløbet eller forkert — bed om en ny' };
  });
}
async function startSession_(email, pid, pname, kidsJson) {   // kaldes inde i låsen
  const token = uuid_() + uuid_();
  await append('Sessioner', [await hash_('t:' + token), pid, pname, email, new Date(), new Date(), true]);
  const L = await load('Spillere'); let found = false;
  for (let j = 0; j < L.rows.length; j++) {
    if (String(L.rows[j][0]) === pid && String(L.rows[j][2]) === email) { await set('Spillere', L.ids[j], 4, [new Date()]); found = true; }
  }
  if (!found) await append('Spillere', [pid, pname, email, new Date(), new Date()]);
  let kids = []; try { kids = kidsJson ? JSON.parse(kidsJson) : []; } catch { kids = []; }
  if (kids.length) await setKids_(email, pid, pname, kids);
  const approval = APPROVAL.enabled ? await requestApproval_(email, pid, pname) : '';
  return { ok: true, token, player: { id: pid, name: pname, email }, role: await role_(email, pid), follows: await follows_(email), kids: await kids_(email), approval };
}

// ---------- Log ind på en anden enhed ----------
const DEVICE_MINUTES = 10, DEVICE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function deviceCode_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const em = ses.email.toLowerCase(), bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = ''; for (let i = 0; i < 8; i++) code += DEVICE_ALPHA.charAt(bytes[i] % DEVICE_ALPHA.length);
  await withLock(async () => {
    const L = await load('Koder');
    for (let i = 0; i < L.rows.length; i++) if (L.rows[i][1] === 'enhed:' + em && L.rows[i][6] !== true) await set('Koder', L.ids[i], 6, [true]);
    await append('Koder', [new Date(), 'enhed:' + em, await hash_('d:' + code), ses.playerId, ses.playerName, 0, false, '']);
  });
  return { ok: true, code: code.slice(0, 4) + '-' + code.slice(4), minutes: DEVICE_MINUTES };
}
async function deviceLogin_(b) {
  const code = clean_(b.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8) return { ok: false, error: 'Koden har 8 tegn' };
  const fails = Number(await prop('cache:devfail') || 0);
  if (fails >= 30) return { ok: false, error: 'For mange forkerte forsøg — vent 10 minutter' };
  return withLock(async () => {
    const L = await load('Koder'), limit = Date.now() - DEVICE_MINUTES * 60000, h = await hash_('d:' + code);
    for (let i = L.rows.length - 1; i >= 0; i--) {
      const r = L.rows[i];
      if (String(r[1]).indexOf('enhed:') !== 0 || r[6] === true || ts_(r[0]) < limit || r[2] !== h) continue;
      await set('Koder', L.ids[i], 6, [true]);
      return startSession_(String(r[1]).slice(6), String(r[3]), String(r[4]), '');
    }
    await setProp('cache:devfail', String(fails + 1), 600);
    return { ok: false, error: 'Koden er forkert eller udløbet — lav en ny på din anden enhed' };
  });
}

// ---------- roller ----------
async function isSuper_(email) { const em = em_(email); return !!em && SUPER_ADMIN_SHA256.indexOf(await sha256hex_(em)) >= 0; }
async function isOwner_(email, playerId) {
  if (await isSuper_(email)) return true;
  const em = em_(email), pid = String(playerId || '');
  if (em && ADMIN_EMAIL_SHA256.indexOf(await sha256hex_(em)) >= 0) return true;
  if (!em || ADMIN_PLAYER_IDS.indexOf(pid) < 0) return false;
  const first = (await data('Spillere')).filter((r) => String(r[0]) === pid).sort((a, b) => ts_(a[3]) - ts_(b[3]))[0];
  return !!first && em_(first[2]) === em;
}
async function isAdmin_(email, playerId) {
  if (await isOwner_(email, playerId)) return true;
  const em = em_(email);
  return !!em && (await data('Administratorer')).some((r) => em_(r[0]) === em);
}
async function role_(email, playerId) {
  const em = em_(email);
  if (!em) return { leader: false, teams: [] };
  const tr = trainerOf_(await data('Trænere'), em);
  if (await isAdmin_(em, playerId)) return { leader: true, all: true, admin: true, owner: await isOwner_(em, playerId), super: await isSuper_(em), teams: [], trainer: { ungdom: true, senior: true, all: true, groups: tr.groups } };
  const teams = []; let all = false;
  (await data('Ledere')).forEach((r) => {
    if (em_(r[0]) !== em) return;
    String(r[2]).split(',').forEach((t) => { t = t.trim(); if (t === '*') all = true; else if (t) teams.push(t); });
  });
  return { leader: all || teams.length > 0, all, teams, trainer: tr.groups.length ? tr : undefined };
}

// ---------- Trænere ----------
// En træner har en eller flere træningsgrupper/-hold ("Ungdom", "Ungdom/Bredde 1", "Senior" …).
// Ungdom → ungdomstræner (rummet x:tr-ungdom), alle andre grupper → seniortræner (x:tr-senior).
const TR_ROOMS = { 'x:tr-ungdom': 'Trænere · Ungdom', 'x:tr-senior': 'Trænere · Senior' };
function trainerOf_(rows, email) {
  const em = em_(email), groups = [];
  if (em) rows.forEach((r) => {
    if (em_(r[0]) !== em) return;
    String(r[2]).split(',').forEach((g) => { g = g.trim(); if (g && groups.indexOf(g) < 0) groups.push(g); });
  });
  const main = groups.map((g) => g.split('/')[0]);
  return { ungdom: main.indexOf('Ungdom') >= 0, senior: main.some((g) => g !== 'Ungdom'), groups };
}
function cleanTrGroups_(arr) {
  const out = [];
  (arr || []).slice(0, 20).forEach((g) => {
    g = clean_(g, 60).replace(/[,]/g, ' ').trim();
    if (TR_GROUPS.indexOf(g.split('/')[0]) >= 0 && out.indexOf(g) < 0) out.push(g);
  });
  return out;
}
async function trainers_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  const trainers = [];
  for (const r of await data('Trænere')) {
    if (!String(r[0]) || await isSuper_(r[0])) continue;
    trainers.push({ email: String(r[0]), name: String(r[1]), groups: String(r[2]).split(',').map((g) => g.trim()).filter(String), by: String(r[3]) });
  }
  const emails = {};   // spiller-id → bekræftede e-mails (kun til administrator)
  for (const r of await data('Spillere')) {
    const id = String(r[0]), e = String(r[2]);
    if (!e || await isSuper_(e)) continue;
    (emails[id] = emails[id] || []); if (emails[id].indexOf(e) < 0) emails[id].push(e);
  }
  return { ok: true, trainers, emails };
}
async function setTrainer_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  const email = clean_(b.email, 120).toLowerCase();
  if (!validEmail_(email)) return { ok: false, error: 'Ugyldig e-mail' };
  const groups = cleanTrGroups_(b.groups), name = clean_(b.name, 80);
  return await withLock(async () => {
    const L = await load('Trænere'), gone = [];
    L.rows.forEach((r, i) => { if (em_(r[0]) === email) gone.push(L.ids[i]); });
    await del('Trænere', gone);
    if (groups.length) await append('Trænere', [email, name, groups.join(', '), ses.playerName, new Date()]);
    return { ok: true, groups };
  });
}

// ---------- Øvelsesbanken (trænere) ----------
const EX_LEVELS = ['Begynder børn', 'Øvede børn', 'Elite børn', 'Begynder senior', 'Øvede senior', 'Elite senior', 'Motion/voksen', 'Veteran'];
const EX_FOCUS = ['Opvarmning', 'Fodarbejde', 'Slag og teknik', 'Single', 'Double', 'Mix', 'Taktik', 'Fysisk', 'Leg og spil'];
async function exTrainer_(b) {   // {ses, admin} for trænere og administratorer — ellers {err}
  const ses = await session_(b.token);
  if (!ses) return { err: { ok: false, error: 'login', message: 'Log ind igen' } };
  const admin = await isAdmin_(ses.email, ses.playerId);
  if (!admin && !trainerOf_(await data('Trænere'), ses.email).groups.length) return { err: { ok: false, error: 'Kun for trænere' } };
  return { ses, admin };
}
function pickList_(arr, allowed) { const out = []; (arr || []).forEach((x) => { x = String(x); if (allowed.indexOf(x) >= 0 && out.indexOf(x) < 0) out.push(x); }); return out; }
const splitList_ = (v) => String(v).split(',').map((x) => x.trim()).filter(String);
async function exList_(b) {
  const a = await exTrainer_(b); if (a.err) return a.err;
  const em = a.ses.email.toLowerCase();
  const exercises = (await data('Øvelser')).filter((r) => r[0] && !bool_(r[13])).map((r) => {
    const mine = String(r[12]).toLowerCase() === em;
    return { id: String(r[0]), t: ts_(r[1]), title: String(r[2]), levels: splitList_(r[3]), focus: splitList_(r[4]), players: String(r[5]), minutes: String(r[6]),
             setup: String(r[7]), text: String(r[8]), vary: String(r[9]), link: String(r[10]), by: String(r[11]), upd: ts_(r[14]), mine, canEdit: mine || a.admin };
  }).sort((x, y) => x.title.localeCompare(y.title, 'da'));
  return { ok: true, exercises, levels: EX_LEVELS, focus: EX_FOCUS };
}
async function exSave_(b) {
  const a = await exTrainer_(b); if (a.err) return a.err;
  const title = clean_(b.title, 100), text = text_(b.text, 3000), levels = pickList_(b.levels, EX_LEVELS), focus = pickList_(b.focus, EX_FOCUS);
  if (!title) return { ok: false, error: 'Skriv en titel' };
  if (!levels.length) return { ok: false, error: 'Vælg mindst ét niveau' };
  if (!focus.length) return { ok: false, error: 'Vælg mindst ét fokus' };
  if (!text) return { ok: false, error: 'Beskriv øvelsen' };
  const link = clean_(b.link, 300);
  if (link && !/^https:\/\/[^\s"'<>]+$/i.test(link)) return { ok: false, error: 'Linket skal starte med https://' };
  const vals = [title, levels.join(', '), focus.join(', '), clean_(b.players, 40), clean_(b.minutes, 20), text_(b.setup, 1000), text, text_(b.vary, 1500), link];
  let id = clean_(b.id, 40); const em = a.ses.email.toLowerCase();
  return await withLock(async () => {
    if (id) {
      const L = await load('Øvelser');
      for (let i = 0; i < L.rows.length; i++) {
        const r = L.rows[i];
        if (String(r[0]) !== id || bool_(r[13])) continue;
        if (String(r[12]).toLowerCase() !== em && !a.admin) return { ok: false, error: 'Du kan kun rette dine egne øvelser' };
        await set('Øvelser', L.ids[i], 2, vals);
        await set('Øvelser', L.ids[i], 14, [new Date()]);
        return { ok: true, id };
      }
      return { ok: false, error: 'Øvelsen findes ikke' };
    }
    id = newId_('o');
    await append('Øvelser', [id, new Date()].concat(vals).concat([a.ses.playerName, em, false, '']));
    return { ok: true, id };
  });
}
async function exDel_(b) {
  const a = await exTrainer_(b); if (a.err) return a.err;
  const id = clean_(b.id, 40), em = a.ses.email.toLowerCase();
  return await withLock(async () => {
    const L = await load('Øvelser');
    for (let i = 0; i < L.rows.length; i++) {
      if (String(L.rows[i][0]) !== id) continue;
      if (String(L.rows[i][12]).toLowerCase() !== em && !a.admin) return { ok: false, error: 'Du kan kun slette dine egne øvelser' };
      await set('Øvelser', L.ids[i], 13, [true]);
      return { ok: true };
    }
    return { ok: false, error: 'Øvelsen findes ikke' };
  });
}

async function saveLineup_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const team = clean_(b.team, 60), eventId = clean_(b.eventId, 80), role = await role_(ses.email, ses.playerId);
  if (!role.leader || !(role.all || role.teams.indexOf(team) >= 0)) return { ok: false, error: 'Du er ikke holdleder for ' + team };
  if (!/^m:/.test(eventId)) return { ok: false, error: 'Ukendt kamp' };
  const status = ['udkast', 'klar', 'indtastet'].indexOf(b.status) >= 0 ? b.status : 'udkast';
  const people = (l) => (l || []).slice(0, 30).map((p) => ({ id: clean_(p.id, 40), name: clean_(p.name, 80) })).filter((p) => p.id && p.name);
  const d = {
    squad: people(b.squad),
    games: (b.games || []).slice(0, 20).map((g) => ({ k: clean_(g.k, 12), p: (g.p || []).slice(0, 2).map((x) => clean_(x, 40)) })),
    note: clean_(b.note, 300), by: ses.playerName,
  };
  await withLock(() => append('Opstillinger', [new Date(), eventId, team, status, ses.playerName, JSON.stringify(d)]));
  return { ok: true };
}

// ---------- Administrator: holdledere ----------
async function leaders_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  const leaders = [];
  for (const r of await data('Ledere')) {
    if (await isSuper_(r[0]) || !String(r[0])) continue;
    leaders.push({ email: String(r[0]), name: String(r[1]), teams: String(r[2]).split(',').map((t) => t.trim()).filter(String) });
  }
  const emails = {};
  for (const r of await data('Spillere')) {
    const id = String(r[0]); (emails[id] = emails[id] || []);
    if (emails[id].indexOf(String(r[2])) < 0 && !await isSuper_(r[2])) emails[id].push(String(r[2]));
  }
  const admins = [];
  for (const r of await data('Administratorer')) if (String(r[0]) && !await isSuper_(r[0])) admins.push({ email: String(r[0]), name: String(r[1]), by: String(r[2]) });
  const lm = await leaderMailed_(); leaders.forEach((l) => { l.mailed = lm[em_(l.email)] || 0; });
  return { ok: true, leaders, emails, stats: await stats_(), admins, owner: await isOwner_(ses.email, ses.playerId), super: await isSuper_(ses.email) };
}
async function setLeader_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  const email = clean_(b.email, 120).toLowerCase();
  if (!validEmail_(email)) return { ok: false, error: 'Ugyldig e-mail' };
  if (await isSuper_(email)) return { ok: false, error: 'Det er hovedadministratoren — leder for alle hold i forvejen' };
  const teams = (b.teams || []).map((t) => clean_(t, 60)).filter((t) => t && t.toLowerCase() !== 'admin');
  const name = clean_(b.name, 80);
  const res = await withLock(async () => {
    const L = await load('Ledere'); let before = []; const gone = [];
    for (let i = L.rows.length - 1; i >= 0; i--) {
      if (em_(L.rows[i][0]) === email) { before = before.concat(String(L.rows[i][2]).split(',').map((t) => t.trim())); gone.push(L.ids[i]); }
    }
    await del('Ledere', gone);
    if (teams.length) await append('Ledere', [email, name, teams.join(', ')]);
    return { ok: true, added: teams.filter((t) => before.indexOf(t) < 0) };
  });
  if (res.added.length) {
    try { await leaderMail_(email, name, res.added, teams, ses.playerName); res.mailed = true; await leaderMailed_([email]); } catch { res.mailed = false; }
  }
  delete res.added;
  return res;
}
async function leaderMailed_(emails?) {
  let m = {}; try { m = JSON.parse(await prop('LEADER_MAIL') || '{}'); } catch { m = {}; }
  if (emails) { emails.forEach((e) => { m[e.toLowerCase()] = Date.now(); }); await setProp('LEADER_MAIL', JSON.stringify(m)); }
  return m;
}
async function leaderMailSend_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  const one = clean_(b.email, 120).toLowerCase(), sent = await leaderMailed_(), todo = [];
  for (const r of await data('Ledere')) {
    const em = em_(r[0]);
    if (!em || await isSuper_(em) || !validEmail_(em)) continue;
    if (one ? em === one : !sent[em]) todo.push(r);
  }
  if (one && !todo.length) return { ok: false, error: 'Holdlederen findes ikke' };
  if (await mailLeft() < todo.length) return { ok: false, error: 'Klubbens e-mail-kvote rækker ikke lige nu — prøv igen om nogle timer' };
  const done = [], failed = [];
  for (const r of todo) {
    const em = em_(r[0]), teams = String(r[2]).split(',').map((t) => t.trim()).filter(String);
    try { await leaderMail_(em, String(r[1]), teams, teams, ses.playerName); done.push(em); } catch { failed.push(em); }
  }
  if (done.length) await leaderMailed_(done);
  return { ok: true, sent: done.length, failed: failed.length };
}
async function leaderMail_(email, name, added, all, byName) {
  const first = (name || '').split(' ')[0] || 'holdleder';
  const lst = (a) => { a = a.map((t) => t === '*' ? 'alle hold' : t); return a.length === 1 ? a[0] : a.slice(0, -1).join(', ') + ' og ' + a[a.length - 1]; };
  const body =
    'Hej ' + first + '\n\n' +
    (byName ? byName.split(' ')[0] + ' har' : 'Klubben har') + ' gjort dig til holdleder for ' + lst(added) + ' i ' + SHORT + '-appen.' +
    (all.length > added.length ? ' Du er nu holdleder for ' + lst(all) + '.' : '') + '\n\n' +
    'Åbn appen her: ' + APP_URL + '\n' +
    'Læg den gerne på hjemmeskærmen: ' + APP_URL + 'kom-i-gang.html\n\n' +
    'SÅDAN KOMMER DU I GANG\n\n' +
    '1. Log ind\n' +
    '   Gå til Min side → Spiller (eller Forælder), find dit navn og skriv denne e-mail: ' + email + '\n' +
    '   Du får en kode på mail, som du skriver i appen. Er du allerede logget ind, så tryk på opdater-knappen øverst.\n\n' +
    '2. Find Holdleder-fanen\n' +
    '   Tryk på skjoldet øverst i appen, eller gå til Min side → Holdleder.\n\n' +
    '3. Sæt spillerne på dit hold\n' +
    '   Holdleder → Holdlister → vælg holdet. Tryk "+ Sæt alle på listen" for at bruge forslaget, eller søg og tilføj spillere én ad gangen.\n' +
    '   Spillerne på listen får holdets chat, nyheder og aktiviteter.\n\n' +
    '4. Udtag spillere til kampene\n' +
    '   Holdleder → vælg kampen → Udtag spillere. Du kan se hvem der kan spille, og hvem der er spilleberettigede.\n' +
    '   Tryk derefter "Gem og lav opstilling" for at sætte spillerne på de enkelte kampe. Opstillingen tjekkes mod reglerne, og du kan eksportere den til badmintonplayer.dk.\n\n' +
    'Guide til hele appen: ' + APP_URL + 'guide.html\n\n' +
    'Har du spørgsmål eller idéer, så tryk på spørgsmålstegnet øverst i appen og skriv til administratorerne.\n\n' +
    'Venlig hilsen\n' + CLUB;
  await sendMail({ to: email, subject: 'Du er nu holdleder for ' + lst(added) + ' i ' + SHORT + '-appen', body });
}
async function setAdmin_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isOwner_(ses.email, ses.playerId)) return { ok: false, error: 'Kun de faste administratorer kan udnævne administratorer' };
  const email = clean_(b.email, 120).toLowerCase();
  if (!validEmail_(email)) return { ok: false, error: 'Ugyldig e-mail' };
  if (email === ses.email.toLowerCase()) return { ok: false, error: 'Du er allerede fast administrator' };
  if (await isSuper_(email)) return { ok: false, error: 'Det er hovedadministratoren — den rolle kan ikke ændres i appen' };
  return withLock(async () => {
    const L = await load('Administratorer');
    await del('Administratorer', L.ids.filter((_, i) => em_(L.rows[i][0]) === email));
    if (b.on) await append('Administratorer', [email, clean_(b.name, 80), ses.playerName, new Date()]);
    return { ok: true };
  });
}
async function users_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  const meSuper = await isSuper_(ses.email), cx = await ctx_(), by = {};
  for (const r of await data('Spillere')) {
    const em = em_(r[2]); if (!em) continue;
    if (!meSuper && await isSuper_(em)) continue;
    const u = by[em] = by[em] || { email: em, profiles: [], first: 0, seen: 0, active: 0, push: 0, kids: [] };
    const id = String(r[0]), nm = String(r[1]);
    if (!u.profiles.some((p) => p.id === id)) u.profiles.push({ id, name: nm });
    const f = ts_(r[3]); if (f && (!u.first || f < u.first)) u.first = f;
    const l = ts_(r[4]); if (l > u.seen) u.seen = l;
  }
  (await data('Sessioner')).forEach((r) => { const u = by[String(r[3]).toLowerCase()]; if (!u) return; const t = ts_(r[5]); if (t > u.active) u.active = t; });
  (await data('Push')).forEach((r) => { const u = by[String(r[0]).toLowerCase()]; if (u) u.push++; });
  cx.par.forEach((r) => { const u = by[String(r[0]).toLowerCase()]; if (u) u.kids.push({ id: String(r[3]), name: String(r[4]) }); });
  const users = [];
  for (const em of Object.keys(by)) {
    const u = by[em], p = u.profiles[u.profiles.length - 1], role = await roleIn_(cx, em, p.id);
    users.push({ email: em, name: p.name, id: p.id, profiles: u.profiles, parent: /^p:/.test(p.id) || u.kids.length > 0, kids: u.kids,
      admin: role.admin, superAdmin: await isSuper_(em), leader: role.all || role.teams.length > 0, teams: role.teams, trainer: trainerOf_(cx.trn, em).groups, first: u.first, active: Math.max(u.active, u.seen), push: u.push });
  }
  users.sort((a, b) => a.name.localeCompare(b.name, 'da'));
  return { ok: true, users };
}

// Skift playerId/navn for en e-mail i alle tabeller der gemmer det
async function changeIdentity_(email, newId, newName) {
  const em = em_(email);
  const upd = async (tabName, emailCol, idCol, nameCol) => {
    const L = await load(tabName);
    for (let i = 0; i < L.rows.length; i++) {
      if (em_(L.rows[i][emailCol]) !== em) continue;
      if (idCol >= 0) await set(tabName, L.ids[i], idCol, [newId]);
      if (nameCol >= 0) await set(tabName, L.ids[i], nameCol, [newName]);
    }
  };
  await upd('Spillere', 2, 0, 1); await upd('Sessioner', 3, 1, 2); await upd('Følger', 0, 1, 2); await upd('Push', 0, 1, -1); await upd('Forældre', 0, 1, 2); await upd('Grupper', 0, 1, -1);
}
function parentIdFor_(name) { return 'p:' + String(name).toLowerCase().replace(/[^a-z0-9æøå]+/g, '-').replace(/^-|-$/g, ''); }
async function toParent_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  const em = clean_(b.email, 120).toLowerCase();
  if (await isSuper_(em)) return { ok: false, error: 'Kan ikke ændre hovedadministratoren' };
  const rows = (await data('Spillere')).filter((r) => em_(r[2]) === em);
  if (!rows.length) return { ok: false, error: 'Ukendt bruger' };
  const cur = rows[rows.length - 1], curId = String(cur[0]), curName = String(cur[1]);
  if (/^p:/.test(curId)) return { ok: false, error: 'Er allerede forælder' };
  const childId = clean_(b.childId, 40) || curId, childName = clean_(b.childName, 80) || curName;
  if ((await kids_(em)).length) return { ok: false, error: 'Brugeren er allerede registreret som forælder' };
  const newName = childName.split(' ')[0] + ' forælder', newId = parentIdFor_(newName + '-' + em.split('@')[0]);
  return withLock(async () => {
    await changeIdentity_(em, newId, newName);
    const kids = await kids_(em); if (!kids.some((k) => k.id === childId)) kids.push({ id: childId, name: childName });
    await setKids_(em, newId, newName, kids);
    return { ok: true, id: newId, name: newName, kids };
  });
}
async function notPlayer_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  if (/^p:/.test(ses.playerId)) return { ok: false, error: 'Du er allerede registreret som forælder' };
  const em = ses.email.toLowerCase(), kids = await kids_(em);
  if (!kids.length && !await isAdmin_(em, ses.playerId)) return { ok: false, error: 'Tilføj først dine børn under Forælder' };
  const name = ses.playerName, newId = parentIdFor_(name + '-' + em.split('@')[0]);
  return withLock(async () => {
    await changeIdentity_(em, newId, name);
    if (kids.length) await setKids_(em, newId, name, kids);
    return { ok: true, id: newId, name, kids: await kids_(em) };
  });
}
async function rename_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  if (!/^p:/.test(ses.playerId)) return { ok: false, error: 'Kun forældre kan ændre deres navn — spillere hedder som på badmintonplayer.dk' };
  const name = clean_(b.name, 60).replace(/\s+/g, ' ');
  if (name.length < 2) return { ok: false, error: 'Skriv et navn' };
  return withLock(async () => { await changeIdentity_(ses.email, ses.playerId, name); return { ok: true, name }; });
}

async function lineups_() {
  const latest = {};
  (await data('Opstillinger')).forEach((r) => {
    const t = r[0] instanceof Date ? r[0].getTime() : 0, id = String(r[1]);
    if (latest[id] && latest[id].t > t) return;
    let d = {}; try { d = JSON.parse(r[5]); } catch { d = {}; }
    latest[id] = { e: id, team: String(r[2]), status: String(r[3]), t, squad: d.squad || [], games: d.games || [], note: d.note || '', by: d.by || String(r[4]) };
  });
  return Object.keys(latest).map((k) => latest[k]);
}

// ---------- Følg turneringer + notifikationer ----------
async function follows_(email) { const em = em_(email); return (await data('Følger')).filter((r) => em_(r[0]) === em).map((r) => String(r[3])); }
async function follow_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const tid = clean_(b.tid, 40);
  if (!/^x?[0-9a-f]+$/i.test(tid)) return { ok: false, error: 'Ukendt turnering' };
  return withLock(async () => {
    const L = await load('Følger'), em = ses.email.toLowerCase();
    await del('Følger', L.ids.filter((_, i) => em_(L.rows[i][0]) === em && String(L.rows[i][3]) === tid));
    if (b.on) {
      if ((await follows_(em)).length >= 60) return { ok: false, error: 'Du følger allerede 60 turneringer' };
      await append('Følger', [em, ses.playerId, ses.playerName, tid, clean_(b.title, 120), new Date()]);
    }
    return { ok: true, follows: await follows_(em) };
  });
}
async function mailOn_(email) {
  const em = em_(email); let on = true;
  (await data('Indstillinger')).forEach((r) => { if (em_(r[0]) === em) on = r[1] !== false && String(r[1]).toUpperCase() !== 'FALSE'; });
  return on;
}
async function settings_(email) {
  const em = em_(email);
  return { mail: await mailOn_(em), pushDevices: (await data('Push')).filter((r) => em_(r[0]) === em).length };
}
async function prefs_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  return withLock(async () => {
    const L = await load('Indstillinger'), em = ses.email.toLowerCase();
    await del('Indstillinger', L.ids.filter((_, i) => em_(L.rows[i][0]) === em));
    await append('Indstillinger', [em, !!b.mail]);
    return { ok: true, settings: await settings_(em) };
  });
}
async function push_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const sub = b.sub || {}, keys = sub.keys || {}, ep = clean_(sub.endpoint, 600);
  if (!/^https:\/\//.test(ep)) return { ok: false, error: 'Ugyldig push-adresse' };
  return withLock(async () => {
    const L = await load('Push'), em = ses.email.toLowerCase();
    await del('Push', L.ids.filter((_, i) => String(L.rows[i][2]) === ep));
    if (b.on) {
      if (!keys.p256dh || !keys.auth) return { ok: false, error: 'Ugyldig push-adresse' };
      await append('Push', [em, ses.playerId, ep, clean_(keys.p256dh, 200), clean_(keys.auth, 100), new Date(), clean_(b.device, 60)]);
    }
    return { ok: true, settings: await settings_(em) };
  });
}
async function pushGone_(b) {
  if (!keyOk(b.key)) return { ok: false, error: 'Forkert nøgle' };
  const gone = (b.endpoints || []).map(String);
  return withLock(async () => {
    const L = await load('Push'), ids = L.ids.filter((_, i) => gone.indexOf(String(L.rows[i][2])) >= 0);
    await del('Push', ids);
    return { ok: true, removed: ids.length };
  });
}
// Kaldes af GitHub (notify_turneringer.py) efter hver dataopdatering — én samlet mail pr. person.
async function notify_(b) {
  if (!keyOk(b.key)) return { ok: false, error: 'Forkert nøgle' };
  const items = (b.items || []).slice(0, 200), byEmail = {}, rows = await data('Følger');
  items.forEach((it) => {
    const ids = (it.ids || []).map(String);
    rows.forEach((r) => {
      if (ids.indexOf(String(r[3])) < 0) return;
      const em = String(r[0]).toLowerCase();
      (byEmail[em] = byEmail[em] || { name: String(r[2]), items: [] });
      if (byEmail[em].items.indexOf(it) < 0) byEmail[em].items.push(it);
    });
  });
  let sent = 0, skipped = 0; const pushRows = await data('Push'), jobs = [];
  for (const em of Object.keys(byEmail)) {
    const p = byEmail[em], lst = p.items;
    pushRows.forEach((r) => {
      if (String(r[0]).toLowerCase() !== em) return;
      lst.slice(0, 5).forEach((it) => {
        jobs.push({ endpoint: String(r[2]), keys: { p256dh: String(r[3]), auth: String(r[4]) },
          title: clean_(it.title, 80), body: (it.lines || []).slice(0, 3).map((l) => clean_(l, 120)).join('\n'),
          url: clean_(it.url, 200), tag: 't' + String(it.ids[0]) });
      });
    });
    if (!await mailOn_(em)) continue;
    if (await mailLeft() < 2) { skipped++; continue; }
    const subject = lst.length === 1 ? SHORT + ' · ' + clean_(lst[0].title, 80) + ': ' + clean_((lst[0].lines || [])[0] || 'nyt', 80)
      : SHORT + ' · nyt om ' + lst.length + ' turneringer du følger';
    const body = 'Hej ' + p.name.split(' ')[0] + '\n\n' + lst.map((it) =>
      clean_(it.title, 120) + (it.when ? ' (' + clean_(it.when, 60) + ')' : '') + '\n' +
      (it.lines || []).slice(0, 8).map((l) => '  • ' + clean_(l, 200)).join('\n') +
      (it.url ? '\n  ' + clean_(it.url, 200) : '')).join('\n\n') +
      '\n\nDu får denne mail, fordi du følger turneringen i ' + SHORT + '-appen. Tryk "Følger" på turneringen i appen for at stoppe.\n\n' + CLUB;
    try {
      await sendMail({ to: em, subject, body });
      await append('Notifikationer', [new Date(), em, subject, lst.map((it) => it.ids[0]).join(', ')]);
      sent++;
    } catch { skipped++; }
  }
  return { ok: true, sent, skipped, push: jobs };
}

// Antal brugere — kun tal, ingen e-mails
async function stats_() {
  const now = Date.now(), day = 86400000, players = {}, emails = {};
  (await data('Spillere')).forEach((r) => { if (String(r[2])) { players[String(r[0])] = 1; emails[String(r[2]).toLowerCase()] = 1; } });
  const active7 = {}, active30 = {}; let sessions = 0;
  (await data('Sessioner')).forEach((r) => {
    if (r[6] !== true) return;
    sessions++;
    const seen = r[5] instanceof Date ? r[5].getTime() : 0, pid = String(r[1]);
    if (now - seen < 7 * day) active7[pid] = 1;
    if (now - seen < 30 * day) active30[pid] = 1;
  });
  const followers = {}; let teamF = 0, tourF = 0;
  (await data('Følger')).forEach((r) => { followers[String(r[0]).toLowerCase()] = 1; if (/^f\d+$/.test(String(r[3]))) teamF++; else tourF++; });
  const push = await data('Push'), pushUsers = {};
  push.forEach((r) => { pushUsers[String(r[0]).toLowerCase()] = 1; });
  const par = {}; (await data('Forældre')).forEach((r) => { par[String(r[0]).toLowerCase()] = 1; });
  return { players: Object.keys(players).length, emails: Object.keys(emails).length, loggedIn: sessions,
    active7: Object.keys(active7).length, active30: Object.keys(active30).length,
    followers: Object.keys(followers).length, teamFollows: teamF, tourFollows: tourF,
    pushDevices: push.length, pushUsers: Object.keys(pushUsers).length,
    mailOff: (await data('Indstillinger')).filter((r) => r[1] === false || String(r[1]).toUpperCase() === 'FALSE').length,
    leaders: (await data('Ledere')).length, admins: (await data('Administratorer')).length, parents: Object.keys(par).length };
}

async function register_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const type = clean_(b.type, 10), status = clean_(b.status, 10), eventId = clean_(b.eventId, 80);
  if (!TYPES[type] || TYPES[type].indexOf(status) < 0 || !eventId) return { ok: false, error: 'Ugyldigt svar' };
  let pid = ses.playerId, pname = ses.playerName; const forId = clean_(b.player, 40);
  if (forId && forId !== ses.playerId) {
    const kid = (await kids_(ses.email)).filter((k) => k.id === forId)[0];
    if (!kid) return { ok: false, error: 'Du kan kun svare for dine egne børn' };
    pid = kid.id; pname = kid.name;
  }
  await withLock(() => append('Tilmeldinger', [new Date(), type, eventId, pid, pname, status, clean_(b.label, 120)]));
  return { ok: true, player: { id: pid, name: pname } };
}

// ---------- Forældre ----------
function cleanKids_(l) {
  const seen = {};
  return (l || []).slice(0, 8).map((k) => ({ id: clean_(k && k.id, 40), name: clean_(k && k.name, 80) }))
    .filter((k) => { if (!k.id || !k.name || /^p:/.test(k.id) || seen[k.id]) return false; seen[k.id] = 1; return true; });
}
async function kids_(email) { const em = em_(email); return (await data('Forældre')).filter((r) => em_(r[0]) === em).map((r) => ({ id: String(r[3]), name: String(r[4]) })); }
async function setKids_(email, pid, pname, kids) {
  const em = em_(email);
  await withLock(async () => {
    const L = await load('Forældre');
    await del('Forældre', L.ids.filter((_, i) => em_(L.rows[i][0]) === em));
    await appendMany('Forældre', kids.map((k) => [em, pid, pname, k.id, k.name, new Date()]));
  });
}
async function children_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const kids = cleanKids_(b.children).filter((k) => k.id !== ses.playerId);
  if (/^p:/.test(ses.playerId) && !kids.length) return { ok: false, error: 'En forælder skal have mindst ét barn' };
  await setKids_(ses.email, ses.playerId, ses.playerName, kids);
  return { ok: true, kids: await kids_(ses.email) };
}

// ---------- Snak (beskeder i hold og træningsgrupper) + nyheder ----------
const TR_GROUPS = list(env('TR_GROUPS', 'Ungdom,Senior,Veteran,Motionist'));
const MSG_MAX = 1000, NEWS_MAX = 3000, MSG_PER_MIN = 10, TAIL = 3000;
const ADMIN_ROOM = 'x:admin';

async function teams_() {
  const v = await prop('cache:teams1');
  if (v) { try { return JSON.parse(v); } catch { /* hent igen */ } }
  let map = {};
  try {
    const r = await fetch(APP_URL + 'data/holdkampe.json?t=' + Date.now());
    if (r.ok) (await r.json()).teams.forEach((t) => {
      map[String(t.leagueGroupTeamID)] = { l: String(t.label), p: (t.players || []).map((p) => String(p.id)) };
    });
  } catch { map = {}; }
  if (Object.keys(map).length) await setProp('cache:teams1', JSON.stringify(map), 21600);
  return map;
}
async function ctx_() {
  return { teams: await teams_(), fol: await data('Følger'), led: await data('Ledere'), grp: await data('Grupper'), par: await data('Forældre'), trn: await data('Trænere'), admins: {}, gm: null };
}
async function roleIn_(cx, email, pid) {
  const em = em_(email), k = em + '|' + pid;
  if (!(k in cx.admins)) cx.admins[k] = await isAdmin_(em, pid);
  if (cx.admins[k]) return { admin: true, all: true, teams: [] };
  const teams = []; let all = false;
  cx.led.forEach((r) => {
    if (em_(r[0]) !== em) return;
    String(r[2]).split(',').forEach((t) => { t = t.trim(); if (t === '*') all = true; else if (t) teams.push(t); });
  });
  return { admin: false, all, teams };
}
async function memberRooms_(cx, email, pid, strict?) {
  const em = em_(email), out = {};
  let role = await roleIn_(cx, em, pid);
  if (role.admin) out[ADMIN_ROOM] = 'Admin-chat';
  const tr = trainerOf_(cx.trn || [], em);   // trænerchat: trænerne for den del; administratorer kan se og skrive i begge (men får ikke push)
  if (tr.ungdom || (role.admin && !strict)) out['x:tr-ungdom'] = TR_ROOMS['x:tr-ungdom'];
  if (tr.senior || (role.admin && !strict)) out['x:tr-senior'] = TR_ROOMS['x:tr-senior'];
  if (strict) role = { admin: false, all: false, teams: role.teams };
  const follows = {}; cx.fol.forEach((r) => { if (String(r[0]).toLowerCase() === em) follows[String(r[3])] = 1; });
  const kids = []; (cx.par || []).forEach((r) => { if (String(r[0]).toLowerCase() === em) kids.push(String(r[3])); });
  const gm = APPROVAL.teamsFromLeaders ? (cx.gm || (cx.gm = await groupMembers_())) : null;
  Object.keys(cx.teams).forEach((id) => {
    const t = gm && (gm['h:' + id] || []).length ? { l: cx.teams[id].l, p: gm['h:' + id] } : cx.teams[id];
    if (role.admin || role.all || role.teams.indexOf(t.l) >= 0 || follows['f' + id] || t.p.indexOf(String(pid)) >= 0 ||
        kids.some((k) => t.p.indexOf(k) >= 0)) out['h:' + id] = t.l;
  });
  let groups = role.admin ? TR_GROUPS.slice() : [];
  const listed = (g) => gm && (gm['g:' + g] || []).length;
  if (gm) TR_GROUPS.forEach((g) => { if (listed(g) && (gm['g:' + g].indexOf(String(pid)) >= 0 || kids.some((k) => gm['g:' + g].indexOf(k) >= 0))) groups.push(g); });
  cx.grp.forEach((r) => { if (String(r[0]).toLowerCase() === em) groups = groups.concat(String(r[2]).split(',').filter((g) => !listed(g.trim()))); });
  tr.groups.forEach((g) => { groups.push(g.split('/')[0]); });   // trænere er med i chatten for de grupper de træner
  groups.forEach((g) => { g = g.trim(); if (TR_GROUPS.indexOf(g) >= 0) out['g:' + g] = 'Træning · ' + g; });
  return out;
}
async function canWrite_(cx, email, pid, room) {
  const em = em_(email), role = await roleIn_(cx, em, pid);
  if (role.admin) return { ok: true };
  if (room && TR_ROOMS[room]) return { ok: true };   // trænerchat: alle med i rummet må skrive (medlemskab tjekkes af post_)
  if (room && /^g:/.test(room) && trainerOf_(cx.trn || [], em).groups.some((g) => 'g:' + g.split('/')[0] === room)) return { ok: true };   // træner for gruppen
  if (APPROVAL.enabled && await approvalOf_(em) !== 'godkendt') return { ok: false, why: 'afventer', msg: 'Din profil afventer godkendelse — du kan læse med, men ikke skrive endnu' };
  if (role.all || role.teams.length) return { ok: true };
  if (/^p:/.test(String(pid)) || (cx.par || []).some((r) => String(r[0]).toLowerCase() === em)) return { ok: true };
  const senior = Object.keys(cx.teams).some((id) => { const t = cx.teams[id]; return !/^U\d/.test(t.l) && t.p.indexOf(String(pid)) >= 0; });
  if (senior) return { ok: true };
  const onTeam = Object.keys(cx.teams).some((id) => cx.teams[id].p.indexOf(String(pid)) >= 0);
  if (!onTeam) {
    if (room && /^g:/.test(room) && room !== 'g:Ungdom') return { ok: true };
    return { ok: false, why: 'udenhold', msg: 'Du er ikke på holdet, så du kan læse med her, men ikke skrive. Du kan skrive i chatten for din træningsgruppe.' };
  }
  return { ok: false, why: 'ungdom', msg: 'Ungdomsspillere kan læse med i chatten, men ikke skrive. Forældre, holdledere og seniorspillere kan skrive.' };
}
async function canModerate_(cx, ses, room) {
  const role = await roleIn_(cx, ses.email, ses.playerId);
  if (role.admin || (role.all && /^h:/.test(room))) return true;
  const t = /^h:/.test(room) ? cx.teams[room.slice(2)] : null;
  return !!t && role.teams.indexOf(t.l) >= 0;
}
async function muted_(email) {
  const em = em_(email), m = {};
  (await data('Lydløs')).forEach((r) => { if (String(r[0]).toLowerCase() === em) m[String(r[1])] = 1; });
  return m;
}
async function saveGroups_(ses, groups) {
  const g = (groups || []).map(String).filter((x) => TR_GROUPS.indexOf(x) >= 0).join(', ');
  const em = ses.email.toLowerCase(), same = (await data('Grupper')).filter((r) => String(r[0]).toLowerCase() === em);
  if (same.length === 1 && String(same[0][2]) === g) return;
  await withLock(async () => {
    const L = await load('Grupper');
    await del('Grupper', L.ids.filter((_, i) => String(L.rows[i][0]).toLowerCase() === em));
    await append('Grupper', [em, ses.playerId, g]);
  });
}
async function newsRows_() {
  return (await data('Nyheder')).filter((r) => r[0] && !bool_(r[6])).map((r) => ({
    id: String(r[0]), t: ts_(r[1]), title: String(r[2]), text: String(r[3]),
    to: String(r[4]).split(',').map((x) => x.trim()).filter(String), by: String(r[5]), img: String(r[7] || ''),
  })).sort((a, b) => b.t - a.t);
}
async function newsFor_(rooms, all) {
  const since = Date.now() - 120 * 86400000;
  return (await newsRows_()).filter((n) => n.t >= since && (all || n.to.indexOf('*') >= 0 || n.to.some((x) => !!rooms[x]))).slice(0, 30);
}
async function rooms_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  if (Array.isArray(b.groups)) await saveGroups_(ses, b.groups);
  const cx = await ctx_(), mr = await memberRooms_(cx, ses.email, ses.playerId), mute = await muted_(ses.email);
  const em = ses.email.toLowerCase(), sum = {};
  (await tail('Beskeder', TAIL)).rows.forEach((r) => {
    const room = String(r[2]); if (!mr[room] || bool_(r[7])) return;
    const s = sum[room] = sum[room] || { last: 0, n: 0, by: '', x: '', recent: [] };
    const t = ts_(r[1]); s.n++;
    if (t >= s.last) { s.last = t; s.by = String(r[4]); s.x = String(r[6]).slice(0, 80); }
    if (String(r[5]).toLowerCase() !== em) s.recent.push(t);
  });
  const own = await memberRooms_(cx, ses.email, ses.playerId, true);
  const rooms = Object.keys(mr).map((id) => {
    const s = sum[id] || { last: 0, n: 0, by: '', x: '', recent: [] };
    return { id, title: mr[id], last: s.last, n: s.n, by: s.by, x: s.x, recent: s.recent.slice(-30), muted: !!mute[id], extra: !own[id] };
  });
  const admin = (await roleIn_(cx, ses.email, ses.playerId)).admin;
  return { ok: true, rooms, news: await newsFor_(mr, admin), canNews: admin };
}
async function messages_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const room = clean_(b.room, 60), cx = await ctx_(), mr = await memberRooms_(cx, ses.email, ses.playerId);
  if (!mr[room]) return { ok: false, error: 'Du er ikke med i ' + (/^g:/.test(room) ? 'træningsgruppen' : 'holdet') };
  const em = ses.email.toLowerCase(), kidsOf = {}, team = /^h:/.test(room) ? cx.teams[room.slice(2)] : null;
  cx.par.forEach((r) => {
    const e = String(r[0]).toLowerCase(), pid0 = String(r[1]);
    if (!/^p:/.test(pid0) && !(team && team.p.indexOf(String(r[3])) >= 0)) return;
    (kidsOf[e] = kidsOf[e] || []).push(String(r[4]).split(' ')[0]);
  });
  const msgs = (await tail('Beskeder', TAIL)).rows.filter((r) => String(r[2]) === room && !bool_(r[7])).map((r) => {
    const se = String(r[5]).toLowerCase();
    return { id: String(r[0]), t: ts_(r[1]), p: String(r[3]), n: String(r[4]), x: String(r[6]), mine: se === em, k: kidsOf[se] && kidsOf[se].length ? kidsOf[se] : undefined };
  }).sort((a, b) => a.t - b.t).slice(-150);
  const cw = await canWrite_(cx, ses.email, ses.playerId, room);
  return { ok: true, room, title: mr[room], messages: msgs, canMod: await canModerate_(cx, ses, room), muted: !!(await muted_(em))[room], canWrite: cw.ok, readOnlyMsg: cw.ok ? '' : cw.msg };
}
async function post_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const room = clean_(b.room, 60), txt = text_(b.text, MSG_MAX);
  if (!txt) return { ok: false, error: 'Skriv en besked' };
  const cx = await ctx_(), mr = await memberRooms_(cx, ses.email, ses.playerId);
  if (!mr[room]) return { ok: false, error: 'Du er ikke med i ' + (/^g:/.test(room) ? 'træningsgruppen' : 'holdet') };
  const cw = await canWrite_(cx, ses.email, ses.playerId, room);
  if (!cw.ok) return { ok: false, error: cw.msg, readOnly: true };
  const em = ses.email.toLowerCase();
  const msg = await withLock(async () => {
    const minute = Date.now() - 60000;
    const recent = (await tail('Beskeder', 200)).rows.filter((r) => String(r[5]).toLowerCase() === em && ts_(r[1]) > minute).length;
    if (recent >= MSG_PER_MIN) return null;
    const id = newId_('b'), now = new Date();
    await append('Beskeder', [id, now, room, ses.playerId, ses.playerName, em, txt, false]);
    return { id, t: now.getTime(), p: ses.playerId, n: ses.playerName, x: txt, mine: true };
  });
  if (!msg) return { ok: false, error: 'Du skriver meget hurtigt — vent et øjeblik' };
  try {
    const muted = {}; (await data('Lydløs')).forEach((r) => { if (String(r[1]) === room) muted[String(r[0]).toLowerCase()] = 1; });
    const targets = await pushTargets_(async (e, pid) => e !== em && !muted[e] && !!(await memberRooms_(cx, e, pid, true))[room]);
    await queuePush_(targets.map((r) => [new Date(), r.endpoint, r.p256dh, r.auth, clean_(ses.playerName.split(' ')[0] + ' · ' + mr[room], 80),
      clean_(txt, 140), APP_URL + '#/snak/' + encodeURIComponent(room), 'r:' + room]));
  } catch (e) { console.error('push', e); }
  return { ok: true, message: msg };
}
async function delMsg_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const id = clean_(b.id, 40), cx = await ctx_();
  return withLock(async () => {
    const t = await tail('Beskeder', TAIL), em = ses.email.toLowerCase();
    for (let i = t.rows.length - 1; i >= 0; i--) {
      const r = t.rows[i];
      if (String(r[0]) !== id) continue;
      if (String(r[5]).toLowerCase() !== em && !await canModerate_(cx, ses, String(r[2]))) return { ok: false, error: 'Du kan kun slette dine egne beskeder' };
      await set('Beskeder', t.ids[i], 7, [true]);
      return { ok: true };
    }
    return { ok: false, error: 'Beskeden findes ikke' };
  });
}
async function mute_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const room = clean_(b.room, 60);
  return withLock(async () => {
    const L = await load('Lydløs'), em = ses.email.toLowerCase();
    await del('Lydløs', L.ids.filter((_, i) => String(L.rows[i][0]).toLowerCase() === em && String(L.rows[i][1]) === room));
    if (b.on) await append('Lydløs', [em, room]);
    return { ok: true, muted: !!b.on };
  });
}

// ---------- Nyheder (administrator) ----------
const NEWS_IMG_MAX = 2000000;   // tegn base64 ≈ 1,5 MB
const SB_URL = env('SUPABASE_URL');
const SB_KEY = (() => {   // ny "secret key" hvis projektet har den, ellers den gamle service_role-nøgle
  try { const k = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}'); if (k.default) return k.default; } catch { /* brug den gamle */ }
  return env('SUPABASE_SERVICE_ROLE_KEY');
})();
const BUCKET = env('IMG_BUCKET', CLUB_ID ? CLUB_ID + '-nyhedsbilleder' : 'nyhedsbilleder');
async function newsImg_(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+\/=]+)$/.exec(String(dataUrl));
  if (!m) return { ok: false, error: 'Billedet kunne ikke læses' };
  if (m[2].length > NEWS_IMG_MAX) return { ok: false, error: 'Billedet er for stort' };
  try {
    const bin = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
    const name = 'nyhed-' + cph(new Date(), true).replace(/[T:]/g, '-') + '-' + uuid_().slice(0, 6) + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    const r = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + name, {
      method: 'POST', headers: { Authorization: 'Bearer ' + SB_KEY, apikey: SB_KEY, 'Content-Type': 'image/' + m[1], 'x-upsert': 'false' }, body: bin,
    });
    if (!r.ok) throw new Error('storage ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return { ok: true, id: SB_URL + '/storage/v1/object/public/' + BUCKET + '/' + name };
  } catch (e) {
    console.error('newsImg', e);
    return { ok: false, error: 'Billedet kunne ikke gemmes — tjek at mappen "nyhedsbilleder" findes i Supabase Storage' };
  }
}
async function newsImgDel_(url) {
  const i = String(url).indexOf('/object/public/' + BUCKET + '/');
  if (i < 0) return;
  const name = String(url).slice(i + ('/object/public/' + BUCKET + '/').length);
  try { await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + name, { method: 'DELETE', headers: { Authorization: 'Bearer ' + SB_KEY, apikey: SB_KEY } }); } catch { /* allerede væk */ }
}
function toList_(b, cx) {
  let to = (b.to || []).map((x) => clean_(x, 60)).filter((x) =>
    x === '*' || (/^h:\d+$/.test(x) && cx.teams[x.slice(2)]) || (/^g:/.test(x) && TR_GROUPS.indexOf(x.slice(2)) >= 0));
  if (to.indexOf('*') >= 0) to = ['*'];
  return to;
}
async function newsSave_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  const title = clean_(b.title, 100), txt = text_(b.text, NEWS_MAX);
  if (!title) return { ok: false, error: 'Skriv en overskrift' };
  if (!txt) return { ok: false, error: 'Skriv en tekst' };
  const cx = await ctx_(), to = toList_(b, cx);
  if (!to.length) return { ok: false, error: 'Vælg hvem nyheden er til' };
  let img = '';
  if (b.img) { const saved = await newsImg_(b.img); if (!saved.ok) return saved; img = saved.id; }
  const id = newId_('n');
  await withLock(() => append('Nyheder', [id, new Date(), title, txt, to.join(','), ses.playerName, false, img]));
  let pushed = 0;
  if (b.push) {
    const targets = await pushTargets_(async (e, pid) => {
      if (to[0] === '*') return true;
      const mr = await memberRooms_(cx, e, pid, true);
      return to.some((x) => !!mr[x]);
    });
    const jobs = targets.map((r) => [new Date(), r.endpoint, r.p256dh, r.auth, clean_(SHORT + ' · ' + title, 80), clean_(txt, 140), APP_URL + '#/nyhed/' + id, 'n:' + id]);
    pushed = jobs.length; await queuePush_(jobs);
  }
  return { ok: true, id, pushed, img };
}
async function newsDel_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  const id = clean_(b.id, 40);
  return withLock(async () => {
    const L = await load('Nyheder');
    for (let i = 0; i < L.rows.length; i++) if (String(L.rows[i][0]) === id) {
      await set('Nyheder', L.ids[i], 6, [true]);
      if (L.rows[i][7]) await newsImgDel_(L.rows[i][7]);
      return { ok: true };
    }
    return { ok: false, error: 'Nyheden findes ikke' };
  });
}
async function newsList_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  return { ok: true, news: (await newsRows_()).slice(0, 60) };
}

// ---------- Aktiviteter ----------
function dtOk_(x) { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(x); }
const localNow_ = () => cph(new Date(), true);
async function actRows_() {
  const L = await load('Aktiviteter');
  return L.rows.map((r, i) => {
    let tasks = []; try { tasks = JSON.parse(r[10] || '[]'); } catch { tasks = []; }
    return { rid: L.ids[i], id: String(r[0]), name: String(r[2]), desc: String(r[3]), start: String(r[4]), end: String(r[5]),
      cal: bool_(r[6]), to: String(r[7]).split(',').map((x) => x.trim()).filter(String), by: String(r[8]), del: bool_(r[9]), tasks, help: bool_(r[11]), link: String(r[12] || '') };
  }).filter((a) => a.id && !a.del);
}
async function signups_() {
  const last = {};
  (await data('Opgavetilmeldinger')).forEach((r) => {
    const k = r[1] + '|' + r[2] + '|' + String(r[3]).toLowerCase();
    if (!last[k] || ts_(last[k][0]) <= ts_(r[0])) last[k] = r;
  });
  const out = {};
  Object.keys(last).forEach((k) => {
    const r = last[k]; if (String(r[6]) !== 'ja') return;
    const key = r[1] + '|' + r[2];
    (out[key] = out[key] || []).push({ email: String(r[3]).toLowerCase(), p: String(r[4]), n: String(r[5]), t: ts_(r[0]) });
  });
  Object.keys(out).forEach((k) => out[k].sort((a, b) => a.t - b.t));
  return out;
}
function visible_(a, rooms, admin) { return admin || a.to.indexOf('*') >= 0 || a.to.some((x) => !!rooms[x]); }
function actOut_(a, sign, em, names) {
  return { id: a.id, name: a.name, desc: a.desc, start: a.start, end: a.end, cal: a.cal, to: a.to, by: a.by, help: !!a.help, link: a.link || '',
    tasks: a.tasks.map((t) => {
      const l = sign[a.id + '|' + t.id] || [];
      return { id: t.id, title: t.title, need: t.need, from: t.from || '', to: t.to || '', n: l.length, mine: !!em && l.some((x) => x.email === em),
        who: names ? l.map((x) => ({ p: x.p, n: x.n })) : undefined };
    }) };
}
async function acts_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const cx = await ctx_(), admin = (await roleIn_(cx, ses.email, ses.playerId)).admin, mr = await memberRooms_(cx, ses.email, ses.playerId);
  const since = cph(new Date(Date.now() - 60 * 86400000), true), sign = await signups_(), em = ses.email.toLowerCase();
  const l = (await actRows_()).filter((a) => a.end >= since && visible_(a, mr, admin))
    .sort((x, y) => x.start < y.start ? -1 : 1).map((a) => actOut_(a, sign, em, true));
  return { ok: true, acts: l, canEdit: admin };
}
async function actsPublic_() {
  const now = localNow_(), sign = await signups_();
  return { ok: true, acts: (await actRows_()).filter((a) => a.end >= now && a.to.indexOf('*') >= 0)
    .sort((x, y) => x.start < y.start ? -1 : 1).map((a) => actOut_(a, sign, '', false)) };
}
async function actSave_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  const name = clean_(b.name, 100), desc = text_(b.desc, 3000), start = clean_(b.start, 16), end = clean_(b.end, 16) || start;
  if (!name) return { ok: false, error: 'Skriv et navn' };
  if (!dtOk_(start) || !dtOk_(end)) return { ok: false, error: 'Vælg start og slut' };
  if (end < start) return { ok: false, error: 'Slut er før start' };
  const cx = await ctx_(), to = toList_(b, cx);
  if (!to.length) return { ok: false, error: 'Vælg hvem aktiviteten er for' };
  if (b.help && !(b.tasks || []).some((t) => clean_(t && t.title, 80))) return { ok: false, error: 'Tilføj mindst én opgave, når I søger hjælp' };
  const tasks = (b.tasks || []).slice(0, 40).map((t) => {
    const from = dtOk_(String(t.from || '')) ? String(t.from) : ''; let tt = dtOk_(String(t.to || '')) ? String(t.to) : '';
    if (from && tt && tt < from) tt = from;
    return { id: /^o[0-9a-z]+$/.test(String(t.id || '')) ? String(t.id) : newId_('o'), title: clean_(t.title, 80), need: Math.max(0, Math.min(99, parseInt(t.need, 10) || 0)), from, to: tt };
  }).filter((t) => t.title);
  const badTime = tasks.filter((t) => t.from && (t.from < start.slice(0, 10) + 'T00:00' || t.from > end))[0];
  if (badTime) return { ok: false, error: 'Tiden for "' + badTime.title + '" ligger uden for aktiviteten' };
  const link = clean_(b.link, 500);
  if (link && !/^https:\/\/[^\s"'<>]+$/i.test(link)) return { ok: false, error: 'Linket skal starte med https://' };
  let id = /^a[0-9a-z]+$/.test(String(b.id || '')) ? String(b.id) : '';
  let isNew = !id;
  await withLock(async () => {
    if (id) {
      const cur = (await actRows_()).filter((a) => a.id === id)[0];
      if (!cur) { id = ''; isNew = true; }
      else await set('Aktiviteter', cur.rid, 2, [name, desc, start, end, !!b.cal, to.join(','), ses.playerName, false, JSON.stringify(tasks), !!b.help, link]);
    }
    if (!id) { id = newId_('a'); await append('Aktiviteter', [id, new Date(), name, desc, start, end, !!b.cal, to.join(','), ses.playerName, false, JSON.stringify(tasks), !!b.help, link]); }
  });
  let pushed = 0;
  if (b.push) {
    const targets = await pushTargets_(async (e, pid) => {
      if (to[0] === '*') return true;
      const mr = await memberRooms_(cx, e, pid, true);
      return to.some((x) => !!mr[x]);
    });
    const jobs = targets.map((r) => [new Date(), r.endpoint, r.p256dh, r.auth, clean_((isNew ? 'Ny aktivitet · ' : 'Aktivitet ændret · ') + name, 80),
      clean_(start.replace('T', ' kl. ') + (tasks.length ? ' — tag en opgave i appen' : ''), 140), APP_URL + '#/aktivitet/' + id, 'a:' + id]);
    pushed = jobs.length; await queuePush_(jobs);
  }
  return { ok: true, id, pushed };
}
async function actDel_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  const id = clean_(b.id, 40);
  return withLock(async () => {
    const cur = (await actRows_()).filter((a) => a.id === id)[0];
    if (!cur) return { ok: false, error: 'Aktiviteten findes ikke' };
    await set('Aktiviteter', cur.rid, 9, [true]);
    return { ok: true };
  });
}
async function taskSign_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const aid = clean_(b.act, 40), tid = clean_(b.task, 40);
  const cx = await ctx_(), admin = (await roleIn_(cx, ses.email, ses.playerId)).admin;
  const a = (await actRows_()).filter((x) => x.id === aid)[0];
  if (!a || !visible_(a, await memberRooms_(cx, ses.email, ses.playerId), admin)) return { ok: false, error: 'Aktiviteten findes ikke' };
  const t = a.tasks.filter((x) => x.id === tid)[0];
  if (!t) return { ok: false, error: 'Opgaven findes ikke' };
  if (a.end < localNow_()) return { ok: false, error: 'Aktiviteten er slut' };
  const em = ses.email.toLowerCase();
  return withLock(async () => {
    const l = (await signups_())[aid + '|' + tid] || [], has = l.some((x) => x.email === em);
    if (b.on && !has && t.need && l.length >= t.need) return { ok: false, error: 'Opgaven er fuld' };
    if (!!b.on !== has) await append('Opgavetilmeldinger', [new Date(), aid, tid, em, ses.playerId, ses.playerName, b.on ? 'ja' : 'nej']);
    const now = (await signups_())[aid + '|' + tid] || [];
    return { ok: true, task: { id: t.id, title: t.title, need: t.need, from: t.from || '', to: t.to || '', n: now.length, mine: !!b.on, who: now.map((x) => ({ p: x.p, n: x.n })) } };
  });
}

// ---------- Samkørsel ----------
const RIDE_MODES = ['drive', 'need', 'own'];
async function rideRows_(ev) {
  const L = await load('Kørsel'), out = [];
  L.rows.forEach((r, i) => {
    if (String(r[1]) !== ev) return;
    out.push({ rid: L.ids[i], p: String(r[3]), n: String(r[4]), email: String(r[5]).toLowerCase(), mode: String(r[6]), seats: Number(r[7]) || 0,
      pickup: String(r[8] || ''), time: String(r[9] || ''), driver: String(r[10] || ''), note: String(r[11] || ''), title: String(r[2] || '') });
  });
  return out;
}
async function ridePub_(rows, em, kidIds) {
  const pname = {}, kidsOf = {};
  (await data('Forældre')).forEach((r) => {
    const e = String(r[0]).toLowerCase();
    pname[e + '|' + String(r[3])] = String(r[2]);
    (kidsOf[e] = kidsOf[e] || []).push({ id: String(r[3]), n: String(r[4]) });
  });
  return rows.filter((r) => RIDE_MODES.indexOf(r.mode) >= 0).map((r) => {
    const by = pname[r.email + '|' + r.p] || '';
    return { p: r.p, n: r.n, mode: r.mode, seats: r.seats, pickup: r.pickup, time: r.time, driver: r.driver, note: r.note,
      mine: r.p === kidIds.self || kidIds[r.p] === 1 || (r.email === em && !by), by, kids: by ? [] : (kidsOf[r.email] || []) };
  });
}
async function rideYouthBlock_(b, ses, who) {
  if (who.kid) return '';
  const team = clean_(b.team, 20), cx = await ctx_(); let youth = !!b.youth;
  if (team && cx.teams[team]) youth = /^U\d/.test(cx.teams[team].l);
  if (!youth) return '';
  return (await canWrite_(cx, ses.email, ses.playerId, null)).why === 'ungdom' ? 'Til ungdomskampe er det forældrene der melder samkørsel — bed din forælder om at gøre det i appen' : '';
}
async function rideWho_(ses, forId) {
  if (!forId || forId === ses.playerId) return { id: ses.playerId, name: ses.playerName, kid: false, label: ses.playerName };
  const kid = (await kids_(ses.email)).filter((k) => k.id === forId)[0];
  return kid ? { id: kid.id, name: kid.name, kid: true, label: kid.name + ' (' + ses.playerName + ')' } : null;
}
async function rideMine_(rows, who, em) {
  let mine = rows.filter((r) => r.p === who.id)[0];
  if (mine || who.kid) return mine;
  const kids = {}; (await kids_(em)).forEach((k) => { kids[k.id] = 1; });
  mine = rows.filter((r) => r.email === em && !kids[r.p])[0];
  if (!mine) return null;
  const old = mine.p;
  await set('Kørsel', mine.rid, 3, [who.id, who.name]);
  for (const r of rows) if (r.driver === old) { r.driver = who.id; await set('Kørsel', r.rid, 10, [who.id]); }
  mine.p = who.id; mine.n = who.name;
  return mine;
}
async function rideIds_(ses) { const o = { self: ses.playerId }; (await kids_(ses.email)).forEach((k) => { o[k.id] = 1; }); return o; }
function rideEv_(b) { const ev = clean_(b.event, 80); return /^[mt]:[\w:.\- æøåÆØÅ]+$/.test(ev) ? ev : ''; }
function rideLink_(b) { const l = clean_(b.link, 120); return /^#\/(holdid\/\d+(\/kamp\/\d+)?|turnering\/[\w%.\-]+)$/.test(l) ? l : ''; }
async function ridePush_(emails, title, txt, link, tag) {
  const want = {}; emails.forEach((e) => { if (e) want[e] = 1; });
  if (!Object.keys(want).length) return 0;
  const jobs = (await pushTargets_(async (em) => !!want[em])).map((t) => [new Date(), t.endpoint, t.p256dh, t.auth, clean_(title, 80), clean_(txt, 140), APP_URL + (link || ''), tag]);
  await queuePush_(jobs);
  return jobs.length;
}
async function rides_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const ev = rideEv_(b); if (!ev) return { ok: false, error: 'Ukendt kamp' };
  return { ok: true, event: ev, rides: await ridePub_(await rideRows_(ev), ses.email.toLowerCase(), await rideIds_(ses)) };
}
async function rideSet_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const ev = rideEv_(b); if (!ev) return { ok: false, error: 'Ukendt kamp' };
  const who = await rideWho_(ses, clean_(b.player, 40));
  if (!who) return { ok: false, error: 'Du kan kun svare for dig selv og dine egne børn' };
  const mode = clean_(b.mode, 10);
  if (mode !== 'clear' && RIDE_MODES.indexOf(mode) < 0) return { ok: false, error: 'Ugyldigt valg' };
  const yb = await rideYouthBlock_(b, ses, who); if (yb) return { ok: false, error: yb };
  if (mode === 'drive' && who.kid) return { ok: false, error: 'Et barn kan ikke være chauffør' };
  const seats = Math.max(0, Math.min(8, Math.floor(Number(b.seats) || 0)));
  if (mode === 'drive' && seats < 1) return { ok: false, error: 'Vælg mindst 1 ledig plads' };
  const pickup = mode === 'drive' ? (clean_(b.pickup, 80) || 'vej') : '';
  const time = mode === 'drive' && /^\d{1,2}[:.]\d{2}$/.test(clean_(b.time, 5)) ? clean_(b.time, 5).replace('.', ':') : '';
  const note = mode === 'need' ? clean_(b.note, 80) : '';
  const title = clean_(b.title, 120), link = rideLink_(b), em = ses.email.toLowerCase(), notify = [];
  const res = await withLock(async () => {
    const rows = await rideRows_(ev), mine = await rideMine_(rows, who, em);
    const pass = rows.filter((r) => r.mode === 'need' && r.driver === who.id);
    if (mode === 'drive' && pass.length > seats) return { ok: false, error: 'Du har allerede ' + pass.length + ' passagerer — vælg mindst ' + pass.length + ' pladser' };
    if (mine && mine.mode === 'drive' && mode !== 'drive' && pass.length) {
      for (const r of pass) { await set('Kørsel', r.rid, 10, ['']); notify.push({ em: r.email, t: who.name + ' kører ikke alligevel', x: r.n.split(' ')[0] + ' mangler igen et lift' + (title ? ' · ' + title : '') }); }
    } else if (mine && mine.mode === 'drive' && mode === 'drive' && pass.length && (mine.pickup !== pickup || mine.time !== time)) {
      pass.forEach((r) => notify.push({ em: r.email, t: 'Ny opsamling hos ' + who.name, x: (pickup === 'vej' ? 'Henter på vejen' : 'Mødested: ' + pickup) + (time ? ' kl. ' + time : '') + (title ? ' · ' + title : '') }));
    }
    const driver = mode === 'need' && mine && mine.mode === 'need' ? mine.driver : '';
    const vals = [new Date(), ev, title || (mine && mine.title) || '', who.id, who.name, em, mode === 'clear' ? 'ryd' : mode, mode === 'drive' ? seats : '', pickup, time, driver, note];
    if (mine) await set('Kørsel', mine.rid, 0, vals); else if (mode !== 'clear') await append('Kørsel', vals);
    if (mine && mine.mode === 'need' && mine.driver && mode !== 'need') {
      const d = rows.filter((r) => r.p === mine.driver && r.mode === 'drive')[0];
      if (d) notify.push({ em: d.email, t: who.label + ' kører ikke med alligevel', x: 'Der er en plads mere i din bil' + (title ? ' · ' + title : '') });
    }
    return { ok: true };
  });
  if (!res.ok) return res;
  for (const n of notify) { try { await ridePush_([n.em], n.t, n.x, link, 'k:' + ev); } catch { /* push er ikke afgørende */ } }
  return { ok: true, event: ev, rides: await ridePub_(await rideRows_(ev), em, await rideIds_(ses)) };
}
async function rideTake_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const ev = rideEv_(b); if (!ev) return { ok: false, error: 'Ukendt kamp' };
  const who = await rideWho_(ses, clean_(b.player, 40));
  if (!who) return { ok: false, error: 'Du kan kun svare for dig selv og dine egne børn' };
  const yb = await rideYouthBlock_(b, ses, who); if (yb) return { ok: false, error: yb };
  const did = clean_(b.driver, 40), title = clean_(b.title, 120), link = rideLink_(b), em = ses.email.toLowerCase();
  let notify = null;
  const res = await withLock(async () => {
    const rows = await rideRows_(ev), mine = await rideMine_(rows, who, em);
    if (did) {
      if (did === who.id) return { ok: false, error: 'Du kan ikke tage plads i din egen bil' };
      const d = rows.filter((r) => r.p === did && r.mode === 'drive')[0];
      if (!d) return { ok: false, error: 'Bilen findes ikke længere' };
      if (mine && mine.mode === 'need' && mine.driver === did) return { ok: true };
      const taken = rows.filter((r) => r.mode === 'need' && r.driver === did).length;
      if (taken >= d.seats) return { ok: false, error: 'Bilen er fuld' };
      if (mine && mine.mode === 'drive' && rows.some((r) => r.mode === 'need' && r.driver === who.id)) return { ok: false, error: 'Du har selv passagerer — skift først dit eget valg' };
      notify = { em: d.email, t: who.label + ' kører med dig', x: (taken + 1) + ' af ' + d.seats + ' pladser taget' + (title ? ' · ' + title : '') };
    } else if (mine && mine.driver) {
      const od = rows.filter((r) => r.p === mine.driver && r.mode === 'drive')[0];
      if (od) notify = { em: od.email, t: who.label + ' kører ikke med alligevel', x: 'Der er en plads mere i din bil' + (title ? ' · ' + title : '') };
    }
    const vals = [new Date(), ev, title || (mine && mine.title) || '', who.id, who.name, em, 'need', '', '', '', did, mine && mine.mode === 'need' ? mine.note : ''];
    if (mine) await set('Kørsel', mine.rid, 0, vals); else await append('Kørsel', vals);
    return { ok: true };
  });
  if (!res.ok) return res;
  if (notify) { try { await ridePush_([notify.em], notify.t, notify.x, link, 'k:' + ev); } catch { /* ok */ } }
  return { ok: true, event: ev, rides: await ridePub_(await rideRows_(ev), em, await rideIds_(ses)) };
}

// ---------- Push-kø ----------
// Web-push underskrives af GitHub-workflowet push.yml (VAPID-nøglen ligger kun i GitHub). Funktionen lægger beskederne
// i tabellen push_koe og starter workflowet (højst hvert minut); tick starter det igen, hvis der stadig ligger noget.
async function pushTargets_(want) {
  const out = [], seen = {};
  for (const r of await data('Push')) {
    const em = String(r[0]).toLowerCase(), ep = String(r[2]);
    if (!ep || seen[ep]) continue; seen[ep] = 1;
    if (await want(em, String(r[1]))) out.push({ endpoint: ep, p256dh: String(r[3]), auth: String(r[4]) });
  }
  return out;
}
async function queuePush_(rows) {
  if (!rows || !rows.length) return;
  await withLock(() => appendMany('PushKø', rows));
  await setProp('PUSH_PENDING', '1');
  if (Date.now() - Number(await prop('PUSH_DISPATCHED') || 0) > 60000) {
    await setProp('PUSH_DISPATCHED', String(Date.now()));
    try { await ghDispatch_('push.yml'); } catch { /* tick prøver igen */ }
  }
}
async function pushQueue_(key) {
  if (!keyOk(key)) return { ok: false, error: 'Forkert nøgle' };
  return withLock(async () => {
    const L = await load('PushKø'), dayAgo = Date.now() - 86400000;
    await del('PushKø', L.ids);
    await setProp('PUSH_PENDING', '0');
    return { ok: true, push: L.rows.filter((r) => ts_(r[0]) > dayAgo).slice(0, 1000).map((r) =>
      ({ endpoint: String(r[1]), keys: { p256dh: String(r[2]), auth: String(r[3]) }, title: String(r[4]), body: String(r[5]), url: String(r[6]), tag: String(r[7]) })) };
  });
}

// ---------- Godkendelse og holdmedlemskab (som i HØBK: godkendelse slået fra, holdlister slået til) ----------
const APPROVAL = { enabled: env('APPROVAL_ENABLED') === 'true', since: env('APPROVAL_SINCE'), memberCheck: env('APPROVAL_MEMBER_CHECK') === 'true', teamsFromLeaders: env('TEAMS_FROM_LEADERS', 'true') !== 'false' };
async function approvalOf_(email) {
  const em = em_(email); let st = '';
  (await data('Godkendelser')).forEach((r) => { if (em_(r[1]) === em) st = String(r[5]); });
  if (!st && await existedBefore_(em)) st = 'godkendt';
  return st;
}
async function existedBefore_(email) {
  if (!APPROVAL.since) return false;
  const cut = new Date(APPROVAL.since + 'T00:00:00').getTime();
  return (await data('Spillere')).some((r) => em_(r[2]) === email && ts_(r[3]) && ts_(r[3]) < cut);
}
async function isMember_(email) { const em = em_(email); return (await data('Medlemmer')).some((r) => em_(r[0]) === em); }
async function adminEmails_() {
  const out = (await data('Administratorer')).map((r) => em_(r[0])).filter(String);
  (await data('Spillere')).forEach((r) => { if (ADMIN_PLAYER_IDS.indexOf(String(r[0])) >= 0) out.push(em_(r[2])); });
  const res = [];
  for (let i = 0; i < out.length; i++) if (out[i] && out.indexOf(out[i]) === i && !await isSuper_(out[i])) res.push(out[i]);
  return res;
}
async function requestApproval_(email, pid, pname) {
  const em = em_(email);
  if (await isAdmin_(em, pid) || await approvalOf_(em)) return (await approvalOf_(em)) || 'godkendt';
  const role = /^p:/.test(String(pid)) ? 'forælder' : 'spiller'; let note = role === 'forælder' ? 'forælder — godkendes individuelt' : '';
  if (role === 'spiller' && APPROVAL.memberCheck && !await isMember_(em)) {
    note = 'ikke i medlemssystemet';
    try {
      if (await mailLeft() > 2) {
        await sendMail({ to: em, subject: SHORT + '-appen: din e-mail står ikke i medlemssystemet',
          body: 'Hej ' + pname.split(' ')[0] + '\n\nDu har oprettet dig i ' + SHORT + '-appen som spiller med ' + em + ', men den e-mail står ikke i klubbens medlemssystem.\n' +
            'Ret din e-mail i medlemssystemet (eller kontakt klubben), så kan din profil blive godkendt.\n\nIndtil da kan du se kampe og læse med, men ikke skrive i chatten.\n\n' + CLUB });
        const admins = await adminEmails_();
        if (admins.length) await sendMail({ to: admins.join(','), subject: SHORT + '-appen: ' + pname + ' er ikke i medlemssystemet',
          body: pname + ' (' + em + ') har oprettet sig som spiller, men e-mailen står ikke i medlemssystemet.\nGodkend eller afvis under Administration → Godkendelser, når det er løst.\n\n' + CLUB });
      }
    } catch { /* mail er ikke afgørende */ }
  }
  await withLock(() => append('Godkendelser', [new Date(), em, pid, pname, role, 'afventer', note, '', '']));
  return 'afventer';
}
async function approve_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  if (!await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administratorer kan godkende' };
  const em = clean_(b.email, 120).toLowerCase();
  let row = null; (await data('Godkendelser')).forEach((r) => { if (em_(r[1]) === em) row = r; });
  if (!row) return { ok: false, error: 'Ingen anmodning for ' + em };
  const st = b.on ? 'godkendt' : 'afvist';
  await withLock(() => append('Godkendelser', [new Date(), em, String(row[2]), String(row[3]), String(row[4]), st, clean_(b.note, 200), ses.playerName, new Date()]));
  return { ok: true, status: st };
}
async function pendingList_(b) {
  const ses = await session_(b.token);
  if (!ses || !await isAdmin_(ses.email, ses.playerId)) return { ok: false, error: 'Kun administrator' };
  const last = {};
  (await data('Godkendelser')).forEach((r) => { last[em_(r[1])] = r; });
  const pending = [];
  for (const k of Object.keys(last)) {
    const r = last[k]; if (String(r[5]) !== 'afventer') continue;
    pending.push({ email: String(r[1]), id: String(r[2]), name: String(r[3]), role: String(r[4]), note: String(r[6]), t: ts_(r[0]), member: await isMember_(r[1]) });
  }
  return { ok: true, pending };
}
// Hold → træningsgruppe (holdledere for et hold må styre listen for den tilsvarende træningsgruppe)
const GROUP_OF_TEAM = (label) => /^U\d/.test(label) ? 'Ungdom' : /^MOT/.test(label) ? 'Motionist' : /[A-C]-række/.test(label) ? 'Veteran' : 'Senior';
function canManageGroup_(cx, role, group) {
  if (role.admin || role.all) return true;
  if (/^h:/.test(group)) { const t = cx.teams[group.slice(2)]; return !!t && role.teams.indexOf(t.l) >= 0; }
  if (/^g:/.test(group)) {
    const g = group.slice(2).replace(/2$/, '');
    return Object.keys(cx.teams).some((id) => { const t = cx.teams[id]; return role.teams.indexOf(t.l) >= 0 && GROUP_OF_TEAM(t.l) === g; });
  }
  return false;
}
async function setGroupMember_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const cx = await ctx_(), role = await roleIn_(cx, ses.email, ses.playerId), group = clean_(b.group, 60);
  let pid = clean_(b.playerId, 40);
  if (Array.isArray(b.players) && !pid) pid = '*';
  if (!/^(h:\d+|g:[A-Za-zæøåÆØÅ0-9]+)$/.test(group) || !pid) return { ok: false, error: 'Ukendt hold eller spiller' };
  if (!canManageGroup_(cx, role, group)) return { ok: false, error: 'Kun holdlederen for holdet kan ændre det' };
  const lst = (Array.isArray(b.players) ? b.players : [{ id: pid, name: b.name }]).slice(0, 200)
    .map((x) => ({ id: clean_(x && x.id, 40), name: clean_(x && x.name, 80) })).filter((x) => x.id);
  const ids = {}; lst.forEach((x) => { ids[x.id] = 1; });
  return withLock(async () => {
    const L = await load('Holdmedlemmer');
    await del('Holdmedlemmer', L.ids.filter((_, i) => ids[String(L.rows[i][0])] && String(L.rows[i][2]) === group));
    if (b.on && lst.length) { const now = new Date(); await appendMany('Holdmedlemmer', lst.map((x) => [x.id, x.name, group, ses.playerName, now])); }
    return { ok: true, members: (await data('Holdmedlemmer')).filter((r) => String(r[2]) === group).map((r) => ({ id: String(r[0]), name: String(r[1]) })) };
  });
}
async function groupLists_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const cx = await ctx_(), role = await roleIn_(cx, ses.email, ses.playerId), out = {};
  (await data('Holdmedlemmer')).forEach((r) => {
    const g = String(r[2]); if (!canManageGroup_(cx, role, g)) return;
    (out[g] = out[g] || []).push({ id: String(r[0]), name: String(r[1]), by: String(r[3]), t: ts_(r[4]) });
  });
  return { ok: true, on: !!APPROVAL.teamsFromLeaders, lists: out };
}
async function groupMembers_() {
  const m = {}; (await data('Holdmedlemmer')).forEach((r) => { const g = String(r[2]); (m[g] = m[g] || []).push(String(r[0])); });
  return m;
}

// ---------- Hjælp og feedback ----------
const FB_TYPES = ['idé', 'fejl', 'spørgsmål', 'andet'], FB_MAX = 2000, FB_PER_HOUR = 6;
function fbOut_(r, admin) {
  const o = { id: String(r[0]), t: ts_(r[1]), pid: String(r[3]), n: String(r[4]), type: String(r[5]), x: String(r[6]), side: String(r[7]),
    st: String(r[9] || 'ny'), svar: String(r[10] || ''), by: String(r[11] || ''), st2: ts_(r[12]), chat: ts_(r[13]) };
  if (admin) { o.email = String(r[2]); o.dev = String(r[8]); }
  return o;
}
async function fbAdmin_(b) {
  const ses = await session_(b.token);
  if (!ses) return { err: { ok: false, error: 'login', message: 'Log ind igen' } };
  if (!await isAdmin_(ses.email, ses.playerId)) return { err: { ok: false, error: 'Kun for administratorer' } };
  return { ses };
}
async function fbRow_(id) {
  const L = await load('Feedback');
  for (let i = L.rows.length - 1; i >= 0; i--) if (String(L.rows[i][0]) === id) return [L.ids[i], L.rows[i]];
  return null;
}
async function fbSend_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const type = FB_TYPES.indexOf(clean_(b.type, 20)) >= 0 ? clean_(b.type, 20) : 'andet';
  const txt = text_(b.text, FB_MAX);
  if (txt.length < 3) return { ok: false, error: 'Skriv lidt mere' };
  const side = clean_(b.side, 120), dev = clean_(b.dev, 160), em = ses.email.toLowerCase();
  const out = await withLock(async () => {
    const hour = Date.now() - 3600000;
    if ((await data('Feedback')).filter((r) => em_(r[2]) === em && ts_(r[1]) > hour).length >= FB_PER_HOUR) return null;
    const row = [newId_('f'), new Date(), em, ses.playerId, ses.playerName, type, txt, side, dev, 'ny', '', '', '', ''];
    await append('Feedback', row);
    return fbOut_(row, false);
  });
  if (!out) return { ok: false, error: 'Du har sendt mange henvendelser den sidste time — prøv igen senere' };
  try {
    const cx = await ctx_();
    const targets = await pushTargets_(async (e, pid) => e !== em && (await roleIn_(cx, e, pid)).admin);
    await queuePush_(targets.map((r) => [new Date(), r.endpoint, r.p256dh, r.auth, clean_('Ny feedback · ' + type + ' · ' + ses.playerName.split(' ')[0], 80), clean_(txt, 140), APP_URL + '#/feedback', 'fb']));
  } catch { /* ok */ }
  return { ok: true, item: out };
}
async function fbMine_(b) {
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login', message: 'Log ind igen' };
  const em = ses.email.toLowerCase();
  return { ok: true, items: (await data('Feedback')).filter((r) => em_(r[2]) === em).map((r) => fbOut_(r, false)).reverse().slice(0, 50) };
}
async function fbList_(b) {
  const a = await fbAdmin_(b); if (a.err) return a.err;
  return { ok: true, items: (await data('Feedback')).map((r) => fbOut_(r, true)).reverse().slice(0, 300) };
}
async function fbReply_(b) {
  const a = await fbAdmin_(b); if (a.err) return a.err;
  const id = clean_(b.id, 40), txt = text_(b.text, FB_MAX);
  if (!txt) return { ok: false, error: 'Skriv et svar' };
  const res = await withLock(async () => {
    const f = await fbRow_(id); if (!f) return null;
    const now = new Date();
    await set('Feedback', f[0], 9, ['besvaret', txt, a.ses.playerName, now]);
    f[1][9] = 'besvaret'; f[1][10] = txt; f[1][11] = a.ses.playerName; f[1][12] = now;
    return f[1];
  });
  if (!res) return { ok: false, error: 'Henvendelsen findes ikke' };
  try {
    const to = em_(res[2]);
    await queuePush_((await pushTargets_(async (e) => e === to)).map((r) => [new Date(), r.endpoint, r.p256dh, r.auth, 'Svar på din feedback', clean_(txt, 140), APP_URL + '#/hjaelp', 'fb:' + id]));
  } catch { /* ok */ }
  return { ok: true, item: fbOut_(res, true) };
}
async function fbStatus_(b) {
  const a = await fbAdmin_(b); if (a.err) return a.err;
  const id = clean_(b.id, 40), st = clean_(b.status, 20);
  if (['ny', 'besvaret', 'lukket'].indexOf(st) < 0) return { ok: false, error: 'Ugyldig status' };
  const res = await withLock(async () => {
    const f = await fbRow_(id); if (!f) return null;
    await set('Feedback', f[0], 9, [st]); f[1][9] = st; return f[1];
  });
  return res ? { ok: true, item: fbOut_(res, true) } : { ok: false, error: 'Henvendelsen findes ikke' };
}
async function fbToChat_(b) {
  const a = await fbAdmin_(b); if (a.err) return a.err;
  const id = clean_(b.id, 40), f = await fbRow_(id);
  if (!f) return { ok: false, error: 'Henvendelsen findes ikke' };
  const r = f[1], note = text_(b.note, 400);
  const head = '💡 Feedback fra ' + String(r[4]) + ' (' + String(r[5]) + (r[7] ? ', skærm ' + String(r[7]) : '') + '):\n';
  const tl = note ? '\n\n' + a.ses.playerName.split(' ')[0] + ': ' + note : '';
  let body = String(r[6]);
  if ((head + body + tl).length > MSG_MAX) body = body.slice(0, Math.max(50, MSG_MAX - head.length - tl.length - 2)) + ' …';
  const p = await post_({ token: b.token, room: ADMIN_ROOM, text: head + body + tl });
  if (!p.ok) return p;
  const res = await withLock(async () => {
    const g = await fbRow_(id); if (!g) return null;
    const now = new Date(); await set('Feedback', g[0], 13, [now]); g[1][13] = now; return g[1];
  });
  return { ok: true, item: res ? fbOut_(res, true) : null };
}

// ---------- driftsovervågning ----------
const STAT_BUCKET = 600000;   // 10 minutter
async function stat_(name) { try { await bump('st:' + name + ':' + Math.floor(Date.now() / STAT_BUCKET)); } catch { /* ok */ } }
async function statSum_(name, minutes) {
  try {
    const now = Math.floor(Date.now() / STAT_BUCKET), keys = [];
    for (let i = 0; i < Math.ceil(minutes / 10); i++) keys.push('st:' + name + ':' + (now - i));
    return await statGet(keys);
  } catch { return -1; }
}
function errKind_(err) {
  const m = String(err && err.message || err);
  if (/lock/i.test(m)) return 'lock';
  if (/too many|quota|kvote|limit/i.test(m)) return 'quota';
  if (/timed? ?out|timeout/i.test(m)) return 'timeout';
  return 'other';
}
const ALERT_COOLDOWN_H = 3;
async function healthAlert_() {
  const now = Date.now(), alerts = [];
  const left = await mailLeft(), blocked = await statSum_('mailblocked', 60);
  const req = await statSum_('req', 60), err = await statSum_('err', 60), slow = await statSum_('slow', 60), lock = await statSum_('err_lock', 60);
  if (left < 1 || blocked > 0) {
    alerts.push(['mail0', '🔴 Klubbens e-mail-kvote er brugt op' + (blocked > 0 ? ' — ' + blocked + ' har ikke kunnet få en login-kode den seneste time' : '') + '.',
      'Nye kan ikke logge ind med e-mail, før kvoten nulstilles ved midnat. Henvis til ?-ikonet → "Lav kode" på en enhed, de allerede er logget ind på. Send ikke holdleder-mails i dag.']);
  } else if (left <= 15) {
    alerts.push(['mail', '🟠 Klubbens e-mail-kvote er ved at slippe op: ' + left + ' mails tilbage i dag.',
      'Hold igen med holdleder-mails i dag, så login-koderne rækker. Henvis gerne til ?-ikonet → "Lav kode" for at logge ind på en ekstra enhed.']);
  }
  if (err >= 10 || (req >= 40 && err / req > 0.05)) {
    alerts.push(['err', '🟠 Appen giver fejl: ' + err + ' fejl ud af ' + req + ' forespørgsler den seneste time' + (lock >= 3 ? ' (mange samtidige skrivninger)' : '') + '.',
      'Vent med at sende push eller nyheder til alle, til det har lagt sig. Brugere kan prøve igen om et par minutter.']);
  }
  if (slow >= 10) alerts.push(['slow', '🟠 Appen er langsom: ' + slow + ' svar tog over 8 sekunder den seneste time.', 'Vent med at sende push eller nyheder til alle, til det har lagt sig.']);
  for (const a of alerts) {
    const key = 'ALERT_' + a[0], last = Number(await prop(key) || 0);
    if (now - last < ALERT_COOLDOWN_H * 3600000) continue;
    await setProp(key, String(now));
    await systemPost_(ADMIN_ROOM, a[1] + '\n\nHvad gør vi: ' + a[2] + '\n\nAppens ansvarlige kan lægge en driftsbesked øverst i appen til alle.');
  }
}
async function systemPost_(room, txt) {
  txt = text_(txt, MSG_MAX);
  await withLock(() => append('Beskeder', [newId_('b'), new Date(), room, 'system', SHORT + '-drift', '', txt, false]));
  const cx = await ctx_(), muted = {};
  (await data('Lydløs')).forEach((r) => { if (String(r[1]) === room) muted[String(r[0]).toLowerCase()] = 1; });
  const targets = await pushTargets_(async (e, pid) => !muted[e] && !!(await memberRooms_(cx, e, pid, true))[room]);
  await queuePush_(targets.map((r) => [new Date(), r.endpoint, r.p256dh, r.auth, SHORT + '-drift · Admin-chat', clean_(txt, 140), APP_URL + '#/snak/' + encodeURIComponent(room), 'drift']));
}
async function health_() {
  const now = new Date(), dayStart = cphMidnight(now).getTime(), hourAgo = now.getTime() - 3600000;
  const codes = await data('Koder'), ses = await data('Sessioner');
  const w = async (name) => ({ m10: await statSum_(name, 10), h1: await statSum_(name, 60), h6: await statSum_(name, 360) });
  return {
    ok: true, version: SCRIPT_VERSION, at: now.toISOString(), mailLeft: await mailLeft(),
    codes: { h1: codes.filter((r) => ts_(r[0]) > hourAgo).length, today: codes.filter((r) => ts_(r[0]) >= dayStart).length },
    mailBlocked: await w('mailblocked'),
    sessions: { active: ses.filter((r) => r[6] === true).length, newToday: ses.filter((r) => ts_(r[4]) >= dayStart).length,
      usedH1: ses.filter((r) => r[6] === true && ts_(r[5]) > hourAgo).length },
    requests: await w('req'), slow: await w('slow'), errors: await w('err'),
    errorKinds: { lock: await statSum_('err_lock', 60), quota: await statSum_('err_quota', 60), timeout: await statSum_('err_timeout', 60), other: await statSum_('err_other', 60) },
  };
}

// ---------- tidsplan: GitHub-kørslerne startes herfra (pg_cron kalder ?action=tick hvert kvarter) ----------
const GH_REPO = env('GH_REPO');
const ghToken = () => env('GH_TOKEN');   // læses ved hvert kald (HØBK: kommer med importen)
async function ghDispatch_(workflow) {
  const GH_TOKEN = ghToken();
  if (!GH_TOKEN || !GH_REPO) return 'ingen GH_TOKEN/GH_REPO';
  const r = await fetch('https://api.github.com/repos/' + GH_REPO + '/actions/workflows/' + workflow + '/dispatches', {
    method: 'POST', headers: { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': (CLUB_ID || 'nkb') + '-app' },
    body: JSON.stringify({ ref: 'main' }),
  });
  return workflow + ':' + r.status;   // 204 = startet
}
async function tick_() {
  const now = new Date(), h = cphHour(now), day = cph(now, false), res = [await ghDispatch_('tilmeldinger.yml')];
  const odd = await prop('TICK_ODD') === '1';
  await setProp('TICK_ODD', odd ? '0' : '1');
  if (h >= 9 && h <= 22 && !odd) res.push(await ghDispatch_('live.yml'));
  if (h >= 6 && await prop('FULL_AM') !== day) { await setProp('FULL_AM', day); res.push(await ghDispatch_('holdkampe.yml')); }
  else if (h >= 21 && await prop('FULL_PM') !== day) { await setProp('FULL_PM', day); res.push(await ghDispatch_('holdkampe.yml')); }
  if (await prop('PUSH_PENDING') === '1') res.push(await ghDispatch_('push.yml'));
  try { if (await convStale_()) res.push('conventus:' + await conventusSync_()); } catch (e) { console.error('conventus', e); res.push('conventus:fejl'); }
  try { await healthAlert_(); } catch (e) { console.error('healthAlert', e); }
  try { await statCleanup(); } catch { /* ok */ }
  await setProp('LAST_TICK', now.toISOString());
  await setProp('LAST_DISPATCH', res.join(' '));
  return { ok: true, dispatched: res };
}

// ---------- Conventus (klubbens medlemskartotek, kun HØBK) ----------
// Conventus blokerer mange servere, så XML'en hentes gennem klubbens Apps Script (relayConventus) — samme nøgle som REG_KEY.
// Kun læsning. Kun medlemmer på sæsonens træningshold (CONVENTUS_TRAENING_AFD) gemmes: navn + hold, ingen kontaktdata.
import { DOMParser } from "npm:@xmldom/xmldom@0.8.10";
const CONV_HOURS = 6;
const convOn_ = () => !!env('CONVENTUS_RELAY_URL');
async function convGet_(file, params?) {
  const r = await fetch(env('CONVENTUS_RELAY_URL'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, redirect: 'follow',
    body: JSON.stringify({ action: 'relayConventus', key: KEY, file, params: params || {} }) });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw new Error('Conventus: ' + ((j && j.error) || 'HTTP ' + r.status));
  return new DOMParser().parseFromString(j.xml, 'text/xml').documentElement;
}
function convKids_(el, name) {   // alle under-elementer med et bestemt navn, uanset dybde og namespace
  const out = [];
  (function walk(e) { for (let c = e.firstChild; c; c = c.nextSibling) { if (c.nodeType !== 1) continue; if ((c.localName || c.nodeName) === name) out.push(c); else walk(c); } })(el);
  return out;
}
function convChild_(el, name) { if (!el) return null; for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && (c.localName || c.nodeName) === name) return c; return null; }
function convText_(el, name) { const c = convChild_(el, name); return c ? String(c.textContent || '').trim() : ''; }
function convElems_(el, name) { const o = []; if (el) for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && (c.localName || c.nodeName) === name) o.push(c); return o; }
async function convStale_() { return convOn_() && Date.now() - Number(await prop('CONV_SYNC') || 0) > CONV_HOURS * 3600000; }
async function conventusSync_() {
  const tafd = {}; list(env('CONVENTUS_TRAENING_AFD', '68381,68711')).forEach((x) => { tafd[x] = 1; });
  const gnames = {}, gmeta = {}, training = {};
  convKids_(await convGet_('get_grupper.php'), 'gruppe').forEach((g) => {
    const id = convText_(g, 'id'), nm = convText_(g, 'titel') || convText_(g, 'navn'), afd = convText_(g, 'afdeling'); if (!id) return;
    gnames[id] = nm || ('Gruppe ' + id);
    if (tafd[afd] && convText_(g, 'aktiv') !== 'false') training[id] = 1;
    gmeta[id] = { row: [id, gnames[id], convText_(g, 'type'), convText_(g, 'aktivitet_titel'), convText_(g, 'aktiv'), convText_(g, 'periode_fra'), convText_(g, 'periode_til'), convText_(g, 'pris')], m: 0, l: 0, afd };
  });
  const mx = convKids_(await convGet_('get_medlemmer.php', { relationer: 'true' }), 'medlem').filter((m) => convChild_(m, 'id'));
  const rows = [], now = new Date();
  mx.forEach((m) => {
    const t = convText_(m, 'type') || '?';
    if (convText_(m, 'slettet') === 'true' || t === 'virksomhed') return;
    const rel = convChild_(m, 'relationer');
    const part = (kind) => convElems_(convChild_(rel, kind), 'gruppe').map((g) => {
      const id = String(g.textContent || '').trim(); if (gmeta[id]) gmeta[id][kind === 'leder' ? 'l' : 'm']++;
      return training[id] ? gnames[id] : ''; }).filter(String);
    const groups = part('medlem'), leads = part('leder');
    if (!groups.length && !leads.length) return;
    rows.push([convText_(m, 'id'), clean_(convText_(m, 'navn'), 120), groups.join('; '), leads.join('; '), now]);
  });
  if (!rows.length) throw new Error('Ingen medlemmer på træningshold — beholder den gamle liste');
  const grows = Object.keys(gmeta).map((id) => { const g = gmeta[id]; return g.row.map(String).concat([g.m, g.l, now, g.afd, training[id] ? 'ja' : '']); })
    .sort((x, y) => y[8] - x[8]);
  await withLock(async () => {
    await sql`delete from ${sql(TABS['Conventus'].t)}`; await appendMany('Conventus', rows);
    await sql`delete from ${sql(TABS['Conventus grupper'].t)}`; await appendMany('Conventus grupper', grows);
  });
  await setProp('CONV_SYNC', String(now.getTime()));
  return rows.length;
}
async function members_(b) {   // medlemslisten til appen — kun for indloggede. Administratorer får også appens brugere.
  const ses = await session_(b.token);
  if (!ses) return { ok: false, error: 'login' };
  if (!convOn_()) return { ok: false, error: 'Conventus er ikke sat op' };
  let rows = await data('Conventus');
  if (!rows.length) { try { await conventusSync_(); rows = await data('Conventus'); } catch (e) { return { ok: false, error: String(e.message || e) }; } }
  const split = (x) => String(x || '').split(';').map((t) => t.trim()).filter(String);
  const out = { ok: true, updated: Number(await prop('CONV_SYNC') || 0),
    members: rows.filter((r) => r[0] && r[1]).map((r) => ({ cid: String(r[0]), name: String(r[1]), groups: split(r[2]), leads: split(r[3]) })) };
  if (await isAdmin_(ses.email, ses.playerId)) {
    const seen = {}; out.users = [];
    (await data('Spillere')).forEach((r) => { const id = String(r[0]); if (!id || /^p:/.test(id) || seen[id]) return; seen[id] = 1; out.users.push({ id, name: String(r[1]) }); });
  }
  return out;
}

// ---------- Engangsimport fra Google Sheet (flytning af en klub fra Apps Script) ----------
// Apps Script-funktionen migrateToSupabase() sender fane for fane. Kræver engangsnøglen, hvis SHA-256 ligger i kv som import_token_sha.
// importTab {token, tab, part, rows[][]} — part 0 tømmer tabellen først. importEnd {token, props{}} gemmer indstillinger og sletter nøglen.
async function importOk_(b) {
  const want = await prop('import_token_sha');
  return !!CLUB_ID && !!want && !!b.token && (await sha256hex_(String(b.token))) === want;
}
async function importTab_(b) {
  if (!await importOk_(b)) return { ok: false, error: 'Forkert importnøgle' };
  const tab = String(b.tab || ''); if (!TABS[tab]) return { ok: false, error: 'Ukendt fane ' + tab };
  const n = TABS[tab].cols.length;
  const rows = (b.rows || []).map((r) => { const a = (r || []).slice(0, n); while (a.length < n) a.push(''); return a; });
  await withLock(async () => {
    if (!b.part) await sql`delete from ${sql(TABS[tab].t)}`;
    for (let i = 0; i < rows.length; i += 500) await appendMany(tab, rows.slice(i, i + 500));
  });
  return { ok: true, tab, rows: rows.length };
}
async function importEnd_(b) {
  if (!await importOk_(b)) return { ok: false, error: 'Forkert importnøgle' };
  const p = b.props || {}, map = { KEY: 'cfg:REG_KEY', IDEAS_KEY: 'cfg:IDEAS_KEY', GH_TOKEN: 'cfg:GH_TOKEN', CONVENTUS_TRAENING_AFD: 'cfg:CONVENTUS_TRAENING_AFD',
    LEADER_MAIL: 'LEADER_MAIL', CONV_SYNC: 'CONV_SYNC', FULL_AM: 'FULL_AM', FULL_PM: 'FULL_PM' };
  const saved = [];
  for (const k of Object.keys(map)) if (p[k] != null && p[k] !== '') { await setProp(map[k], String(p[k])); saved.push(k); }
  await setProp('import_token_sha', '', 1);
  return { ok: true, saved, counts: Object.fromEntries(await Promise.all(Object.keys(TABS).map(async (t) => [t, (await sql`select count(*)::int as n from ${sql(TABS[t].t)}`)[0].n]))) };
}

// ---------- router ----------
async function route_(b) {
  switch (b.action) {
    case 'request': return request_(b);
    case 'verify': return verify_(b);
    case 'deviceCode': return deviceCode_(b);
    case 'deviceLogin': return deviceLogin_(b);
    case 'register': return register_(b);
    case 'lineup': return saveLineup_(b);
    case 'leaders': return leaders_(b);
    case 'setLeader': return setLeader_(b);
    case 'leaderMail': return leaderMailSend_(b);
    case 'setAdmin': return setAdmin_(b);
    case 'users': return users_(b);
    case 'toParent': return toParent_(b);
    case 'rename': return rename_(b);
    case 'notPlayer': return notPlayer_(b);
    case 'follow': return follow_(b);
    case 'notify': return notify_(b);
    case 'push': return push_(b);
    case 'prefs': return prefs_(b);
    case 'pushGone': return pushGone_(b);
    case 'children': return children_(b);
    case 'approve': return APPROVAL.enabled ? approve_(b) : { ok: false, error: 'Godkendelse er ikke slået til' };
    case 'pending': return APPROVAL.enabled ? pendingList_(b) : { ok: true, pending: [], off: true };
    case 'groupList': return groupLists_(b);
    case 'groupMember': return APPROVAL.teamsFromLeaders ? setGroupMember_(b) : { ok: false, error: 'Holdledernes holdlister er ikke slået til' };
    case 'acts': return acts_(b);
    case 'actSave': return actSave_(b);
    case 'actDel': return actDel_(b);
    case 'taskSign': return taskSign_(b);
    case 'rides': return rides_(b);
    case 'rideSet': return rideSet_(b);
    case 'rideTake': return rideTake_(b);
    case 'rooms': return rooms_(b);
    case 'messages': return messages_(b);
    case 'post': return post_(b);
    case 'delMsg': return delMsg_(b);
    case 'mute': return mute_(b);
    case 'newsSave': return newsSave_(b);
    case 'newsDel': return newsDel_(b);
    case 'newsList': return newsList_(b);
    case 'trainers': return trainers_(b);
    case 'setTrainer': return setTrainer_(b);
    case 'exList': return exList_(b);
    case 'exSave': return exSave_(b);
    case 'exDel': return exDel_(b);
    case 'members': return members_(b);
    case 'importTab': return importTab_(b);
    case 'importEnd': return importEnd_(b);
    case 'fbSend': return fbSend_(b);
    case 'fbMine': return fbMine_(b);
    case 'fbList': return fbList_(b);
    case 'fbReply': return fbReply_(b);
    case 'fbStatus': return fbStatus_(b);
    case 'fbToChat': return fbToChat_(b);
    case 'me': {
      const s = await session_(b.token);
      return s ? { ok: true, player: { id: s.playerId, name: s.playerName, email: s.email }, role: await role_(s.email, s.playerId), follows: await follows_(s.email), settings: await settings_(s.email), kids: await kids_(s.email) } : { ok: false, error: 'login' };
    }
    case 'logout': { const s = await session_(b.token); if (s) await set('Sessioner', s.id, 6, [false]); return { ok: true }; }
    default: return { ok: false, error: 'Ukendt handling' };
  }
}

async function doGet_(p: URLSearchParams) {
  const action = p.get('action') || 'status';
  if (action === 'version') {
    let triggers = 0;
    try { const r = await sql`select count(*)::int as n from cron.job where command ilike ${'%/functions/v1/' + (CLUB_ID || 'api') + '?action=tick%'}`; triggers = r[0].n; } catch { triggers = -1; }
    return { ok: true, version: SCRIPT_VERSION, backend: 'supabase', scheduler: { token: !!ghToken(), repo: GH_REPO, triggers, lastTick: await prop('LAST_TICK') || '', last: await prop('LAST_DISPATCH') || '' } };
  }
  if (action === 'health') return health_();
  if (action === 'tick') return keyOk(p.get('key')) ? tick_() : { ok: false, error: 'Forkert nøgle' };
  if (action === 'news') return { ok: true, news: (await newsFor_({}, false)).filter((n) => n.to.indexOf('*') >= 0).slice(0, 10) };
  if (action === 'pushqueue') return pushQueue_(p.get('key'));
  if (action === 'acts') return actsPublic_();
  if (action === 'ideas') {
    const ik = env('IDEAS_KEY');
    if (!ik || p.get('key') !== ik) return { ok: false, error: 'Forkert nøgle' };
    const since = Number(p.get('since') || 0);
    return { ok: true, messages: (await tail('Beskeder', TAIL)).rows.filter((r) => String(r[2]) === ADMIN_ROOM && !bool_(r[7]) && ts_(r[1]) > since)
      .map((r) => ({ id: String(r[0]), t: new Date(ts_(r[1])).toISOString(), n: String(r[4]), x: String(r[6]) })).slice(-300) };
  }
  if (action === 'follows') {
    if (!keyOk(p.get('key'))) return { ok: false, error: 'Forkert nøgle' };
    const ids = {}; (await data('Følger')).forEach((r) => { ids[String(r[3])] = 1; });
    return { ok: true, follows: Object.keys(ids) };
  }
  const rows = await data('Tilmeldinger');
  if (action === 'all') {
    if (!keyOk(p.get('key'))) return { ok: false, error: 'Forkert nøgle' };
    return { ok: true, version: SCRIPT_VERSION, stats: await stats_(), lineups: await lineups_(), rows: rows.map((r) => ({
      ts: r[0] instanceof Date ? r[0].toISOString() : String(r[0]), type: r[1], eventId: String(r[2]),
      playerId: String(r[3]), playerName: String(r[4]), status: r[5], label: String(r[6]) })) };
  }
  const latest = {};
  rows.forEach((r) => {
    const k = r[2] + '|' + r[3], t = r[0] instanceof Date ? r[0].getTime() : 0;
    if (!latest[k] || latest[k].t <= t) latest[k] = { e: String(r[2]), p: String(r[3]), n: String(r[4]), s: r[5], t };
  });
  return { ok: true, updated: new Date().toISOString(), status: Object.keys(latest).map((k) => latest[k]).filter((x) => x.s !== 'ryd'), lineups: await lineups_() };
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function handle(req: Request) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!KEY && CLUB_ID) { await reloadCfg(); KEY = env('REG_KEY'); }   // en flyttet klub får nøglen med importen
  return runRequest(async () => {
    const t0 = Date.now();
    try {
      if (!KEY && req.method === 'GET' && new URL(req.url).searchParams.get('action') === 'version') return json({ ok: true, version: SCRIPT_VERSION, backend: 'supabase', waitingForImport: !!CLUB_ID });
      if (!KEY && !CLUB_ID) return json({ ok: false, error: 'Serveren mangler REG_KEY — se docs/SUPABASE.md' }, 500);
      if (req.method === 'GET') return KEY ? json(await doGet_(new URL(req.url).searchParams)) : json({ ok: false, error: 'Serveren venter på import' }, 503);
      let b;
      try { b = JSON.parse(await req.text()); } catch { return json({ ok: false, error: 'Ugyldig forespørgsel' }); }
      if (!b || typeof b !== 'object') return json({ ok: false, error: 'Ugyldig forespørgsel' });
      if (!KEY && !/^import/.test(String(b.action))) return json({ ok: false, error: 'Serveren venter på import' }, 503);
      stat_('req');
      const out = await route_(b);
      if (Date.now() - t0 > 8000) stat_('slow');
      return json(out);
    } catch (err) {
      console.error(err);
      stat_('err'); stat_('err_' + errKind_(err));
      return json({ ok: false, error: 'Serverfejl — prøv igen' });
    }
  });
}

if (import.meta.main) Deno.serve(handle);
