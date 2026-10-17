// src/lib/ship-cancel.js — an order is cancelled while its Shiprocket parcel is booked.
//
// Not picked up yet  -> cancel the Shiprocket shipment (that also drops the pickup request), undo our Shopify
//                       fulfilment for that AWB, and the order becomes cancelled everywhere.
// Already picked up  -> nothing can stop the courier from here: the shipment is flagged "cancelled after pickup"
//                       (dashboard + Shopify tag) so the owner can ask for RTO.
// Tracking unknown   -> nothing is cancelled blind; it is retried on the next cron run.
//
// Called from every cancel path (dashboard, the customer's WhatsApp "Cancel", the cron sweep below), and the sweep
// also catches orders cancelled anywhere else: in Shopify itself, or tagged as cancelled by another COD app.

import { srTrack, cancelShipment } from './shiprocket.js';
import { classify } from './wa-ship.js';
import { addTags, cancelOrder, cancelFulfilmentsFor, ordersCancelState, ordersShipState } from './shopify.js';

const now = () => Math.floor(Date.now() / 1000);
/** Tags other apps / our own flows put on an order the customer cancelled. */
export const CANCEL_TAG = /cod[-_ ]?cancel|cancell?ed[-_ ]by[-_ ]customer|customer[-_ ]cancell?ed/i;
const LIVE = "awb IS NOT NULL AND awb<>'' AND COALESCE(status,'')<>'cancelled'";

const setState = (env, id, state, note) => env.DB.prepare('UPDATE shipments SET cancel_state=?, cancel_note=?, updated_at=? WHERE order_id=?').bind(state, String(note || '').slice(0, 400), now(), String(id)).run();

/** Is there a booked (not cancelled) Shiprocket shipment for this order? */
export async function liveShipment(env, orderId) {
  return env.DB.prepare(`SELECT * FROM shipments WHERE order_id=? AND ${LIVE}`).bind(String(orderId)).first();
}

/**
 * Stop the parcel for a cancelled order. Never throws.
 * Returns { state: 'none' | 'cancelled' | 'picked' | 'error', note }.
 */
export async function stopShipment(env, orderId, why = 'Order cancelled') {
  const id = String(orderId);
  let rec;
  try { rec = await liveShipment(env, id); } catch (e) { return { state: 'error', note: String(e.message || e) }; }
  if (!rec) return { state: 'none' };
  if (rec.cancel_state === 'picked') return { state: 'picked', note: rec.cancel_note || '' };

  /* 1. has the courier already got it? (tracking first: never cancel blind) */
  let c;
  try { c = classify(await srTrack(env, rec.awb)); }
  catch (e) { const note = 'Could not check tracking, will retry: ' + String(e.message || e).slice(0, 200); await setState(env, id, 'error', note).catch(() => {}); return { state: 'error', note }; }
  if (c.stage !== 'pending') {
    const note = `${why}, but the courier already has the parcel (${c.stage}). Ask Shiprocket for RTO.`;
    await setState(env, id, 'picked', note).catch(() => {});
    await addTags(env, `gid://shopify/Order/${id}`, ['cancelled-after-pickup']).catch(() => {});
    return { state: 'picked', note };
  }

  /* 2. cancel in Shiprocket: removes the AWB from the pickup */
  try {
    if (!rec.sr_order_id) throw new Error('no Shiprocket order id saved for this shipment');
    await cancelShipment(env, rec);
  } catch (e) {
    if (!/already\s+cancel/i.test(String(e.message))) {
      const note = 'Shiprocket cancel failed, will retry: ' + String(e.message || e).slice(0, 200);
      await setState(env, id, 'error', note).catch(() => {});
      return { state: 'error', note };
    }
  }
  const t = now();
  await env.DB.prepare("UPDATE shipments SET status='cancelled', cancel_state='cancelled', cancel_note=?, updated_at=? WHERE order_id=?").bind(String(why).slice(0, 400), t, id).run();
  await env.DB.prepare("UPDATE ship_track SET done=TRUE, status='cancelled', updated_at=? WHERE order_id=?").bind(t, id).run().catch(() => {});
  await env.DB.prepare('UPDATE orders SET shipped_at=NULL, tracking=NULL WHERE order_id=?').bind(id).run();

  /* 3. undo our Shopify fulfilment so the order can be cancelled there (Shopify refuses while it is fulfilled) */
  let note = '';
  try { await cancelFulfilmentsFor(env, id, rec.awb); } catch (e) { note = String(e.message || e).slice(0, 200); }
  return { state: 'cancelled', note };
}

