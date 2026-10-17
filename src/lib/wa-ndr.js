// src/lib/wa-ndr.js — the customer's own re-attempt / return choice after a failed delivery.
//
// When the courier fails a delivery, the "ship_failed" WhatsApp message goes out with a signed link to this page
// (its {{track}} variable), so the customer can ask for another attempt — optionally on a day that suits them — or
// have the parcel returned, without anyone from the team in the loop. A plain WhatsApp reply ("re-attempt",
// "deliver again", "return") does the same through processInbound (lib/wa-g4w.js).
//
// Both paths call Shiprocket's NDR action for the live AWB (lib/shiprocket.js ndrAction) and log the choice.

import { hmacSha256hex, safeEqual } from './util.js';
import { ndrAction } from './shiprocket.js';
import { page } from './wa-g4w.js';
import { logMsg, sendText } from './whatsapp.js';

const now = () => Math.floor(Date.now() / 1000);
const secret = (env) => env.WA_LINK_SECRET || env.ADMIN_TOKEN || env.CRON_SECRET || '';
const base = (env) => String(env.WORKER_URL || '').replace(/\/$/, '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function signNdr(env, orderId) { const s = secret(env); return s ? (await hmacSha256hex(s, 'ndr:' + String(orderId))).slice(0, 12) : null; }
export async function verifyNdr(env, orderId, sig) { const want = await signNdr(env, orderId); return !!want && safeEqual(want, String(sig || '')); }
/** The link that goes into the ship_failed message. '' when links cannot be signed. */
export async function ndrLink(env, orderId) { const sig = await signNdr(env, orderId); return sig && base(env) ? `${base(env)}/api/wa/ndr?o=${orderId}&s=${sig}` : ''; }

/** The live booking that is sitting in NDR for this order (or this phone's newest one). */
export async function ndrShipment(env, { orderId, phone }) {
  const LIVE = "s.awb IS NOT NULL AND s.awb<>'' AND COALESCE(s.status,'')<>'cancelled' AND COALESCE(s.stage,'') IN ('ndr','ofd','transit')";
  if (orderId) return env.DB.prepare(`SELECT s.*, o.phone, o.first_name FROM shipments s JOIN orders o ON o.order_id = s.order_id WHERE s.order_id=? AND ${LIVE}`).bind(String(orderId)).first();
  return env.DB.prepare(`SELECT s.*, o.phone, o.first_name FROM shipments s JOIN orders o ON o.order_id = s.order_id WHERE o.phone=? AND ${LIVE} AND s.created_at>? ORDER BY (COALESCE(s.stage,'')='ndr') DESC, s.created_at DESC LIMIT 1`).bind(String(phone), now() - 30 * 86400).first();
}

const istToday = () => new Date(Date.now() + 19800 * 1000).toISOString().slice(0, 10);
const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= istToday() && d <= new Date(Date.now() + 10 * 86400 * 1000).toISOString().slice(0, 10);

/**
 * Apply the customer's choice. what: 'reattempt' | 'return'; date: optional YYYY-MM-DD for the re-attempt.
 * Returns a short status: 'reattempt' | 'return' | 'no-shipment' | 'already'.
 */
export async function customerNdr(env, { orderId, phone, what, date = '', via = 'link' }) {
  const rec = await ndrShipment(env, { orderId, phone });
  if (!rec) return { status: 'no-shipment' };
  const key = what === 'return' ? 'return' : 'reattempt';
  if (rec.ndr_choice === key && now() - Number(rec.ndr_choice_at || 0) < 12 * 3600) return { status: 'already', rec };
  await ndrAction(env, { awb: rec.awb, action: key === 'return' ? 'return' : 're-attempt', deferred_date: okDate(date) ? date : '', comments: key === 'return' ? 'Customer asked for return on WhatsApp' : 'Customer asked for re-attempt on WhatsApp' + (okDate(date) ? ' on ' + date : '') });
  await env.DB.prepare('UPDATE shipments SET ndr_choice=?, ndr_choice_at=?, ndr_date=?, updated_at=? WHERE order_id=?').bind(key, now(), okDate(date) ? date : null, now(), String(rec.order_id)).run().catch(() => {});
  await logMsg(env, { direction: 'in', phone: rec.phone, trigger: 'ndr-' + via, template: key.toUpperCase(), status: 'applied', orderName: rec.order_name, preview: okDate(date) ? 'on ' + date : '' });
  return { status: key, rec };
}

const nice = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 6)).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : ''; };

