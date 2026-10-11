/**
 * WhatsApp shipment updates from NimbusPost tracking. Runs on the cron.
 *
 * Shopify gets each shipment's AWB + NimbusPost tracking link from NimbusPost's fulfilment. For every shipped order
 * we poll GET /v1/shipments/track/<awb> (at most every POLL seconds per order) and send each update once:
 *
 *   ship_picked  - first "Pickup Done" (PD/PKD) scan               - with the expected delivery date
 *   ship_transit - in transit (IT/RAD), at least 6h after pickup   - last seen city + expected delivery date
 *   ship_ofd     - out for delivery (OFD), once per day
 *   ship_failed  - a failed delivery attempt (EX / status ndr), once per attempt, and NOT when the courier says
 *                  the customer refused / cancelled with the OTP ("Code verified cancellation", "refused" ...)
 *
 * Delivered / RTO end tracking without a message. An order first seen mid-journey (e.g. when this is switched on)
 * only gets the update for where it is now, not a burst of old ones.
 *
 * Status vocabulary observed on this account (Oct 2026): status pickup_pending | in_transit | reached_at_destination |
 * ndr | rto_initiated | delivered; history codes PP, PD, PKD, IT, RAD, OFD, EX, DL, RT.
 */
import { orderDetail } from './shopify.js';
import { nimbus } from './shipping.js';
import { fireTrigger, logMsg } from './whatsapp.js';
import { triggerConfig } from './settings.js';

const now = () => Math.floor(Date.now() / 1000);
const POLL = 25 * 60;              // seconds between checks of one shipment
const MAX_PER_RUN = 30;
const WINDOW_DAYS = 20;
const TRANSIT_GAP = 6 * 3600;      // "in transit" goes out at least this long after "picked up"
/* Reasons that mean the customer did not want it: no "we'll re-attempt" message for these. */
export const REFUSED = /refus|reject|code verified|otp|cancel|not interested|don'?t want|do not want/i;

const parseTime = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T') + '+05:30'); return Number.isNaN(t) ? 0 : Math.floor(t / 1000); };
export const fmtEdd = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return 'in the next few days';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 6));
  if (d.getTime() < Date.now() - 86400000) return 'in the next few days';
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
};
/* "NBM/PNV, Navi Mumbai, MAHARASHTRA" -> "Navi Mumbai" */
export const cityOf = (loc) => {
  const parts = String(loc || '').split(',').map((x) => x.trim()).filter(Boolean);
  const c = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || '';
  return c && !/^[A-Z0-9/_-]{2,12}$/.test(c) ? c.replace(/\b([a-z])/g, (x) => x.toUpperCase()) : (c ? c.charAt(0) + c.slice(1).toLowerCase() : '');
};

/** Where the shipment is now, from NimbusPost's tracking reply (newest scan first). */
export function classify(t) {
  const st = String(t.status || '').toLowerCase();
  const hist = Array.isArray(t.history) ? t.history.slice().sort((a, b) => parseTime(b.event_time) - parseTime(a.event_time)) : [];
  const top = hist[0] || {};
  const code = String(top.status_code || '').toUpperCase();
  if (st === 'delivered' || code === 'DL' || t.delivered_date) return { stage: 'delivered' };
  if (/^rto|return/.test(st) || t.rto_status || code === 'RT') return { stage: 'rto' };
  if (code === 'OFD') return { stage: 'ofd', at: parseTime(top.event_time) };
  if (code === 'EX' || st === 'ndr') {
    const ex = hist.find((h) => String(h.status_code).toUpperCase() === 'EX') || top;
    return { stage: 'failed', at: parseTime(ex.event_time), reason: String(ex.message || '') };
  }
  const picked = hist.some((h) => /^(PD|PKD)$/i.test(h.status_code)) || !!t.pickup_date;
  if (/^(IT|RAD)$/.test(code) || /in_transit|reached_at_destination/.test(st)) return { stage: 'transit', at: parseTime(top.event_time), city: cityOf(top.location), picked };
  if (picked || /^(PD|PKD)$/.test(code)) return { stage: 'picked', at: parseTime(top.event_time) };
  return { stage: 'pending' };
}

const dayOf = (ts) => new Date((ts || now()) * 1000 + 19800000).toISOString().slice(0, 10);

/**
 * Decide what to send now. Pure, so it can be tested.
 * sent = { picked: ts, transit: ts, ofd: [yyyy-mm-dd], failed: [scan ts] }. Returns { todo, base } where base is
 * `sent` plus, for a shipment seen for the first time mid-journey, the earlier stages marked as already told.
 */
export function decide(c, sent, firstSeen, ndrReason = '') {
  const base = { ofd: [], failed: [], ...sent };
  const todo = [];
  if (firstSeen && ['transit', 'ofd', 'failed'].includes(c.stage)) base.picked = base.picked || 1;
  if (firstSeen && ['ofd', 'failed'].includes(c.stage)) base.transit = base.transit || 1;
  if (c.stage === 'picked' && !base.picked) todo.push('picked');
  if (c.stage === 'transit') {
    if (!base.picked) todo.push('picked');
    else if (!base.transit && (firstSeen || now() - Number(base.picked) >= TRANSIT_GAP)) todo.push('transit');
  }
  if (c.stage === 'ofd' && !base.ofd.includes(dayOf(c.at))) todo.push('ofd');
  if (c.stage === 'failed' && c.at && !base.failed.includes(c.at)) {
    /* The newest scan's own words win; NimbusPost's NDR remark is only used when the scan is a bare code ("70"). */
    const reason = /[a-z]{4,}/i.test(c.reason || '') ? c.reason : `${c.reason || ''} ${ndrReason}`;
    todo.push(REFUSED.test(reason) ? 'failed-refused' : 'failed');
  }
  return { todo, base };
}

