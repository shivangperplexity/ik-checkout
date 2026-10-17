// src/lib/ship-audit.js — the reconciliation agent for shipping.
//
// Three systems hold a view of every order: Shopify (cancelled? fulfilled? which AWB?), Shiprocket (where the parcel
// is), and this dashboard's own tables (orders.status / shipped_at, shipments.*). They drift: an order is cancelled in
// Shopify after it was fulfilled, a parcel is cancelled in the Shiprocket panel while Shopify still says shipped, a
// booking exists but the Shopify fulfilment step failed, something was fulfilled by hand with an AWB we never saw...
//
// `audit()` reads all three, lists every mismatch as an issue (order, kind, what each system says, the fix that would
// settle it) and remembers them in ship_issues so the dashboard can show a count, and the owner can dismiss or fix each
// one. `fix()` applies one named fix. The cron runs the audit; it never fixes anything on its own — the automatic flows
// that are safe (cancel the pickup for a cancelled order, retry a failed fulfilment) already live in ship-cancel.js and
// admin.js; everything the audit finds beyond those is a decision for the owner.

import { gql } from './shopify.orig.js';
import { addTags, cancelOrder, cancelFulfilmentsFor, updateTracking, ordersShipState } from './shopify.js';
import { stopShipment } from './ship-cancel.js';
import { CANCEL_TAG } from './ship-cancel.js';

const now = () => Math.floor(Date.now() / 1000);
const PICKED = ['transit', 'ofd', 'ndr', 'delivered', 'rto', 'lost'];

/** Every kind of mismatch, what it means, and the fixes it offers (first one is the suggested fix). */
export const KINDS = {
  shop_cancelled_fulfilled: { sev: 'bad', title: 'Cancelled in Shopify, but still fulfilled', why: 'The order is cancelled in Shopify yet a fulfilment with an AWB is still active there, so Shopify shows it as shipped and the courier may still come.',
    fixes: ['stop', 'unfulfil'] },
  shop_cancelled_shipping: { sev: 'bad', title: 'Cancelled, but the parcel is still booked', why: 'Shopify (or a COD app tag) says cancelled while the Shiprocket booking is live and not picked up yet.',
    fixes: ['stop'] },
  cancelled_after_pickup: { sev: 'warn', title: 'Cancelled after the courier picked it up', why: 'Nothing can stop the parcel from here. Ask Shiprocket for RTO, or let it deliver and keep the order.',
    fixes: ['reopen_shop_note', 'dismiss'] },
  sr_cancelled_fulfilled: { sev: 'bad', title: 'Shiprocket booking cancelled, Shopify still says fulfilled', why: 'The AWB was cancelled (here or in the Shiprocket panel) but the Shopify fulfilment for it is still active, so Shopify shows it as shipped and nobody will book it again.',
    fixes: ['unfulfil'] },
  booked_not_fulfilled: { sev: 'warn', title: 'Booked with Shiprocket, not fulfilled in Shopify', why: 'The AWB exists but Shopify still shows the order as unfulfilled (the fulfilment step failed or was never run).',
    fixes: ['fulfil'] },
  fulfilled_no_booking: { sev: 'warn', title: 'Fulfilled in Shopify, no booking here', why: 'Shopify has an active fulfilment (shipped by hand or through another app) that this dashboard knows nothing about, so it cannot track or label it. Book it from the Orders tab after unfulfilling, or dismiss if it really went out another way.',
    fixes: ['unfulfil', 'dismiss'] },
  awb_mismatch: { sev: 'warn', title: 'Shopify tracking number differs from the live AWB', why: 'The customer sees the wrong tracking link (usually after a rebook).',
    fixes: ['retrack'] },
  shop_cancelled_db_open: { sev: 'warn', title: 'Cancelled in Shopify, still open here', why: 'The order is cancelled in Shopify but still counts as placed in this dashboard (it may sit in To ship).',
    fixes: ['sync_cancel'] },
  db_cancelled_shop_open: { sev: 'warn', title: 'Cancelled here, still open in Shopify', why: 'This dashboard marked the order cancelled but Shopify did not get the cancellation.',
    fixes: ['cancel_shop', 'reopen_db'] },
  shipped_flag_stale: { sev: 'info', title: 'Marked shipped here, but nothing is shipped', why: 'shipped_at is set but Shopify has no active fulfilment and there is no live booking, so the order hides from To ship.',
    fixes: ['reset_shipped'] },
  cancelled_delivered: { sev: 'info', title: 'Cancelled, but the parcel was delivered', why: 'The customer has the parcel although the order is cancelled. Decide whether to collect payment / re-open it in Shopify by hand.',
    fixes: ['dismiss'] },
};
export const FIX_LABEL = {
  stop: 'Cancel pickup & unfulfil', unfulfil: 'Unfulfil in Shopify', fulfil: 'Fulfil in Shopify', retrack: 'Update Shopify tracking',
  sync_cancel: 'Mark cancelled here', cancel_shop: 'Cancel in Shopify', reopen_db: 'Re-open here', reset_shipped: 'Back to To ship', reopen_shop_note: 'Tag for RTO follow-up', dismiss: 'Dismiss',
};

