/**
 * Go4WhatsUp inbound: the quick-reply webhook, the one-tap confirm link, and the auto-cancel sweep.
 * Routed from src/api/[[...slug]].js so src/lib/app.js stays untouched.
 *   POST /api/wa/g4w?k=<G4W_WEBHOOK_SECRET>   <- register in Go4WhatsUp: API -> Webhook -> Receive Message
 *   GET  /api/wa/act?o=<orderId>&s=<sig>      <- the link inside the cod_order_confirm body
 */
import { addTags, removeTags, cancelOrder } from './shopify.js';
import { withSettings } from './settings.js';
import { logMsg, sendText } from './whatsapp.js';
import { parseInbound, replyAction } from './go4whatsup.js';
import { verifyOrder, linkShapeOk } from './wa-token.js';
import { safeEqual } from './util.js';
import { stopShipment, liveShipment } from './ship-cancel.js';

const now = () => Math.floor(Date.now() / 1000);
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const PENDING_TTL = 7 * 86400;
const rs = (paise) => '₹' + Math.round(Number(paise || 0) / 100);

/** Apply CONFIRM / CANCEL to one order. Idempotent. Returns a short status string. */
export async function applyAction(env, row, action, opts = {}) {
  const gid = `gid://shopify/Order/${row.order_id}`;
  if (row.converted_at || row.status === 'paid') return 'already-paid';
  if (action === 'CONFIRM') {
    if (row.status === 'cancelled') return 'already-cancelled';
    if (row.confirmed_at) return 'already-confirmed';
    /* claim first so two taps arriving together tag the order once */
    const claim = await env.DB.prepare('UPDATE orders SET confirmed_at=? WHERE order_id=? AND confirmed_at IS NULL RETURNING order_id').bind(now(), String(row.order_id)).first();
    if (!claim) return 'already-confirmed';
    await removeTags(env, gid, ['cod-unconfirmed']);
    await addTags(env, gid, ['cod-confirmed']);
    return 'confirmed';
  }
  if (row.confirmed_at && !opts.force) return 'already-confirmed';
  if (row.status === 'cancelled') return 'already-cancelled';
  /* The owner shipped it anyway: the "no reply" auto-cancel leaves booked parcels alone (a customer's own Cancel does not). */
  if (opts.auto && await liveShipment(env, row.order_id)) return 'already-shipped';
  const claim = await env.DB.prepare("UPDATE orders SET status='cancelled' WHERE order_id=? AND status='placed' AND confirmed_at IS NULL AND converted_at IS NULL RETURNING order_id").bind(String(row.order_id)).first();
  if (!claim) return 'already-cancelled';
  const undo = () => env.DB.prepare("UPDATE orders SET status='placed' WHERE order_id=?").bind(String(row.order_id)).run();
  /* Booked with Shiprocket? Stop the pickup first (Shopify will not cancel an order that is still fulfilled). */
  const stop = await stopShipment(env, row.order_id, opts.note || 'Customer cancelled via WhatsApp');
  if (stop.state === 'picked') {
    await undo();
    await addTags(env, gid, ['cancel-requested-after-pickup']).catch(() => {});
    throw new Error('Customer asked to cancel but the courier already picked the parcel up: ' + stop.note);
  }
  try {
    await cancelOrder(env, gid, opts.note || 'Customer cancelled via WhatsApp');
  } catch (e) {
    /* The shipment could not be stopped yet: keep it cancelled here, the cron sweep finishes it (pickup + Shopify). */
    if (stop.state === 'error') {
      await removeTags(env, gid, ['cod-unconfirmed']).catch(() => {});
      await addTags(env, gid, [opts.tag || 'cod-cancelled-by-customer']).catch(() => {});
      return 'cancelled';
    }
    /* Shopify refused (e.g. already fulfilled): undo our side so the dashboard tells the truth. */
    await undo();
    throw e;
  }
  await removeTags(env, gid, ['cod-unconfirmed']).catch(() => {});
  await addTags(env, gid, [opts.tag || 'cod-cancelled-by-customer']).catch(() => {});
  return 'cancelled';
}

