// @ts-nocheck
// E-mail (erstatter MailApp i Apps Script). To muligheder — sæt secrets i Supabase:
//  A) Gmail med app-adgangskode (anbefalet: klubbens egen Gmail, ca. 500 mails/døgn):  SMTP_USER, SMTP_PASS
//     (valgfrit SMTP_HOST, standard smtp.gmail.com, port 465 — Supabase tillader ikke port 25 og 587)
//  B) Resend (resend.com, kræver et domæne man kan sætte DNS på):  RESEND_API_KEY, MAIL_FROM
// MAIL_DAILY_LIMIT = hvor mange mails appen højst sender pr. døgn (standard 400 med Gmail, 100 med Resend).
import nodemailer from "npm:nodemailer@6.9.16";
import { bump, env, statGet } from "./db.ts";

const RESEND = env('RESEND_API_KEY');
// C) Relæ: klubbens eget Google Apps Script sender mailen fra klubbens Gmail (MailApp) — MAIL_RELAY_URL = scriptets /exec-adresse,
//    nøglen er REG_KEY (samme som scriptets KEY). Bruges af HØBK, så mails stadig kommer fra klubbens adresse.
const RELAY = env('MAIL_RELAY_URL');
// Gmail med app-adgangskode går forud for relæet, når SMTP_USER + SMTP_PASS er sat (HØBK: secrets HOEBK_SMTP_USER / HOEBK_SMTP_PASS).
// Fejler SMTP (fx forkert adgangskode), sendes mailen gennem relæet i stedet. Grænse med SMTP: SMTP_DAILY_LIMIT (standard 400),
// ellers MAIL_DAILY_LIMIT som før — så HØBK's MAIL_DAILY_LIMIT=95 (relæet) ikke begrænser SMTP.
const SMTP = !!(env('SMTP_USER') && env('SMTP_PASS'));
export function smtpOn() { return SMTP; }
const LIMIT = SMTP
  ? Number(env('SMTP_DAILY_LIMIT', env('MAIL_DAILY_LIMIT', '400'))) || 400
  : Number(env('MAIL_DAILY_LIMIT', RESEND || RELAY ? '100' : '400')) || 100;
let transport = null;

function dayKey() { return 'mail:' + new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Copenhagen' }); }

const DRYRUN = env('MAIL_DRYRUN') === '1';   // kun til test: mails skrives i loggen i stedet for at blive sendt
export function mailConfigured() { return DRYRUN || !!(RELAY || RESEND || SMTP); }
export async function mailLeft() {
  if (!mailConfigured()) return 0;
  return Math.max(0, LIMIT - await statGet([dayKey()]));
}

export async function sendMail(m: { to: string; subject: string; body: string; name?: string }) {
  if (!mailConfigured()) throw new Error('Mail er ikke sat op (SMTP_USER/SMTP_PASS eller RESEND_API_KEY mangler)');
  if (await mailLeft() < 1) throw new Error('kvote');
  const name = m.name || env('CLUB_NAME', 'Nivå Kokkedal Badmintonklub');
  if (!DRYRUN && SMTP) {
    try {
      if (!transport) transport = nodemailer.createTransport({
        host: env('SMTP_HOST', 'smtp.gmail.com'), port: Number(env('SMTP_PORT', '465')), secure: true,
        auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
      });
      await transport.sendMail({ from: { name, address: env('MAIL_FROM') || env('SMTP_USER') }, to: m.to, subject: m.subject, text: m.body });
      await bump(dayKey(), m.to.split(',').length);
      return;
    } catch (e) {
      console.error('smtp', String(e && e.message || e));
      if (!RELAY && !RESEND) throw e;   // ingen reserve — fejlen går videre
    }
  }
  if (DRYRUN) {
    console.log('MAIL(dryrun) til ' + m.to + ': ' + m.subject + '\n' + m.body);
  } else if (RELAY) {
    const r = await fetch(RELAY, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, redirect: 'follow',
      body: JSON.stringify({ action: 'relayMail', key: env('REG_KEY'), to: m.to, subject: m.subject, body: m.body, name }) });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) throw new Error('Mail-relæ: ' + ((j && j.error) || 'HTTP ' + r.status));
  } else if (RESEND) {
    const from = env('MAIL_FROM') || ('NKB <onboarding@resend.dev>');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from.includes('<') ? from : name + ' <' + from + '>', to: m.to.split(',').map((x) => x.trim()).filter(Boolean), subject: m.subject, text: m.body }),
    });
    if (!r.ok) throw new Error('Resend ' + r.status + ': ' + (await r.text()).slice(0, 200));
  } else {
    if (!transport) transport = nodemailer.createTransport({
      host: env('SMTP_HOST', 'smtp.gmail.com'), port: Number(env('SMTP_PORT', '465')), secure: true,
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
    });
    await transport.sendMail({ from: { name, address: env('MAIL_FROM') || env('SMTP_USER') }, to: m.to, subject: m.subject, text: m.body });
  }
  await bump(dayKey(), m.to.split(',').length);
}
