// @ts-nocheck
// Databaselaget: efterligner Google Sheet-fanerne fra Apps Script-udgaven (HØBK) oven på Postgres.
// Hver fane er en tabel med samme kolonner i samme rækkefølge. En "række" er et array (som getValues() i Sheets):
// tomme celler er '' (ikke null), tidspunkter er Date, afkrydsning er true/false.
import postgres from "npm:postgres@3.4.5";
import { AsyncLocalStorage } from "node:async_hooks";

const DB_URL = Deno.env.get("SUPABASE_DB_URL") || Deno.env.get("DATABASE_URL") || "";
export const sql = postgres(DB_URL, { max: 5, prepare: false, idle_timeout: 20, connect_timeout: 10 });

type Col = [string, string];   // [kolonne, type] — type: '' (tekst) | 'ts' | 'bool' | 'int'
const c = (s: string): Col[] => s.split(',').map((x) => { const [n, t] = x.trim().split(':'); return [n, t || '']; });

export const TABS: Record<string, { t: string; cols: Col[] }> = {
  Tilmeldinger: { t: 'tilmeldinger', cols: c('tidspunkt:ts,type,event_id,player_id,player_name,status,label') },
  Spillere: { t: 'spillere', cols: c('player_id,player_name,email,bekraeftet:ts,sidst_set:ts') },
  Koder: { t: 'koder', cols: c('tidspunkt:ts,email,kode_hash,player_id,player_name,forsoeg:int,brugt:bool,boern') },
  Sessioner: { t: 'sessioner', cols: c('token_hash,player_id,player_name,email,oprettet:ts,sidst_brugt:ts,aktiv:bool') },
  Ledere: { t: 'ledere', cols: c('email,navn,hold') },
  Opstillinger: { t: 'opstillinger', cols: c('tidspunkt:ts,event_id,hold,status,gemt_af,data') },
  'Følger': { t: 'foelger', cols: c('email,player_id,player_name,turnering_id,titel,tidspunkt:ts') },
  Notifikationer: { t: 'notifikationer', cols: c('tidspunkt:ts,email,emne,turneringer') },
  Push: { t: 'push', cols: c('email,player_id,endpoint,p256dh,auth,tidspunkt:ts,enhed') },
  Indstillinger: { t: 'indstillinger', cols: c('email,mail:bool') },
  Beskeder: { t: 'beskeder', cols: c('id,tidspunkt:ts,rum,player_id,player_name,email,tekst,slettet:bool') },
  Nyheder: { t: 'nyheder', cols: c('id,tidspunkt:ts,titel,tekst,til,af,slettet:bool,billede') },
  Grupper: { t: 'grupper', cols: c('email,player_id,grupper') },
  'Lydløs': { t: 'lydloes', cols: c('email,rum') },
  'Forældre': { t: 'foraeldre', cols: c('email,foraelder_id,foraelder_navn,barn_id,barn_navn,tidspunkt:ts') },
  Aktiviteter: { t: 'aktiviteter', cols: c('id,oprettet:ts,navn,beskrivelse,start,slut,kalender:bool,til,af,slettet:bool,opgaver,soeger_hjaelp:bool,link') },
  Opgavetilmeldinger: { t: 'opgavetilmeldinger', cols: c('tidspunkt:ts,aktivitet_id,opgave_id,email,player_id,navn,status') },
  Administratorer: { t: 'administratorer', cols: c('email,navn,udnaevnt_af,tidspunkt:ts') },
  Medlemmer: { t: 'medlemmer', cols: c('email,navn,medlemsnr,importeret:ts') },
  Godkendelser: { t: 'godkendelser', cols: c('tidspunkt:ts,email,player_id,navn,rolle,status,note,behandlet_af,behandlet:ts') },
  Holdmedlemmer: { t: 'holdmedlemmer', cols: c('player_id,navn,gruppe,tilfoejet_af,tidspunkt:ts') },
  'PushKø': { t: 'push_koe', cols: c('tidspunkt:ts,endpoint,p256dh,auth,titel,tekst,url,tag') },
  'Kørsel': { t: 'koersel', cols: c('tidspunkt:ts,begivenhed,titel,player_id,navn,email,valg,pladser:int,opsamling,afgang,chauffoer,note') },
  Feedback: { t: 'feedback', cols: c('id,tidspunkt:ts,email,player_id,navn,type,tekst,side,enhed,status,svar,svaret_af,svaret:ts,admin_chat:ts') },
};

// ---- pr. forespørgsel: cache af læste faner + den åbne transaktion når låsen holdes ----
const store = new AsyncLocalStorage();
export function runRequest(fn) { return store.run({ cache: new Map(), tx: null }, fn); }
function cx() { return store.getStore() || { cache: new Map(), tx: null }; }
function db() { return cx().tx || sql; }

