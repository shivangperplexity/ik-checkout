import test from 'node:test';
import assert from 'node:assert/strict';
import { gql, variantNodes, _clearVariantCache } from './shopify.orig.js';

const env = { SHOP_DOMAIN: 'x.myshopify.com', SHOPIFY_ADMIN_TOKEN: 'tok' };
const node = (id, price = '399.00') => ({ id: `gid://shopify/ProductVariant/${id}`, title: 'T', price, availableForSale: true, product: { title: 'P' + id, productType: 'Tattoo', handle: 'p' } });

function mockFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return handler(calls.length, init); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const ok = (data) => ({ ok: true, status: 200, json: async () => ({ data }) });

test('gql: a query that fails on the network is tried once more', async () => {
  const m = mockFetch((n) => { if (n === 1) throw new TypeError('fetch failed'); return ok({ shop: { name: 'x' } }); });
  try {
    const d = await gql(env, '{ shop { name } }');
    assert.equal(d.shop.name, 'x');
    assert.equal(m.calls.length, 2);
  } finally { m.restore(); }
});

test('gql: a mutation is never sent twice', async () => {
  const m = mockFetch(() => { throw new TypeError('fetch failed'); });
  try {
    await assert.rejects(gql(env, 'mutation { x }'));
    assert.equal(m.calls.length, 1);
  } finally { m.restore(); }
});

test('gql: a request that hangs gives up at the deadline and retries', async () => {
  const m = mockFetch((n, init) => (n === 1
    ? new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    : ok({ shop: { name: 'y' } })));
  try {
    const d = await gql(env, '{ shop { name } }', {}, { timeoutMs: 50 });
    assert.equal(d.shop.name, 'y');
    assert.equal(m.calls.length, 2);
  } finally { m.restore(); }
});

test('variantNodes: one Shopify call per cart, reused for 60 s when cached; orders read fresh', async () => {
  _clearVariantCache();
  const m = mockFetch((n, init) => ok({ nodes: JSON.parse(init.body).variables.ids.map((g) => node(g.split('/').pop())) }));
  try {
    const a = await variantNodes(env, ['1', '2'], { cache: true });
    assert.deepEqual(a.map((v) => v.id.split('/').pop()), ['1', '2']);
    await variantNodes(env, ['2', '1'], { cache: true });       /* same cart, other order: from cache */
    assert.equal(m.calls.length, 1);
    await variantNodes(env, ['1', '3'], { cache: true });       /* only the new variant is fetched */
    assert.deepEqual(m.calls[1].variables.ids, ['gid://shopify/ProductVariant/3']);
    await variantNodes(env, ['1']);                              /* no cache: always asks */
    assert.equal(m.calls.length, 3);
  } finally { m.restore(); _clearVariantCache(); }
});
