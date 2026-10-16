import test from 'node:test';
import assert from 'node:assert/strict';
import { fulfilBooked } from './admin.js';

/* Fake DB + fake Shopify: checks that a booked order gets fulfilled, a failure is kept with its reason, and an
   order that Shopify already shows as fulfilled is simply recorded. */
function setup(shopify) {
  const log = [], order = { order_id: '1', order_name: '#1', phone: '9999999999', first_name: 'Asha', shipped_at: null };
  const rec = { order_id: '1', awb: 'AWB1', courier: 'Delhivery' };
  const db = { prepare(sql) { return { bind: (...a) => ({
    first: async () => (/FROM shipments/.test(sql) ? rec : /FROM orders/.test(sql) ? order : null),
    all: async () => ({ results: [] }),
    run: async () => { log.push([sql.replace(/\s+/g, ' ').slice(0, 40), a]); if (/UPDATE orders SET shipped_at/.test(sql)) order.shipped_at = a[0]; return {}; },
  }) }; } };
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const q = JSON.parse(o?.body || '{}').query || '';
    const reply = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (!/myshopify/.test(u)) return reply({ ok: true });
    return shopify(q, reply);
  };
  return { env: { DB: db, SHOP_DOMAIN: 'x.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't', SETTINGS: {} }, log, order, done: () => { globalThis.fetch = real; } };
}
const errOf = (log) => log.filter(([s]) => /UPDATE shipments SET fulfil_error/.test(s)).map(([, a]) => a[0]);

test('fulfils in Shopify with the AWB and clears any earlier error', async () => {
  const sent = [];
  const t = setup((q, reply) => {
    if (/fulfillmentCreate/.test(q)) { sent.push(q); return reply({ data: { fulfillmentCreate: { fulfillment: { id: 'f', status: 'SUCCESS' }, userErrors: [] } } }); }
    return reply({ data: { order: { fulfillmentOrders: { nodes: [{ id: 'fo1', status: 'OPEN' }] } } } });
  });
  try {
    assert.equal(await fulfilBooked(t.env, '1'), '');
    assert.equal(sent.length, 1);
    assert.ok(t.order.shipped_at, 'orders.shipped_at is set');
    assert.deepEqual(errOf(t.log), [null]);
  } finally { t.done(); }
});

test('a Shopify failure is returned and saved, and the order stays unshipped so it is retried', async () => {
  const t = setup((q, reply) => reply({ errors: [{ message: 'Access denied for fulfillmentCreate field.' }] }));
  try {
    const e = await fulfilBooked(t.env, '1');
    assert.match(e, /Access denied/);
    assert.equal(t.order.shipped_at, null);
    assert.match(errOf(t.log)[0], /Access denied/);
  } finally { t.done(); }
});

test('already fulfilled in Shopify: just recorded, no error, nothing to retry', async () => {
  const t = setup((q, reply) => /displayFulfillmentStatus/.test(q)
    ? reply({ data: { order: { displayFulfillmentStatus: 'FULFILLED', fulfillmentOrders: { nodes: [] } } } })
    : reply({ data: { order: { fulfillmentOrders: { nodes: [] } } } }));
  try {
    assert.equal(await fulfilBooked(t.env, '1'), '');
    assert.ok(t.order.shipped_at);
  } finally { t.done(); }
});

test('rebooked order: Shopify still carries the old AWB, so the fulfilment is retargeted to the new one', async () => {
  const calls = [];
  const t = setup((q, reply) => {
    if (/fulfillmentOrders\(first:10\)/.test(q)) return reply({ data: { order: { fulfillmentOrders: { nodes: [{ id: 'fo1', status: 'CLOSED' }] } } } });
    if (/fulfillments\(first:10\)\{ id status trackingInfo/.test(q)) return reply({ data: { order: { cancelledAt: null, displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ id: 'gid://shopify/Fulfillment/9', status: 'SUCCESS', trackingInfo: [{ number: 'OLD1', company: 'Xpressbees' }] }] } } });
    if (/fulfillmentTrackingInfoUpdate/.test(q)) { calls.push('retrack'); return reply({ data: { fulfillmentTrackingInfoUpdate: { userErrors: [] } } }); }
    return reply({ data: {} });
  });
  try {
    assert.equal(await fulfilBooked(t.env, '1'), '');
    assert.ok(calls.includes('retrack'), 'tracking updated to AWB1');
    assert.ok(t.order.shipped_at, 'shipped here');
    assert.ok(t.log.some(([s]) => /INSERT INTO ship_track/.test(s)), 'WhatsApp tracking row restarted with the new AWB');
    assert.deepEqual(errOf(t.log).slice(-1), [null]);
  } finally { t.done(); }
});

test('already fulfilled with the same AWB: nothing changes in Shopify, just recorded here', async () => {
  const calls = [];
  const t = setup((q, reply) => {
    if (/fulfillmentOrders\(first:10\)/.test(q)) return reply({ data: { order: { fulfillmentOrders: { nodes: [{ id: 'fo1', status: 'CLOSED' }] } } } });
    if (/fulfillments\(first:10\)\{ id status trackingInfo/.test(q)) return reply({ data: { order: { cancelledAt: null, displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ id: 'gid://shopify/Fulfillment/9', status: 'SUCCESS', trackingInfo: [{ number: 'AWB1', company: 'Delhivery' }] }] } } });
    if (/fulfillmentTrackingInfoUpdate|fulfillmentCancel|fulfillmentCreate/.test(q)) calls.push('write');
    return reply({ data: {} });
  });
  try {
    assert.equal(await fulfilBooked(t.env, '1'), '');
    assert.deepEqual(calls, []);
    assert.ok(t.order.shipped_at);
  } finally { t.done(); }
});
