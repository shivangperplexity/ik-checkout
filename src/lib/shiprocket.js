// src/lib/shiprocket.js — Shiprocket is Ink Kulture's fixed courier partner.
//
// From the IK dashboard one tap does: package size (lib/packing.js) -> live rates -> cheapest courier ->
// Shiprocket order -> AWB -> pickup request -> label -> Shopify fulfilment + WhatsApp "shipped".
// After that the cron (lib/wa-ship.js) follows the AWB through Shiprocket tracking: picked up / in transit /
// out for delivery / failed attempt / RTO, and the dashboard "Shipments" tab shows NDR and RTO with actions.
//
// Shiprocket API (https://apiv2.shiprocket.in/v1/external), logged in with a Shiprocket *API user*:
//   POST auth/login {email,password} -> {token}                       GET  courier/serviceability/?pickup_postcode=...
//   POST orders/create/adhoc {...}  -> {order_id, shipment_id}        POST courier/assign/awb {shipment_id, courier_id}
//   POST courier/generate/pickup {shipment_id:[id]}                   POST courier/generate/label {shipment_id:[id]}
//   GET  courier/track/awb/<awb>                                      GET  settings/company/pickup
//   POST orders/cancel {ids:[order_id]}                               GET  ndr/all ; POST ndr/<awb>/action
// Only the fields documented there are used; replies are read defensively and errors are passed on verbatim.

import { cfg, courierBlocked } from './shipping.js';
import { codDue } from './partial-cod.js';
import { packCfg, packOrder } from './packing.js';
import { summarize, PRE } from './sr-scan.js';

const SR = 'https://apiv2.shiprocket.in/v1/external';
const TIMEOUT = 15000;
const now = () => Math.floor(Date.now() / 1000);

let tok = { value: '', exp: 0, key: '' };
const key = (c) => c.shiprocketEmail + ':' + c.shiprocketPassword;

export function srConnected(env) { const c = cfg(env); return !!(c.shiprocketEmail && c.shiprocketPassword); }

async function srToken(c, force) {
  if (!c.shiprocketEmail || !c.shiprocketPassword) throw new Error('Shiprocket is not connected. Add the API user login in Settings, Shipping carriers.');
  if (!force && tok.value && tok.key === key(c) && Date.now() < tok.exp) return tok.value;
  const r = await fetch(SR + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: c.shiprocketEmail, password: c.shiprocketPassword }), signal: AbortSignal.timeout(TIMEOUT) });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error('Shiprocket login failed' + (j.message ? ': ' + j.message : ''));
  tok = { value: j.token, key: key(c), exp: Date.now() + 9 * 24 * 3600 * 1000 };
  return tok.value;
}