/** Decide the issues for one order from the three views. Pure. */
export function diagnose(o, ship, shop, { since = 0 } = {}) {
  const issues = [];
  if (!shop) return issues;                                                  // not in Shopify at all: nothing to reconcile
  const push = (kind, extra = {}) => issues.push({ kind, ...extra });
  const dbCancelled = o.status === 'cancelled';
  const live = ship && ship.awb && ship.status !== 'cancelled';
  const stage = live ? (ship.stage || 'pickup_pending') : '';
  const picked = live && (PICKED.includes(stage) || ship.cancel_state === 'picked');
  const cancelTag = (shop.tags || []).find((t) => CANCEL_TAG.test(t)) || '';
  const shopCancelled = shop.cancelled || !!cancelTag;
  const fulfilled = shop.fulfilments.length > 0;
  const liveAwbInShop = live && shop.awbs.includes(String(ship.awb));

  if (shopCancelled) {
    if (live && stage === 'delivered') push('cancelled_delivered');
    else if (live && picked) push('cancelled_after_pickup');
    else if (live) push(fulfilled ? 'shop_cancelled_fulfilled' : 'shop_cancelled_shipping');
    else if (fulfilled) push('shop_cancelled_fulfilled');
    if (!dbCancelled && !(live && picked)) push('shop_cancelled_db_open');
    return issues;
  }
  if (dbCancelled) { push('db_cancelled_shop_open'); return issues; }

  /* open everywhere: do the shipping records agree? */
  if (ship && ship.awb && ship.status === 'cancelled' && fulfilled && shop.awbs.includes(String(ship.awb))) push('sr_cancelled_fulfilled');
  if (live && !fulfilled) push('booked_not_fulfilled');
  if (live && fulfilled && !liveAwbInShop) push('awb_mismatch', { shop_awb: shop.awbs.join(', ') });
  /* shipped outside Shiprocket but recorded here (orders.tracking carries the AWB Shopify shows): not a mismatch */
  const recorded = !!(o.tracking && (shop.awbs.some((a) => String(o.tracking).includes(a)) || !shop.awbs.length));
  if (!live && fulfilled && !recorded && Number(o.created_at || 0) >= since && !(ship && ship.awb && ship.status === 'cancelled' && shop.awbs.includes(String(ship.awb)))) push('fulfilled_no_booking', { shop_awb: shop.awbs.join(', '), company: shop.fulfilments[0]?.company || '' });
  if (!live && !fulfilled && o.shipped_at) push('shipped_flag_stale');
  return issues;
}

/**
 * Run the audit over orders of the last `days` days (and every order that has a shipment row in that window).
 * Returns { checked, found, issues } — issues as stored, newest first.
 */