function toDb(v, type) {
  if (type === 'ts') {
    if (v === '' || v == null) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(+d) ? null : d;
  }
  if (type === 'bool') {
    if (v === '' || v == null) return null;
    return v === true || String(v).toUpperCase() === 'TRUE';
  }
  if (type === 'int') {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return isFinite(n) ? Math.trunc(n) : null;
  }
  return v == null ? '' : String(v);
}
function fromDb(v) { return v === null || v === undefined ? '' : v; }
function tab(name) { const t = TABS[name]; if (!t) throw new Error('Ukendt fane ' + name); return t; }
function obj(t, values: any[], start = 0) {
  const o = {};
  values.forEach((v, i) => { const col = t.cols[start + i]; if (col) o[col[0]] = toDb(v, col[1]); });
  return o;
}

export interface Loaded { rows: any[][]; ids: number[] }

// Hele fanen (som data_() i Apps Script) — plus rækkernes id'er, så man kan skrive tilbage i en bestemt række
export async function load(name: string): Promise<Loaded> {
  const x = cx(), hit = x.cache.get(name);
  if (hit) return hit;
  const t = tab(name), names = t.cols.map((k) => k[0]);
  const res = await db()`select rid, ${db()(names)} from ${db()(t.t)} order by rid`;
  const out = { rows: res.map((r) => names.map((n) => fromDb(r[n]))), ids: res.map((r) => Number(r.rid)) };
  x.cache.set(name, out);
  return out;
}
export async function data(name: string) { return (await load(name)).rows; }

// De sidste n rækker (beskeder vokser — vi læser kun de nyeste)
export async function tail(name: string, n: number): Promise<Loaded> {
  const t = tab(name), names = t.cols.map((k) => k[0]);
  const res = await db()`select rid, ${db()(names)} from ${db()(t.t)} order by rid desc limit ${n}`;
  res.reverse();
  return { rows: res.map((r) => names.map((nm) => fromDb(r[nm]))), ids: res.map((r) => Number(r.rid)) };
}

function dirty(name) { cx().cache.delete(name); }

export async function append(name: string, row: any[]) { return appendMany(name, [row]); }
export async function appendMany(name: string, rows: any[][]) {
  if (!rows.length) return;
  const t = tab(name), names = t.cols.map((k) => k[0]);
  const objs = rows.map((r) => obj(t, r));
  dirty(name);
  await db()`insert into ${db()(t.t)} ${db()(objs, names)}`;
}
// Skriv værdier fra kolonne col (0 = første) i rækken med id
export async function set(name: string, id: number, col: number, values: any[]) {
  const t = tab(name), o = obj(t, values, col);
  dirty(name);
  await db()`update ${db()(t.t)} set ${db()(o)} where rid = ${id}`;
}
export async function del(name: string, ids: number[]) {
  if (!ids.length) return;
  const t = tab(name);
  dirty(name);
  await db()`delete from ${db()(t.t)} where rid in ${db()(ids)}`;
}
export async function count(name: string) {
  const t = tab(name);
  const r = await db()`select count(*)::int as n from ${db()(t.t)}`;
  return r[0].n;
}

// LockService.getScriptLock(): én skrivning ad gangen (advisory lock i en transaktion, venter højst 10 s).
// Inde i låsen bruger alle kald samme forbindelse, og cachen tømmes, så man læser det nyeste.
export async function withLock(fn) {
  const x = cx();
  if (x.tx) return fn();
  return await sql.begin(async (tx) => {
    await tx`select set_config('lock_timeout', '10s', true)`;
    await tx`select pg_advisory_xact_lock(7311)`;
    x.tx = tx; x.cache.clear();
    try { return await fn(); } finally { x.tx = null; x.cache.clear(); }
  });
}

// ---- PropertiesService / CacheService ----
export async function prop(key: string) {
  const r = await db()`select value from kv where key = ${key} and (expires is null or expires > now())`;
  return r.length ? r[0].value : null;
}
export async function setProp(key: string, value: string, seconds?: number) {
  const exp = seconds ? new Date(Date.now() + seconds * 1000) : null;
  await db()`insert into kv (key, value, expires) values (${key}, ${String(value)}, ${exp})
            on conflict (key) do update set value = excluded.value, expires = excluded.expires`;
}

// ---- driftstal ----
export async function bump(k: string, by = 1) {
  const r = await db()`insert into stats (k, n) values (${k}, ${by}) on conflict (k) do update set n = stats.n + ${by}, at = now() returning n`;
  return r[0].n;
}
export async function statGet(keys: string[]) {
  if (!keys.length) return 0;
  const r = await db()`select coalesce(sum(n), 0)::int as n from stats where k in ${db()(keys)}`;
  return r[0].n;
}
export async function statCleanup() { await db()`delete from stats where at < now() - interval '3 days'`; await db()`delete from kv where expires < now()`; }
