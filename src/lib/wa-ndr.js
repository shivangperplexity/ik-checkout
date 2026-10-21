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
  const LIVE = "LENGTH(s.awb) > 0 AND COALESCE(s.status,'')<>'cancelled' AND COALESCE(s.stage,'') IN ('ndr','ofd','transit')";
  if (orderId) return env.DB.prepare(`SELECT s.*, o.phone, o.first_name FROM shipments s JOIN orders o ON o.order_id = s.order_id WHERE s.order_id=? AND ${LIVE}`).bind(String(orderId)).first();
  return env.DB.prepare(`SELECT s.*, o.phone, o.first_name FROM shipments s JOIN orders o ON o.order_id = s.order_id WHERE o.phone=? AND ${LIVE} AND s.created_at>? ORDER BY (COALESCE(s.stage,'')='ndr') DESC, s.created_at DESC LIMIT 1`).bind(String(phone), now() - 30 * 86400).first();
}

const istToday = () => new Date(Date.now() + 19800 * 1000).toISOString().slice(0, 10);
const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= istToday() && d <= new Date(Date.now() + 10 * 86400 * 1000).toISOString().slice(0, 10);

/**
 * Apply the customer's choice. what: 'reattempt' | 'return'; date: optional YYYY-MM-DD for the re-attempt.
 * Returns a short status: 'reattempt' | 'return' | 'no-shipment' | 'already'.
 */
export async function customerNdr(env, { orderId, phone, what, date = '', via = 'link', address1 = '', address2 = '', altPhone = '' }) {
  const rec = await ndrShipment(env, { orderId, phone });
  if (!rec) return { status: 'no-shipment' };
  const key = what === 'return' ? 'return' : 'reattempt';
  const fix = key === 'reattempt' && (address1 || address2 || altPhone);
  if (!fix && rec.ndr_choice === key && now() - Number(rec.ndr_choice_at || 0) < 48 * 3600 && rec.ndr_by !== 'auto') return { status: 'already', rec };
  const a1 = String(address1 || '').trim().slice(0, 200), a2 = String(address2 || '').trim().slice(0, 200);
  const ph = /^[6-9]\d{9}$/.test(String(altPhone || '').replace(/\D/g, '').slice(-10)) ? String(altPhone).replace(/\D/g, '').slice(-10) : '';
  const notes = [okDate(date) ? 'on ' + date : '', a1 || a2 ? 'new address: ' + [a1, a2].filter(Boolean).join(', ') : '', ph ? 'call ' + ph : ''].filter(Boolean).join('; ');
  await ndrAction(env, { awb: rec.awb, action: key === 'return' ? 'return' : 're-attempt', deferred_date: okDate(date) ? date : '', address1: a1, address2: a2, phone: ph,
    comments: key === 'return' ? 'Customer asked for return on WhatsApp' : 'Customer asked for re-attempt on WhatsApp' + (notes ? ' (' + notes + ')' : '') });
  await env.DB.prepare('UPDATE shipments SET ndr_choice=?, ndr_choice_at=?, ndr_date=?, ndr_by=?, updated_at=? WHERE order_id=?').bind(key, now(), okDate(date) ? date : null, 'customer', now(), String(rec.order_id)).run().catch(() => {});
  /* keep Shopify's copy of the address in step (best effort: the courier already has the new one) */
  if (a1 || a2) await updateShopifyAddress(env, rec.order_id, { address1: a1, address2: a2 }).catch((e) => console.error('ndr address', e.message));
  await logMsg(env, { direction: 'in', phone: rec.phone, trigger: 'ndr-' + via, template: key.toUpperCase(), status: 'applied', orderName: rec.order_name, preview: notes.replace(/new address: .*?(;|$)/, 'new address given$1') });
  return { status: key, rec };
}

async function updateShopifyAddress(env, orderId, { address1, address2 }) {
  const { orderDetail, gql } = await import('./shopify.js');
  const o = await orderDetail(env, orderId);
  const a = o?.shippingAddress;
  if (!a) return;
  const [firstName, ...rest] = String(a.name || '').split(' ');
  await gql(env, 'mutation($input:OrderInput!){ orderUpdate(input:$input){ userErrors{ message } } }', { input: { id: `gid://shopify/Order/${orderId}`,
    shippingAddress: { firstName, lastName: rest.join(' '), address1: address1 || a.address1, address2: address2 || a.address2 || '', city: a.city, province: a.province, zip: a.zip, phone: a.phone, countryCode: 'IN' } } });
}

const nice = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 6)).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : ''; };

const REASON_TEXT = { not_available: 'nobody was available to receive it', phone: 'they could not reach you on the phone', address: 'they could not find the address', cash: 'the cash was not ready', future: 'you asked for another day', refused: 'the delivery was refused or cancelled', courier: 'of a problem on their side', other: '' };

