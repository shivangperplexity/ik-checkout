/**
 * Shadowfax direct (Dale API, https://developer.shadowfax.in/docs/forward-logistics/quickstart).
 * Token: Settings > Shipping carriers > Shadowfax (shipping.shadowfax_token); shipping.shadowfax_env 'staging' for tests.
 * Shipments booked here are saved with provider='shadowfax'; tracking is turned into ShipPrime's status words so the
 * existing scanner (spToSrShape -> sr-scan) reads it.
 */
const now = () => Math.floor(Date.now() / 1000);
import { planBasics } from './shiprocket.js';
import { spToSrShape } from './shipprime.js';

const TIMEOUT = 20000;
const digits10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export const sfxToken = (env) => String(env.SETTINGS?.shipping?.shadowfax_token || env.SHADOWFAX_TOKEN || '').trim();
export const sfxConnected = (env) => !!sfxToken(env);
const host = (env) => (env.SETTINGS?.shipping?.shadowfax_env === 'staging' ? 'https://dale.staging.shadowfax.in' : 'https://dale.shadowfax.in');
export const sfxTrackUrl = (awb) => `https://tracker.shadowfax.in/#/track/${encodeURIComponent(String(awb || ''))}`;

export async function sfx(env, method, path, body) {
  const token = sfxToken(env);
  if (!token) throw new Error('Shadowfax is not connected. Paste the API token in Settings, Shipping carriers.');
  for (let n = 0; ; n++) {
    let r, j;
    try {
      r = await fetch(host(env) + path, { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Token ' + token },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT) });
      j = await r.json().catch(() => ({}));
    } catch (e) {
      if (method === 'GET' && n < 2) { await new Promise((ok) => setTimeout(ok, 800 * (n + 1))); continue; }
      throw new Error('Shadowfax did not answer: ' + String(e.message || e).slice(0, 120));
    }
    const failed = j && (j.success === false || /fail|error/i.test(String(j.status || '')));
    if (r.ok && !failed) return j;
    if (method === 'GET' && (r.status === 429 || r.status >= 500) && n < 2) { await new Promise((ok) => setTimeout(ok, 1000 * (n + 1))); continue; }
    const msg = r.status === 401 || r.status === 403 ? 'Shadowfax refused the API token. Paste the current one in Settings, Shipping carriers (staging and live tokens differ).'
      : `Shadowfax ${r.status}: ${j?.message || j?.errors || j?.error || JSON.stringify(j).slice(0, 240)}`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)); err.status = r.status; err.body = j; throw err;
  }
}

/** { ok, services, raw } for one PIN. service: customer_delivery (where the parcel goes) or seller_pickup. */
export async function sfxServiceable(env, pin, service = 'customer_delivery') {
  const j = await sfx(env, 'GET', `/api/v1/clients/serviceability/?service=${service}&pincodes=${encodeURIComponent(String(pin))}`);
  const arr = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
  const hit = arr.find((x) => String(x.code ?? x.pincode) === String(pin));
  const services = hit?.services || [];
  return { ok: !!hit && services.length > 0, services, raw: j };
}

/** Pickup / return address: settings.shipping.sfx_pickup, else ShipPrime's pickup address. */
async function pickupOf(env) {
  const s = env.SETTINGS?.shipping || {};
  let p = s.sfx_pickup && typeof s.sfx_pickup === 'object' && s.sfx_pickup.pincode ? s.sfx_pickup : null;
  if (!p && s.sp_pickup?.pincode) { const x = s.sp_pickup; p = { name: x.name, contact: x.phone, address_line_1: [x.address1, x.address2].filter(Boolean).join(', '), city: x.city, state: x.state, pincode: x.pincode }; }
  if (!p?.pincode) {
    try { const { spPickup } = await import('./shipprime.js'); const x = await spPickup(env); p = { name: x.name || x.contactName, contact: x.phone, address_line_1: [x.address1, x.address2].filter(Boolean).join(', '), city: x.city, state: x.state, pincode: x.pincode }; }
    catch { /* no ShipPrime */ }
  }
  if (!p?.pincode) throw new Error('Set the Shadowfax pickup address first (Settings, Shipping carriers, Shadowfax pickup).');
  return { name: cut(p.name || 'Ink Kulture', 100), contact: digits10(p.contact || p.phone), address_line_1: cut(p.address_line_1 || p.address, 250), city: cut(p.city, 60), state: cut(p.state, 60), pincode: Number(String(p.pincode).replace(/\D/g, '')) };
}

