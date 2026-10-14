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
import { cancelFulfilmentsFor } from './shopify.js';

const now = () => Math.floor(Date.now() / 1000);
export const STAGES = ['pickup_pending', 'pickup_failed', 'transit', 'ofd', 'ndr', 'delivered', 'rto', 'lost', 'cancelled'];
export const FINAL = ['delivered', 'rto_done', 'cancelled', 'lost'];

/** Stage from Shiprocket's status text. `scanned` = the courier has scanned it at least once (picked up). */
export function stageOf(text, scanned = false) {
  const t = String(text || '').toLowerCase().replace(/_/g, ' ');
  if (!t.trim()) return scanned ? 'transit' : 'pickup_pending';
  if (/cancel/.test(t) && !/pickup cancel/.test(t)) return 'cancelled';
  if (/\brto\b|return to origin|returned|return initiated/.test(t)) return 'rto';
  if (/lost|damaged|destroyed|untraceable|disposed/.test(t)) return 'lost';
  if (/undelivered|\bndr\b|delivery attempt|failed delivery|not delivered/.test(t)) return 'ndr';
  if (/out for delivery/.test(t)) return 'ofd';
  if (/delivered/.test(t)) return 'delivered';
  if (/pickup (exception|error|failed|cancel)|pick ?up not done|not picked/.test(t)) return 'pickup_failed';
  if (/out for pickup|pickup (scheduled|generated|queued|rescheduled|requested|pending)|awb assigned|manifest|label generated|ready to ship|^new$|booked/.test(t)) return scanned ? 'transit' : 'pickup_pending';
  if (/picked|shipped|transit|reached|dispatched|arrived|departed|connected|misrouted|delayed|hub|in flight|handover/.test(t)) return 'transit';
  return scanned ? 'transit' : 'pickup_pending';
}
export const LABEL = { pickup_pending: 'Pickup pending', pickup_failed: 'Pickup failed', transit: 'In transit', ofd: 'Out for delivery', ndr: 'NDR', delivered: 'Delivered', rto: 'RTO', lost: 'Lost / damaged', cancelled: 'Cancelled' };

/** Shiprocket's current status text for a booking: from tracking, else from the order record (before the first scan). */
async function srStatus(env, rec) {
  let text = '', scanned = false, scanAt = '', edd = '';
  try {
    const raw = await sr(env, 'GET', `courier/track/awb/${encodeURIComponent(rec.awb)}`);
    const td = raw?.tracking_data || {}, trk = Array.isArray(td.shipment_track) ? td.shipment_track[0] || {} : {};
    const acts = Array.isArray(td.shipment_track_activities) ? td.shipment_track_activities : [];
    text = String(trk.current_status || '');
    edd = String(td.etd || trk.edd || '').slice(0, 10);
    scanned = acts.some((a) => /picked|pickup done|in transit|shipped|reached|out for delivery|delivered|dispatched|arrived/i.test(`${a['sr-status-label'] || ''} ${a.activity || ''}`) && !/pickup (scheduled|generated|exception|error|queued)|out for pickup/i.test(`${a['sr-status-label'] || ''} ${a.activity || ''}`));
    if (acts[0]) scanAt = String(acts[0].date || '');
  } catch { /* no scans yet or tracking down: fall back below */ }
  if (!text && rec.sr_order_id) {
    try {
      const o = await sr(env, 'GET', `orders/show/${encodeURIComponent(rec.sr_order_id)}`);
      const d = o?.data || {}, sh = Array.isArray(d.shipments) ? d.shipments[0] || {} : d.shipments || {};
      text = String(sh.status || d.status || '');
    } catch { /* keep empty */ }
  }
  return { text, scanned, scanAt, edd };
}

/** Refresh one shipment row; returns the new stage. Also keeps things consistent if it was cancelled inside Shiprocket. */
export async function refreshShipment(env, rec) {
  const s = await srStatus(env, rec);
  const t = now();
  if (!s.text && !s.scanned) {
    await env.DB.prepare('UPDATE shipments SET tracked_at=? WHERE order_id=?').bind(t, String(rec.order_id)).run();
    return rec.stage || 'pickup_pending';
  }
  const stage = stageOf(s.text, s.scanned);
  const picked = !['pickup_pending', 'pickup_failed', 'cancelled'].includes(stage);
  await env.DB.prepare(`UPDATE shipments SET stage=?, sr_status=?, tracked_at=?, edd=COALESCE(NULLIF(?::text,''), edd),
      picked_at=CASE WHEN ?::boolean AND picked_at IS NULL THEN ?::bigint ELSE picked_at END,
      delivered_at=CASE WHEN ?::text='delivered' AND delivered_at IS NULL THEN ?::bigint ELSE delivered_at END,
      rto=CASE WHEN ?::text='rto' THEN TRUE ELSE rto END WHERE order_id=?`)
    .bind(stage, s.text.slice(0, 80), t, s.edd, picked, t, stage, t, stage, String(rec.order_id)).run();
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
