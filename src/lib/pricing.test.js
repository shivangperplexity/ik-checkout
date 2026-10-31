import test from 'node:test';
import assert from 'node:assert/strict';

test('pricing v2: prepaid ₹50 or 10% (whichever is more), ₹29 COD fee; v1 unchanged', async () => {
  const { priceCart, pricingCfg } = await import('./pricing.js');
  const L = (unit, qty = 1) => [{ variantId: 'x', title: 't', qty, unit, productType: 'Semi-Permanent Tattoo' }];
  const v2 = pricingCfg({ SETTINGS: {} }, { pv: 2 });
  assert.equal(priceCart(L(39900), 'prepaid', v2).prepaid, 5000);            // 10% = ₹40 -> ₹50
  assert.equal(priceCart(L(69900), 'prepaid', v2).prepaid, 7000);            // 10% = ₹70 > ₹50
  assert.equal(priceCart(L(39900), 'cod', v2).cod, 2900);
  assert.equal(priceCart(L(39900), 'cod', v2).total, 42800);
  const v1 = pricingCfg({ SETTINGS: {} }, {});
  assert.equal(priceCart(L(39900), 'prepaid', v1).prepaid, 4000);
  assert.equal(priceCart(L(39900), 'cod', v1).cod, 0);
});