/**
 * Orders cancelled outside this dashboard (in Shopify itself, or tagged cancelled by another COD app) are still
 * "placed" here and show under To ship. Check these ids with Shopify and mark the cancelled ones. Returns their ids.
 */
export async function syncCancelledOrders(env, ids) {
  ids = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  const shop = await ordersCancelState(env, ids);
  const gone = ids.filter((id) => { const s = shop[id]; return s && (s.cancelled || s.tags.some((t) => CANCEL_TAG.test(t))); });
  for (const id of gone) await env.DB.prepare("UPDATE orders SET status='cancelled' WHERE order_id=? AND COALESCE(status,'')<>'cancelled'").bind(id).run();
  return gone;
}

/**
 * Orders Shopify shows as fulfilled (by another app, by hand, or by a booking whose record here was reset) but that still
 * count as "to ship" here: mark them shipped with whatever tracking Shopify has. Returns the ids marked.
 */
export async function syncFulfilledOrders(env, ids) {
  ids = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  const shop = await ordersShipState(env, ids), done = [];
  for (const id of ids) {
    const s = shop[id];
    if (!s || s.cancelled || !s.fulfilments.length) continue;
    const f = s.fulfilments.find((x) => x.numbers.length) || s.fulfilments[0];
    const tracking = f.numbers.length ? `${f.company || 'Courier'} ${f.numbers[0]}` : 'Fulfilled in Shopify';
    await env.DB.prepare('UPDATE orders SET shipped_at=?, tracking=? WHERE order_id=? AND shipped_at IS NULL').bind(f.at || now(), tracking, id).run();
    done.push(id);
  }
  return done;
}

/**
 * Cron: booked parcels whose order has been cancelled anywhere (our dashboard / WhatsApp, Shopify, or a
 * "COD cancelled" tag from another app). Not picked up -> pickup cancelled and the order cancelled in Shopify too.
 */
export async function sweepCancelled(env, { maxStops = 10 } = {}) {
  const out = { checked: 0, stopped: 0, late: 0, retry: 0 };
  const rows = (await env.DB.prepare(`SELECT s.order_id, s.order_name, o.status AS order_status FROM shipments s LEFT JOIN orders o ON o.order_id = s.order_id
      WHERE s.awb IS NOT NULL AND s.awb<>'' AND COALESCE(s.status,'')<>'cancelled' AND COALESCE(s.cancel_state,'') NOT IN ('picked','cancelled')
        AND COALESCE(s.rto, FALSE) = FALSE AND LOWER(COALESCE(s.status,'')) NOT IN ('delivered','rto_initiated') AND s.created_at > ?
      ORDER BY s.created_at DESC LIMIT 150`).bind(now() - 30 * 86400).all()).results;
  out.checked = rows.length;
  if (!rows.length) return out;
  const shop = await ordersCancelState(env, rows.map((r) => String(r.order_id)));
  let stops = 0;
  for (const r of rows) {
    const id = String(r.order_id), s = shop[id] || { cancelled: false, tags: [] };
    const tag = s.tags.find((x) => CANCEL_TAG.test(x));
    if (!(r.order_status === 'cancelled' || s.cancelled || tag)) continue;
    if (stops++ >= maxStops) break;
    const why = s.cancelled ? 'Order cancelled in Shopify' : r.order_status === 'cancelled' ? 'Order cancelled' : `Customer cancelled (tag "${tag}")`;
    const res = await stopShipment(env, id, why);
    if (res.state === 'picked') out.late++;
    else if (res.state === 'error') out.retry++;
    else if (res.state === 'cancelled') {
      out.stopped++;
      if (!s.cancelled) {
        try { await cancelOrder(env, `gid://shopify/Order/${id}`, why + ' (shipment cancelled before pickup)'); }
        catch (e) { await setState(env, id, 'cancelled', why + '. Shopify order not cancelled: ' + String(e.message || e).slice(0, 200)).catch(() => {}); }
      }
      await env.DB.prepare("UPDATE orders SET status='cancelled' WHERE order_id=?").bind(id).run();
    }
  }
  return out;
}