export async function audit(env, { days = 45, max = 400, ids = null } = {}) {
  const t = now();
  let orders;
  if (ids && ids.length) {
    orders = (await env.DB.prepare(`SELECT * FROM orders WHERE order_id IN (${ids.map(() => '?').join(',')})`).bind(...ids.map(String)).all()).results;
  } else {
    orders = (await env.DB.prepare(`SELECT * FROM orders WHERE order_id IS NOT NULL AND status NOT IN ('pending_payment','failed','completing') AND created_at>? ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(800, max))}`).bind(t - days * 86400).all()).results;
  }
  const oids = orders.map((o) => String(o.order_id));
  if (!oids.length) return { checked: 0, found: 0, issues: await listIssues(env) };
  const ships = Object.fromEntries((await env.DB.prepare(`SELECT * FROM shipments WHERE order_id IN (${oids.map(() => '?').join(',')})`).bind(...oids).all()).results.map((s) => [String(s.order_id), s]));
  const shop = await ordersShipState(env, oids);
  /* orders from before the first Shiprocket booking were shipped another way (NimbusPost): a Shopify fulfilment without a booking here is normal for them */
  const since = Number((await env.DB.prepare('SELECT MIN(created_at) AS t FROM shipments WHERE sr_shipment_id IS NOT NULL').first().catch(() => null))?.t) || 0;

  const found = [];
  for (const o of orders) {
    const id = String(o.order_id), s = ships[id] || null, sh = shop[id];
    for (const is of diagnose(o, s, sh, { since })) {
      const detail = {
        shopify: sh ? (sh.cancelled ? 'Cancelled' : sh.tags.some((x) => CANCEL_TAG.test(x)) ? `Open · tagged "${sh.tags.find((x) => CANCEL_TAG.test(x))}"` : 'Open') + ' · ' + (sh.fulfilments.length ? 'Fulfilled' + (sh.awbs.length ? ' (' + sh.awbs.join(', ') + ')' : '') : (sh.status || 'Unfulfilled').toLowerCase().replace(/_/g, ' ')) : 'Not found',
        shiprocket: s && s.awb ? (s.status === 'cancelled' ? 'Booking cancelled' : (s.stage ? s.stage.replace(/_/g, ' ') : 'booked')) + ' · ' + `${s.courier || ''} ${s.awb}`.trim() + (s.cancel_state === 'picked' ? ' · cancelled after pickup' : '') : 'No booking',
        here: (o.status === 'cancelled' ? 'Cancelled' : o.status === 'placed' ? (o.shipped_at ? 'Shipped' : 'To ship') : o.status || '') + (o.method === 'cod' ? ' · COD' : ' · Prepaid'),
        ...is,
      };
      found.push({ order_id: id, kind: is.kind, order_name: o.order_name || sh?.name || id, detail });
    }
  }
  /* remember: upsert what was found, resolve what was not (within the checked set) */
  for (const f of found) {
    await env.DB.prepare(`INSERT INTO ship_issues (order_id, kind, order_name, detail, first_seen, last_seen, resolved_at) VALUES (?,?,?,?,?,?,NULL)
      ON CONFLICT (order_id, kind) DO UPDATE SET order_name=EXCLUDED.order_name, detail=EXCLUDED.detail, last_seen=EXCLUDED.last_seen, resolved_at=NULL,
        first_seen=CASE WHEN ship_issues.resolved_at IS NULL THEN ship_issues.first_seen ELSE EXCLUDED.first_seen END,
        dismissed_at=CASE WHEN ship_issues.resolved_at IS NULL THEN ship_issues.dismissed_at ELSE NULL END`)
      .bind(f.order_id, f.kind, f.order_name, JSON.stringify(f.detail), t, t).run();
  }
  const keep = new Set(found.map((f) => f.order_id + '|' + f.kind));
  const open = (await env.DB.prepare(`SELECT order_id, kind FROM ship_issues WHERE resolved_at IS NULL AND order_id IN (${oids.map(() => '?').join(',')})`).bind(...oids).all()).results;
  for (const r of open) if (!keep.has(String(r.order_id) + '|' + r.kind)) await env.DB.prepare('UPDATE ship_issues SET resolved_at=? WHERE order_id=? AND kind=?').bind(t, String(r.order_id), r.kind).run();
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('ship_audit_at', ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v").bind(String(t)).run().catch(() => {});
  return { checked: orders.length, found: found.length, issues: await listIssues(env) };
}

/** Open issues (not resolved), newest first; dismissed ones carry dismissed_at. */
export async function listIssues(env) {
  const rows = (await env.DB.prepare('SELECT * FROM ship_issues WHERE resolved_at IS NULL ORDER BY last_seen DESC, order_name DESC LIMIT 500').all()).results;
  let at = 0; try { at = Number((await env.DB.prepare("SELECT v FROM settings WHERE k='ship_audit_at'").first())?.v) || 0; } catch { /* no settings table */ }
  return { audited_at: at, issues: rows.map((r) => { let d = {}; try { d = JSON.parse(r.detail || '{}'); } catch { /* ignore */ }
    const k = KINDS[r.kind] || { sev: 'info', title: r.kind, fixes: [] };
    return { order_id: String(r.order_id), kind: r.kind, order_name: r.order_name, sev: k.sev, title: k.title, why: k.why, fixes: k.fixes, shopify: d.shopify || '', shiprocket: d.shiprocket || '', here: d.here || '',
      shop_awb: d.shop_awb || '', first_seen: Number(r.first_seen) || 0, last_seen: Number(r.last_seen) || 0, dismissed_at: Number(r.dismissed_at) || null }; }) };
}

export async function dismissIssue(env, id, kind, undo = false) {
  await env.DB.prepare('UPDATE ship_issues SET dismissed_at=? WHERE order_id=? AND kind=?').bind(undo ? null : now(), String(id), String(kind)).run();
}

/**
 * Apply one fix to one order. `deps` carries the admin-side helpers the fix needs (fulfilBooked). Throws with a plain
 * reason. Afterwards the order is re-audited so the dashboard shows what is left.
 */
export async function fix(env, { id, fix: what }, deps = {}) {
  id = String(id || '');
  if (!id) throw new Error('No order');
  const gid = `gid://shopify/Order/${id}`;
  const o = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(id).first();
  const ship = await env.DB.prepare('SELECT * FROM shipments WHERE order_id=?').bind(id).first();
  const shop = (await ordersShipState(env, [id]))[id];
  if (!shop) throw new Error('Order not found in Shopify');
  shop.cancelTag = (shop.tags || []).find((t) => CANCEL_TAG.test(t)) || '';
  let note = '';
  switch (what) {
    case 'stop': {                                   // cancel the Shiprocket pickup (never after pickup) and undo the Shopify fulfilment
      const r = ship && ship.awb && ship.status !== 'cancelled' ? await stopShipment(env, id, 'Order cancelled (reconciliation)') : { state: 'none' };
      if (r.state === 'picked') throw new Error('The courier already has this parcel; it cannot be cancelled. Ask Shiprocket for RTO.');
      if (r.state === 'error') throw new Error(r.note);
      if (shop.cancelled || shop.cancelTag) await env.DB.prepare("UPDATE orders SET status='cancelled', shipped_at=NULL, tracking=NULL WHERE order_id=?").bind(id).run();
      let n = 0, err = '';
      try { n = await cancelFulfilmentsFor(env, id); } catch (e) { err = String(e.message || e); }   // any fulfilment still active (stopShipment only undoes its own AWB)
      note = (r.state === 'cancelled' ? 'Shiprocket booking cancelled. ' : '') + (err ? '' : n ? `${n} Shopify fulfilment${n === 1 ? '' : 's'} undone.` : 'Nothing left to unfulfil.');
      if (err) throw new Error(note + err);
      break;
    }
    case 'unfulfil': {                               // Shopify fulfilment undone; the order goes back to To ship here unless it is cancelled
      const n = await cancelFulfilmentsFor(env, id);
      if (!n) throw new Error('No active fulfilment in Shopify');
      if (shop.cancelled || shop.cancelTag) await env.DB.prepare("UPDATE orders SET status='cancelled', shipped_at=NULL, tracking=NULL WHERE order_id=?").bind(id).run();
      else await env.DB.prepare('UPDATE orders SET shipped_at=NULL, tracking=NULL WHERE order_id=?').bind(id).run();
      note = `${n} fulfilment${n === 1 ? '' : 's'} undone in Shopify.`;
      break;
    }
    case 'fulfil': {
      if (!deps.fulfilBooked) throw new Error('fulfil not available');
      const err = await deps.fulfilBooked(env, id);
      if (err) throw new Error(err);
      note = 'Fulfilled in Shopify with AWB ' + (ship?.awb || '') + '.';
      break;
    }
    case 'retrack': {
      if (!ship?.awb || ship.status === 'cancelled') throw new Error('No live booking to point Shopify at');
      const f = shop.fulfilments[0];
      if (!f) throw new Error('No active fulfilment in Shopify to update');
      await updateTracking(env, f.id, { company: ship.courier || 'Shiprocket', number: ship.awb, url: `https://shiprocket.co/tracking/${ship.awb}` });
      await env.DB.prepare('UPDATE orders SET tracking=? WHERE order_id=?').bind(`${ship.courier || 'Shiprocket'} ${ship.awb}`, id).run();
      note = `Shopify tracking set to ${ship.awb}.`;
      break;
    }
    case 'sync_cancel':
      await env.DB.prepare("UPDATE orders SET status='cancelled', packed_at=NULL WHERE order_id=?").bind(id).run();
      note = 'Marked cancelled here.';
      break;
    case 'cancel_shop':
      if (shop.fulfilments.length) throw new Error('Shopify refuses to cancel a fulfilled order: unfulfil it first');
      await cancelOrder(env, gid, 'Cancelled from Ink Kulture dashboard (reconciliation)');
      note = 'Cancelled in Shopify.';
      break;
    case 'reopen_db':
      await env.DB.prepare("UPDATE orders SET status='placed' WHERE order_id=? AND status='cancelled'").bind(id).run();
      note = 'Re-opened here; it is back in the Orders tab.';
      break;
    case 'reset_shipped':
      await env.DB.prepare('UPDATE orders SET shipped_at=NULL, tracking=NULL WHERE order_id=?').bind(id).run();
      note = 'Back in To ship.';
      break;
    case 'reopen_shop_note':
      await addTags(env, gid, ['cancelled-after-pickup', 'rto-followup']);
      note = 'Tagged in Shopify for RTO follow-up.';
      break;
    default: throw new Error('Unknown fix');
  }
  const after = await audit(env, { ids: [id] });
  return { ok: true, note, left: after.issues.issues.filter((x) => x.order_id === id && !x.dismissed_at) };
}
