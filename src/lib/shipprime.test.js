import test from 'node:test';
import assert from 'node:assert/strict';
import { courierLabel, parseRates, spPick, spFallbacks, spPrefer, arrivalDate, spItems, spBody, spToSrShape, trackUrlOf, handleSpWebhook, spWebhookSecret } from './shipprime.js';
import { summarize } from './sr-scan.js';
import { adaptTrack } from './shiprocket.js';
import { classify } from './wa-ship.js';

test('courier codes read like names', () => {
  assert.equal(courierLabel('BLUEDART'), 'Blue Dart');
  assert.equal(courierLabel('BLUEDART_AIR'), 'Blue Dart Air');
  assert.equal(courierLabel('XPRESSBEES_PREMIUM'), 'Xpressbees Premium');
  assert.equal(courierLabel('DELHIVERY'), 'Delhivery');
  assert.equal(courierLabel('Delhivery Surface'), 'Delhivery Surface');
});

test('rates: cheapest first, total = forward + COD when no total given; Blue Dart never first by default', () => {
  const r = parseRates({ status: 'SUCCESS', rates: [
    { tpl: 'DELHIVERY', forwardCharge: 75, codCharge: 0, totalCharge: 75, rtoCharge: 0 },
    { tpl: 'BLUEDART', forwardCharge: 110, codCharge: 0, rtoCharge: 0 },
    { tpl: 'XPRESSBEES', forwardCharge: 70, codCharge: 0, totalCharge: 70 },
  ] });
  assert.deepEqual(r.map((x) => x.code), ['XPRESSBEES', 'DELHIVERY', 'BLUEDART']);
  assert.equal(r[2].charge, 110);
  assert.equal(spPick(r).code, 'XPRESSBEES');
  assert.equal(spPick(r, 'DTDC|DELHIVERY').code, 'DELHIVERY');
  assert.equal(spPick(r, '').code, 'XPRESSBEES');
  assert.equal(spPick(r, 'BLUEDART|DELHIVERY').code, 'BLUEDART');                     /* only when you put it first yourself */
  /* the old saved default (Blue Dart first) reads as the new one */
  assert.equal(spPrefer({ shipprime_prefer: 'BLUEDART|XPRESSBEES|DELHIVERY' }), 'XPRESSBEES|DELHIVERY|SHADOWFAX|EKART|DTDC');
  assert.equal(spPrefer({ shipprime_prefer: 'DELHIVERY' }), 'DELHIVERY');
  assert.equal(spPick([], 'BLUEDART'), null);
});

test('items: same SKU and price merged, repeated SKU at another price kept apart', () => {
  const it = spItems([{ title: 'Dragon', sku: 'D1', quantity: 1, unitPrice: 199 }, { title: 'Dragon', sku: 'D1', quantity: 2, unitPrice: 199 }, { title: 'Dragon', sku: 'D1', quantity: 1, unitPrice: 0 }]);
  assert.equal(it.length, 2);
  assert.equal(it[0].quantity, 3);
  assert.notEqual(it[0].sku, it[1].sku);
});

test('create body: COD amount, real weight in grams, courier locked, pickup not mutated', () => {
  const pickup = { name: 'IK', phone: '9000000001', address1: 'Plot 1', address2: '', city: 'Navi Mumbai', state: 'Maharashtra', pincode: '410206', country: 'India' };
  const b = spBody({ ref: '1601', tpl: 'BLUEDART', pickup,
    plan: { pin: '560001', cod: true, codAmount: 449, amount: 449, pack: { weight_g: 35 } },
    order: { items: [{ title: 'Rose', sku: 'R', quantity: 1, unitPrice: 449 }], address: { name: 'Asha V', phone: '+91 98765 43210', address1: '12 MG Road', city: 'Bengaluru', province: 'Karnataka' } },
    row: { order_id: '1', phone: '9876543210' } });
  assert.equal(b.paymentMethod, 'COD'); assert.equal(b.collectibleAmount, 449); assert.equal(b.weightGrams, 35);
  assert.deepEqual(b.preferredTpls, ['BLUEDART']);
  assert.equal(b.deliveryAddress.phone, '9876543210'); assert.equal(b.deliveryAddress.pincode, '560001');
  assert.ok(!('address2' in b.pickupAddress)); assert.equal(pickup.address2, '');           /* the cached pickup stays whole */
  const p = spBody({ ref: 'x', pickup, plan: { pin: '560001', cod: false, codAmount: 0, amount: 399, pack: { weight_g: 30 } }, order: { items: [], address: {} }, row: { phone: '9876543210', city: 'Pune' } });
  assert.equal(p.paymentMethod, 'PREPAID'); assert.ok(!('collectibleAmount' in p)); assert.ok(!('preferredTpls' in p));
});