/** GET: the choice page. POST d=r[&date=YYYY-MM-DD] or d=x: apply it. */
export async function handleNdr(req, env0) {
  const url = new URL(req.url);
  const orderId = String(url.searchParams.get('o') || ''), sig = String(url.searchParams.get('s') || '');
  if (!/^\d{1,25}$/.test(orderId) || !/^[a-f0-9]{12}$/.test(sig) || !(await verifyNdr(env0, orderId, sig))) return page('Link not valid', 'Please use the link from your WhatsApp message.');
  const { withSettings } = await import('./settings.js');
  const env = await withSettings(env0);
  const rec = await ndrShipment(env, { orderId });
  if (!rec) return page('Delivery update', 'This parcel is not waiting for a re-attempt right now. Reply on WhatsApp if you need help.');
  const name = esc(rec.order_name);
  const trackHref = esc(`https://shiprocket.co/tracking/${rec.awb}`);
  if (req.method !== 'POST') {
    if (rec.ndr_choice && now() - Number(rec.ndr_choice_at || 0) < 12 * 3600) {
      return page(`Order ${name}`, rec.ndr_choice === 'return' ? 'Your parcel is being returned to us.' : `Delivery will be re-attempted${rec.ndr_date ? ' on ' + nice(rec.ndr_date) : ' on the next working day'}. Please keep your phone reachable.`, `<a class="btn n" href="${trackHref}">Track parcel</a>`);
    }
    const act = (d, cls, label, extra = '') => `<form method="POST" action="/api/wa/ndr?o=${orderId}&s=${sig}&d=${d}">${extra}<button class="${cls}" type="submit">${label}</button></form>`;
    const today = istToday(), max = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
    return page(`Order ${name}`, 'The courier could not deliver your parcel. What would you like us to do?',
      `<div class="row">${act('r', 'y', 'Deliver again (next working day)')}` +
      `${act('r', 'n', 'Deliver on a day I choose', `<input type="date" name="date" min="${today}" max="${max}" style="width:100%;box-sizing:border-box;margin:0 0 8px;padding:12px;border-radius:12px;border:1px solid #cfc9c1;font:inherit">`)}` +
      `${act('x', 'n', 'Return the parcel, cancel delivery')}</div><p style="margin:14px 0 0"><a href="${trackHref}" style="opacity:.7">Track parcel</a></p>`);
  }
  const d = url.searchParams.get('d');
  let date = '';
  try { const f = await req.formData(); date = String(f.get('date') || ''); } catch { /* no body */ }
  let r;
  try { r = await customerNdr(env, { orderId, what: d === 'x' ? 'return' : 'reattempt', date }); }
  catch (e) { console.error('ndr', orderId, e.message); return page(`Order ${name}`, 'We could not reach the courier right now. Please reply on WhatsApp and our team will arrange it.'); }
  if (r.status === 'return') return page(`Order ${name}`, 'Understood. The parcel will be returned to us and the order closed.');
  if (r.status === 'reattempt' || r.status === 'already') return page(`Order ${name}`, `Thank you! Delivery will be re-attempted${okDate(date) ? ' on ' + nice(date) : ' on the next working day'}. Please keep your phone reachable.`, `<a class="btn n" href="${trackHref}">Track parcel</a>`);
  return page(`Order ${name}`, 'This parcel is not waiting for a re-attempt right now.');
}

/** A WhatsApp text reply ("re-attempt" / "return") from a phone that has a parcel in NDR. Returns true when handled. */
export async function ndrReply(env, phone, action) {
  const rec = await ndrShipment(env, { phone }).catch(() => null);
  if (!rec || rec.stage !== 'ndr') return false;
  try {
    const r = await customerNdr(env, { phone, what: action === 'RETURN' ? 'return' : 'reattempt', via: 'reply' });
    if (r.status === 'return') await sendText(env, '91' + phone, `Okay, order ${rec.order_name} will be returned to us and closed.`);
    else await sendText(env, '91' + phone, `Thanks ${rec.first_name || ''}! We have asked the courier to deliver order ${rec.order_name} again on the next working day. Please keep your phone reachable.`);
  } catch (e) {
    await logMsg(env, { direction: 'in', phone, trigger: 'ndr-reply', template: action, status: 'failed', orderName: rec.order_name, error: String(e.message || e) });
    await sendText(env, '91' + phone, `We could not reach the courier just now for order ${rec.order_name}. Our team will arrange it shortly.`);
  }
  return true;
}