const clearPending = (env, phone) => env.DB.prepare('DELETE FROM wa_pending WHERE phone=?').bind(phone).run();

/**
 * Resolve a bare button tap (phone + label, no payload) back to one order:
 *  1. the order we actually sent the buttons for (wa_pending, under 7 days old), else
 *  2. that phone's newest still-unconfirmed COD order.
 */
export async function resolveOrder(env, phone) {
  const p = await env.DB.prepare('SELECT * FROM wa_pending WHERE phone=?').bind(phone).first();
  if (p && now() - Number(p.sent_at || 0) < PENDING_TTL) {
    const row = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(String(p.order_id)).first();
    if (row) return row;
  }
  return env.DB.prepare(
    "SELECT * FROM orders WHERE phone=? AND method='cod' AND status='placed' AND confirmed_at IS NULL AND created_at>? ORDER BY created_at DESC LIMIT 1",
  ).bind(phone, now() - PENDING_TTL).first();
}

export async function handleG4w(req0, env0, ctx) {
  const url = new URL(req0.url);
  if (!env0.G4W_WEBHOOK_SECRET || !safeEqual(String(url.searchParams.get('k') || ''), env0.G4W_WEBHOOK_SECRET)) {
    return new Response('forbidden', { status: 403 });
  }
  if (req0.method !== 'POST') return new Response('ok'); /* some panels probe with GET */
  const raw = await req0.text();
  let payload;
  try { payload = JSON.parse(raw); } catch {
    try { payload = Object.fromEntries(new URLSearchParams(raw)); } catch { return new Response('ok'); }
  }

  ctx.waitUntil((async () => {
    const env = await withSettings(env0);
    const msgs = parseInbound(payload);
    /* The inbound shape is undocumented: keep the raw body in the log until the parser has proven itself. */
    if (!msgs.length) {
      await logMsg(env, { direction: 'in', trigger: 'g4w-raw', status: 'unparsed', preview: raw.slice(0, 300) });
      return;
    }
    await processInbound(env, msgs.map((m) => ({ ...m, via: 'g4w' })));
  })().catch((e) => console.error('g4w', e)));

  return new Response('ok');
}


/** Shared by the Go4WhatsUp webhook and the Meta webhook: act on customer replies ({ from: 10 digits, text }). */
export async function processInbound(env0, msgs) {
  for (const m of msgs) {
    /* everything sent back in this conversation leaves from the number the customer wrote to */
    const env = m.via ? Object.assign(Object.create(null), env0, { REPLY_ROUTE: { via: m.via, phoneId: m.phoneId || '' } }) : env0;
    const action = replyAction(m.text);
    await logMsg(env, { direction: 'in', phone: m.from, trigger: 'reply', template: action || '', status: 'received', wamid: m.via ? `in:${m.via}${m.phoneId ? ':' + m.phoneId : ''}` : '', preview: m.text });
    if (action === 'STOP') {
      await env.DB.prepare('INSERT INTO wa_optout (phone, at) VALUES (?,?) ON CONFLICT(phone) DO UPDATE SET at=excluded.at').bind(m.from, now()).run();
      await sendText(env, '91' + m.from, 'You will not get offers from Ink Kulture on WhatsApp any more. Order updates still come here. Reply START to undo.');
      continue;
    }
    if (action === 'START') {
      await env.DB.prepare('DELETE FROM wa_optout WHERE phone=?').bind(m.from).run();
      await sendText(env, '91' + m.from, 'Done, you are subscribed to Ink Kulture updates again.');
      continue;
    }
    if (!action) {
      /* plain text: the assistant answers from the store knowledge + this customer's orders (lib/wa-ai.js), when switched on */
      try { const { aiReply } = await import('./wa-ai.js'); await aiReply(env, m.from, m.text); } catch (e) { console.error('wa-ai', e.message); }
      continue;
    }
    /* a parcel waiting after a failed delivery: the customer decides re-attempt / return right here */
    if (action === 'REATTEMPT' || action === 'RETURN') { const { ndrReply } = await import('./wa-ndr.js'); if (!(await ndrReply(env, m.from, action))) await sendText(env, '91' + m.from, 'There is no parcel waiting for a re-attempt on this number right now. Reply with your order number if you need help.'); continue; }
    const row = await resolveOrder(env, m.from);
    if (!row || row.method !== 'cod') continue;
    let result;
    try { result = await applyAction(env, row, action); } catch (e) {
      await logMsg(env, { direction: 'in', phone: m.from, trigger: 'reply', template: action, status: 'failed', orderName: row.order_name, error: String(e.message || e) });
      await sendText(env, '91' + m.from, `We could not update order ${row.order_name} automatically. Our team will message you shortly.`);
      continue;
    }
    await clearPending(env, m.from);
    await logMsg(env, { direction: 'in', phone: m.from, trigger: 'reply', template: action, status: result, orderName: row.order_name });
    if (result === 'confirmed') {
      await sendText(env, '91' + m.from, `Thanks ${row.first_name || ''}! Order ${row.order_name} is confirmed. We'll pack and ship it soon.`);
      const { sendAddressCheck } = await import('./wa-address.js');
      await sendAddressCheck(env, row);
    }
    else if (result === 'cancelled') await sendText(env, '91' + m.from, `Order ${row.order_name} has been cancelled. You can order again anytime at inkkulture.in`);
    else if (result === 'already-confirmed') await sendText(env, '91' + m.from, `Order ${row.order_name} is already confirmed. We'll ship it soon.`);
    else if (result === 'already-cancelled') await sendText(env, '91' + m.from, `Order ${row.order_name} was already cancelled.`);
  }
}

