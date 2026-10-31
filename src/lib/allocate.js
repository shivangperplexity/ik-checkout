/**
 * Courier allocation by delivery record: for every parcel, the courier that is expected to cost least per DELIVERED
 * order on this store's own history, at this PIN area. (What ClickPost sells as "AI carrier allocation", on our data.)
 *
 *   RTO chance   COD parcels that reached a final state (delivered / RTO) in the last 180 days, per courier family,
 *                narrowed step by step: all couriers -> this courier -> this courier in the state -> this courier in the
 *                first 3 digits of the PIN. Each step is shrunk towards the one above (k parcels of weight), so a
 *                courier with 3 parcels in a PIN area does not swing the choice on luck.
 *   Slow pickup  share of the courier's bookings (last 60 days) not picked up within 48 hours. On this store a parcel
 *                picked up 4+ days after the order RTOs ~20 points more often (Oct 2026), so slow pickup adds to it.
 *   Cost         charge + chance x (freight back + the margin the order would have earned). Lowest wins, among the
 *                options within the delivery-date tolerance of the fastest.
 * Prepaid parcels rarely RTO here, so for them only cost and slow pickup count.
 * Settings > Shipping: smart_alloc (default on).
 */
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400000;

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
  if (/shree[ _]?maruti/.test(s)) return 'Shree Maruti';
  if (/india[ _]?post|speed[ _]?post/.test(s)) return 'India Post';
  return s.trim() ? String(name).trim().split(/[\s_]+/)[0] : '';
}

/** Pure: build the stats from rows { courier, stage, method, state_code, pincode, booked_at, picked_at, cancelled }. */
export function buildStats(rows, t = now()) {
  const S = { all: { n: 0, r: 0 }, fam: {}, famState: {}, famPin: {}, pickup: {}, pickAll: { n: 0, slow: 0 } };
  const bump = (o, k, rto) => { const x = (o[k] = o[k] || { n: 0, r: 0 }); x.n++; if (rto) x.r++; };
  for (const x of rows) {
    const f = familyOf(x.courier); if (!f) continue;
    if ((x.stage === 'delivered' || x.stage === 'rto') && x.method === 'cod') {
      const rto = x.stage === 'rto';
      S.all.n++; if (rto) S.all.r++;
      bump(S.fam, f, rto);
      if (x.state_code) bump(S.famState, f + '|' + x.state_code, rto);
      const p3 = String(x.pincode || '').slice(0, 3); if (/^\d{3}$/.test(p3)) bump(S.famPin, f + '|' + p3, rto);
    }
    const b = Number(x.booked_at) || 0;
    if (b && b > t - 60 * 86400 && b < t - 2 * 86400 && !x.cancelled) {
      const p = Number(x.picked_at) || 0;
      const slow = !p || p - b > 48 * 3600;
      const y = (S.pickup[f] = S.pickup[f] || { n: 0, slow: 0 }); y.n++; if (slow) y.slow++;
      S.pickAll.n++; if (slow) S.pickAll.slow++;
    }
  }
  return S;
}

/** Pure: shrunken RTO chance for a courier family at a state / PIN area. */
export function rtoChance(S, family, state, pin, k = 8) {
  const g = S.all.n >= 10 ? S.all.r / S.all.n : 0.45;
  const step = (x, prior) => (x ? (x.r + k * prior) / (x.n + k) : prior);
  const pf = step(S.fam[family], g);
  const ps = state ? step(S.famState[family + '|' + state], pf) : pf;
  const p3 = String(pin || '').slice(0, 3);
  return /^\d{3}$/.test(p3) ? step(S.famPin[family + '|' + p3], ps) : ps;
}
/** Pure: share of bookings not picked up within 48 h, shrunk towards the store average. */
export function slowPickup(S, family, k = 6, prior = null) {
  const g = prior != null ? prior : S.pickAll.n >= 10 ? S.pickAll.slow / S.pickAll.n : 0.15;
  const x = S.pickup[family];
  return x ? (x.slow + k * g) / (x.n + k) : g;
}

/**
 * Pure: the courier to book. options: [{ courier, charge, rto?, eddDate?, ok? }]. ctx: { cod, state, pin, loss, toleranceDays }.
 * Returns { pick, note, table } or null (fewer than 2 priced options, or too little history).
 */