/** GET: the choice page. POST d=r[&date=YYYY-MM-DD][&address1&address2&phone] or d=x: apply it. */
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
  const { classifyNdr } = await import('./ndr-rules.js');
  const cat = classifyNdr(rec.ndr_reason || '');
  if (req.method !== 'POST') {
    const recent = rec.ndr_choice && now() - Number(rec.ndr_choice_at || 0) < 48 * 3600;
    if (recent && rec.ndr_by !== 'auto') {
      return page(`Order ${name}`, rec.ndr_choice === 'return' ? 'Your parcel is being returned to us.' : `Delivery will be re-attempted${rec.ndr_date ? ' on ' + nice(rec.ndr_date) : ' on the next working day'}. Please keep your phone reachable.`, `<a class="btn n" href="${trackHref}">Track parcel</a>`);
    }
    const act = (d, cls, label, extra = '') => `<form method="POST" action="/api/wa/ndr?o=${orderId}&s=${sig}&d=${d}">${extra}<button class="${cls}" type="submit">${label}</button></form>`;
    const inp = 'style="width:100%;box-sizing:border-box;margin:0 0 8px;padding:12px;border-radius:12px;border:1px solid #cfc9c1;font:inherit"';
    const today = istToday(), max = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
    const why = REASON_TEXT[cat] ? `The courier says ${REASON_TEXT[cat]}.` : 'The courier could not deliver your parcel.';
    const autoNote = recent && rec.ndr_by === 'auto' && rec.ndr_choice === 'reattempt' ? `<p style="margin:0 0 14px;font-size:14px">We have already asked the courier to try again${rec.ndr_date ? ' on ' + nice(rec.ndr_date) : ''}. You can change it below.</p>` : '';
    /* address / phone problems: let them fix it right here, the courier gets it with the re-attempt */
    let addr = null;
    if (['address', 'phone', 'not_available', 'other'].includes(cat)) { try { const { orderDetail } = await import('./shopify.js'); addr = (await orderDetail(env, orderId))?.shippingAddress || null; } catch { addr = null; } }
    const fixForm = ['address', 'phone', 'not_available', 'other'].includes(cat)
      ? act('r', cat === 'address' || cat === 'phone' ? 'y' : 'n', cat === 'phone' ? 'Deliver again on this number' : 'Deliver again to this address',
        (cat !== 'phone' ? `<input name="address1" ${inp} placeholder="House / flat no., building" value="${esc(addr?.address1 || '')}"><input name="address2" ${inp} placeholder="Area, street, landmark" value="${esc(addr?.address2 || '')}">` : '') +
        `<input name="phone" ${inp} type="tel" inputmode="numeric" maxlength="10" placeholder="Phone the courier should call (optional)">` +
        `<input type="date" name="date" min="${today}" max="${max}" ${inp} aria-label="Day (optional)">`)
      : '';
    const title = cat === 'refused' ? 'Do you still want your order?' : `Order ${name}`;
    const lead = cat === 'refused' ? `Order ${name} was not delivered: ${REASON_TEXT.refused}. If that was a mistake, we can send it again.` : `${why} What would you like us to do?`;
    return page(title, lead, autoNote +
      `<div class="row">${fixForm}${act('r', fixForm && (cat === 'address' || cat === 'phone') ? 'n' : 'y', cat === 'refused' ? 'Yes, deliver it again' : 'Deliver again (next working day)')}` +
      `${cat !== 'refused' ? act('r', 'n', 'Deliver on a day I choose', `<input type="date" name="date" min="${today}" max="${max}" ${inp}>`) : ''}` +
      `${act('x', 'n', cat === 'refused' ? 'No, I don’t want it' : 'Return the parcel, cancel delivery')}</div><p style="margin:14px 0 0"><a href="${trackHref}" style="opacity:.7">Track parcel</a></p>`);
  }
  const d = url.searchParams.get('d');
  let date = '', address1 = '', address2 = '', altPhone = '';
  try { const f = await req.formData(); date = String(f.get('date') || ''); address1 = String(f.get('address1') || ''); address2 = String(f.get('address2') || ''); altPhone = String(f.get('phone') || ''); } catch { /* no body */ }
  /* an unchanged prefilled address is not a change */
  if (address1 || address2) { try { const { orderDetail } = await import('./shopify.js'); const a = (await orderDetail(env, orderId))?.shippingAddress || {}; if (address1.trim() === String(a.address1 || '').trim() && address2.trim() === String(a.address2 || '').trim()) { address1 = ''; address2 = ''; } } catch { /* send it anyway */ } }
  let r;
  try { r = await customerNdr(env, { orderId, what: d === 'x' ? 'return' : 'reattempt', date, address1, address2, altPhone }); }
  catch (e) { console.error('ndr', orderId, e.message); return page(`Order ${name}`, 'We could not reach the courier right now. Please reply on WhatsApp and our team will arrange it.'); }
  if (r.status === 'return') return page(`Order ${name}`, 'Understood. The parcel will be returned to us and the order closed.');
  if (r.status === 'reattempt' || r.status === 'already') return page(`Order ${name}`, `Thank you! Delivery will be re-attempted${okDate(date) ? ' on ' + nice(date) : ' on the next working day'}${address1 || address2 ? ' at the address you gave' : ''}. Please keep your phone reachable.`, `<a class="btn n" href="${trackHref}">Track parcel</a>`);
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