function mark(sent, what, c) {
  const s = { ofd: [], failed: [], ...sent };
  const day = dayOf(c.at);
  if (what === 'picked') s.picked = now();
  if (what === 'transit') s.transit = now();
  if (what === 'ofd') s.ofd = [...s.ofd, day].slice(-10);
  if (what === 'failed' || what === 'failed-refused') s.failed = [...s.failed, c.at].slice(-10);
  return s;
}

/** Courier reasons for open NDRs, by AWB (one call per run). */
async function ndrReasons(env) {
  try {
    const n = await nimbus(env, 'ndr');
    const list = Array.isArray(n.data) ? n.data : n.data?.data || [];
    return Object.fromEntries(list.map((x) => [String(x.awb_number), String(x.courier_remarks || '')]));
  } catch { return {}; }
}

export async function shipUpdates(env) {
  if (!env.DB) return { shipChecked: 0 };
  const anyOn = ['ship_picked', 'ship_transit', 'ship_ofd', 'ship_failed'].some((k) => triggerConfig(env, k).enabled);
  if (!anyOn) return { shipChecked: 0, skipped: 'off' };
  const t = now();
  const rows = (await env.DB.prepare(
    `SELECT o.order_id, o.order_name, o.phone, o.first_name, o.status_url, s.awb, s.courier, s.url, s.sent, s.checked_at, s.order_id AS seen
       FROM orders o LEFT JOIN ship_track s ON s.order_id = o.order_id
      WHERE o.order_id IS NOT NULL AND o.created_at > ? AND o.status NOT IN ('cancelled','failed','pending_payment','completing')
        AND (s.done IS NULL OR s.done = FALSE) AND COALESCE(s.checked_at, 0) < ?
      ORDER BY COALESCE(s.checked_at, 0) LIMIT ${MAX_PER_RUN}`,
  ).bind(t - WINDOW_DAYS * 86400, t - POLL).all()).results;
  if (!rows.length) return { shipChecked: 0 };
  let ndr = null;
  let sentN = 0;
  const save = (r, f) => env.DB.prepare(
    `INSERT INTO ship_track (order_id, awb, courier, url, status, sent, checked_at, done, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (order_id) DO UPDATE SET awb=excluded.awb, courier=excluded.courier, url=excluded.url, status=excluded.status, sent=excluded.sent, checked_at=excluded.checked_at, done=excluded.done, updated_at=excluded.updated_at`,
  ).bind(String(r.order_id), f.awb || null, f.courier || null, f.url || null, f.status || null, JSON.stringify(f.sent || {}), t, !!f.done, t).run();

  for (const r of rows) {
    try {
      let { awb, courier, url } = r;
      if (!awb) {
        const o = await orderDetail(env, r.order_id);
        if (!o || o.cancelledAt) { await save(r, { done: true, status: 'cancelled' }); continue; }
        const f = (o.fulfillments || []).find((x) => !/CANCEL/i.test(String(x.status)) && x.trackingInfo?.some((ti) => ti.number));
        if (!f) { await save(r, { status: 'not-shipped' }); continue; }
        const ti = f.trackingInfo.find((x) => x.number);
        awb = ti.number; courier = ti.company || ''; url = ti.url || '';
      }
      const tr = (await nimbus(env, `shipments/track/${encodeURIComponent(awb)}`)).data || {};
      const c = classify(tr);
      let sent = {};
      try { sent = JSON.parse(r.sent || '{}') || {}; } catch { sent = {}; }
      const firstSeen = !r.seen || !r.awb;
      if (c.stage === 'failed' && ndr === null) ndr = await ndrReasons(env);
      const { todo, base } = decide(c, sent, firstSeen, (ndr || {})[awb] || '');
      sent = base;
      const vars = { name: r.first_name || 'there', order: r.order_name, courier: String(courier || tr.courier_name || 'our courier').replace(/\s+(Surface|Air)$/i, ''), edd: fmtEdd(tr.edd), location: c.city || 'a courier hub', track: url || r.status_url || '' };
      for (const what of todo) {
        if (what === 'failed-refused') {
          await logMsg(env, { direction: 'out', phone: r.phone, trigger: 'ship_failed', status: 'skipped', orderName: r.order_name, error: 'courier says the customer refused / cancelled with OTP' });
        } else {
          const key = { picked: 'ship_picked', transit: 'ship_transit', ofd: 'ship_ofd', failed: 'ship_failed' }[what];
          if (!triggerConfig(env, key).enabled) { sent = mark(sent, what, c); continue; }
          const res = await fireTrigger(env, key, { to: r.phone, vars, orderName: r.order_name });
          if (!res.ok && !res.skipped) continue; /* failed send: try again next run */
          sentN++;
        }
        sent = mark(sent, what, c);
      }
      await save(r, { awb, courier, url, status: tr.status || c.stage, sent, done: c.stage === 'delivered' || c.stage === 'rto' });
    } catch (e) {
      console.error('shipUpdates', r.order_id, e.message);
      await save(r, { awb: r.awb, courier: r.courier, url: r.url, status: 'error', sent: (() => { try { return JSON.parse(r.sent || '{}'); } catch { return {}; } })() }).catch(() => {});
    }
  }
  return { shipChecked: rows.length, shipSent: sentN };
}
