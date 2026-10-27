// src/lib/shipprime.js — ShipPrime as a second carrier next to Shiprocket.
//
// Each order can be shipped with Shiprocket (lib/shiprocket.js) or ShipPrime. A ShipPrime booking lives in the same
// `shipments` row (provider = 'shipprime'), so the Shipments tab, Shopify fulfilment, WhatsApp shipping messages,
// the courier report and cancel all work the same way. What differs:
//   * one call books it: POST /v1/forward -> AWB + courier + label PDF, order already PACKED (ShipPrime asks the
//     courier for the pickup itself; there is no separate pickup / manifest call);
//   * no NDR action API: re-attempts / returns for ShipPrime parcels are done in ShipPrime (Manage NDR). The NDR
//     autopilot leaves them alone and the customer's choice is kept for the team;
//   * weight only (weightGrams), no box size.
//
// API (Postman "ShipPrime API", linked from Profile -> API Setup), base https://api.shipprime.live,
// header Authorization: Bearer <shop token>:
//   POST /v1/forward                         create (clientReferenceId, paymentMethod, collectibleAmount, weightGrams,
//                                            declaredValue, preferredTpls, items, pickupAddress, deliveryAddress)
//   GET  /v1/forward/rates?pickupPincode&deliveryPincode&weightGrams&paymentMethod&collectibleAmount
//   GET  /v1/forward/track?awbs=a,b          POST /v1/forward/{awb}/cancel (pre-pickup only, 409 CANCEL_FAILED after)
//   GET  /v1/forward/wallet                  GET  /v1/external/courier/track/awb/{awb} (Shiprocket-style tracking)
// Errors: { status:'FAILED', code, message }. Webhook: POST to our URL with Authorization: Bearer <secret>, one JSON
// payload per status change (flow, awb_number, order_status, picked_at, delivered_at, rto_at, tpl_vendor ...); a
// non-200 is not retried, so the 5-minute tracking poll stays on as the backstop.

import { hmacSha256hex, safeEqual } from './util.js';

const API = 'https://api.shipprime.live';
const TIMEOUT = 20000;
const now = () => Math.floor(Date.now() / 1000);

/** ShipPrime's courier codes (from its dashboard). */
export const SP_COURIERS = ['BLUEDART', 'BLUEDART_AIR', 'XPRESSBEES', 'XPRESSBEES_CDC', 'XPRESSBEES_PREMIUM', 'DELHIVERY', 'DELHIVERY_CDC', 'DELHIVERY_PREMIUM', 'DELHIVERY_AIR',
  'SHADOWFAX', 'SHADOWFAX_CDC', 'SHADOWFAX_PREMIUM', 'EKART', 'ECOM', 'DTDC', 'DTDC_AIR', 'SHREE_MARUTI', 'SHREE_MARUTI_AIR', 'AMAZON'];
export const SP_DEFAULT_PREFER = 'BLUEDART|XPRESSBEES|DELHIVERY';

export const spToken = (env) => String(env.SETTINGS?.shipping?.shipprime_token || env.SHIPPRIME_TOKEN || '').trim();
export const spConnected = (env) => !!spToken(env);
export const spTrackUrl = (awb) => `https://www.shipprime.live/track-order?awb=${encodeURIComponent(String(awb || ''))}`;
/** Public tracking page for a shipment row (either carrier). */
export const trackUrlOf = (rec) => (!rec?.awb ? '' : rec.provider === 'shipprime' ? spTrackUrl(rec.awb) : `https://shiprocket.co/tracking/${rec.awb}`);

/** "XPRESSBEES_PREMIUM" -> "Xpressbees Premium", "BLUEDART_AIR" -> "Blue Dart Air" */
export function courierLabel(code) {
  const c = String(code || '').trim();
  if (!c) return '';
  if (!/^[A-Z0-9_]+$/.test(c)) return c;
  return c.split('_').map((w) => ({ BLUEDART: 'Blue Dart', XPRESSBEES: 'Xpressbees', CDC: 'CDC', DTDC: 'DTDC', ECOM: 'Ecom Express', AIR: 'Air' }[w] || w.charAt(0) + w.slice(1).toLowerCase())).join(' ');
}

