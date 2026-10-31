/**
 * Order links and self-service cancel (the inkkulture.in track page, /pages/track).
 *
 *  trackLink(env, orderId)   https://www.inkkulture.in/pages/track?k=<orderId>.<sig>: every WhatsApp order / shipping
 *                            message carries it; opening it logs the customer in to that order's number (the link
 *                            only ever reaches their own WhatsApp), no code needed just to look.
 *  Cancel (until the courier picks the parcel up, never after):
 *    1. customer taps Cancel order, picks a reason
 *    2. a WhatsApp code goes to the order's number (the same OTP as checkout) and they type it
 *    3. the order is cancelled at once (booking stopped, Shopify cancelled, tagged cancelled-by-customer)
 *    If the code cannot be sent (WhatsApp down / the number has no WhatsApp / it failed to deliver), the customer can
 *    raise a cancellation request instead: it shows in the dashboard (Home > Cancellation requests, and Chats) and
 *    the team cancels it with one tap.
 */
import { hmacSha256hex, safeEqual } from './util.js';

const now = () => Math.floor(Date.now() / 1000);
export const TRACK_PAGE = 'https://www.inkkulture.in/pages/track';
export const CANCEL_REASONS = ['Ordered by mistake', 'Ordered twice', 'Want a different design', 'Delivery is too late', 'Changed my mind', 'Other'];
/* the courier does not have it yet: booked or not, pickup still pending */
const NOT_PICKED = new Set(['', 'booked', 'new', 'pending', 'pickup_pending', 'pickup_failed', 'pickup_scheduled', 'manifested', 'ready']);

const sec = (env) => env.ADMIN_SECRET || env.CRON_SECRET || env.ADMIN_TOKEN || 'ik';
export async function trackKey(env, orderId) {
  const id = String(orderId || '').replace(/\D/g, '');
  return id ? `${id}.${(await hmacSha256hex(sec(env), 'trk:' + id)).slice(0, 12)}` : '';
}
export async function readTrackKey(env, k) {
  const m = /^(\d{6,25})\.([a-f0-9]{12})$/.exec(String(k || ''));
  if (!m) return '';
  return safeEqual((await hmacSha256hex(sec(env), 'trk:' + m[1])).slice(0, 12), m[2]) ? m[1] : '';
}
export async function trackLink(env, orderId) { const k = await trackKey(env, orderId); return k ? `${TRACK_PAGE}?k=${k}` : TRACK_PAGE; }

/** Pure: can the customer still cancel this order themselves? (o: orders row + its live shipment's stage / picked_at) */
export function cancellable(o) {
  if (!o || o.status === 'cancelled' || ['pending_payment', 'failed', 'completing'].includes(o.status)) return false;
  if (o.picked_at || o.delivered_at || o.rto) return false;
  return NOT_PICKED.has(String(o.stage || '').toLowerCase());
}

async function orderOf(env, phone, name) {
  const o = await env.DB.prepare(`SELECT o.order_id, o.order_name, o.status, o.phone, o.method, s.stage, s.picked_at, s.delivered_at, s.rto
      FROM orders o LEFT JOIN shipments s ON s.order_id=o.order_id AND COALESCE(s.status,'')<>'cancelled'
      WHERE o.phone=? AND o.order_name=? AND o.order_id IS NOT NULL`).bind(phone, String(name || '')).first();
  return o || null;
}

/** Step 2: send the WhatsApp code. { ok } or { ok:false, fallback:true } when it cannot go out (offer the request). */
export async function cancelCode(env, phone, name) {
  const o = await orderOf(env, phone, name);
  if (!o) return { ok: false, error: 'Order not found on this number' };
  if (!cancellable(o)) return { ok: false, error: 'This order has already been handed to the courier, so it cannot be cancelled now.' };
  if (o.method !== 'cod') return { ok: false, request: true, error: 'Paid orders are cancelled by our team so the refund goes back to you. Raise a cancellation request.' };
  const { sendOtp } = await import('./cod-otp.js');
  const { logMsg } = await import('./whatsapp.js');
  const r = await sendOtp(env, phone, { log: (x) => logMsg(env, { direction: 'out', ...x, orderName: o.order_name }) });
  if (r.ok) return { ok: true, resend_in: r.resend_in };
  if (r.wait) return { ok: false, wait: r.wait, error: r.error };
  return { ok: false, fallback: true, error: 'We could not send a WhatsApp code to this number right now.' };
}

/** Step 3: check the code and cancel. */
export async function cancelWithCode(env, phone, name, code, reason) {
  const o = await orderOf(env, phone, name);
  if (!o) return { ok: false, error: 'Order not found on this number' };
  if (!cancellable(o)) return { ok: false, error: 'This order has already been handed to the courier, so it cannot be cancelled now.' };
  if (o.method !== 'cod') return { ok: false, request: true, error: 'Paid orders are cancelled by our team so the refund goes back to you. Raise a cancellation request.' };
  const { checkOtp } = await import('./cod-otp.js');
  const v = await checkOtp(env, phone, code);
  if (!v.ok) return { ok: false, error: v.error, expired: !!v.expired };
  const { action } = await import('./admin.js');
  const res = (await action('cancel_orders')(env, { ids: [o.order_id] })).results?.[0] || {};
  const why = CANCEL_REASONS.includes(reason) ? reason : 'Other';
  if (!res.ok) return { ok: false, error: res.note || 'Could not cancel right now, please try again.' };
  try { const { addTags } = await import('./shopify.js'); await addTags(env, `gid://shopify/Order/${o.order_id}`, ['cancelled-by-customer', 'cancel: ' + why]); } catch { /* tag is best effort */ }
  const { logMsg } = await import('./whatsapp.js');
  await logMsg(env, { direction: 'in', phone, trigger: 'self_cancel', template: why, status: res.queued ? 'queued' : 'cancelled', orderName: o.order_name, preview: `Customer cancelled ${o.order_name} on the track page (${why})` }).catch(() => {});
  await env.DB.prepare("UPDATE cancel_requests SET status='done', done_at=?, done_by='customer' WHERE order_id=? AND status='open'").bind(now(), o.order_id).run().catch(() => {});
  return { ok: true, queued: !!res.queued };
}

