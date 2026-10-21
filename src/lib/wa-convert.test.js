import test from 'node:test';
import assert from 'node:assert/strict';
import { convertCfg, discountOrder, payKey, parseKey } from './wa-convert.js';

test('settings: dashboard wins, legacy env still works, values clamped', () => {
  assert.deepEqual(convertCfg({ SETTINGS: { convert: { mode: 'on', pct: 90, delay_min: -5, hours: 500 } } }), { mode: 'on', pct: 50, delay_min: 0, hours: 72, template: 'cod_prepaid_offer' });
  assert.equal(convertCfg({}).mode, 'off');
  const legacy = convertCfg({ COD_CONVERT_HOURS: '6', COD_CONVERT_DISCOUNT: '10' });
  assert.deepEqual([legacy.mode, legacy.pct, legacy.delay_min], ['legacy', 10, 360]);
});

test('pay key: signed, tamper-proof', async () => {
  const env = { ADMIN_TOKEN: 'x' };
  const k = await payKey(env, '123');
  assert.match(k, /^123-[a-f0-9]{12}$/);
  assert.equal(await parseKey(env, k), '123');
  assert.equal(await parseKey(env, k.replace('123-', '124-')), null);
  assert.equal(await parseKey(env, 'junk'), null);
});

/* Shopify order edit stand-in: a fixed discount takes its amount off (per line), a percent takes pct of the line */
function shopify(lines, total, { fixedPerUnit = false } = {}) {
  const st = { committed: null, begins: 0 };
  globalThis.fetch = async (url, init) => {
    const { query: q, variables: v } = JSON.parse(init.body);
    const ok = (d) => new Response(JSON.stringify({ data: d }));
    if (/orderEditBegin/.test(q)) { st.begins++; st.off = 0; return ok({ orderEditBegin: { calculatedOrder: { id: 'C', totalOutstandingSet: { shopMoney: { amount: String(total) } }, lineItems: { nodes: lines.map((l) => ({ id: l.id, quantity: l.q, discountedUnitPriceSet: { shopMoney: { amount: String(l.p) } } })) } }, userErrors: [] } }); }
    if (/orderEditAddLineItemDiscount/.test(q)) {
      const l = lines.find((x) => x.id === v.li);
      st.off += v.d.fixedValue ? Number(v.d.fixedValue.amount) * (fixedPerUnit ? l.q : 1) : (l.p * l.q * v.d.percentValue) / 100;
      return ok({ orderEditAddLineItemDiscount: { calculatedOrder: { id: 'C', totalOutstandingSet: { shopMoney: { amount: String(Math.round((total - st.off) * 100) / 100) } } }, userErrors: [] } });
    }
    if (/orderEditCommit/.test(q)) { st.committed = st.off; return ok({ orderEditCommit: { order: { id: 'o' }, userErrors: [] } }); }
    return ok({});
  };
  return st;
}
const env = { SHOP_DOMAIN: 'x.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't' };

test('Shopify gets exactly what was paid: fixed amount on one line', async () => {
  const st = shopify([{ id: 'a', q: 1, p: 399 }, { id: 'b', q: 1, p: 499 }], 499);
  const r = await discountOrder(env, '1', { pct: 20, paidPaise: 39900, note: 'n' });
  assert.equal(r.edited, true); assert.equal(st.committed, 100);
});

test('a multi-quantity line whose fixed discount Shopify applies per unit', async () => {
  const st = shopify([{ id: 'a', q: 2, p: 399 }], 399, { fixedPerUnit: true });
  await discountOrder(env, '1', { pct: 20, paidPaise: 31900, note: 'n' });
  assert.equal(st.committed, 80);
});

test('never commits an edit whose total would not match the payment', async () => {
  const st = shopify([{ id: 'a', q: 3, p: 133 }], 399, { fixedPerUnit: true });
  await assert.rejects(discountOrder(env, '1', { pct: 10, paidPaise: 29900, note: 'n' }), /could not make Shopify's total match/);
  assert.equal(st.committed, null);
});
