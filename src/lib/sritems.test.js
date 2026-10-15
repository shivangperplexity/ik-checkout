import test from 'node:test';
import assert from 'node:assert/strict';
import { srItems } from './shiprocket.js';

test('same SKU twice (order #1571) becomes one Shiprocket line with 2 units; different prices stay separate with unique SKUs', () => {
  const two = srItems([{ title: 'Pentacle Star Knot Tattoo', sku: 'IKA7', quantity: 1, unitPrice: 399 }, { title: 'Pentacle Star Knot Tattoo', sku: 'IKA7', quantity: 1, unitPrice: 399 }]);
  assert.deepEqual(two.map((x) => [x.sku, x.units, x.selling_price]), [['IKA7', 2, 399]]);
  const mixed = srItems([{ title: 'A', sku: 'IKA7', quantity: 1, unitPrice: 399 }, { title: 'A', sku: 'IKA7', quantity: 2, unitPrice: 299 }, { title: 'B', sku: '', quantity: 1, unitPrice: 199 }]);
  assert.deepEqual(mixed.map((x) => [x.sku, x.units, x.selling_price]), [['IKA7', 1, 399], ['IKA7-2', 2, 299], ['B', 1, 199]]);
  assert.equal(new Set(mixed.map((x) => x.sku)).size, mixed.length, 'all SKUs unique');
});
