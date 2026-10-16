// src/lib/ship-status.js — where every Shiprocket parcel is, and the controls for it.
//
// Shiprocket's status *text* ("PICKUP SCHEDULED", "PICKUP EXCEPTION", "OUT FOR DELIVERY" ...) is mapped to a stage.
// The numeric status ids differ between Shiprocket's own docs, so they are not relied on.
//
//   pickup_pending  AWB made, waiting for the courier (scheduled / queued / rescheduled / out for pickup)
//   pickup_failed   the courier came or should have come and did not collect (pickup exception / error / cancelled)
//   transit         picked up and moving        ofd   out for delivery        ndr   delivery attempt failed
//   delivered       delivered                   rto   coming back / returned  lost  lost / damaged / destroyed
//   cancelled       shipment cancelled
//
// Refreshed on the 5-minute cron (own schedule, independent of the WhatsApp updates), and on demand from the
// Shipments tab. Nothing about the customer's address is stored.

import { sr, srTrack } from './shiprocket.js';
import { stageOf, summarize } from './sr-scan.js';
import { cancelFulfilmentsFor, activeFulfilments } from './shopify.js';
import { nimbus } from './shipping.js';
import { classify } from './wa-ship.js';

const now = () => Math.floor(Date.now() / 1000);
/** '2026-10-14 15:30:00' (IST) -> epoch seconds, or 0 */
const istTs = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v || '')); return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000) - 19800 : 0; };
export const STAGES = ['pickup_pending', 'pickup_failed', 'transit', 'ofd', 'ndr', 'delivered', 'rto', 'lost', 'cancelled'];
export const FINAL = ['delivered', 'rto_done', 'cancelled', 'lost'];

export { stageOf };
export const LABEL = { pickup_pending: 'Pickup pending', pickup_failed: 'Pickup failed', transit: 'In transit', ofd: 'Out for delivery', ndr: 'NDR', delivered: 'Delivered', rto: 'RTO', lost: 'Lost / damaged', cancelled: 'Cancelled' };

/** A parcel that was not booked here (imported from a Shopify fulfilment, usually an old NimbusPost AWB): NimbusPost tracking if it is set up, else what the WhatsApp tracker last saw. */
async function otherStatus(env, rec) {
  try {
    const tr = (await nimbus(env, `shipments/track/${encodeURIComponent(rec.awb)}`)).data || {};
    const c = classify(tr);
    const stage = { picked: 'transit', failed: 'ndr', pending: 'pickup_pending' }[c.stage] || c.stage;
    return { stage, picked: !['pickup_pending', 'pickup_failed', 'cancelled'].includes(stage), text: String(tr.status || c.stage || '').replace(/_/g, ' '), edd: String(tr.edd || '').slice(0, 10), pickedTs: 0, lastTs: c.at || 0 };
  } catch { /* NimbusPost not configured or AWB unknown there */ }
  const t = await env.DB.prepare('SELECT status FROM ship_track WHERE order_id=?').bind(String(rec.order_id)).first().catch(() => null);
  const st = stageOf(String(t?.status || ''));
  if (!t?.status) return null;
  return { stage: st, picked: !['pickup_pending', 'pickup_failed', 'cancelled'].includes(st), text: String(t.status).replace(/_/g, ' '), edd: '' };
}

/** Where a booking is, read like Shiprocket's tracking page (lib/sr-scan.js); before the first scan, from the Shiprocket order. */
async function srStatus(env, rec) {
  if (rec.provider && rec.provider !== 'shiprocket') return otherStatus(env, rec);
  let sum = null;
  try { sum = summarize(await sr(env, 'GET', `courier/track/awb/${encodeURIComponent(rec.awb)}`)); } catch { /* no scans yet or tracking down */ }
  if (sum && (sum.current || sum.scans.length)) {
    const text = [sum.current, sum.newest && sum.newest.toLowerCase() !== sum.current.toLowerCase() ? sum.newest : ''].filter(Boolean).join(' · ');
    return { stage: sum.stage, picked: sum.picked, text, edd: sum.edd, pickedTs: istTs(sum.pickedAt), lastTs: istTs(sum.newestAt) };
  }
  if (rec.sr_order_id) {
    try {
      const o = await sr(env, 'GET', `orders/show/${encodeURIComponent(rec.sr_order_id)}`);
      const d = o?.data || {}, sh = Array.isArray(d.shipments) ? d.shipments[0] || {} : d.shipments || {};
      const text = String(sh.status || d.status || '');
      if (text) { const st = stageOf(text); return { stage: st, picked: !['pickup_pending', 'pickup_failed', 'cancelled'].includes(st), text, edd: sum?.edd || '' }; }
    } catch { /* keep unknown */ }
  }
  return null;
}