/* ---------------- one-tap link ---------------- */

export const page = (title, msg, extra = '') => new Response(
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} · Ink Kulture</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f4f0;color:#141414;padding:16px;box-sizing:border-box}
  .card{background:#fff;border:1px solid #e7e3dd;border-radius:18px;padding:28px 24px;max-width:380px;width:100%;text-align:center;box-sizing:border-box}
  .brand{font-weight:800;letter-spacing:.14em;font-size:12px;opacity:.6;margin-bottom:14px}
  h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;opacity:.78}
  .row{display:grid;gap:10px}
  button,.btn{font:inherit;font-weight:700;border:0;border-radius:999px;padding:14px 20px;cursor:pointer;width:100%;text-decoration:none;display:block;box-sizing:border-box}
  .y{background:#0a0a0c;color:#fff}.n{background:transparent;color:inherit;border:1px solid #cfc9c1}
  .amt{font-size:32px;font-weight:750;margin:2px 0}.was{opacity:.55;text-decoration:line-through}
  @media(prefers-color-scheme:dark){body{background:#131211;color:#f3f1ee}.card{background:#1d1b19;border-color:#2e2b28}.y{background:#f3f1ee;color:#131211}.n{border-color:#4a4642}}
</style>
<div class="card"><div class="brand">INK KULTURE</div><h1>${title}</h1><p>${msg}</p>${extra}</div></html>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } },
);

/* Opening the link only SHOWS the order; confirming or cancelling needs a tap on the page. WhatsApp and
   other link previewers fetch the bare URL, so they can never act on an order by accident. */