export function sfxBody({ ref, plan, order, row, pickup }) {
  const a = order.address || {};
  const items = (order.items || []).slice(0, 20).map((it, i) => ({ sku_name: cut(it.title || it.name || 'Tattoo', 100), sku_id: cut(it.sku || it.variant_id || it.id || 'IK-' + (i + 1), 50),
    price: Math.max(1, Math.round(Number(it.price) || 1)), category: 'Cosmetics' }));
  return {
    customer_details: { name: cut(a.name || [a.firstName, a.lastName].filter(Boolean).join(' ') || row.first_name || 'Customer', 100), contact: digits10(a.phone) || digits10(row.phone),
      address_line_1: cut(a.address1, 250), address_line_2: cut(a.address2, 250) || undefined, city: cut(a.city || row.city, 60), state: cut(a.province, 60), pincode: Number(plan.pin) },
    order_details: { client_order_id: String(ref).slice(0, 50), product_value: Math.max(1, Math.round(plan.amount || 1)), payment_mode: plan.cod ? 'cod' : 'prepaid',
      cod_amount: plan.cod ? Math.max(1, Math.round(plan.codAmount)) : 0, order_service: 'Regular', actual_weight: Math.max(1, Math.round(plan.pack?.weight_g || 50)) },
    pickup_details: { pickup_type: 'seller', ...pickup },
    return_details: { return_type: 'seller', ...pickup },
    product_details: items.length ? items : [{ sku_name: 'Semi permanent tattoo', sku_id: 'IK-TATTOO', price: Math.max(1, Math.round(plan.amount || 1)), category: 'Cosmetics' }],
  };
}

