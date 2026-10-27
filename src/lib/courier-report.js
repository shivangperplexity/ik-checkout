/**
 * Courier report: every parcel ever shipped (NimbusPost era from Shopify's fulfilment tracking, Shiprocket from our own
 * shipments table), compared courier by courier.
 *
 *   RTO %            returned / (delivered + returned). Parcels still moving are left out.
 *   95% range        Wilson interval: with few parcels the true rate could be anywhere in it.
 *   State-adjusted   observed RTOs / RTOs expected from the states it delivered to (each state's RTO rate across all
 *                    couriers). 1.00 = as good as the average courier on the same addresses; 0.50 = half the RTOs.
 *   Speed            days from booking to delivery (median), and hours from booking to the courier's first scan.
 *   Cost / delivered freight paid (both ways for RTOs) / delivered parcels. Shiprocket only (NimbusPost freight unknown).
 */
import { normState } from './revenue.js';

const num = (x) => Number(x) || 0;
const now = () => Math.floor(Date.now() / 1000);
const STALE = 25 * 86400;   /* still "in transit" after this long: lost track, not counted */

export function familyOf(name) {
  const s = String(name || '').toLowerCase();
  if (/blue ?dart/.test(s)) return 'Blue Dart';
  if (/delhivery/.test(s)) return 'Delhivery';
  if (/xpress ?bees/.test(s)) return 'Xpressbees';
  if (/amazon|\bats\b/.test(s)) return 'Amazon';
  if (/ekart/.test(s)) return 'Ekart';
  if (/dtdc/.test(s)) return 'DTDC';
  if (/shadowfax/.test(s)) return 'Shadowfax';
  if (/ecom/.test(s)) return 'Ecom Express';
  if (/india ?post|speed ?post/.test(s)) return 'India Post';
  return s.trim() ? String(name).trim().split(/\s+/)[0] : '';
}
export const modeOf = (name) => (/air/i.test(String(name || '')) ? 'Air' : /surface|ground/i.test(String(name || '')) ? 'Surface' : '');

/** Wilson 95% interval for k of n, in % */
export function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d) * 100, Math.min(1, (c + m) / d) * 100].map((x) => Math.round(x));
}
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** A joined rev_orders + shipments row -> one parcel, or null (not shipped / no courier). Pure. */
export function parcelOf(r, t = now()) {
  const sr = !!(r.sr_awb && String(r.sr_status || '') !== 'cancelled');
  if (sr) {
    const stage = String(r.sr_stage || '');
    if (['pickup_pending', 'pickup_failed', 'cancelled', ''].includes(stage) && !r.sr_rto) return null;
    const outcome = r.sr_rto === true || r.sr_rto === 1 || stage === 'rto' ? 'rto' : stage === 'delivered' ? 'delivered' : 'transit';
    const booked = num(r.sr_created);
    return { via: r.sr_provider === 'shipprime' ? 'ShipPrime' : 'Shiprocket', name: r.sr_courier || '', family: familyOf(r.sr_courier), mode: modeOf(r.sr_courier), outcome, order: r.name, pay: r.pay || '', state: normState(r.region, ''),
      booked, first_scan: num(r.sr_picked) || null, delivered_at: num(r.sr_delivered_at) || null, charge: num(r.sr_charge) / 100, attempts: r.sr_attempts == null ? null : num(r.sr_attempts) };
  }
  if (!r.courier || !['delivered', 'returned', 'shipped'].includes(r.state)) return null;
  const booked = num(r.shipped_at);
  const outcome = r.state === 'delivered' ? 'delivered' : r.state === 'returned' ? 'rto' : booked && t - booked > STALE ? 'stale' : 'transit';
  return { via: r.carrier === 'nimbuspost' ? 'NimbusPost' : r.carrier === 'shiprocket' ? 'Shiprocket' : 'Other', name: r.courier, family: familyOf(r.courier), mode: modeOf(r.courier), outcome, order: r.name,
    pay: r.pay || '', state: normState(r.region, ''), booked, first_scan: num(r.picked_at) && num(r.picked_at) !== booked ? num(r.picked_at) : null, delivered_at: num(r.delivered_at) || null, charge: 0, attempts: null };
}