/** Code could not be sent: a request for the team. */
export async function cancelRequest(env, phone, name, reason) {
  const o = await orderOf(env, phone, name);
  if (!o) return { ok: false, error: 'Order not found on this number' };
  if (!cancellable(o)) return { ok: false, error: 'This order has already been handed to the courier, so it cannot be cancelled now.' };
  const why = CANCEL_REASONS.includes(reason) ? reason : 'Other';
  const have = await env.DB.prepare("SELECT id FROM cancel_requests WHERE order_id=? AND status='open'").bind(o.order_id).first();
  if (have) return { ok: true, already: true };
  await env.DB.prepare("INSERT INTO cancel_requests (order_id, order_name, phone, reason, status, created_at) VALUES (?,?,?,?,'open',?)").bind(o.order_id, o.order_name, phone, why, now()).run();
  const paid = o.method !== 'cod';
  const { logMsg } = await import('./whatsapp.js');
  await logMsg(env, { direction: 'in', phone, trigger: 'ticket', template: '', status: 'received', orderName: o.order_name, preview: `🛑 Cancellation request for ${o.order_name} (${why}). ${paid ? 'Paid online: cancel it and refund the payment in PayU.' : 'The WhatsApp code could not be sent.'} Home > Cancellation requests.` }).catch(() => {});
  try { const { openHandoff } = await import('./inbox.js'); await openHandoff(env, phone, `Cancel request ${o.order_name}`); } catch { /* best effort */ }
  return { ok: true };
}

/** Dashboard. */
export async function listRequests(env) {
  const rows = (await env.DB.prepare(`SELECT r.*, s.stage, s.picked_at, s.awb, o.status AS order_status, o.method FROM cancel_requests r
      JOIN orders o ON o.order_id=r.order_id LEFT JOIN shipments s ON s.order_id=r.order_id AND COALESCE(s.status,'')<>'cancelled'
      WHERE r.status='open' ORDER BY r.created_at DESC LIMIT 50`).all()).results;
  return rows.map((r) => ({ id: r.id, order_id: r.order_id, order: r.order_name, phone: r.phone, reason: r.reason, at: Number(r.created_at), paid: r.method !== 'cod',
    can: cancellable({ status: r.order_status, stage: r.stage, picked_at: r.picked_at }), stage: r.stage || (r.awb ? 'booked' : 'not booked') }));
}
export async function closeRequest(env, id, how) {
  const r = await env.DB.prepare("SELECT * FROM cancel_requests WHERE id=? AND status='open'").bind(Number(id)).first();
  if (!r) throw new Error('Request not found or already handled');
  if (how === 'cancel') {
    const { action } = await import('./admin.js');
    const res = (await action('cancel_orders')(env, { ids: [r.order_id] })).results?.[0] || {};
    if (!res.ok && !/Already cancelled/i.test(res.note || '')) throw new Error(res.note || 'Could not cancel');
    try { const { addTags } = await import('./shopify.js'); await addTags(env, `gid://shopify/Order/${r.order_id}`, ['cancelled-by-customer', 'cancel: ' + r.reason]); } catch { /* best effort */ }
  }
  await env.DB.prepare('UPDATE cancel_requests SET status=?, done_at=?, done_by=? WHERE id=?').bind(how === 'cancel' ? 'done' : 'dismissed', now(), 'team', r.id).run();
  return { ok: true };
}

/** Shown at the bottom of the track page. */
export const FAQS = [
  ['When will my order arrive?', 'Most orders reach you 3-6 days after they are handed to the courier. The expected date for your order is shown above, and you get the tracking link on WhatsApp the moment it ships.'],
  ['Can I cancel my order?', 'Yes, until it is handed to the courier. Tap "Cancel order" on the order and confirm with the 4-digit code we send on WhatsApp. Once the courier has picked it up it cannot be cancelled.'],
  ['I paid online. How do I get my money back if I cancel?', 'Tap "Cancel order" before it ships: our team cancels it and the full amount goes back to the same UPI / card / bank within 5-7 working days.'],
  ['Can I change my delivery address or phone number?', 'Yes, before it ships: use the "Edit address" button in our WhatsApp message, or raise a request below. After it ships we can only pass small changes in the same city to the courier.'],
  ['How do I pay for a Cash on Delivery order?', 'Pay the courier in cash or by UPI when the parcel arrives. Keeping the exact amount ready helps.'],
  ['The courier says I was not available, but nobody came.', 'Raise a request below with "Where is my order". We push the courier for another attempt every night, and it is not counted against you.'],
  ['How long does the tattoo last?', 'It is semi-permanent: about 1-2 weeks depending on your skin, sometimes fewer days on very sensitive or oily skin. Then it fades on its own.'],
  ['How do I apply it?', 'Watch the 1-minute video above and follow the 4 steps. Most patchy results come from skipping the skin wipe or not pressing for the full 30 seconds.'],
  ['My design is wrong, damaged or did not come out well.', 'We replace it within 7 days of delivery. Raise a request below with a photo and we will sort it out on WhatsApp.'],
];