/** Secret ShipPrime sends as "Authorization: Bearer <secret>" on webhooks (set the same one in ShipPrime). */
export async function spWebhookSecret(env) {
  const base = env.ADMIN_SECRET || env.CRON_SECRET || 'ik|' + (env.DATABASE_URL || env.POSTGRES_URL || 'x');
  return (await hmacSha256hex(base, 'shipprime-webhook')).slice(0, 40);
}
export const spWebhookUrl = (env) => `${String(env.WORKER_URL || 'https://ik-checkout.vercel.app').replace(/\/$/, '')}/api/shipprime/webhook`;

/** One ShipPrime call. Errors carry .status, .code and ShipPrime's message. Only reads are retried (never a create). */
export async function sp(env, method, path, body) {
  const token = spToken(env);
  if (!token) throw new Error('ShipPrime is not connected. Paste the API token in Settings, Shipping carriers.');
  for (let n = 0; ; n++) {
    let r, j;
    try {
      r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + token },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
      j = await r.json().catch(() => ({}));
    } catch (e) {
      if (method === 'GET' && n < 2) { await new Promise((ok) => setTimeout(ok, 800 * (n + 1))); continue; }
      throw new Error('ShipPrime did not answer: ' + String(e.message || e).slice(0, 120));
    }
    if (r.ok && String(j?.status || '').toUpperCase() !== 'FAILED') return j;
    if (method === 'GET' && (r.status === 429 || r.status >= 500) && n < 2) { await new Promise((ok) => setTimeout(ok, 1000 * (n + 1))); continue; }
    const msg = r.status === 401 ? 'ShipPrime refused the API token (missing, revoked or rotated). Paste the current one in Settings, Shipping carriers.'
      : `ShipPrime ${r.status}${j?.code ? ' ' + j.code : ''}: ${j?.message || j?.error || JSON.stringify(j).slice(0, 200)}`;
    const err = new Error(msg); err.status = r.status; err.code = j?.code || ''; err.body = j;
    throw err;
  }
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const arrOf = (j) => (Array.isArray(j) ? j : Array.isArray(j?.rates) ? j.rates : Array.isArray(j?.data) ? j.data : Array.isArray(j?.data?.rates) ? j.data.rates
  : Array.isArray(j?.results) ? j.results : Array.isArray(j?.couriers) ? j.couriers : []);

/** Rates for every courier the shop has, cheapest first: [{ code, courier, charge, forward, cod, rto }] (₹, GST incl.). */
export function parseRates(j) {
  return arrOf(j).map((x) => {
    const code = String(x.tpl || x.tplVendor || x.tpl_vendor || x.courier || x.courierCode || x.vendor || x.name || '').trim();
    const forward = num(x.forwardCharge ?? x.forward_charge), cod = num(x.codCharge ?? x.cod_charge) || 0;
    const total = num(x.totalCharge ?? x.total_charge ?? x.charge) ?? (forward != null ? forward + cod : null);
    return { code, courier: courierLabel(code), charge: total, forward, cod, rto: num(x.rtoCharge ?? x.rto_charge) };
  }).filter((x) => x.code).sort((a, b) => (a.charge ?? 9e9) - (b.charge ?? 9e9));
}
export async function spRates(env, { from, pin, weightGrams, cod, amount }) {
  const q = new URLSearchParams({ pickupPincode: String(from), deliveryPincode: String(pin), weightGrams: String(Math.max(1, Math.round(weightGrams || 1))), paymentMethod: cod ? 'COD' : 'PREPAID' });
  if (cod) q.set('collectibleAmount', String(Math.max(1, Math.round(amount || 0))));
  return parseRates(await sp(env, 'GET', '/v1/forward/rates?' + q));
}

