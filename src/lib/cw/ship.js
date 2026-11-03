/**
 * CodWing shipping: the seller's own Shiprocket or ShipPrime account, from the CodWing dashboard.
 *   - unshipped Shopify orders in one list (Admin API), with COD / prepaid and the amount to collect
 *   - live courier rates per order; the courier is picked by the seller's rule:
 *       'rto'      COD: the courier with the best return-to-origin record for that PIN (Shiprocket's network scores),
 *                  if it costs at most `maxExtra` more than the cheapest; prepaid: cheapest with a good delivery score
 *       'cheapest' lowest charge
 *       'fastest'  earliest delivery estimate
 *   - book one order at a time (the dashboard loops for bulk), label, Shopify fulfilment with tracking, packed flag
 * Credentials are the seller's: Shiprocket API user (email + password) or ShipPrime API token, sealed at rest.
 */
import { adminGraphql } from './shopify.js';
import { sp, parseRates, courierLabel, spItems, spTrackUrl } from '../shipprime.js';

const SR = 'https://apiv2.shiprocket.in/v1/external';
const now = () => Math.floor(Date.now() / 1000);

export const SHIP_DDL = [
  `CREATE TABLE IF NOT EXISTS cw_shipments (shop TEXT, order_id TEXT, order_name TEXT, provider TEXT, awb TEXT, courier TEXT, charge BIGINT, cod_amount BIGINT, label_url TEXT, sr_order_id TEXT, sr_shipment_id TEXT, status TEXT, error TEXT, packed_at BIGINT, fulfilled BOOLEAN DEFAULT FALSE, created_at BIGINT, updated_at BIGINT, PRIMARY KEY (shop, order_id))`,
];

/* ---------- pure ---------- */
/**
 * rates: [{ id, courier, charge (₹), days, rto, delivery }] (scores 0-5, higher = better, null = unknown).
 * Returns { pick, why }.
 */
export function pickCourier(rates, { cod = false, rule = 'rto', maxExtra = 15 } = {}) {
  const list = (rates || []).filter((r) => r && r.charge != null && r.ok !== false);
  if (!list.length) return { pick: null, why: 'No courier delivers to this PIN code' };
  const cheapest = [...list].sort((a, b) => a.charge - b.charge)[0];
  if (rule === 'cheapest') return { pick: cheapest, why: 'Cheapest' };
  if (rule === 'fastest') {
    const f = [...list].sort((a, b) => ((a.days ?? 99) - (b.days ?? 99)) || (a.charge - b.charge))[0];
    return { pick: f, why: f.days != null ? `Fastest (${f.days} days)` : 'Fastest' };
  }
  const within = list.filter((r) => r.charge <= cheapest.charge + maxExtra);
  const score = (r) => (cod ? r.rto : r.delivery);
  const scored = within.filter((r) => score(r) != null);
  if (!scored.length) return { pick: cheapest, why: 'Cheapest (no delivery record for this PIN yet)' };
  const best = [...scored].sort((a, b) => (score(b) - score(a)) || (a.charge - b.charge))[0];
  if (best === cheapest) return { pick: best, why: cod ? 'Cheapest, and best return record here' : 'Cheapest, good delivery record' };
  return { pick: best, why: cod ? `Fewer returns to this PIN (₹${Math.round(best.charge - cheapest.charge)} more than cheapest)` : `Better delivery record (₹${Math.round(best.charge - cheapest.charge)} more)` };
}

export function parcelOf(s, items) {
  const units = (items || []).reduce((n, i) => n + Math.max(1, Number(i.quantity) || 1), 0) || 1;
  const w = Math.max(50, (Number(s.pkg_weight_g) || 300) + (units - 1) * (Number(s.pkg_extra_g) || 0));
  return { weight_g: w, weight_kg: Math.round(w) / 1000, length: Number(s.pkg_l) || 20, breadth: Number(s.pkg_b) || 15, height: Number(s.pkg_h) || 5 };
}