export async function handleAct(req, env0) {
  const url = new URL(req.url);
  const orderId = String(url.searchParams.get('o') || '');
  const sig = String(url.searchParams.get('s') || '');
  const d = url.searchParams.get('d');
  if (!linkShapeOk(orderId, sig) || !(await verifyOrder(env0, orderId, sig))) return page('Link not valid', 'Please use the link from your WhatsApp message.');
  const env = await withSettings(env0);
  const row = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(orderId).first();
  if (!row) return page('Order not found', 'We could not find that order.');
  const name = esc(row.order_name);

  if (!d || req.method !== 'POST') {
    if (row.converted_at || row.status === 'paid') return page(`Order ${name}`, 'Paid online. Thank you! We will ship it soon.');
    if (row.confirmed_at) return page(`Order ${name}`, 'Already confirmed. Thank you! We will ship it soon.');
    if (row.status === 'cancelled') return page(`Order ${name}`, 'This order was cancelled.');
    const form = (dv, cls, label) => `<form method="POST" action="/api/wa/act?o=${orderId}&s=${sig}&d=${dv}"><button class="${cls}" type="submit">${label}</button></form>`;
    return page(`Order ${name}`, `Cash on Delivery · ${rs(row.total_paise)}. Please confirm so we can pack and ship it today.`,
      `<div class="row">${form('c', 'y', 'Yes, confirm my order')}${form('x', 'n', 'No, cancel it')}</div>`);
  }

  const action = d === 'c' ? 'CONFIRM' : 'CANCEL';
  let result;
  try { result = await applyAction(env, row, action); } catch (e) {
    console.error('act', orderId, e.message);
    return page(`Order ${name}`, 'We could not update this order right now. Please reply on WhatsApp and our team will help.');
  }
  await env.DB.prepare('DELETE FROM wa_pending WHERE order_id=?').bind(orderId).run().catch(() => {});
  await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'link', template: action, status: result, orderName: row.order_name });
  if (result === 'confirmed') {
    /* Show where it is going, with a way to fix it. Read live from Shopify; nothing is stored here. */
    let extra = '';
    try {
      const { fmtAddress, editable } = await import('./wa-address.js');
      const { orderDetail } = await import('./shopify.js');
      const { addrLink } = await import('./wa-token.js');
      const o = await orderDetail(env, orderId);
      if (o?.shippingAddress && editable(o)) extra = `<p style="text-align:left;background:rgba(127,127,127,.08);border-radius:12px;padding:12px 14px;margin:0 0 14px"><b>Delivering to</b><br>${esc(fmtAddress(o.shippingAddress)).replace(/\n/g, '<br>')}</p><a class="btn n" href="${esc(await addrLink(env, orderId))}">Edit address</a>`;
    } catch (e) { console.error('act addr', orderId, e.message); }
    return page(`Order ${name} confirmed`, "Thank you! We'll pack it and ship it soon.", extra);
  }
  if (result === 'cancelled') return page(`Order ${name} cancelled`, 'Your order has been cancelled. You can order again anytime.', `<a class="btn y" href="${esc(env.STORE_URL || 'https://www.inkkulture.in')}">Back to Ink Kulture</a>`);
  if (result === 'already-paid') return page(`Order ${name}`, 'Paid online. Thank you! We will ship it soon.');
  return page(`Order ${name}`, result === 'already-confirmed' ? 'Already confirmed. Thank you!' : 'This order was already cancelled.');
}

/* ---------------- auto-cancel ---------------- */

/**
 * Cancel COD orders nobody confirmed. Off unless COD_AUTOCANCEL_HOURS is set (48 is sensible): it cancels
 * real orders, so it is a deliberate choice. Max 25 per run; never touches converted or confirmed orders.
 */
export async function autoCancelStale(env0) {
  const hours = Number(env0.COD_AUTOCANCEL_HOURS || 0);
  if (!hours || !env0.DB) return { autoCancelled: 0, skipped: 'off' };
  const env = await withSettings(env0);
  const { results } = await env.DB.prepare(
    "SELECT * FROM orders WHERE method='cod' AND status='placed' AND confirmed_at IS NULL AND converted_at IS NULL AND order_id IS NOT NULL AND created_at<? ORDER BY created_at LIMIT 25",
  ).bind(now() - hours * 3600).all();
  let n = 0;
  for (const row of results) {
    try {
      const r = await applyAction(env, row, 'CANCEL', { auto: true, tag: 'cod-cancelled-no-response', note: `Auto-cancelled: no WhatsApp confirmation within ${hours}h` });
      if (r === 'cancelled') n++;
      await env.DB.prepare('DELETE FROM wa_pending WHERE order_id=?').bind(String(row.order_id)).run();
      await logMsg(env, { direction: 'out', phone: row.phone, trigger: 'auto_cancel', template: r, status: r, orderName: row.order_name });
    } catch (e) {
      console.error('autoCancel', row.order_id, e.message);
      await logMsg(env, { direction: 'out', phone: row.phone, trigger: 'auto_cancel', status: 'failed', orderName: row.order_name, error: String(e.message || e) }).catch(() => {});
    }
  }
  return { autoCancelled: n };
}
