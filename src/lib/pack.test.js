import test from 'node:test';
import assert from 'node:assert/strict';
import { packOrders } from './admin.js';

test('mark packed: only unshipped, uncancelled orders; Shopify gets a "packed" tag; unmark clears it', async () => {
  const orders = { 1: { order_id: '1', order_name: '#1', status: 'placed' }, 2: { order_id: '2', order_name: '#2', status: 'cancelled' }, 3: { order_id: '3', order_name: '#3', status: 'paid', shipped_at: 5 } };
  const ship = { 4: { awb: 'A4' } };
  const tags = [], real = globalThis.fetch;
  const env = { SHOP_DOMAIN: 'x.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't', DB: { prepare: (sql) => ({ bind: (...a) => ({
    all: async () => ({ results: /FROM shipments/.test(sql) ? Object.entries(ship).map(([k, v]) => ({ order_id: k, ...v })) : a.map((id) => orders[id]).filter(Boolean) }),
    run: async () => { if (/SET packed_at/.test(sql)) orders[a[1]].packed_at = a[0]; return {}; } }) }) } };
  globalThis.fetch = async (u, o) => { const b = JSON.parse(o.body); if (/tagsAdd|tagsRemove/.test(b.query)) tags.push((/tagsAdd/.test(b.query) ? '+' : '-') + b.variables.t[0] + ' ' + b.variables.id.split('/').pop()); return new Response(JSON.stringify({ data: { tagsAdd: { userErrors: [] }, tagsRemove: { userErrors: [] } } })); };
  try {
    const r = await packOrders(env, ['1', '2', '3', '4', '9'], true);
    assert.deepEqual(r.map((x) => [x.name, x.ok, x.note]), [['#1', true, 'Packed'], ['#2', false, 'Cancelled'], ['#3', false, 'Already shipped'], ['4', false, 'Order not found'], ['9', false, 'Order not found']]);
    assert.ok(orders[1].packed_at > 0);
    assert.deepEqual(tags, ['+packed 1']);
    await packOrders(env, ['1'], false);
    assert.equal(orders[1].packed_at, null);
    assert.deepEqual(tags, ['+packed 1', '-packed 1']);
  } finally { globalThis.fetch = real; }
});