export async function sfxBook(env, order, row) {
  const db = env.DB, id = String(row.order_id);
  let rec = await db.prepare('SELECT * FROM shipments WHERE order_id=?').bind(id).first(), rebook = '';
  if (rec && rec.status === 'cancelled') {
    rebook = '-F' + String(now()).slice(-4);
    if (rec.awb) await db.prepare('INSERT INTO ship_old_awbs (awb, order_id, order_name, courier, cancelled_at) VALUES (?,?,?,?,?) ON CONFLICT (awb) DO NOTHING').bind(String(rec.awb), id, rec.order_name || row.order_name, rec.courier || '', now()).run().catch(() => {});
    await db.prepare('DELETE FROM shipments WHERE order_id=?').bind(id).run(); rec = null;
  }
  if (rec?.awb) return { ok: true, already: true, rec };
  if (rec && (rec.sr_shipment_id || rec.sr_order_id || rec.sp_ref)) throw new Error('This order already has another booking in progress. Cancel it first.');
  const plan = planBasics(env, order, row);
  const ref = String(row.order_name || id).replace(/^#/, '') + rebook, t = now();
  const body = sfxBody({ ref, plan, order, row, pickup: await pickupOf(env) });
  const c = body.customer_details;
  if (!c.contact || !c.address_line_1 || !c.city) throw new Error('The order address is incomplete (name, address, city and phone are needed).');
  if (!rec) await db.prepare(`INSERT INTO shipments (order_id, order_name, provider, sp_ref, courier, charge_paise, pack, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (order_id) DO NOTHING`)
    .bind(id, row.order_name, 'shadowfax', ref, 'Shadowfax', 0, JSON.stringify(plan.pack), 'booking', t, t).run();
  let j;
  try { j = await sfx(env, 'POST', '/api/v3/clients/orders/', body); }
  catch (e) { await db.prepare("DELETE FROM shipments WHERE order_id=? AND COALESCE(awb,'')='' AND provider='shadowfax'").bind(id).run().catch(() => {}); throw e; }
  const d = j?.data && typeof j.data === 'object' ? { ...j, ...j.data } : j;
  const awb = String(d.awb_number || d.awb || d.AWB || '').trim();
  if (!awb) throw new Error('Shadowfax did not return an AWB: ' + JSON.stringify(j).slice(0, 240));
  let label = '';
  try { label = await sfxLabel(env, awb); } catch (e) { console.warn('sfx label', awb, e.message); }
  await db.prepare(`UPDATE shipments SET provider='shadowfax', sp_ref=?, awb=?, courier='Shadowfax', cod_paise=?, label_url=?, pickup=?, status='booked', stage='pickup_pending', updated_at=? WHERE order_id=?`)
    .bind(ref, awb, plan.cod ? Math.round(plan.codAmount) * 100 : 0, label, 'Shadowfax picks up from the registered pickup address', now(), id).run();
  rec = await db.prepare('SELECT * FROM shipments WHERE order_id=?').bind(id).first();
  return { ok: true, rec, pack: plan.pack };
}

/** Label link (valid 2 days, only before pickup). */
export async function sfxLabel(env, awb) {
  const j = await sfx(env, 'POST', '/api/client/generate_label/', { awb_number: String(awb), file_type: 'pdf' });
  return String(j?.data?.label_url || j?.label_url || '');
}

export async function sfxCancel(env, rec) {
  const id = rec.awb || rec.sp_ref;
  if (!id) throw new Error('No Shadowfax AWB to cancel');
  try { await sfx(env, 'POST', '/api/v3/clients/orders/cancel/', { request_id: String(id), cancel_remarks: 'Cancelled by seller' }); }
  catch (e) { if (!/already\s*cancel/i.test(String(e.message))) throw e; }
}

/** Shadowfax status words -> ShipPrime's, so spToSrShape / the scanner understand them. */
export function sfxStatus(s) {
  const x = String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (/^(delivered)$/.test(x)) return 'DELIVERED';
  if (/rto.*deliver|returned|rts_d|rto_d|returned_to_seller/.test(x)) return 'RTO';
  if (/rto|rts|return/.test(x)) return 'RTO_INITIATED';
  if (/ofd|out_for_delivery/.test(x)) return 'OUT_FOR_DELIVERY';
  if (/undeliver|nc|cid|ndr|attempt|failed/.test(x)) return 'UNDELIVERED';
  if (/cancel/.test(x)) return 'CANCELLED';
  if (/lost/.test(x)) return 'LOST';
  if (/new|created|assigned|pickup_pending|ready|not_picked|on_hold/.test(x)) return 'PENDING';
  return 'SHIPPED';
}

/** Tracking in Shiprocket's raw shape. */
export async function sfxTrackRaw(env, awb) {
  const j = await sfx(env, 'GET', `/api/v4/clients/orders/${encodeURIComponent(String(awb))}/track/`);
  const d = j?.data && typeof j.data === 'object' ? j.data : j;
  const ev = d.tracking_details || d.order_tracking_details || d.timeline || d.events || [];
  const list = Array.isArray(ev) ? ev : [];
  const last = list.length ? list[list.length - 1] : {};
  const raw = d.status || d.current_status || d.order_status || last.status || '';
  const when = (e) => String(e?.created || e?.timestamp || e?.date || e?.time || '').replace('T', ' ').slice(0, 19);
  const find = (re) => list.find((e) => re.test(String(e.status || e.status_id || '').toLowerCase()));
  const st = sfxStatus(raw);
  const out = spToSrShape({ status: st, statusDate: when(last), picked_at: when(find(/pick/)), delivered_at: st === 'DELIVERED' ? when(last) : '', remark: last.remarks || last.comment || '', location: last.location || '', edd: d.promised_delivery_date || d.edd || '' }, 'SHADOWFAX');
  const acts = list.map((e) => ({ date: when(e), activity: cut(`${e.status || ''}${e.remarks ? ' - ' + e.remarks : ''}`, 200), location: cut(e.location || e.hub || '', 80) })).filter((a) => a.activity).reverse();
  if (acts.length) out.tracking_data.shipment_track_activities = acts;
  out.tracking_data.shipment_track[0].courier_name = 'Shadowfax';
  return out;
}
