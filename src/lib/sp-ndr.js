/**
 * ShipPrime NDR actions through the ShipPrime dashboard's own API (there is no NDR call in the public API).
 * Found by watching app.shipprime.live → Manage NDR (Nov 2026):
 *   base https://dropshipindia.live/dropship, headers Authorization: Bearer <dashboard session token>, X-Source: shipprime
 *   POST /self-ship/ndr/orders?page=&page_size=   { search_by, search_term, filters:{ status[], shop, start_date, end_date,
 *                                                  type: FAILED_DELIVERY | DELIVERED | OUT_FOR_DELIVERY | RTO, show_pending_action }, shop_id }
 *        -> { orders:[{ order_id, direct_shipper_order_id ("1719" = our #1719), awb_number, order_status, tpl_vendor,
 *                       ndr_reason, reattempt_count, is_action_taken, payment_mode, collectible_amount, ... }], total_count }
 *   POST /self-ship/ndr/orders/count               same filters
 *   POST /self-ship/ndr/actions/reattempt          { order_id, shop_id }            ("Re-Open" in the dashboard)
 *   POST /self-ship/ndr/actions/mark-rto           { order_id, shop_id }            ("RTO")
 *   POST /self-ship/ndr/actions/update-contact-information
 *        { order_id, shop_id, phone, address:{ name, first_name, last_name, phone, address1, address2, city, province, zip, country } }
 *   GET  /self-ship/ndr/actions/{order_id}?shop_id=  action history
 *
 * Token: the dashboard session token (app.shipprime.live/api/auth/session → "token", valid ~5 years). Pasted once in
 * Settings → Shipping → "ShipPrime dashboard token" (the whole JSON from that page is fine). It is a different token
 * from the public API token.
 *
 * Owner's rule (Nov 2026): RTO costs sales, the courier's word is not final. Every ShipPrime NDR that has no action yet
 * is re-opened automatically, unless our order is cancelled or the customer chose return on WhatsApp. Nothing is
 * marked RTO automatically; "Mark RTO" is a dashboard button.
 */
const BASE = 'https://dropshipindia.live/dropship';
const now = () => Math.floor(Date.now() / 1000);
export const SP_SHOP_ID = '84439761131';

/** Accepts the bare token, "Bearer …", or the whole JSON of app.shipprime.live/api/auth/session. */
export function parseDashToken(v) {
  let s = String(v || '').trim();
  if (s.startsWith('{')) { try { s = String(JSON.parse(s).token || ''); } catch { s = ''; } }
  s = s.replace(/^Bearer\s+/i, '').trim();
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(s) ? s : '';
}
export function dashCfg(env) {
  const sh = env.SETTINGS?.shipping || {};
  return { token: parseDashToken(sh.sp_dash_token || env.SHIPPRIME_DASH_TOKEN), shop: String(sh.sp_shop_id || env.SHIPPRIME_SHOP_ID || SP_SHOP_ID), auto: sh.sp_ndr_auto !== false };
}
/** exp of the JWT, for the settings card (no signature check; the server does that). */
export function tokenExpiry(token) {
  try { return JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp || null; } catch { return null; }
}