/** Pure: the courier to book. prefer = 'BLUEDART|XPRESSBEES|DELHIVERY' (first one offered wins); empty = cheapest. */
export function spPick(rates, prefer = SP_DEFAULT_PREFER) {
  const list = (rates || []).filter((r) => r.code);
  if (!list.length) return null;
  const want = String(prefer || '').split(/[|,\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  for (const w of want) { const hit = list.find((r) => r.code.toUpperCase() === w); if (hit) return hit; }
  return list[0];
}

/** ShipPrime line items: same SKU + price merged (one line per SKU), names / SKUs cut to ShipPrime's limits. */
export function spItems(items) {
  const out = [];
  for (const i of items || []) {
    const sku = String(i.sku || i.title || 'item').trim().slice(0, 64) || 'item';
    const price = Math.max(0, Math.round(Number(i.unitPrice) || 0)), quantity = Math.max(1, Math.round(Number(i.quantity) || 1));
    const same = out.find((o) => o.sku === sku && o.price === price);
    if (same) { same.quantity += quantity; continue; }
    const n = out.filter((o) => o.sku.startsWith(sku.slice(0, 60))).length;
    out.push({ name: String(i.title || 'Tattoo').slice(0, 200), sku: n ? `${sku.slice(0, 60)}-${n + 1}` : sku, quantity, price });
  }
  return out.length ? out : [{ name: 'Tattoo', sku: 'item', quantity: 1, price: 1 }];
}

const digits10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Where the courier collects: Settings > Shipping (sp_pickup), else the Shiprocket pickup location in use. */
let pickupCache = { key: '', at: 0, v: null };
export async function spPickup(env) {
  const s = env.SETTINGS?.shipping || {};
  const p = s.sp_pickup;
  if (p && p.address1 && /^\d{6}$/.test(String(p.pincode || '')) && /^\d{10}$/.test(digits10(p.phone))) return normAddr(p);
  if (pickupCache.v && pickupCache.key === s.sr_pickup && Date.now() - pickupCache.at < 3600e3) return pickupCache.v;
  const { sr } = await import('./shiprocket.js');
  const j = await sr(env, 'GET', 'settings/company/pickup');
  const list = j?.data?.shipping_address || [];
  const x = list.find((a) => a.pickup_location === s.sr_pickup) || list.find((a) => Number(a.is_primary_location) === 1) || list[0];
  if (!x) throw new Error('Set the ShipPrime pickup address in Settings, Shipping carriers (no Shiprocket pickup location to copy it from).');
  const v = normAddr({ name: x.name || x.pickup_location, phone: x.phone, address1: x.address, address2: x.address_2, city: x.city, state: x.state, pincode: x.pin_code });
  pickupCache = { key: s.sr_pickup, at: Date.now(), v };
  return v;
}
function normAddr(a) {
  return { name: cut(a.name || 'Ink Kulture', 200), phone: digits10(a.phone), address1: cut(a.address1, 250), address2: cut(a.address2, 250), city: cut(a.city, 100), state: cut(a.state, 100), pincode: String(a.pincode || '').replace(/\D/g, '').slice(0, 6), country: 'India' };
}

/** The ShipPrime create body. Pure. */
export function spBody({ ref, plan, order, row, pickup, tpl }) {
  const a = order.address || {};
  const name = cut(a.name || [a.firstName, a.lastName].filter(Boolean).join(' ') || row.first_name || 'Customer', 200);
  const delivery = { name, phone: digits10(a.phone) || digits10(row.phone), address1: cut(a.address1, 250), address2: cut(a.address2, 250), city: cut(a.city || row.city, 100), state: cut(a.province, 100), pincode: plan.pin, country: 'India' };
  const body = {
    clientReferenceId: String(ref).slice(0, 64), paymentMethod: plan.cod ? 'COD' : 'PREPAID',
    weightGrams: Math.max(1, Math.round(plan.pack.weight_g || 50)), declaredValue: Math.max(1, Math.round(plan.amount || 1)),
    items: spItems(order.items), pickupAddress: { ...pickup }, deliveryAddress: delivery,
  };
  if (plan.cod) body.collectibleAmount = Math.max(1, Math.round(plan.codAmount));
  if (tpl) body.preferredTpls = [tpl];
  if (!delivery.address2) delete delivery.address2;
  if (!body.pickupAddress.address2) delete body.pickupAddress.address2;
  return body;
}

/** Plan: parcel + ShipPrime rates + the courier we would book. Books nothing. */
export async function spPlan(env, order, row) {
  const { planBasics } = await import('./shiprocket.js');
  const base = planBasics(env, order, row);
  const s = env.SETTINGS?.shipping || {};
  const pickup = await spPickup(env);
  let rates = [], error = '';
  try { rates = await spRates(env, { from: pickup.pincode, pin: base.pin, weightGrams: base.pack.weight_g, cod: base.cod, amount: base.codAmount }); }
  catch (e) { error = String(e.message || e); }
  const pick = spPick(rates, s.shipprime_prefer ?? SP_DEFAULT_PREFER);
  return { ...base, pickup, rates, pick, error };
}

/**
 * Book with ShipPrime. Safe to call again: an order that already has a live AWB is returned as it is; a booking that
 * stopped half way (no AWB saved) is looked up by its reference before a new one is made.
 */
export async function spBook(env, order, row, { tpl = '' } = {}) {
  const db = env.DB, id = String(row.order_id);
  if (!row.converted_at && Number(row.convert_started_at) > now() - 15 * 60) throw new Error('The customer is paying online right now (pay-online offer). Book it again in 15 minutes: it will go as prepaid if they paid.');
  let rec = await db.prepare('SELECT * FROM shipments WHERE order_id=?').bind(id).first();
  let rebook = '';
  if (rec && rec.status === 'cancelled') {
    rebook = '-P' + String(now()).slice(-4);
    if (rec.awb) await db.prepare('INSERT INTO ship_old_awbs (awb, order_id, order_name, courier, cancelled_at) VALUES (?,?,?,?,?) ON CONFLICT (awb) DO NOTHING').bind(String(rec.awb), id, rec.order_name || row.order_name, rec.courier || '', now()).run().catch(() => {});
    await db.prepare('DELETE FROM shipments WHERE order_id=?').bind(id).run(); rec = null;
  }
  if (rec?.awb) return { ok: true, already: true, rec };
  if (rec && rec.provider !== 'shipprime' && (rec.sr_shipment_id || rec.sr_order_id)) throw new Error('This order already has a Shiprocket booking in progress. Finish or cancel it first.');

  const plan = await spPlan(env, order, row);
  const want = String(tpl || '').toUpperCase();
  const chosen = want ? plan.rates.find((r) => r.code.toUpperCase() === want) || { code: want, courier: courierLabel(want), charge: null } : plan.pick;
  if (!chosen && plan.error) throw new Error(plan.error);
  const ref = String(rec?.sp_ref || (String(row.order_name || id).replace(/^#/, '') + rebook));
  const t = now();
  if (!rec) {
    await db.prepare(`INSERT INTO shipments (order_id, order_name, provider, sp_ref, courier, charge_paise, pack, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (order_id) DO NOTHING`)
      .bind(id, row.order_name, 'shipprime', ref, chosen ? chosen.courier : '', Math.round(((chosen && chosen.charge) || 0) * 100), JSON.stringify(plan.pack), 'booking', t, t).run();
  }
  const body = spBody({ ref, plan, order, row, pickup: plan.pickup, tpl: chosen ? chosen.code : '' });
  if (!body.deliveryAddress.phone || !body.deliveryAddress.address1 || !body.deliveryAddress.city || !body.deliveryAddress.state) throw new Error('The order address is incomplete (name, address, city, state and phone are needed).');
  let j;
  try { j = await sp(env, 'POST', '/v1/forward', body); }
  catch (e) {
    if (e.code === 'DUPLICATE_CLIENT_REFERENCE') {
      const found = await spFindByRef(env, ref).catch(() => null);
      if (found?.awb) j = found;
      else throw new Error(`ShipPrime already has an order ${ref} but its AWB could not be read back. Check Manage Orders in ShipPrime before booking again.`);
    } else {
      if (!rec) await db.prepare("DELETE FROM shipments WHERE order_id=? AND COALESCE(awb,'')='' AND provider='shipprime'").bind(id).run().catch(() => {});
      throw e;
    }
  }
  const d = j?.data && typeof j.data === 'object' ? { ...j, ...j.data } : j;
  const awb = String(d.awb || d.awbNumber || d.awb_number || '').trim();
  if (!awb) throw new Error('ShipPrime did not return an AWB: ' + JSON.stringify(j).slice(0, 200));
  const courier = courierLabel(d.courier || d.tpl || d.tplVendor || d.tpl_vendor || (chosen && chosen.code) || '');
  const charge = (plan.rates.find((r) => r.code.toUpperCase() === String(d.courier || d.tpl || (chosen && chosen.code) || '').toUpperCase()) || chosen || {}).charge;
  await db.prepare(`UPDATE shipments SET provider='shipprime', sp_ref=?, sp_order_id=?, awb=?, courier=?, charge_paise=?, cod_paise=?, label_url=?, pickup=?, status='booked', stage='pickup_pending', updated_at=? WHERE order_id=?`)
    .bind(ref, String(d.orderId || d.order_id || ''), awb, courier, Math.round((charge || 0) * 100), plan.cod ? Math.round(plan.codAmount) * 100 : 0, String(d.labelUrl || d.label_url || ''),
      'ShipPrime asks the courier for the pickup', now(), id).run();
  rec = await db.prepare('SELECT * FROM shipments WHERE order_id=?').bind(id).first();
  return { ok: true, rec, pack: plan.pack, note: '' };
}

/** A ShipPrime order by our reference (after a lost reply): { awb, courier, orderId, labelUrl } or null. */
async function spFindByRef(env, ref) {
  const q = new URLSearchParams({ filter_by: 'channel_order_id', filter: ref, per_page: '5' });
  const j = await sp(env, 'GET', '/v1/external/orders?' + q);
  const list = arrOf(j?.data && !Array.isArray(j.data) ? j.data : j) || [];
  for (const o of list) {
    const sh = Array.isArray(o.shipments) ? o.shipments[0] || {} : o.shipment || {};
    const awb = o.awb_number || o.awb || sh.awb_number || sh.awb;
    if (awb) return { awb, courier: o.tpl_vendor || sh.tpl_vendor || o.courier || '', orderId: o.id || o.order_id || '', labelUrl: o.label_url || sh.label_url || '' };
  }
  return null;
}

export async function spCancel(env, rec) {
  if (!rec?.awb) throw new Error('No ShipPrime AWB to cancel');
  try { await sp(env, 'POST', `/v1/forward/${encodeURIComponent(rec.awb)}/cancel`, {}); }
  catch (e) {
    if (e.code === 'CANCEL_FAILED') { const er = new Error('ShipPrime says the parcel is past the cancel point (already picked up).'); er.picked = true; throw er; }
    throw e;
  }
}

/* ---------- tracking ---------- */
/* ShipPrime statuses -> the Shiprocket-style status text lib/sr-scan.js reads */
const TEXT = { PENDING: 'Pickup Scheduled', CONFIRMED: 'Pickup Scheduled', PACKED: 'Pickup Scheduled', LABEL_GENERATED_ERRORED: 'Pickup Error',
  SHIPPED: 'In Transit - Shipment picked up', OUT_FOR_DELIVERY: 'Out For Delivery', UNDELIVERED: 'Undelivered', DELIVERED: 'Delivered',
  RTO_INITIATED: 'RTO Initiated', RTO: 'RTO Delivered', RETURNED: 'RTO Delivered', CANCELLED: 'Cancelled', LOST: 'Lost' };
const istText = (v) => {
  const s = String(v || '').trim(); if (!s) return '';
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(s);       /* 02-Jan-2006 15:04:05 (IST) */
  if (m) { const mo = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[2]) / 3 + 1; return `${m[3]}-${String(mo).padStart(2, '0')}-${m[1]} ${m[4]}`; }
  const t = Date.parse(s); if (Number.isNaN(t)) return '';
  return new Date(t + 19800000).toISOString().slice(0, 19).replace('T', ' ');    /* ISO (UTC) -> IST */
};

/**
 * ShipPrime status (from /v1/forward/track, the webhook, or the `shipprime` object) -> a Shiprocket-shaped
 * courier/track reply, so lib/sr-scan.js summarize() and adaptTrack() read it unchanged. Pure.
 */
export function spToSrShape(x = {}, courier = '') {
  const st = String(x.status || x.orderStatus || x.order_status || x.currentStatus || '').toUpperCase().replace(/\s+/g, '_');
  const text = TEXT[st] || String(x.status || x.order_status || '').replace(/_/g, ' ');
  const at = istText(x.statusDate || x.status_date || x.updated_at || x.updatedAt);
  const picked = istText(x.picked_at || x.pickedAt || x.pickupDate), delivered = istText(x.delivered_at || x.deliveredAt), rto = istText(x.rto_at || x.rtoAt);
  const reason = String(x.comments || x.remark || x.reason || x.ndrReason || '').trim();
  const acts = [];
  if (picked) acts.push({ date: picked, activity: 'In Transit - Shipment picked up', location: '' });
  if (st && !['PENDING', 'CONFIRMED', 'PACKED'].includes(st)) acts.push({ date: at || delivered || rto || picked || '', activity: text + (st === 'UNDELIVERED' && reason ? ' - ' + reason : ''), location: String(x.location || '') });
  return { tracking_data: { shipment_status: st, etd: String(x.edd || x.expectedDeliveryDate || '').slice(0, 10),
    shipment_track: [{ current_status: text, courier_name: courierLabel(x.tpl_vendor || x.tplVendor || x.courier || courier), pickup_date: picked, delivered_date: st === 'DELIVERED' ? (delivered || at) : '', edd: '' }],
    shipment_track_activities: acts.filter((a) => a.date || a.activity) } };
}

/**
 * Tracking for one ShipPrime AWB, Shiprocket-shaped. The compatibility endpoint gives the courier's scans; when it
 * has none, the status from /v1/forward/track is turned into one.
 */
export async function spTrackRaw(env, awb, courier = '') {
  let ext = null;
  try { ext = await sp(env, 'GET', `/v1/external/courier/track/awb/${encodeURIComponent(awb)}`); } catch (e) { if (e.status === 401) throw e; }
  const td = ext?.tracking_data || ext?.data?.tracking_data;
  const acts = Array.isArray(td?.shipment_track_activities) ? td.shipment_track_activities : [];
  const spObj = ext?.shipprime || ext?.data?.shipprime || td?.shipprime || null;
  if (td && acts.length) {
    /* the courier's scans, with ShipPrime's own final word on top (delivered / RTO dates) */
    if (spObj) {
      const own = spToSrShape(spObj, courier).tracking_data.shipment_track[0];
      const trk = Array.isArray(td.shipment_track) && td.shipment_track[0] ? td.shipment_track[0] : (td.shipment_track = [{}])[0];
      if (!trk.delivered_date && own.delivered_date) trk.delivered_date = own.delivered_date;
      if (!trk.pickup_date && own.pickup_date) trk.pickup_date = own.pickup_date;
      if (!trk.current_status) trk.current_status = own.current_status;
      if (!trk.courier_name) trk.courier_name = own.courier_name;
    }
    return { tracking_data: td };
  }
  if (spObj && (spObj.status || spObj.order_status)) return spToSrShape(spObj, courier);
  const j = await sp(env, 'GET', '/v1/forward/track?' + new URLSearchParams({ awbs: String(awb) }));
  const list = arrOf(j?.data && !Array.isArray(j.data) ? j.data : j);
  const row = list.find((r) => String(r.awb || r.awbNumber || r.awb_number || '') === String(awb)) || list[0];
  if (!row) throw new Error('ShipPrime has no tracking for ' + awb + ' yet');
  return spToSrShape(row, courier);
}

/* ---------- webhook ---------- */
/**
 * POST /api/shipprime/webhook. Checks the Bearer secret, then refreshes that shipment at once (stage, Shopify,
 * WhatsApp updates follow on the next run, which is pulled forward). Always answers 200 for a known secret so
 * ShipPrime does not log it as missed; unknown AWBs are ignored.
 */
export async function handleSpWebhook(req, env) {
  const auth = String(req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!auth || !safeEqual(auth, await spWebhookSecret(env))) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  let p = {};
  try { p = await req.json(); } catch { /* empty */ }
  const awb = String(p.awb_number || p.awb || '').trim();
  const out = { ok: true };
  if (awb && env.DB && String(p.flow || 'FORWARD').toUpperCase() === 'FORWARD') {
    const rec = await env.DB.prepare("SELECT * FROM shipments WHERE awb=? AND provider='shipprime'").bind(awb).first();
    if (rec) {
      await env.DB.prepare('UPDATE shipments SET sp_status=?, sp_event_at=? WHERE order_id=?').bind(String(p.order_status || '').slice(0, 40), now(), String(rec.order_id)).run().catch(() => {});
      try {
        const { refreshShipment } = await import('./ship-status.js');
        out.stage = await refreshShipment(env, rec, spToSrShape(p, rec.courier));
      } catch (e) { console.error('shipprime webhook refresh', awb, e.message); }
      /* WhatsApp update on the next cron run instead of waiting for its 25-minute poll */
      await env.DB.prepare('UPDATE ship_track SET checked_at=0 WHERE order_id=?').bind(String(rec.order_id)).run().catch(() => {});
      out.matched = true;
    }
  }
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function spWallet(env) {
  const j = await sp(env, 'GET', '/v1/forward/wallet');
  const d = j?.data && typeof j.data === 'object' ? j.data : j;
  return { balance: num(d.balance), withdrawable: num(d.withdrawableBalance), banned: !!d.walletBanned };
}
