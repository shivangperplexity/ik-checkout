import test from 'node:test';
import assert from 'node:assert/strict';
import { stageOf, refreshShipment, requestPickup } from './ship-status.js';

test('Shiprocket status text -> stage', () => {
  const cases = {
    'PICKUP SCHEDULED': 'pickup_pending', 'Pickup Generated': 'pickup_pending', 'PICKUP QUEUED': 'pickup_pending', 'OUT FOR PICKUP': 'pickup_pending',
    'PICKUP RESCHEDULED': 'pickup_pending', 'AWB ASSIGNED': 'pickup_pending', 'MANIFEST GENERATED': 'pickup_pending', 'pickup_pending': 'pickup_pending',
    'PICKUP EXCEPTION': 'pickup_failed', 'Pickup Error': 'pickup_failed', 'PICKUP CANCELLED': 'pickup_failed',
    'PICKED UP': 'transit', 'SHIPPED': 'transit', 'IN TRANSIT': 'transit', 'in_transit': 'transit', 'REACHED AT DESTINATION HUB': 'transit', 'MISROUTED': 'transit',
    'OUT FOR DELIVERY': 'ofd', 'UNDELIVERED': 'ndr', 'ndr': 'ndr', 'DELIVERED': 'delivered',
    'RTO INITIATED': 'rto', 'rto_initiated': 'rto', 'RTO IN TRANSIT': 'rto', 'RTO DELIVERED': 'rto',
    'CANCELED': 'cancelled', 'Cancellation Requested': 'cancelled', 'LOST': 'lost', 'DAMAGED': 'lost', '': 'pickup_pending', booked: 'pickup_pending',
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(stageOf(text), want, text);
  assert.equal(stageOf('', true), 'transit', 'scanned but no text -> moving');
  assert.equal(stageOf('PICKUP SCHEDULED', true), 'transit', 'stale "scheduled" text after a pickup scan');
});

/* fake DB + Shiprocket/Shopify */
function world(sr) {
  const runs = [], calls = [];
  const env = { SETTINGS: { shipping: { shiprocket_email: 'a@b.c', shiprocket_password: 'p' } }, SHOP_DOMAIN: 'x.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't',
    DB: { prepare: (sql) => ({ bind: (...a) => ({ run: async () => { runs.push([sql.replace(/\s+/g, ' ').trim(), a]); return {}; }, first: async () => null, all: async () => ({ results: [] }) }) }) } };
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u), ok = (j, st = 200) => new Response(JSON.stringify(j), { status: st });
    if (/auth\/login/.test(url)) return ok({ token: 't' });
    if (/shiprocket/.test(url)) { calls.push(url.replace(/.*external\//, '') + (o?.body ? ' ' + o.body : '')); return sr(url, o, ok); }
    const q = JSON.parse(o?.body || '{}').query || '';
    if (/fulfillments\(first/.test(q)) return ok({ data: { order: { fulfillments: [{ id: 'gid://shopify/Fulfillment/9', status: 'SUCCESS', trackingInfo: [{ number: 'AWB1' }] }] } } });
    if (/fulfillmentCancel/.test(q)) { calls.push('shopify-unfulfil'); return ok({ data: { fulfillmentCancel: { userErrors: [] } } }); }
    return ok({ data: {} });
  };
  return { env, runs, calls, done: () => { globalThis.fetch = real; } };
}
const rec = { order_id: '1', order_name: '#1', awb: 'AWB1', sr_order_id: '901', sr_shipment_id: '801', status: 'booked' };

test('before the first scan the status comes from the Shiprocket order (e.g. pickup exception)', async () => {
  const w = world((url, o, ok) => /track\/awb/.test(url) ? ok({ tracking_data: { track_status: 0, error: 'no activities found' } }) : /orders\/show/.test(url) ? ok({ data: { status: 'PICKUP EXCEPTION', shipments: [{ status: 'PICKUP EXCEPTION' }] } }) : ok({}));
  try {
    assert.equal(await refreshShipment(w.env, rec), 'pickup_failed');
    const up = w.runs.find(([s]) => /^UPDATE shipments SET stage=/.test(s));
    assert.equal(up[1][0], 'pickup_failed');
    assert.equal(up[1][1], 'PICKUP EXCEPTION');
  } finally { w.done(); }
});

test('picked up: stage transit and picked_at is set', async () => {
  const w = world((url, o, ok) => ok({ tracking_data: { etd: '2026-10-18 12:00:00', shipment_track: [{ current_status: 'PICKED UP' }], shipment_track_activities: [{ 'sr-status-label': 'PICKED UP', activity: 'Shipment picked up', date: '2026-10-15 11:00:00' }] } }));
  try {
    assert.equal(await refreshShipment(w.env, rec), 'transit');
    const up = w.runs.find(([s]) => /^UPDATE shipments SET stage=/.test(s))[1];
    assert.equal(up[3], '2026-10-18');      // edd
    assert.equal(up[4], true);              // picked -> picked_at set
  } finally { w.done(); }
});

test('cancelled inside the Shiprocket panel: shown cancelled here, order freed to ship again, Shopify fulfilment undone', async () => {
  const w = world((url, o, ok) => ok({ tracking_data: { shipment_track: [{ current_status: 'CANCELED' }], shipment_track_activities: [] } }));
  try {
    assert.equal(await refreshShipment(w.env, rec), 'cancelled');
    assert.ok(w.runs.some(([s]) => /^UPDATE shipments SET status='cancelled'/.test(s)));
    assert.ok(w.runs.some(([s]) => /^UPDATE orders SET shipped_at=NULL/.test(s)));
    assert.ok(w.calls.includes('shopify-unfulfil'));
  } finally { w.done(); }
});

test('request pickup (with a date): one call per shipment, Shiprocket\'s answer is shown, a failure does not stop the rest', async () => {
  const w = world((url, o, ok) => {
    const b = JSON.parse(o.body);
    if (b.shipment_id[0] === 802) return ok({ message: 'Pickup already scheduled for this shipment' }, 422);
    return ok({ pickup_status: 1, response: { pickup_scheduled_date: '2026-10-16 10:00:00', data: 'Pickup is scheduled' } });
  });
  try {
    const r = await requestPickup(w.env, [rec, { ...rec, order_id: '2', order_name: '#2', sr_shipment_id: '802' }], '2026-10-16');
    assert.deepEqual(r.map((x) => [x.name, x.ok]), [['#1', true], ['#2', false]]);
    assert.equal(r[0].note, 'Pickup on 2026-10-16 10:00:00');
    assert.match(r[1].note, /already scheduled/);
    assert.ok(w.calls[0].includes('"pickup_date":["2026-10-16"]'));
  } finally { w.done(); }
});