/** Refresh one shipment row; returns the new stage. Also keeps things consistent if it was cancelled inside Shiprocket. */
export async function refreshShipment(env, rec) {
  /* an imported (non-Shiprocket) parcel without its own tracking link yet: take Shopify's */
  if (rec.provider && rec.provider !== 'shiprocket' && !rec.track_url) {
    try {
      const f = (await activeFulfilments(env, String(rec.order_id))).list.find((x) => x.numbers.includes(String(rec.awb)));
      const url = f?.url || (/nimbus/i.test(rec.provider + ' ' + (rec.courier || '') + ' ' + (f?.company || '')) ? `https://ship.nimbuspost.com/tracking/${rec.awb}` : '');
      if (url) { await env.DB.prepare('UPDATE shipments SET track_url=? WHERE order_id=?').bind(url, String(rec.order_id)).run(); rec.track_url = url; }
    } catch { /* next time */ }
  }
  const s = await srStatus(env, rec);
  const t = now();
  if (!s) {
    await env.DB.prepare('UPDATE shipments SET tracked_at=? WHERE order_id=?').bind(t, String(rec.order_id)).run();
    return rec.stage || 'pickup_pending';
  }
  const stage = s.stage, picked = s.picked;
  await env.DB.prepare(`UPDATE shipments SET stage=?, sr_status=?, tracked_at=?, edd=COALESCE(NULLIF(?::text,''), edd),
      picked_at=CASE WHEN ?::boolean AND picked_at IS NULL THEN ?::bigint ELSE picked_at END,
      delivered_at=CASE WHEN ?::text='delivered' AND delivered_at IS NULL THEN ?::bigint ELSE delivered_at END,
      rto=CASE WHEN ?::text='rto' THEN TRUE ELSE rto END WHERE order_id=?`)
    .bind(stage, s.text.slice(0, 160), t, s.edd, picked, Math.min(t, s.pickedTs || t), stage, Math.min(t, s.lastTs || t), stage, String(rec.order_id)).run();
  /* cancelled in the Shiprocket panel: show it as cancelled here too and free the order to be shipped again */
  if (stage === 'cancelled' && rec.status !== 'cancelled') {
    await env.DB.prepare("UPDATE shipments SET status='cancelled', cancel_state=COALESCE(cancel_state,'cancelled'), cancel_note=COALESCE(cancel_note,'Cancelled in Shiprocket'), updated_at=? WHERE order_id=?").bind(t, String(rec.order_id)).run();
    await env.DB.prepare('UPDATE orders SET shipped_at=NULL, tracking=NULL WHERE order_id=?').bind(String(rec.order_id)).run();
    await cancelFulfilmentsFor(env, String(rec.order_id), rec.awb).catch(() => {});
  }
  return stage;
}

/** Cron: refresh live parcels not checked for a while; pickup-stage ones more often. */
export async function refreshDue(env, { max = 25 } = {}) {
  const t = now();
  const rows = (await env.DB.prepare(`SELECT * FROM shipments WHERE awb IS NOT NULL AND awb<>'' AND COALESCE(status,'')<>'cancelled'
      AND COALESCE(stage,'') NOT IN ('delivered','lost','cancelled') AND created_at > ?
      AND COALESCE(tracked_at,0) < (CASE WHEN COALESCE(stage,'pickup_pending') IN ('pickup_pending','pickup_failed') THEN ?::bigint ELSE ?::bigint END)
      ORDER BY COALESCE(tracked_at,0) LIMIT ${Math.max(1, Math.min(60, max))}`).bind(t - 45 * 86400, t - 15 * 60, t - 45 * 60).all()).results;
  let n = 0;
  for (const r of rows) { try { await refreshShipment(env, r); n++; } catch (e) { console.error('refresh', r.order_id, e.message); } }
  return { refreshed: n };
}

/** Ask the courier to come (again) for these shipments. date: optional 'YYYY-MM-DD'. Returns per-order results. */
export async function requestPickup(env, recs, date) {
  const out = [];
  for (const rec of recs) {
    try {
      const body = { shipment_id: [Number(rec.sr_shipment_id)] };
      if (date) body.pickup_date = [date];
      const p = await sr(env, 'POST', 'courier/generate/pickup', body);
      const when = String(p.response?.pickup_scheduled_date || p.response?.data?.pickup_scheduled_date || p.pickup_scheduled_date || '');
      const note = when ? 'Pickup on ' + when : String(p.response?.data || p.message || 'Pickup requested').slice(0, 120);
      await env.DB.prepare("UPDATE shipments SET pickup=?, stage=CASE WHEN COALESCE(stage,'')='pickup_failed' THEN 'pickup_pending' ELSE stage END, updated_at=? WHERE order_id=?").bind(note, now(), String(rec.order_id)).run();
      out.push({ id: rec.order_id, name: rec.order_name, ok: true, note });
    } catch (e) {
      out.push({ id: rec.order_id, name: rec.order_name, ok: false, note: String(e.message || e).replace(/^Shiprocket [^:]+: /, '').slice(0, 200) });
    }
  }
  return out;
}

/** Manifest PDF link for these shipments (generated once; printed again if it already exists). */
export async function manifestUrl(env, recs) {
  const sids = recs.map((r) => Number(r.sr_shipment_id)).filter(Boolean), oids = recs.map((r) => Number(r.sr_order_id)).filter(Boolean);
  if (!sids.length) throw new Error('No Shiprocket shipments selected');
  try {
    const g = await sr(env, 'POST', 'manifests/generate', { shipment_id: sids });
    if (g.manifest_url) return g.manifest_url;
  } catch (e) { if (!/already|generated/i.test(String(e.message))) throw e; }
  const p = await sr(env, 'POST', 'manifests/print', { order_ids: oids });
  if (!p.manifest_url) throw new Error('Shiprocket did not return a manifest' + (p.message ? ': ' + p.message : ''));
  return p.manifest_url;
}

export { srTrack };