/** Authenticated Shiprocket call. path like 'courier/track/awb/123'. Retries once with a fresh token on 401. */
const SAFE_RETRY = (method, path) => method === 'GET' || /^orders\/cancel/.test(path);
export async function sr(env, method, path, body) {
  /* Shiprocket's own hiccups (502/503/504, timeouts): reads and cancels are retried twice, a second apart then three.
     Bookings are not: a retried AWB request could book twice. */
  for (let n = 0; ; n++) {
    try { return await sr1(env, method, path, body); }
    catch (e) {
      const transient = (e.status >= 500 && e.status < 600) || /timeout|aborted|fetch failed|ECONNRESET/i.test(String(e.message || e.name));
      if (!transient || !SAFE_RETRY(method, path) || n >= 2) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * (n + 1)));
    }
  }
}
async function sr1(env, method, path, body) {
  const c = cfg(env);
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await srToken(c, attempt > 0);
    const r = await fetch(`${SR}/${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
    if (r.status === 401 && attempt === 0) { tok = { value: '', exp: 0, key: '' }; continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = j.errors ? ' ' + JSON.stringify(j.errors).slice(0, 300) : '';
      const e = new Error(`Shiprocket ${path}: ${j.message || r.status}${detail}`); e.status = r.status; e.body = j; throw e;
    }
    return j;
  }
  throw new Error('Shiprocket: could not log in');
}

/* ---------- pickup locations ---------- */
/**
 * Why an AWB was not given. Shiprocket passes the courier's own reply through (Delhivery: packages[].remarks /
 * status / serviceable); this pulls the readable part out instead of a truncated JSON dump.
 */
export function awbFailReason(a) {
  const rd = a?.response?.data || a?.data || {};
  const bits = [];
  const add = (x) => { if (x === undefined || x === null || x === '') return; if (Array.isArray(x)) x.forEach(add); else if (typeof x === 'object') Object.values(x).forEach(add); else bits.push(String(x)); };
  add(rd.awb_assign_error);
  for (const p of Array.isArray(rd.packages) ? rd.packages : []) {
    if (p.remarks && (!Array.isArray(p.remarks) || p.remarks.length)) add(p.remarks);
    else if (p.status && !/success/i.test(p.status)) add(p.status);
    if (p.serviceable === false) bits.push('PIN not serviceable by this courier');
  }
  add(rd.rmk); add(rd.error); add(rd.message);
  add(a?.errors); if (a?.message && !/^Shiprocket courier\/assign/.test(a.message)) add(a.message);
  return [...new Set(bits.map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' · ').slice(0, 300);
}
const WALLET = /wallet|recharge|insufficient (balance|fund)|low balance|balance (is )?(low|insufficient)/i;

/** Shiprocket wallet balance in rupees (cached 5 min; null when it cannot be read). */
let walletCache = { at: 0, v: null };
export async function srWallet(env, fresh = false) {
  if (!fresh && walletCache.v !== null && Date.now() - walletCache.at < 5 * 60 * 1000) return walletCache.v;
  const j = await sr(env, 'GET', 'account/details/wallet-balance');
  const d = j?.data || j || {};
  const n = Number(d.balance_amount ?? d.balance ?? d.wallet_balance ?? d.amount);
  if (!Number.isFinite(n)) throw new Error('Shiprocket did not return a balance: ' + JSON.stringify(j).slice(0, 160));
  walletCache = { at: Date.now(), v: n };
  return n;
}

export async function srPickups(env) {
  const j = await sr(env, 'GET', 'settings/company/pickup');
  const list = j.data?.shipping_address || [];
  return list.map((p) => ({ name: p.pickup_location, pin: String(p.pin_code || ''), city: p.city || '' })).filter((p) => p.name);
}

/* ---------- rates for a real parcel ---------- */
const money = (v) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.round(n * 100) / 100 : null; };
/**
 * Couriers for one parcel, cheapest first. By default only the ones your rules allow (not blocked in Shiprocket, not on
 * the never-use list, in the "only use" list when one is set). { all: true } returns { list, message } with every
 * courier Shiprocket offers, each with `excluded` (why a rule leaves it out, '' when allowed) and `never` (never-use list).
 */
export async function srRates(env, { pin, cod, amount, pack }, { all = false } = {}) {
  const c = cfg(env);
  const qs = new URLSearchParams({ pickup_postcode: c.origin, delivery_postcode: pin, weight: String(pack.weight_kg), cod: cod ? '1' : '0', declared_value: String(Math.round(amount) || 499), length: String(pack.length), breadth: String(pack.breadth), height: String(pack.height) });
  let j;
  try { j = await sr(env, 'GET', 'courier/serviceability/?' + qs); }
  catch (e) { if (e.status === 404 || e.status === 422 || /no courier|not serviceable/i.test(e.message)) return all ? { list: [], message: String(e.body?.message || e.message || '').replace(/^Shiprocket [^:]+: /, '') } : []; throw e; }
  const list = j.data?.available_courier_companies;
  if (!Array.isArray(list)) return all ? { list: [], message: String(j.message || '') } : [];
  let only = null; try { only = c.shiprocketCouriers ? new RegExp(c.shiprocketCouriers, 'i') : null; } catch { only = null; }
  const rows = list.map((x) => {
    const name = String(x.courier_name || 'Courier'), never = courierBlocked(name, c.shiprocketBlock);
    return {
      id: String(x.courier_company_id ?? ''), courier: name,
      charge: money(x.rate ?? (Number(x.freight_charge || 0) + Number(x.cod_charges || 0))), freight: money(x.freight_charge), cod: money(x.cod_charges),
      edd: x.etd || x.estimated_delivery_days || '', rating: Number(x.rating) || null,
      never, excluded: never ? 'on your never-use list' : x.blocked ? 'blocked in your Shiprocket account' : only && !only.test(name) ? 'not in your "only use these couriers" list' : '',
    };
  });
  return all ? { list: rows, message: '' } : rows.filter((r) => !r.excluded);
}

/* ---------- tracking, adapted to the status vocabulary lib/wa-ship.js classify() reads ---------- */
function codeOf(text, srStatus) {
  const t = String(text || '').toLowerCase(), id = Number(srStatus);
  if (id === 7 || (/delivered/.test(t) && !/rto|return|undelivered|not delivered/.test(t))) return 'DL';
  if (id === 9 || id === 10 || /\brto\b|return to origin|returned to (origin|shipper|seller)|return initiated/.test(t)) return 'RT';
  if (id === 17 || /out for delivery/.test(t)) return 'OFD';
  if (id === 21 || /undelivered|ndr|delivery attempt|attempt(ed)? (failed|unsuccessful)|consignee (refused|unavailable)|customer (refused|not available)|refused|not reachable/.test(t)) return 'EX';
  if (id === 42 || /picked ?up|pickup done|shipment picked/.test(t)) return 'PD';
  if (id === 18 || /in transit|reached|hub|dispatched|arrived|departed|received at|bagged|manifest/.test(t)) return 'IT';
  return 'PP';
}
export function adaptTrack(j) {
  const td = j?.tracking_data || {};
  const acts = Array.isArray(td.shipment_track_activities) ? td.shipment_track_activities : [];
  const history = acts.map((a) => ({ status_code: PRE.test(String(a.activity || a.status || '')) ? 'PP' : codeOf(`${a['sr-status-label'] || ''} ${a.status || ''} ${a.activity || ''}`, a['sr-status']), message: String(a.activity || a.status || ''), location: String(a.location || ''), event_time: String(a.date || '').replace('T', ' ').slice(0, 19) }));
  const trk = Array.isArray(td.shipment_track) ? td.shipment_track[0] || {} : {};
  const top = history.slice().sort((x, y) => (y.event_time > x.event_time ? 1 : -1))[0];
  const now1 = codeOf(trk.current_status, td.shipment_status);
  const cur = now1 !== 'PP' ? now1 : (top ? top.status_code : 'PP');
  const status = { DL: 'delivered', RT: 'rto_initiated', EX: 'ndr', IT: 'in_transit', OFD: 'in_transit', PD: 'in_transit' }[cur] || 'pickup_pending';
  const pickup = history.find((h) => h.status_code === 'PD');
  /* Before a real pickup scan, hub scans ("Manifested - Out for Pickup", "Data Received") must not read as picked up /
     in transit, or customers get "picked up" messages for parcels still on our shelf (lib/sr-scan.js). */
  if (!summarize(j).picked) {
    return { status: 'pickup_pending', edd: '', pickup_date: '', delivered_date: '', rto_status: '', courier_name: trk.courier_name || '',
      history: history.map((h) => ({ ...h, status_code: 'PP' })) };
  }
  return {
    status, edd: String(td.etd || trk.edd || '').slice(0, 10), pickup_date: pickup ? pickup.event_time : trk.pickup_date || '',
    delivered_date: cur === 'DL' ? (trk.delivered_date || top?.event_time || 'yes') : '', rto_status: cur === 'RT' ? (trk.current_status || 'RTO') : '',
    courier_name: trk.courier_name || '', history: history.length ? history : (cur !== 'PP' ? [{ status_code: cur, message: String(trk.current_status || ''), location: '', event_time: '' }] : []),
  };
}
export async function srTrack(env, awb) { return adaptTrack(await sr(env, 'GET', `courier/track/awb/${encodeURIComponent(awb)}`)); }

/* ---------- NDR (failed delivery attempts) and RTO ---------- */
export async function ndrList(env) {
  const j = await sr(env, 'GET', 'ndr/all');
  const list = Array.isArray(j.data) ? j.data : j.data?.data || [];
  return list.map((x) => ({ awb: String(x.awb_code || x.awb || ''), order: x.order_id || x.channel_order_id || '', reason: String(x.ndr_reason || x.reason || x.remarks || ''), attempts: Number(x.ndr_attempt || x.attempts || x.total_attempts || 0) || null, date: String(x.ndr_raised_at || x.date || '') })).filter((x) => x.awb);
}
/** action: 're-attempt' (ask the courier to try again, optionally on a later date / new phone) or 'return' (send it back, RTO). */
export async function ndrAction(env, { awb, action, comments, phone, deferred_date, address1, address2 }) {
  if (!awb) throw new Error('Missing AWB');
  const body = action === 'return' ? { action: 'return', comments: comments || 'Return to origin' }
    : { action: 're-attempt', comments: comments || 'Please re-attempt delivery', ...(phone ? { phone } : {}), ...(deferred_date ? { deferred_date } : {}), ...(address1 ? { address1 } : {}), ...(address2 ? { address2 } : {}) };
  try { return await sr(env, 'POST', `ndr/${encodeURIComponent(awb)}/action`, body); }
  catch (e) {
    if (e.status !== 404 || action === 'return') throw e;
    const q = new URLSearchParams({ awb, ...(phone ? { phone } : {}), ...(deferred_date ? { deferred_date } : {}), ...(address1 ? { address1 } : {}), ...(address2 ? { address2 } : {}) });
    return sr(env, 'POST', 'ndr/reattempt?' + q, {});   // older route, same effect
  }
}

/* ---------- booking ---------- */
/**
 * Shiprocket line items. Shiprocket rejects an order when two lines share a SKU ("SKU cannot be repeated"), and the
 * store does create such orders (the same tattoo added twice is two Shopify lines). Same SKU + same price -> one line
 * with the units added up; same SKU at different prices -> the SKU gets a -2, -3 suffix so each line stays unique.
 */
export function srItems(items) {
  const out = [], seen = {};
  for (const i of items || []) {
    const base = String(i.sku || i.title || 'item').trim().slice(0, 30) || 'item';
    const price = Math.max(1, Math.round(i.unitPrice) || 1), units = Math.max(1, Math.round(Number(i.quantity) || 1));
    const same = out.find((o) => o.sku === base && o.selling_price === price);
    if (same) { same.units += units; continue; }
    const n = (seen[base] = (seen[base] || 0) + 1);
    out.push({ name: i.title, sku: n > 1 ? `${base.slice(0, 27)}-${n}` : base, units, selling_price: price, discount: '', tax: '', hsn: '' });
  }
  return out;
}
const istDate = () => new Date(Date.now() + 19800000).toISOString().slice(0, 16).replace('T', ' ');
const digits10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);

/** Parcel + live rates + the courier we'd use, without booking anything. */
export async function planShipment(env, order, row, { pickOption, allowNever = false }) {
  const s = env.SETTINGS?.shipping || {};
  const pack = packOrder(order.items, packCfg(s.pack));
  const pin = String(order.address?.zip || row.pincode || '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(pin)) throw new Error('This order has no valid PIN code');
  /* COD only when something is still to be collected: a COD order paid online later (converted) ships prepaid, and a
     partial-COD order collects only the balance (total - advance). */
  /* a COD order paid online before shipping is worth what was paid (the pay-online discount), not the old COD total */
  const paidOnline = row.converted_at && Number(row.paid_paise) > 0 ? Number(row.paid_paise) / 100 : 0;
  const due = codDue(row), cod = due > 0, amount = paidOnline || Number(row.total_paise) / 100 || 499, codAmount = cod ? due / 100 : 0;
  const c = cfg(env);
  const r = await srRates(env, { pin, cod, amount: cod ? codAmount : amount, pack }, { all: true });
  const ready = (arr) => arr.map((o) => ({ ...o, eddDate: eddOf(o.edd) })).sort((a, b) => (a.charge ?? 9e9) - (b.charge ?? 9e9));
  let options = ready(r.list.filter((o) => !o.excluded)), fallback = '', why = '';
  /* none of the couriers your rules allow deliver here: offer the others Shiprocket has (never the never-use list);
     ones you only left out of the "only use" list come before ones blocked inside Shiprocket */
  if (!options.length) {
    const others = ready(r.list.filter((o) => o.excluded && !o.never)).sort((a, b) => Number(/Shiprocket/.test(a.excluded)) - Number(/Shiprocket/.test(b.excluded)));
    if (others.length) {
      options = others;
      fallback = `None of the couriers your rules allow deliver to ${pin}, so these are the others Shiprocket offers (${[...new Set(others.map((o) => o.excluded))].join('; ')}).`;
    }
  }
  /* only never-use couriers serve this PIN and you chose to use one for this order: allowed for this booking only */
  if (!options.length && allowNever) {
    const nv = ready(r.list.filter((o) => o.never));
    if (nv.length) { options = nv; fallback = `Only ${[...new Set(nv.map((o) => o.courier))].join(', ')} deliver${nv.length > 1 ? '' : 's'} to ${pin}. Using it for this order only: it stays on your never-use list for every other order.`; }
  }
  if (!options.length) {
    const never = r.list.filter((o) => o.never).map((o) => o.courier);
    if (never.length) why = `Only ${[...new Set(never)].join(', ')} deliver${never.length > 1 ? '' : 's'} to ${pin}, and it is on your never-use list (Settings, Shipping carriers).`;
    else if (cod) {
      const p = await srRates(env, { pin, cod: false, amount, pack }, { all: true }).catch(() => ({ list: [] }));
      const n = p.list.filter((o) => !o.never).length;
      why = n ? `No courier collects Cash on Delivery at ${pin}, but ${n} deliver${n > 1 ? '' : 's'} prepaid: send the customer the pay-online link and book it once paid.`
        : `Shiprocket has no courier for ${pin} at all${r.message ? ' (' + r.message + ')' : ''}. Check the PIN code with the customer.`;
    } else why = `Shiprocket has no courier for ${pin}${r.message ? ' (' + r.message + ')' : ''}. Check the PIN code with the customer.`;
  }
  const pick = pickOption(options, { policy: c.policy, toleranceDays: c.toleranceDays });
  const excluded = r.list.filter((o) => o.excluded && !options.some((x) => x.id === o.id)).map((o) => ({ courier: o.courier, charge: o.charge, edd: o.edd, excluded: o.excluded }));
  const onlyNever = !r.list.some((o) => !o.never) && r.list.some((o) => o.never);
  return { pack, pin, cod, amount, codAmount, options, pick, fallback, why, excluded, onlyNever };
}
function eddOf(edd) {
  const s = String(edd || '').trim(); if (!s) return null;
  const d = /^(\d+)$/.exec(s); if (d) { const t = new Date(); t.setUTCDate(t.getUTCDate() + Number(d[1])); return t; }
  const p = Date.parse(s); return Number.isNaN(p) ? null : new Date(p);
}

/**
 * Book one order with Shiprocket. Safe to call again: it resumes where it stopped and never creates a second
 * Shiprocket order / AWB for the same Shopify order. Addresses are sent to Shiprocket, never stored here.
 */
export async function bookShipment(env, order, row, { pickOption, allowNever = false }) {
  const db = env.DB, id = String(row.order_id);
  /* the customer is paying online right now (pay-online offer): booking it as COD would race the payment */
  if (!row.converted_at && Number(row.convert_started_at) > Math.floor(Date.now() / 1000) - 15 * 60) throw new Error('The customer is paying online right now (pay-online offer). Book it again in 15 minutes: it will go as prepaid if they paid.');
  const s = env.SETTINGS?.shipping || {};
  if (!s.sr_pickup) throw new Error('Choose your Shiprocket pickup location in Settings, Shipping carriers, first.');
  let rec = await db.prepare('SELECT * FROM shipments WHERE order_id=?').bind(id).first();
  /* a cancelled earlier booking: start a fresh Shiprocket order (new order id suffix, Shiprocket keeps the old one) */
  let rebook = '';
  if (rec && rec.status === 'cancelled') {
    rebook = '-R' + String(now()).slice(-4);
    if (rec.awb) await db.prepare('INSERT INTO ship_old_awbs (awb, order_id, order_name, courier, cancelled_at) VALUES (?,?,?,?,?) ON CONFLICT (awb) DO NOTHING').bind(String(rec.awb), id, rec.order_name || row.order_name, rec.courier || '', now()).run().catch(() => {});
    await db.prepare('DELETE FROM shipments WHERE order_id=?').bind(id).run(); rec = null;
  }
  if (rec?.awb) return { ok: true, already: true, shipment: publicRec(rec) };

  const plan = await planShipment(env, order, row, { pickOption, allowNever });
  if (!plan.pick) throw new Error(plan.why || `Shiprocket has no courier for PIN ${plan.pin} (${plan.cod ? 'COD' : 'prepaid'}).`);
  const t = now();
  if (!rec) {
    await db.prepare(`INSERT INTO shipments (order_id, order_name, courier, courier_id, charge_paise, pack, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (order_id) DO NOTHING`)
      .bind(id, row.order_name, plan.pick.courier, plan.pick.id, Math.round((plan.pick.charge || 0) * 100), JSON.stringify(plan.pack), 'booking', t, t).run();
    rec = await db.prepare('SELECT * FROM shipments WHERE order_id=?').bind(id).first();
  }
  const save = (f) => {
    const ks = Object.keys(f);
    return db.prepare(`UPDATE shipments SET ${ks.map((k) => k + '=?').join(',')}, updated_at=? WHERE order_id=?`).bind(...ks.map((k) => f[k]), now(), id).run();
  };

  /* 1. the Shiprocket order (once) */
  if (!rec.sr_shipment_id) {
    const a = order.address || {}, parts = String(a.name || row.first_name || 'Customer').trim().split(/\s+/);
    const first = a.firstName || parts.shift(), last = a.lastName || parts.join(' ');
    const body = {
      order_id: String(row.order_name || id).replace(/^#/, '') + rebook, order_date: istDate(), pickup_location: s.sr_pickup, channel_id: '', comment: 'Ink Kulture',
      billing_customer_name: first, billing_last_name: last || '', billing_address: a.address1 || '', billing_address_2: a.address2 || '',
      billing_city: a.city || row.city || '', billing_pincode: plan.pin, billing_state: a.province || '', billing_country: 'India',
      billing_email: order.email || row.email || s.sr_fallback_email || '', billing_phone: digits10(a.phone) || digits10(row.phone),
      shipping_is_billing: true,
      order_items: srItems(order.items),
      payment_method: plan.cod ? 'COD' : 'Prepaid', shipping_charges: 0, giftwrap_charges: 0, transaction_charges: 0, total_discount: 0,
      /* Shiprocket's order total is what the courier collects on a COD parcel: send the balance for partial COD */
      sub_total: plan.cod ? Math.round(plan.codAmount) : Math.round(plan.amount), length: plan.pack.length, breadth: plan.pack.breadth, height: plan.pack.height, weight: plan.pack.weight_kg,
    };
    if (!body.billing_email) throw new Error('This order has no email. Set a fallback email in Settings, Shipping carriers, so Shiprocket can accept it.');
    if (!body.billing_phone || !body.billing_address || !body.billing_city || !body.billing_state) throw new Error('The order address is incomplete (name, address, city, state and phone are needed).');
    const j = await sr(env, 'POST', 'orders/create/adhoc', body);
    if (!j.shipment_id) throw new Error('Shiprocket did not create the order: ' + (j.message || JSON.stringify(j).slice(0, 200)));
    await save({ sr_order_id: String(j.order_id), sr_shipment_id: String(j.shipment_id), cod_paise: plan.cod ? Math.round(plan.codAmount) * 100 : 0 });
    rec.sr_order_id = String(j.order_id); rec.sr_shipment_id = String(j.shipment_id);
    /* read back what Shiprocket will collect, so a wrong COD amount shows up in reconciliation straight away */
    try { const st = await srOrderAmount(env, rec.sr_order_id); if (st) await save({ sr_total_paise: st.cod ? Math.round(st.total * 100) : 0 }); } catch { /* checked again by the audit */ }
  }

  /* 2. AWB with the cheapest courier (a resumed booking that had picked a courier now on the never-use list switches) */
  if (courierBlocked(rec.courier, cfg(env).shiprocketBlock) && !(allowNever && courierBlocked(plan.pick.courier, cfg(env).shiprocketBlock))) {
    await save({ courier: plan.pick.courier, courier_id: plan.pick.id, charge_paise: Math.round((plan.pick.charge || 0) * 100) });
    rec.courier = plan.pick.courier; rec.courier_id = plan.pick.id;
  }
  /* A courier can refuse a parcel Shiprocket listed (its own PIN / COD / pickup rules): the next cheapest one is
     tried, up to 3 couriers. Only a wallet problem stops at once (another courier would not help). */
  let cur = { id: String(rec.courier_id || plan.pick.id), courier: rec.courier || plan.pick.courier, charge: Number(rec.charge_paise || 0) / 100 || plan.pick.charge };
  const tried = new Set(), reasons = [];
  let awb = '', rd = {};
  for (let i = 0; i < 3 && !awb; i++) {
    let a;
    try { a = await sr(env, 'POST', 'courier/assign/awb', { shipment_id: rec.sr_shipment_id, courier_id: cur.id }); }
    catch (e) { if (e.status === 401 || e.status === 403) throw e; a = { ...(e.body || {}), message: e.body?.message || e.message }; }
    rd = a.response?.data || a.data || {};
    awb = rd.awb_code || a.awb_code || '';
    if (awb) break;
    const why = awbFailReason(a) || 'no reason given';
    reasons.push(`${cur.courier}: ${why}`);
    tried.add(cur.id);
    if (WALLET.test(why)) break;
    const next = plan.options.find((o) => o.id && !tried.has(String(o.id)));
    if (!next) break;
    cur = { id: String(next.id), courier: next.courier, charge: next.charge };
    await save({ courier: cur.courier, courier_id: cur.id, charge_paise: Math.round((cur.charge || 0) * 100) });
  }
  if (!awb) {
    let hint = '';
    try { const bal = await srWallet(env, true); if (bal !== null && bal < (cur.charge || 0) + 1) hint = ` Your Shiprocket wallet has ₹${bal}, less than this shipment's ₹${cur.charge}: recharge it.`; } catch { /* balance unknown */ }
    throw new Error(`Shiprocket could not assign an AWB. ${reasons.join(' | ')}.${hint}`);
  }
  const courier = rd.courier_name || cur.courier;
  await save({ awb: String(awb), courier, courier_id: cur.id, charge_paise: Math.round((cur.charge || 0) * 100), status: 'booked' });

  /* 3. pickup + label (a failure here does not undo the AWB; they can be retried from the dashboard) */
  let pickupNote = '', label = '';
  try { const p = await sr(env, 'POST', 'courier/generate/pickup', { shipment_id: [Number(rec.sr_shipment_id)] }); pickupNote = String(p.response?.data?.pickup_scheduled_date || p.pickup_status || 'requested'); }
  catch (e) { pickupNote = 'pickup: ' + String(e.message).slice(0, 120); }
  try { const l = await sr(env, 'POST', 'courier/generate/label', { shipment_id: [Number(rec.sr_shipment_id)] }); label = l.label_url || ''; } catch { /* label can be fetched later */ }
  await save({ pickup: pickupNote, label_url: label });
  rec = await db.prepare('SELECT * FROM shipments WHERE order_id=?').bind(id).first();
  return { ok: true, shipment: publicRec(rec), pack: plan.pack, note: reasons.length ? `Booked with ${rec.courier} (${reasons.join(' | ')})`.slice(0, 300) : '' };
}

/** What Shiprocket has on its order: { total (₹), cod (bool) } — the total is the amount a COD courier collects. */
export async function srOrderAmount(env, srOrderId) {
  if (!srOrderId) return null;
  const j = await sr(env, 'GET', `orders/show/${encodeURIComponent(srOrderId)}`);
  const d = j?.data || j || {};
  const total = Number(d.total ?? d.net_total ?? d.order_total ?? d.sub_total);
  if (!Number.isFinite(total)) return null;
  const pm = String(d.payment_method || d.payment_mode || '').toLowerCase();
  return { total, cod: pm ? pm === 'cod' : Number(d.cod) === 1 };
}

export function publicRec(r) {
  if (!r) return null;
  let pack = null; try { pack = JSON.parse(r.pack || 'null'); } catch { /* ignore */ }
  return { order_id: r.order_id, order_name: r.order_name, awb: r.awb || '', courier: r.courier || '', charge: (Number(r.charge_paise) || 0) / 100, label_url: r.label_url || '', pickup: r.pickup || '', fulfil_error: r.fulfil_error || '', status: r.status || '', rto: !!r.rto, pack, track_url: r.awb ? `https://shiprocket.co/tracking/${r.awb}` : '', sr_order_id: r.sr_order_id || '' };
}

export async function cancelShipment(env, rec) {
  if (!rec?.sr_order_id) throw new Error('No Shiprocket order to cancel');
  try { await sr(env, 'POST', 'orders/cancel', { ids: [Number(rec.sr_order_id)] }); }
  catch (e) {
    /* order cancel down: cancelling the AWB itself also takes it off the pickup */
    if (!(e.status >= 500) || !rec.awb) throw e;
    try { await sr(env, 'POST', 'orders/cancel/shipment/awbs', { awbs: [String(rec.awb)] }); }
    catch (e2) { throw /already\s+cancel/i.test(String(e2.message)) ? e2 : e; }
  }
}

/** Label only (no pickup request). Returns the stored label URL, or asks Shiprocket for a fresh one when there is none or `force` is set. */
export async function ensureLabel(env, rec, force = false) {
  if (rec.label_url && !force) return rec.label_url;
  const l = await sr(env, 'POST', 'courier/generate/label', { shipment_id: [Number(rec.sr_shipment_id)] });
  return l.label_url || '';
}

/** Re-request pickup / label for a booked shipment. */
export async function refreshDocs(env, rec) {
  const sid = [Number(rec.sr_shipment_id)];
  let label = rec.label_url || '', pickup = rec.pickup || '';
  try { const l = await sr(env, 'POST', 'courier/generate/label', { shipment_id: sid }); label = l.label_url || label; } catch (e) { label = label || ''; }
  try { const p = await sr(env, 'POST', 'courier/generate/pickup', { shipment_id: sid }); pickup = String(p.response?.data?.pickup_scheduled_date || p.pickup_status || 'requested'); } catch (e) { pickup = 'pickup: ' + String(e.message).slice(0, 120); }
  return { label_url: label, pickup };
}