test('ShipPrime statuses read as the same stages as Shiprocket tracking', () => {
  const st = (x) => summarize(spToSrShape(x)).stage;
  assert.equal(st({ status: 'PACKED' }), 'pickup_pending');
  assert.equal(st({ status: 'SHIPPED', statusDate: '27-Oct-2026 15:04:05' }), 'transit');
  assert.equal(st({ order_status: 'SHIPPED', picked_at: '2026-10-27T10:30:00Z' }), 'transit');
  assert.equal(st({ status: 'OUT_FOR_DELIVERY', statusDate: '28-Oct-2026 09:00:00' }), 'ofd');
  assert.equal(st({ status: 'UNDELIVERED', statusDate: '28-Oct-2026 18:00:00', comments: 'Customer not available' }), 'ndr');
  assert.equal(st({ status: 'DELIVERED', statusDate: '29-Oct-2026 12:00:00' }), 'delivered');
  assert.equal(st({ status: 'RTO_INITIATED', statusDate: '30-Oct-2026 12:00:00' }), 'rto');
  assert.equal(st({ status: 'CANCELLED' }), 'cancelled');
  /* the WhatsApp updates read the same reply */
  assert.equal(classify(adaptTrack(spToSrShape({ status: 'PACKED' }))).stage, 'pending');
  assert.equal(classify(adaptTrack(spToSrShape({ status: 'DELIVERED', statusDate: '29-Oct-2026 12:00:00' }))).stage, 'delivered');
  assert.equal(classify(adaptTrack(spToSrShape({ status: 'OUT_FOR_DELIVERY', statusDate: '28-Oct-2026 09:00:00' }))).stage, 'ofd');
  /* picked_at in UTC becomes IST */
  assert.equal(summarize(spToSrShape({ order_status: 'SHIPPED', picked_at: '2026-10-27T10:30:00Z' })).pickedAt, '2026-10-27 16:00:00');
});

test('tracking links per carrier', () => {
  assert.equal(trackUrlOf({ awb: '123', provider: 'shipprime' }), 'https://www.shipprime.live/track-order?awb=123');
  assert.equal(trackUrlOf({ awb: '123' }), 'https://shiprocket.co/tracking/123');
  assert.equal(trackUrlOf({}), '');
});

test('webhook: wrong secret refused, unknown AWB acknowledged', async () => {
  const env = { ADMIN_SECRET: 's', DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({}) }) }) } };
  const bad = await handleSpWebhook(new Request('https://x/api/shipprime/webhook', { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' }), env);
  assert.equal(bad.status, 401);
  const ok = await handleSpWebhook(new Request('https://x/api/shipprime/webhook', { method: 'POST', headers: { Authorization: 'Bearer ' + await spWebhookSecret(env) }, body: JSON.stringify({ flow: 'FORWARD', awb_number: 'A1', order_status: 'SHIPPED' }) }), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
});

test('serviceability: never a courier known not to deliver; a confirmed one beats the order; Blue Dart not a fallback', () => {
  const r = [{ code: 'XPRESSBEES', charge: 70, ok: false }, { code: 'DELHIVERY', charge: 75, ok: null }, { code: 'SHADOWFAX', charge: 70, ok: true }, { code: 'BLUEDART', charge: 110, ok: true }];
  assert.equal(spPick(r).code, 'SHADOWFAX');
  assert.equal(spPick(r.map((x) => ({ ...x, ok: x.code === 'XPRESSBEES' ? false : null }))).code, 'DELHIVERY');
  assert.equal(spPick([{ code: 'BLUEDART', charge: 110, ok: null }, { code: 'EKART', charge: 90, ok: null }], 'XPRESSBEES').code, 'EKART');
  assert.equal(spPick([{ code: 'BLUEDART', charge: 110 }]).code, 'BLUEDART');           /* nothing else left */
  assert.equal(spPick([{ code: 'XPRESSBEES', serviceable: false }]), null);
  assert.deepEqual(spFallbacks([{ code: 'XPRESSBEES', charge: 70 }, { code: 'DELHIVERY', charge: 75 }, { code: 'BLUEDART', charge: 110 }, { code: 'DTDC', charge: 72 }], 'XPRESSBEES|DELHIVERY|DTDC', 'XPRESSBEES'), ['DELHIVERY', 'DTDC']);
});

test('arrival date: pickup on the next working day, then the delivery days, Sundays skipped', () => {
  const sat = Date.UTC(2026, 9, 24, 6) - 19800000;        /* Sat 24 Oct 2026, 11:30 IST */
  assert.equal(arrivalDate(0, sat), '2026-10-26');          /* pickup Mon 26 (Sun skipped) */
  assert.equal(arrivalDate(2, sat), '2026-10-28');
  assert.equal(arrivalDate(6, sat), '2026-11-02');          /* Sun 1 Nov skipped */
});