/** parcels -> report. Pure. */
export function buildReport(parcels) {
  const fin = parcels.filter((p) => p.outcome === 'delivered' || p.outcome === 'rto');
  const overall = { n: fin.length, rto: fin.filter((p) => p.outcome === 'rto').length };
  const stRate = {};
  for (const p of fin) { const s = (stRate[p.state || '?'] = stRate[p.state || '?'] || { n: 0, rto: 0 }); s.n++; if (p.outcome === 'rto') s.rto++; }
  const base = overall.n ? overall.rto / overall.n : 0;
  /* each state's rate, shrunk toward the average when it has few parcels (5 parcels' worth of the average) */
  const rateOf = (st) => { const s = stRate[st || '?'] || { n: 0, rto: 0 }; return (s.rto + 5 * base) / (s.n + 5); };

  const group = (list) => {
    const f = list.filter((p) => p.outcome === 'delivered' || p.outcome === 'rto'), rto = f.filter((p) => p.outcome === 'rto').length;
    const cod = f.filter((p) => p.pay === 'cod'), codRto = cod.filter((p) => p.outcome === 'rto').length;
    const expected = f.reduce((a, p) => a + rateOf(p.state), 0);
    const del = list.filter((p) => p.outcome === 'delivered' && p.delivered_at && p.booked);
    const scan = list.filter((p) => p.first_scan && p.booked && p.first_scan >= p.booked);
    const paid = f.filter((p) => p.charge > 0), freight = paid.reduce((a, p) => a + p.charge * (p.outcome === 'rto' ? 2 : 1), 0), paidDel = paid.filter((p) => p.outcome === 'delivered').length;
    const rtoAtt = f.filter((p) => p.outcome === 'rto' && p.attempts != null);
    const states = {}; for (const p of f) states[p.state || '?'] = (states[p.state || '?'] || 0) + 1;
    return {
      parcels: list.length, finished: f.length, delivered: f.length - rto, rto, transit: list.filter((p) => p.outcome === 'transit').length, stale: list.filter((p) => p.outcome === 'stale').length,
      rto_pct: f.length ? Math.round((rto / f.length) * 100) : null, range: wilson(rto, f.length),
      cod_finished: cod.length, cod_rto_pct: cod.length ? Math.round((codRto / cod.length) * 100) : null,
      adj: expected > 0 ? Math.round((rto / expected) * 100) / 100 : null, expected_rto: r1(expected),
      days_to_deliver: r1(median(del.map((p) => (p.delivered_at - p.booked) / 86400))), delivered_timed: del.length,
      hours_to_scan: r1(median(scan.map((p) => (p.first_scan - p.booked) / 3600))), scanned_48h: scan.length ? Math.round((scan.filter((p) => p.first_scan - p.booked <= 48 * 3600).length / scan.length) * 100) : null, scan_n: scan.length,
      avg_charge: paid.length ? Math.round(paid.reduce((a, p) => a + p.charge, 0) / paid.length) : null,
      cost_per_delivered: paidDel ? Math.round(freight / paidDel) : null,
      rto_attempts: rtoAtt.length ? r1(rtoAtt.reduce((a, p) => a + p.attempts, 0) / rtoAtt.length) : null,
      rto_orders: f.filter((p) => p.outcome === 'rto').map((p) => p.order).slice(0, 80), delivered_orders: f.filter((p) => p.outcome === 'delivered').map((p) => p.order).slice(0, 80),
      top_states: Object.entries(states).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, n]) => `${s} ${n}`).join(', '),
    };
  };
  const by = (key) => {
    const m = {}; for (const p of parcels) { const k = key(p); if (k) (m[k] = m[k] || []).push(p); }
    return Object.entries(m).map(([k, list]) => ({ key: k, ...group(list) })).sort((a, b) => b.parcels - a.parcels);
  };

  /* same states, side by side: the states with the most finished parcels, RTO % per courier family */
  const topStates = Object.entries(stRate).filter(([s]) => s !== '?').sort((a, b) => b[1].n - a[1].n).slice(0, 10).map(([s]) => s);
  const fams = [...new Set(fin.map((p) => p.family).filter(Boolean))];
  const head = topStates.map((s) => {
    const row = { state: s, all: Math.round((stRate[s].rto / stRate[s].n) * 100), n: stRate[s].n };
    for (const fm of fams) { const f = fin.filter((p) => p.state === s && p.family === fm); row[fm] = f.length ? { n: f.length, rto: f.filter((p) => p.outcome === 'rto').length } : null; }
    return row;
  });

  return {
    overall: { ...group(parcels) },
    families: by((p) => p.family),
    couriers: by((p) => `${p.via} · ${p.family}${p.mode ? ' ' + p.mode : ''}`),
    vias: by((p) => p.via),
    cod_only: by((p) => (p.pay === 'cod' ? p.family : '')),
    head_to_head: { families: fams, rows: head },
  };
}

export async function courierReport(env) {
  const rows = (await env.DB.prepare(`SELECT r.name, r.pay, r.state, r.region, r.carrier, r.courier, r.shipped_at, r.picked_at, r.delivered_at,
      s.awb AS sr_awb, s.courier AS sr_courier, s.provider AS sr_provider, s.stage AS sr_stage, s.rto AS sr_rto, s.status AS sr_status, s.created_at AS sr_created, s.picked_at AS sr_picked,
      s.delivered_at AS sr_delivered_at, s.charge_paise AS sr_charge, s.attempts AS sr_attempts, o.method AS ik_method, o.converted_at
    FROM rev_orders r LEFT JOIN shipments s ON s.order_id = r.order_id AND COALESCE(s.status,'') <> 'cancelled' AND s.awb IS NOT NULL AND s.awb <> ''
    LEFT JOIN orders o ON o.order_id = r.order_id`).all()).results;
  /* orders from our own checkout reach Shopify as "manual" payments: their real method is in our orders table */
  for (const r of rows) if (r.ik_method) r.pay = r.ik_method === 'cod' && !r.converted_at ? 'cod' : 'prepaid';
  const t = now(), parcels = rows.map((r) => parcelOf(r, t)).filter(Boolean);
  const missing = rows.filter((r) => !r.courier && r.carrier === 'nimbuspost').length;
  return { ok: true, at: t, parcels: parcels.length, missing_courier: missing, ...buildReport(parcels) };
}