export async function dash(env, method, path, body) {
  const c = dashCfg(env);
  if (!c.token) throw new Error('ShipPrime dashboard token not set (Settings → Shipping)');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(BASE + path, {
      method, signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + c.token, 'X-Source': 'shipprime', Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://app.shipprime.live', Referer: 'https://app.shipprime.live/' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
    if (res.status === 401 || res.status === 403) throw new Error('ShipPrime dashboard token expired or wrong: paste a new one in Settings → Shipping');
    if (!res.ok || j?.status === 'FAILED' || j?.error) throw new Error(j?.message || j?.error?.message || j?.error || j?.detail || `ShipPrime HTTP ${res.status}`);
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('ShipPrime did not answer in 20 s');
    throw e;
  } finally { clearTimeout(timer); }
}

const day = (ts) => new Date((ts + 19800) * 1000).toISOString().slice(0, 10);
/** NDR orders of one tab (FAILED_DELIVERY by default) for the last `days`. */
export async function ndrOrders(env, { type = 'FAILED_DELIVERY', days = 30, pendingOnly = false, max = 300 } = {}) {
  const c = dashCfg(env);
  const t = now();
  const status = { FAILED_DELIVERY: ['UNDELIVERED', 'OUT_FOR_DELIVERY'], DELIVERED: ['DELIVERED'], OUT_FOR_DELIVERY: ['OUT_FOR_DELIVERY'], RTO: ['RTO'] }[type] || ['UNDELIVERED'];
  const filters = { status, shop: Number(c.shop), start_date: `${day(t - days * 86400)} 00:00:00`, end_date: `${day(t)} 23:59:59` };
  /* the RTO tab sends only status + dates (as the dashboard does) */
  if (type !== 'RTO') Object.assign(filters, { type, show_pending_action: !!pendingOnly });
  const body = { search_by: 'shopify_id', search_term: '', filters, shop_id: Number(c.shop) };
  const out = [];
  for (let page = 1; page <= 10 && out.length < max; page++) {
    const j = await dash(env, 'POST', `/self-ship/ndr/orders?page=${page}&page_size=50`, body);
    const rows = j.orders || [];
    out.push(...rows);
    if (rows.length < 50 || out.length >= Number(j.total_count || 0)) break;
  }
  return out.map((o) => ({
    sp_id: String(o.order_id), order: o.direct_shipper_order_id ? '#' + o.direct_shipper_order_id : '', awb: String(o.awb_number || ''), courier: o.tpl_vendor || '',
    status: o.order_status || '', reason: o.ndr_reason || '', attempts: Number(o.reattempt_count || 0), action_taken: !!o.is_action_taken,
    cod: o.payment_mode === 'COD' ? Number(o.collectible_amount || 0) : 0, updated: o.last_status_updated_at || '',
  }));
}

/**
 * An NDR still waiting for our action. ShipPrime lists a failed Xpressbees attempt as UNDELIVERED, but leaves a failed
 * Delhivery attempt at OUT_FOR_DELIVERY with the NDR reason filled in, so both count. Pure.
 */
export const isOpenNdr = (o) => !o.action_taken && (o.status === 'UNDELIVERED' || (o.status === 'OUT_FOR_DELIVERY' && !!String(o.reason || '').trim()));

/** '2026-11-07T10:21:22.52+05:30' -> epoch seconds, or 0 */
const ts = (v) => { const t = Date.parse(String(v || '')); return Number.isNaN(t) ? 0 : Math.floor(t / 1000); };

/**
 * Mark failed attempts as NDR on our side: open NDRs from the list whose parcel we still show as out for delivery /
 * in transit become 'ndr', and the attempt time + reason are kept so a tracking refresh that still reads
 * OUT_FOR_DELIVERY does not flip them back (lib/ship-status.js). Returns how many rows changed.
 */
export async function syncNdrStages(env, rows) {
  let n = 0;
  for (const o of rows.filter(isOpenNdr)) {
    if (!o.awb) continue;
    const r = await env.DB.prepare(`UPDATE shipments SET stage='ndr', sp_ndr_at=?, sp_ndr_reason=?, attempt_notes=COALESCE(NULLIF(attempt_notes,''), ?)
        WHERE awb=? AND provider='shipprime' AND COALESCE(stage,'') IN ('ofd','transit','ndr') AND COALESCE(status,'')<>'cancelled' RETURNING order_id`)
      .bind(ts(o.updated) || now(), String(o.reason).slice(0, 160), String(o.reason).slice(0, 400), o.awb).all().catch(() => null);
    if (r?.results?.length) n++;
  }
  return n;
}

export const reattempt = (env, spId) => dash(env, 'POST', '/self-ship/ndr/actions/reattempt', { order_id: Number(spId), shop_id: Number(dashCfg(env).shop) });
export const markRto = (env, spId) => dash(env, 'POST', '/self-ship/ndr/actions/mark-rto', { order_id: Number(spId), shop_id: Number(dashCfg(env).shop) });
export const history = (env, spId) => dash(env, 'GET', `/self-ship/ndr/actions/${encodeURIComponent(spId)}?shop_id=${encodeURIComponent(dashCfg(env).shop)}`);
/** New phone and/or address for the next attempt. a: { name, phone, address1, address2, city, state, pincode } */
export function updateContact(env, spId, a) {
  const name = String(a.name || '').trim();
  return dash(env, 'POST', '/self-ship/ndr/actions/update-contact-information', {
    order_id: Number(spId), shop_id: Number(dashCfg(env).shop), phone: String(a.phone || '').replace(/\D/g, '').slice(-10),
    address: { name, first_name: name, last_name: '', phone: String(a.phone || '').replace(/\D/g, '').slice(-10), address1: a.address1 || '', address2: a.address2 || '', city: a.city || '', province: a.state || '', zip: String(a.pincode || ''), country: 'India' },
  });
}

/** Find the ShipPrime NDR order behind an AWB (FAILED_DELIVERY tab, last 30 days). */
export async function byAwb(env, awb) {
  return (await ndrOrders(env, { days: 30 })).find((o) => o.awb === String(awb)) || null;
}

/**
 * Cron: re-open every ShipPrime NDR with no action yet (once per attempt number), skipping parcels whose order we
 * cancelled and those whose customer chose return. 8 am - 11 pm IST, every 30 minutes.
 */
export async function autoReattempt(env, { force = false, dry = false } = {}) {
  const c = dashCfg(env);
  if (!c.token) return { skipped: 'no token' };
  const m = (() => { const d = new Date((now() + 19800) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); })();
  const { claim, release } = await import('./once.js');
  if (!force && !(await claim(env, 'spndr:run:' + Math.floor(now() / 1800), 1800))) return { skipped: 'ran this half hour' };
  const rows = await ndrOrders(env, { days: 30 });
  /* keep the Shipments tab honest round the clock, even when auto re-attempt is off or it is night */
  const synced = await syncNdrStages(env, rows).catch((e) => { console.error('sp ndr sync', e.message); return 0; });
  if (!c.auto && !force) return { skipped: 'off', synced };
  if (!force && (m < 8 * 60 || m >= 23 * 60)) return { skipped: 'outside 8 am - 11 pm', synced };
  const list = rows.filter(isOpenNdr);
  const out = { open: list.length, synced, reopened: [], skipped: [], failed: [] };
  if (!list.length) return out;
  const awbs = list.map((o) => o.awb).filter(Boolean);
  const ours = awbs.length ? Object.fromEntries((await env.DB.prepare(`SELECT s.awb, s.order_name, s.ndr_choice, s.ndr_by, s.ndr_choice_at, o.status AS order_status
      FROM shipments s LEFT JOIN orders o ON o.order_id=s.order_id WHERE s.awb IN (${awbs.map(() => '?').join(',')})`).bind(...awbs).all()).results.map((r) => [r.awb, r])) : {};
  for (const o of list) {
    const r = ours[o.awb] || {};
    const name = r.order_name || o.order;
    if (r.order_status === 'cancelled') { out.skipped.push(`${name}: order cancelled`); continue; }
    if (r.ndr_choice === 'return' && r.ndr_by && r.ndr_by !== 'auto') { out.skipped.push(`${name}: customer chose return`); continue; }
    const key = `spndr:${o.awb}:${o.attempts}`;
    if (!dry && !(await claim(env, key, 20 * 3600))) { out.skipped.push(`${name}: already re-opened for attempt ${o.attempts}`); continue; }
    if (dry) { out.reopened.push(`${name} (would re-open)`); continue; }
    try {
      await reattempt(env, o.sp_id);
      out.reopened.push(`${name} ${o.courier} · ${o.reason}`);
      await env.DB.prepare('UPDATE shipments SET ndr_choice=?, ndr_choice_at=?, ndr_by=?, ndr_attempt=?, updated_at=? WHERE awb=?').bind('reattempt', now(), 'auto', o.attempts, now(), o.awb).run().catch(() => {});
    } catch (e) {
      out.failed.push(`${name}: ${String(e.message).slice(0, 140)}`);
      /* a refusal (e.g. the courier did not attempt) is final for this attempt; a token / network error tries again */
      if (/token|did not answer|HTTP 5/i.test(e.message)) await release(env, key);
      if (/token/i.test(e.message)) break;
    }
  }
  if (out.reopened.length || out.failed.length) console.log('sp ndr', JSON.stringify(out));
  return out;
}
