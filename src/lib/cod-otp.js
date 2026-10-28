/**
 * WhatsApp OTP for Cash on Delivery: the checkout sends a 4-digit code to the shopper's WhatsApp when they tap
 * "Place order", and the order is created only with the right code. A verified number counts as a confirmed COD order,
 * so no WhatsApp confirmation message goes out for it.
 *
 * The code goes out with Meta's AUTHENTICATION template (ik_cod_otp) and its "Copy code" button: one tap in WhatsApp
 * copies it, and the phone keyboard offers it from the clipboard. Codes are kept only as an HMAC, 10 minutes.
 * If the template is not approved yet or WhatsApp refuses, the checkout falls back to the old flow (order placed,
 * WhatsApp confirmation asked as before).
 */
import { hmacSha256hex, safeEqual } from './util.js';

export const OTP_TEMPLATE = 'ik_cod_otp';
export const OTP_TTL = 10 * 60, RESEND_GAP = 30, MAX_SENDS_HOUR = 5, MAX_TRIES = 5;
const now = () => Math.floor(Date.now() / 1000);
const GRAPH = 'https://graph.facebook.com/v21.0';

export function otpTemplate() {
  return {
    name: OTP_TEMPLATE, language: 'en', category: 'AUTHENTICATION',
    components: [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: 10 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
    ],
  };
}

/** On unless switched off in settings (cod_otp.on = false), and only with the WhatsApp Cloud API connected. */
export const otpOn = (env) => env.SETTINGS?.cod_otp?.on !== false && !!(env.WA_PHONE_ID && env.WA_TOKEN);

const secretOf = (env) => env.ADMIN_SECRET || env.CRON_SECRET || 'ik-otp|' + (env.DATABASE_URL || env.POSTGRES_URL || 'x');
const hashOf = (env, phone, code) => hmacSha256hex(secretOf(env), `otp:${phone}:${code}`);
export function newCode() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 10000).padStart(4, '0');
}

