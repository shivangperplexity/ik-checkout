import test from 'node:test';
import assert from 'node:assert/strict';
import { mysteryCfg, mysteryLine, MYSTERY_TAG } from './mystery.js';
import { createDraft } from './shopify.js';

test('mystery gift settings and the ₹0 order line', () => {
  assert.equal(mysteryCfg({}).on, true);
  assert.equal(mysteryCfg({ SETTINGS: { mystery: { on: false } } }).on, false);
  const l = mysteryLine({});
  assert.equal(l.originalUnitPrice, '0.00'); assert.equal(l.quantity, 1); assert.match(l.title, /Mystery Tattoo/);
  assert.equal(MYSTERY_TAG, 'mystery-gift');
});

test('a prepaid draft order carries the free mystery line next to the cart lines', async () => {
  let sent = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => { sent = JSON.parse(o.body); return new Response(JSON.stringify({ data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/1', name: '#D1', totalPriceSet: { shopMoney: { amount: '359.10' } } }, userErrors: [] } } })); };
  try {
    const env = { SHOPIFY_STORE: 'x.myshopify.com', SHOPIFY_TOKEN: 't', SHOP: 'x.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't' };
    const price = { subtotal: 79800, bogo: 39900, prepaid: 3990, upsell: 0, shipping: 0, cod: 0, total: 35910 };
    const buyer = { firstName: 'A', lastName: 'B', address1: 'x', city: 'Pune', state: 'Maharashtra', pincode: '411001', phone: '9999999999' };
    const d = await createDraft(env, { lines: [{ variantId: 'gid://shopify/ProductVariant/1', qty: 2 }], price, method: 'prepaid', buyer, tags: [], attributes: [], extraLines: [mysteryLine({})] });
    assert.equal(d.total, 35910);
    const li = sent.variables.input.lineItems;
    assert.equal(li.length, 2); assert.equal(li[1].originalUnitPrice, '0.00');
  } finally { globalThis.fetch = real; }
});