export const shipReady = (s, set) => (s.ship_provider === 'shiprocket' ? !!(s.sr_email && set.sr_password && s.sr_pickup)
  : s.ship_provider === 'shipprime' ? !!(set.sp_token && /^\d{6}$/.test(String(s.pickup_pin || '')) && s.pickup_address1 && /^\d{10}$/.test(String(s.pickup_phone || '').replace(/\D/g, '').slice(-10))) : false);

/* ---------- Shiprocket (seller's API user) ---------- */
const srTok = new Map();
async function srLogin(sel, force) {
  const k = sel.shop, c = srTok.get(k);
  const id = sel.settings.sr_email + ':' + (sel.secrets.sr_password || '').length;
  if (!force && c && c.id === id && c.exp > Date.now()) return c.token;
  const r = await fetch(SR + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: sel.settings.sr_email, password: sel.secrets.sr_password }), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error('Shiprocket login failed' + (j.message ? ': ' + j.message : '') + '. Use a Shiprocket API user (Settings → API → Create an API user).');
  srTok.set(k, { id, token: j.token, exp: Date.now() + 8 * 86400e3 });
  return j.token;
}
export async function srCall(sel, method, path, body) {
  for (let a = 0; a < 2; a++) {
    const t = await srLogin(sel, a > 0);
    const r = await fetch(`${SR}/${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (r.status === 401 && a === 0) continue;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`Shiprocket: ${j.message || r.status}${j.errors ? ' ' + JSON.stringify(j.errors).slice(0, 200) : ''}`); e.status = r.status; throw e; }
    return j;
  }
  throw new Error('Shiprocket: could not log in');
}
export async function srPickups(sel) {
  const j = await srCall(sel, 'GET', 'settings/company/pickup');
  return (j.data?.shipping_address || []).map((p) => ({ name: p.pickup_location, pin: String(p.pin_code || ''), city: p.city || '', primary: Number(p.is_primary_location) === 1 })).filter((p) => p.name);
}

/* ---------- ShipPrime (seller's token, IK's client) ---------- */
const spEnv = (sel) => ({ SHIPPRIME_TOKEN: sel.secrets.sp_token });
const spPickupAddr = (s, name) => ({ name: String(name || 'Store').slice(0, 200), phone: String(s.pickup_phone || '').replace(/\D/g, '').slice(-10), address1: String(s.pickup_address1 || '').slice(0, 250), address2: String(s.pickup_address2 || '').slice(0, 250) || undefined, city: s.pickup_city || '', state: s.pickup_state || '', pincode: String(s.pickup_pin || ''), country: 'India' });

/* ---------- Shopify orders ---------- */
const ORDER_FIELDS = `id name createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt
  totalPriceSet{ shopMoney{ amount } } totalOutstandingSet{ shopMoney{ amount } } email phone
  shippingAddress{ firstName lastName name address1 address2 city province provinceCode zip phone }
  lineItems(first: 30){ nodes{ title quantity sku originalUnitPriceSet{ shopMoney{ amount } } } }`;
export function shapeOrder(o) {
  const a = o.shippingAddress || {};
  const total = Math.round(Number(o.totalPriceSet?.shopMoney?.amount || 0) * 100);
  const due = Math.round(Number(o.totalOutstandingSet?.shopMoney?.amount || 0) * 100);
  return {
    id: o.id.split('/').pop(), gid: o.id, name: o.name, at: Math.floor(Date.parse(o.createdAt) / 1000),
    cod: due > 0, collect: due, total, paid: o.displayFinancialStatus,
    customer: a.name || [a.firstName, a.lastName].filter(Boolean).join(' '), phone: String(a.phone || o.phone || '').replace(/\D/g, '').slice(-10),
    address: { first: a.firstName || '', last: a.lastName || '', address1: a.address1 || '', address2: a.address2 || '', city: a.city || '', state: a.province || '', state_code: a.provinceCode || '', pin: String(a.zip || '').replace(/\D/g, '').slice(0, 6) },
    email: o.email || '',
    items: (o.lineItems?.nodes || []).map((l) => ({ title: l.title, quantity: l.quantity, sku: l.sku || '', unitPrice: Number(l.originalUnitPriceSet?.shopMoney?.amount || 0) })),
  };
}
export async function unshippedOrders(sel) {
  const d = await adminGraphql(sel.shop, sel.token, `query{ orders(first: 50, sortKey: CREATED_AT, reverse: true, query: "fulfillment_status:unshipped AND status:open"){ nodes{ ${ORDER_FIELDS} } } }`);
  return d.orders.nodes.filter((o) => !o.cancelledAt).map(shapeOrder);
}
async function oneOrder(sel, id) {
  const d = await adminGraphql(sel.shop, sel.token, `query($id: ID!){ order(id: $id){ ${ORDER_FIELDS} } }`, { id: `gid://shopify/Order/${String(id).replace(/\D/g, '')}` });
  if (!d.order) throw new Error('Order not found in Shopify');
  return shapeOrder(d.order);
}

/* ---------- rates ---------- */
export async function ratesFor(sel, order) {
  const s = sel.settings, parcel = parcelOf(s, order.items);
  if (!/^\d{6}$/.test(order.address.pin)) throw new Error('The order has no valid PIN code');
  if (s.ship_provider === 'shiprocket') {
    const pk = (await srPickups(sel)).find((p) => p.name === s.sr_pickup);
    if (!pk) throw new Error(`Pickup location "${s.sr_pickup}" not found in Shiprocket`);
    const q = new URLSearchParams({ pickup_postcode: pk.pin, delivery_postcode: order.address.pin, weight: String(parcel.weight_kg), cod: order.cod ? '1' : '0', declared_value: String(Math.round(order.total / 100) || 499), length: String(parcel.length), breadth: String(parcel.breadth), height: String(parcel.height) });
    let j; try { j = await srCall(sel, 'GET', 'courier/serviceability/?' + q); } catch (e) { if (e.status === 404 || e.status === 422) return { parcel, rates: [] }; throw e; }
    const n = (v) => { const k = Number(v); return Number.isFinite(k) && k > 0 ? k : null; };
    const rates = (j.data?.available_courier_companies || []).filter((x) => !x.blocked).map((x) => ({
      id: String(x.courier_company_id), courier: String(x.courier_name || 'Courier'), charge: Number(x.rate ?? (Number(x.freight_charge || 0) + Number(x.cod_charges || 0))),
      days: n(x.estimated_delivery_days), etd: x.etd || '', rto: n(x.rto_performance), delivery: n(x.delivery_performance), rating: n(x.rating),
    }));
    return { parcel, rates };
  }
  if (s.ship_provider === 'shipprime') {
    const q = new URLSearchParams({ pickupPincode: String(s.pickup_pin), deliveryPincode: order.address.pin, weightGrams: String(parcel.weight_g), paymentMethod: order.cod ? 'COD' : 'PREPAID' });
    if (order.cod) q.set('collectibleAmount', String(Math.max(1, Math.round(order.collect / 100))));
    const rates = parseRates(await sp(spEnv(sel), 'GET', '/v1/forward/rates?' + q)).map((r) => ({ id: r.code, courier: r.courier, charge: r.charge, days: null, ok: r.serviceable, rto: null, delivery: null }));
    return { parcel, rates };
  }
  throw new Error('Connect Shiprocket or ShipPrime first (Shipping → Settings)');
}

/* ---------- book ---------- */
export async function book(env, sel, orderId, { courierId = '' } = {}) {
  const s = sel.settings, order = await oneOrder(sel, orderId);
  const prev = await env.DB.prepare('SELECT * FROM cw_shipments WHERE shop = ? AND order_id = ?').bind(sel.shop, order.id).first();
  if (prev?.awb && prev.status !== 'cancelled') return { ok: true, already: true, shipment: prev };
  const { parcel, rates } = await ratesFor(sel, order);
  const chosen = courierId ? rates.find((r) => String(r.id) === String(courierId)) : pickCourier(rates, { cod: order.cod, rule: s.ship_rule || 'rto', maxExtra: Number(s.ship_max_extra ?? 15) }).pick;
  if (!chosen) throw new Error(rates.length ? 'That courier is not available for this order' : 'No courier delivers to ' + order.address.pin);
  const a = order.address, t = now();
  if (!a.address1 || !a.city || !a.state || !/^\d{10}$/.test(order.phone)) throw new Error('The order address is incomplete (address, city, state and a 10-digit phone are needed)');
  let rec = { provider: s.ship_provider, courier: chosen.courier, charge: Math.round(chosen.charge * 100), cod_amount: order.cod ? order.collect : 0, awb: '', label_url: '', sr_order_id: '', sr_shipment_id: '' };

  if (s.ship_provider === 'shiprocket') {
    let shipmentId = prev?.sr_shipment_id || '';
    if (!shipmentId) {
      const ref = order.name.replace(/^#/, '') + (prev?.status === 'cancelled' ? '-' + String(t).slice(-4) : '');
      const c = await srCall(sel, 'POST', 'orders/create/adhoc', {
        order_id: ref, order_date: new Date(order.at * 1000).toISOString().slice(0, 16).replace('T', ' '), pickup_location: s.sr_pickup,
        billing_customer_name: a.first || order.customer || 'Customer', billing_last_name: a.last || '', billing_address: a.address1, billing_address_2: a.address2 || '',
        billing_city: a.city, billing_pincode: a.pin, billing_state: a.state, billing_country: 'India', billing_email: order.email || 'na@codwing.com', billing_phone: order.phone,
        shipping_is_billing: true, order_items: order.items.map((i, k) => ({ name: i.title.slice(0, 200), sku: (i.sku || 'item-' + (k + 1)).slice(0, 50), units: i.quantity, selling_price: i.unitPrice })),
        payment_method: order.cod ? 'COD' : 'Prepaid', sub_total: Math.round(order.cod ? order.collect / 100 : order.total / 100),
        length: parcel.length, breadth: parcel.breadth, height: parcel.height, weight: parcel.weight_kg,
      });
      shipmentId = String(c.shipment_id || ''); rec.sr_order_id = String(c.order_id || '');
      if (!shipmentId) throw new Error('Shiprocket did not create the shipment: ' + JSON.stringify(c).slice(0, 200));
      await save(env, sel, order, { ...rec, sr_shipment_id: shipmentId, status: 'booking' }, t);
    }
    rec.sr_shipment_id = shipmentId;
    const aw = await srCall(sel, 'POST', 'courier/assign/awb', { shipment_id: shipmentId, courier_id: chosen.id });
    const d = aw.response?.data || {};
    if (!d.awb_code) throw new Error('No AWB from Shiprocket: ' + (d.awb_assign_error || aw.message || JSON.stringify(aw).slice(0, 200)));
    rec.awb = String(d.awb_code); rec.courier = d.courier_name || rec.courier;
    await srCall(sel, 'POST', 'courier/generate/pickup', { shipment_id: [shipmentId] }).catch(() => null);
    const lb = await srCall(sel, 'POST', 'courier/generate/label', { shipment_id: [shipmentId] }).catch(() => ({}));
    rec.label_url = lb.label_url || '';
  } else {
    const body = {
      clientReferenceId: order.name.replace(/^#/, '') + (prev?.status === 'cancelled' ? '-' + String(t).slice(-4) : ''), paymentMethod: order.cod ? 'COD' : 'PREPAID',
      weightGrams: parcel.weight_g, declaredValue: Math.max(1, Math.round(order.total / 100)), items: spItems(order.items),
      pickupAddress: spPickupAddr(s, sel.name), deliveryAddress: { name: order.customer || 'Customer', phone: order.phone, address1: a.address1.slice(0, 250), address2: a.address2 ? a.address2.slice(0, 250) : undefined, city: a.city, state: a.state, pincode: a.pin, country: 'India' },
      preferredTpls: [chosen.id],
    };
    if (order.cod) body.collectibleAmount = Math.max(1, Math.round(order.collect / 100));
    const j = await sp(spEnv(sel), 'POST', '/v1/forward', body);
    const d = j?.data && typeof j.data === 'object' ? { ...j, ...j.data } : j;
    rec.awb = String(d.awb || d.awbNumber || d.awb_number || '');
    if (!rec.awb) throw new Error('ShipPrime did not return an AWB');
    rec.courier = courierLabel(d.courier || d.tpl || chosen.id); rec.label_url = String(d.labelUrl || d.label_url || '');
  }
  await save(env, sel, order, { ...rec, status: 'booked' }, t);
  const fulfilled = await fulfil(sel, order, rec).then(() => true).catch((e) => { console.warn('cw fulfil', sel.shop, e.message); return false; });
  if (fulfilled) await env.DB.prepare('UPDATE cw_shipments SET fulfilled = TRUE WHERE shop = ? AND order_id = ?').bind(sel.shop, order.id).run();
  return { ok: true, shipment: { ...rec, order_name: order.name, fulfilled } };
}

async function save(env, sel, order, r, t) {
  await env.DB.prepare(`INSERT INTO cw_shipments (shop, order_id, order_name, provider, awb, courier, charge, cod_amount, label_url, sr_order_id, sr_shipment_id, status, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT (shop, order_id) DO UPDATE SET provider = EXCLUDED.provider, awb = EXCLUDED.awb, courier = EXCLUDED.courier, charge = EXCLUDED.charge, cod_amount = EXCLUDED.cod_amount,
      label_url = EXCLUDED.label_url, sr_order_id = COALESCE(NULLIF(EXCLUDED.sr_order_id, ''), cw_shipments.sr_order_id), sr_shipment_id = COALESCE(NULLIF(EXCLUDED.sr_shipment_id, ''), cw_shipments.sr_shipment_id),
      status = EXCLUDED.status, error = NULL, updated_at = EXCLUDED.updated_at`)
    .bind(sel.shop, order.id, order.name, r.provider, r.awb || '', r.courier || '', r.charge || 0, r.cod_amount || 0, r.label_url || '', r.sr_order_id || '', r.sr_shipment_id || '', r.status, t, now()).run();
}

export const trackUrl = (r) => (!r.awb ? '' : r.provider === 'shipprime' ? spTrackUrl(r.awb) : `https://shiprocket.co/tracking/${r.awb}`);

/** Shopify fulfilment with the AWB, so the buyer gets Shopify's shipping email and the order leaves "Unfulfilled". */
async function fulfil(sel, order, rec) {
  const d = await adminGraphql(sel.shop, sel.token, `query($id: ID!){ order(id: $id){ fulfillmentOrders(first: 5){ nodes{ id status } } } }`, { id: order.gid });
  const fos = (d.order?.fulfillmentOrders?.nodes || []).filter((f) => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(f.status));
  if (!fos.length) return;
  const r = await adminGraphql(sel.shop, sel.token, `mutation($f: FulfillmentInput!){ fulfillmentCreate(fulfillment: $f){ fulfillment{ id } userErrors{ message } } }`, {
    f: { lineItemsByFulfillmentOrder: fos.map((f) => ({ fulfillmentOrderId: f.id })), notifyCustomer: true, trackingInfo: { company: rec.courier, number: rec.awb, url: trackUrl(rec) } },
  });
  const e = r.fulfillmentCreate.userErrors; if (e?.length) throw new Error(e.map((x) => x.message).join('; '));
}

/** Labels for several booked orders: Shiprocket merges them into one PDF; ShipPrime gives one PDF per parcel. */
export async function labels(env, sel, orderIds) {
  const rows = (await env.DB.prepare('SELECT * FROM cw_shipments WHERE shop = ? AND awb <> \'\'').bind(sel.shop).all()).results.filter((r) => orderIds.map(String).includes(String(r.order_id)));
  const out = [];
  const srRows = rows.filter((r) => r.provider === 'shiprocket' && r.sr_shipment_id);
  if (srRows.length && sel.settings.ship_provider === 'shiprocket') {
    const j = await srCall(sel, 'POST', 'courier/generate/label', { shipment_id: srRows.map((r) => r.sr_shipment_id) }).catch(() => ({}));
    if (j.label_url) out.push({ url: j.label_url, count: srRows.length, merged: true });
  }
  rows.filter((r) => r.provider !== 'shiprocket' || !out.length).forEach((r) => { if (r.label_url && !out.some((o) => o.url === r.label_url)) out.push({ url: r.label_url, order: r.order_name }); });
  return out;
}