/** Meta Cloud API: authentication template, the code in the body and in the copy-code button. */
export async function metaSendOtp(env, phone, code) {
  const res = await fetch(`${GRAPH}/${env.WA_PHONE_ID}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WA_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: '91' + phone, type: 'template', template: { name: OTP_TEMPLATE, language: { code: 'en' }, components: [
      { type: 'body', parameters: [{ type: 'text', text: code }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
    ] } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.messages?.[0]?.id) { const e = j.error || {}; throw new Error([e.message || 'HTTP ' + res.status, e.error_data?.details, `code ${e.code ?? '?'}`].filter(Boolean).join(' · ')); }
  return j.messages[0].id;
}

/**
 * Send (or re-send) a code. Returns { ok, resend_in } or { ok:false, error, wait? , fallback? }.
 * fallback: WhatsApp could not deliver it, so the checkout should place the order the old way.
 */
export async function sendOtp(env, phone, { send = metaSendOtp, log = null } = {}) {
  if (!/^[6-9]\d{9}$/.test(String(phone || ''))) return { ok: false, error: 'Enter a valid 10-digit mobile number' };
  if (!otpOn(env)) return { ok: false, fallback: true, error: 'otp off' };
  const t = now();
  const row = await env.DB.prepare('SELECT * FROM cod_otps WHERE phone=?').bind(phone).first();
  if (row && t - Number(row.sent_at) < RESEND_GAP) return { ok: false, wait: RESEND_GAP - (t - Number(row.sent_at)), error: 'Please wait a few seconds before asking for another code' };
  const fresh = !row || Number(row.window_start) < t - 3600;
  if (!fresh && Number(row.sends) >= MAX_SENDS_HOUR) return { ok: false, error: 'Too many codes asked for this number. Please try again in an hour.' };
  const code = newCode();
  let wamid = '';
  try { wamid = await send(env, phone, code); }
  catch (e) {
    if (log) await log({ phone, trigger: 'cod_otp', template: OTP_TEMPLATE, status: 'failed', error: String(e.message || e).slice(0, 300), preview: 'COD verification code' }).catch(() => {});
    try { const G = await import('./wa-gate.js'); if (G.RATE_LIMIT.test(String(e.message || e))) await G.pushback(env); } catch { /* best effort */ }
    return { ok: false, fallback: true, error: String(e.message || e).slice(0, 200) };
  }
  await env.DB.prepare(`INSERT INTO cod_otps (phone, code_hash, sent_at, expires_at, tries, sends, window_start, verified_at, wamid, dstatus, drank) VALUES (?,?,?,?,0,1,?,NULL,?,NULL,0)
      ON CONFLICT (phone) DO UPDATE SET code_hash=EXCLUDED.code_hash, sent_at=EXCLUDED.sent_at, expires_at=EXCLUDED.expires_at, tries=0, verified_at=NULL, wamid=EXCLUDED.wamid, dstatus=NULL, drank=0,
      sends=CASE WHEN cod_otps.window_start < ? THEN 1 ELSE cod_otps.sends + 1 END, window_start=CASE WHEN cod_otps.window_start < ? THEN EXCLUDED.window_start ELSE cod_otps.window_start END`)
    .bind(phone, await hashOf(env, phone, code), t, t + OTP_TTL, t, String(wamid || ''), t - 3600, t - 3600).run();
  if (log) await log({ phone, trigger: 'cod_otp', template: OTP_TEMPLATE, status: 'sent', wamid, preview: 'COD verification code (4 digits, not stored)' }).catch(() => {});
  return { ok: true, resend_in: RESEND_GAP, ttl: OTP_TTL };
}

/* WhatsApp delivery statuses can arrive out of order: keep the furthest one (failed is final). */
export const STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 9 };
/** Webhook: a delivery status for a message; updates the code it carried, if it carried one. */
export async function otpStatus(env, wamid, status) {
  const r = STATUS_RANK[String(status || '')];
  if (!r || !wamid) return;
  await env.DB.prepare('UPDATE cod_otps SET dstatus=?, drank=? WHERE wamid=? AND COALESCE(drank,0) < ?').bind(String(status), r, String(wamid), r).run();
}
/**
 * Checkout poll: has the code reached the phone? state: 'delivered' (or read) = ask for it; 'failed' = WhatsApp could
 * not deliver it (number not on WhatsApp...), place the order the old way; 'pending' = keep waiting (the checkout
 * gives up after ~15 s and also falls back).
 */
export async function otpDelivery(env, phone) {
  const row = await env.DB.prepare('SELECT sent_at, dstatus, drank FROM cod_otps WHERE phone=?').bind(String(phone || '')).first();
  if (!row) return { ok: true, state: 'none' };
  const r = Number(row.drank) || 0;
  return { ok: true, state: r >= 9 ? 'failed' : r >= 2 ? 'delivered' : 'pending', age: now() - Number(row.sent_at) };
}

/** Check a code. The right code stays valid until it expires (a retry after a network error must not need a new one). */
export async function checkOtp(env, phone, code) {
  const c = String(code || '').replace(/\D/g, '');
  if (!/^\d{4}$/.test(c)) return { ok: false, error: 'Enter the 4-digit code' };
  const row = await env.DB.prepare('SELECT * FROM cod_otps WHERE phone=?').bind(String(phone)).first();
  const t = now();
  if (!row || !row.code_hash) return { ok: false, expired: true, error: 'Please tap Resend to get a code' };
  if (Number(row.expires_at) < t) return { ok: false, expired: true, error: 'This code has expired. Tap Resend for a new one.' };
  if (Number(row.tries) >= MAX_TRIES) return { ok: false, expired: true, error: 'Too many wrong tries. Tap Resend for a new code.' };
  if (safeEqual(await hashOf(env, String(phone), c), String(row.code_hash))) {
    await env.DB.prepare('UPDATE cod_otps SET verified_at=COALESCE(verified_at, ?) WHERE phone=?').bind(t, String(phone)).run();
    return { ok: true };
  }
  await env.DB.prepare('UPDATE cod_otps SET tries=tries+1 WHERE phone=?').bind(String(phone)).run();
  const left = MAX_TRIES - Number(row.tries) - 1;
  return { ok: false, error: left > 0 ? 'Wrong code. Please check the WhatsApp message and try again.' : 'Too many wrong tries. Tap Resend for a new code.', expired: left <= 0 };
}