export function smartPick(options, S, { cod = true, state = '', pin = '', loss = 150, toleranceDays = 2, maxExtra = 10, prefer = 'Delhivery' } = {}) {
  const priced = (options || []).filter((o) => o.charge != null && o.ok !== false && o.serviceable !== false && familyOf(o.courier));
  if (priced.length < 2 || !S || S.all.n < 20) return null;
  const dated = priced.filter((o) => o.eddDate);
  const fastest = dated.length ? Math.min(...dated.map((o) => +o.eddDate)) : null;
  let pool = fastest === null ? priced : priced.filter((o) => !o.eddDate || +o.eddDate <= fastest + toleranceDays * DAY);
  /* flat-rate band: only couriers within maxExtra rupees of the cheapest (Settings > Shipping: alloc_max_extra, default
     ₹10; empty = no limit). Keeps a ₹114 Blue Dart out when the flat-rate couriers cost ₹74. */
  if (maxExtra != null && maxExtra !== '' && Number.isFinite(Number(maxExtra))) { const lo = Math.min(...pool.map((o) => Number(o.charge))); const band = pool.filter((o) => Number(o.charge) <= lo + Number(maxExtra)); if (band.length) pool = band; }
  const liked = String(prefer || '').split(/[|,]/).map((x) => familyOf(x.trim())).filter(Boolean);
  /* Shiprocket's network scores for this PIN (0-5, all its sellers' parcels): a courier's RTO and pickup record here
     before this store has its own; they count less as the store's own parcels in the area add up */
  const avg = (key) => { const v = pool.map((o) => Number(o.perf?.[key])).filter((x) => x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const mRto = avg('rto'), mDel = avg('delivery');
  const p3 = String(pin || '').slice(0, 3);
  const est = (o) => {
    const f = familyOf(o.courier), pf = o.perf || {};
    const netSlow = Number(pf.pickup) > 0 ? Math.max(0, Math.min(0.7, ((4.5 - Number(pf.pickup)) / 3.5) * 0.7)) : null;
    const slow = slowPickup(S, f, 6, netSlow);
    let base = cod ? rtoChance(S, f, state, pin) : 0.03;
    if (cod && mRto != null && Number(pf.rto) > 0) {
      const own = (S.famPin[f + '|' + p3]?.n || 0) + (S.famState[f + '|' + state]?.n || 0) / 3;
      const mult = Math.max(0.6, Math.min(1.6, 1 + 0.3 * (mRto - Number(pf.rto)) + (mDel != null && Number(pf.delivery) > 0 ? 0.15 * (mDel - Number(pf.delivery)) : 0)));
      base = base * (1 + (10 / (10 + own)) * (mult - 1));
    }
    /* a courier with no record here at all is a guess: a little worse than average until it earns its own record */
    if (cod && !(S.fam[f]?.n >= 5) && !(Number(pf.rto) > 0)) base += 0.05;
    /* your preferred courier (Settings > Shipping: alloc_prefer, default Delhivery) wins near-ties; air is faster */
    if (liked.includes(f)) base *= 0.9;
    if (/\bair\b|_AIR/i.test(o.code || o.courier)) base *= 0.97;
    const p = Math.min(0.95, base + (cod ? 0.2 : 0.05) * slow);
    const back = o.rto != null ? Number(o.rto) : Number(o.charge);
    return { o, f, p, slow, cost: Number(o.charge) + p * (back + loss) };
  };
  const rows = pool.map(est).sort((a, b) => a.cost - b.cost);
  const best = rows[0], cheapest = [...rows].sort((a, b) => a.o.charge - b.o.charge)[0];
  const pct = (x) => Math.round(x * 100);
  const note = best.o === cheapest.o ? `${best.o.courier}: cheapest and ~${pct(best.p)}% RTO expected here`
    : `${best.o.courier} (₹${best.o.charge}, ~${pct(best.p)}% RTO${best.slow > 0.3 ? ', slow pickups' : ''}) over ${cheapest.o.courier} (₹${cheapest.o.charge}, ~${pct(cheapest.p)}% RTO${cheapest.slow > 0.3 ? `, ${pct(cheapest.slow)}% slow pickups` : ''}) on your parcels${state ? ' in ' + state : ''}`;
  return { pick: best.o, note, table: rows.map((x) => ({ courier: x.o.courier, charge: x.o.charge, rto_pct: pct(x.p), slow_pickup_pct: pct(x.slow), network: x.o.perf || null, expected: Math.round(x.cost) })) };
}

/** Shiprocket network scores per courier for one PIN, from its serviceability answer: { courierName: perf } */
export function perfOf(x) {
  const n = (v) => { const k = Number(v); return Number.isFinite(k) && k > 0 ? k : null; };
  const p = { rto: n(x.rto_performance), delivery: n(x.delivery_performance), pickup: n(x.pickup_performance), rating: n(x.rating) };
  return p.rto || p.delivery || p.pickup ? p : null;
}
/** Pure: the network scores for a ShipPrime courier code, from Shiprocket's list for the same PIN (same mode first). */
export function perfFor(code, srList) {
  const f = familyOf(code), air = /AIR/i.test(code);
  const same = (srList || []).filter((o) => o.perf && familyOf(o.courier) === f);
  return (same.find((o) => /air/i.test(o.courier) === air) || same[0] || {}).perf || null;
}
/** Keep the scores (courier_perf) so the scorecard can show the network view; best effort. */
export async function savePerf(env, pin, list) {
  try {
    const t = now();
    for (const o of (list || []).filter((x) => x.perf)) await env.DB.prepare('INSERT INTO courier_perf (pin, courier, rto, delivery, pickup, rating, at) VALUES (?,?,?,?,?,?,?) ON CONFLICT (pin, courier) DO UPDATE SET rto=EXCLUDED.rto, delivery=EXCLUDED.delivery, pickup=EXCLUDED.pickup, rating=EXCLUDED.rating, at=EXCLUDED.at')
      .bind(String(pin), o.courier, o.perf.rto, o.perf.delivery, o.perf.pickup, o.perf.rating, t).run();
  } catch (e) { /* table may not exist yet */ }
}

/* ---------------- data ---------------- */
let mem = null;
export async function allocStats(env) {
  if (mem && mem.at > now() - 1800) return mem.S;
  const rows = (await env.DB.prepare(`SELECT s.courier, s.stage, s.status, s.cancel_state, s.created_at AS booked_at, s.picked_at, o.method, o.converted_at, o.state_code, o.pincode
      FROM shipments s LEFT JOIN orders o ON o.order_id = s.order_id
      WHERE s.created_at > ? AND s.courier IS NOT NULL`).bind(now() - 180 * 86400).all()).results
    .map((x) => ({ ...x, cancelled: x.status === 'cancelled' || !!x.cancel_state, method: x.converted_at ? 'prepaid' : x.method }));
  const S = buildStats(rows);
  mem = { at: now(), S };
  return S;
}
export const smartOn = (env) => env.SETTINGS?.shipping?.smart_alloc !== false;

/** Dashboard: the courier scorecard (COD RTO + slow pickups per courier, and the worst state per courier). */
export async function scorecard(env) {
  const S = await allocStats(env);
  const net = {};
  try {
    for (const r of (await env.DB.prepare('SELECT courier, rto, delivery, pickup FROM courier_perf WHERE at > ?').bind(now() - 60 * 86400).all()).results) {
      const f = familyOf(r.courier); if (!f) continue; const x = (net[f] = net[f] || { pins: 0, rto: 0, delivery: 0, pickup: 0 });
      x.pins++; x.rto += Number(r.rto) || 0; x.delivery += Number(r.delivery) || 0; x.pickup += Number(r.pickup) || 0;
    }
  } catch (e) { /* no table yet */ }
  const fams = Object.keys({ ...S.fam, ...S.pickup, ...net });
  return { ok: true, cod_parcels: S.all.n, rto_pct: S.all.n ? Math.round((S.all.r / S.all.n) * 100) : null,
    couriers: fams.map((f) => ({ courier: f, parcels: S.fam[f]?.n || 0, rto_pct: S.fam[f]?.n ? Math.round((S.fam[f].r / S.fam[f].n) * 100) : null,
      expected_rto_pct: Math.round(rtoChance(S, f, '', '') * 100), network: net[f] ? { pins: net[f].pins, rto: +(net[f].rto / net[f].pins).toFixed(1), delivery: +(net[f].delivery / net[f].pins).toFixed(1), pickup: +(net[f].pickup / net[f].pins).toFixed(1) } : null, bookings: S.pickup[f]?.n || 0, slow_pickup_pct: Math.round(slowPickup(S, f) * 100),
      states: Object.entries(S.famState).filter(([k]) => k.startsWith(f + '|')).map(([k, v]) => ({ state: k.split('|')[1], parcels: v.n, rto_pct: Math.round((v.r / v.n) * 100) })).sort((a, b) => b.parcels - a.parcels).slice(0, 8) }))
      .sort((a, b) => b.parcels - a.parcels) };
}
