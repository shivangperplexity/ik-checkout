import test from 'node:test';
import assert from 'node:assert/strict';
import { srDate, expectedOn } from './remittance.js';
test('remittance: Shiprocket date format and 8-day due date', () => {
  const ts = Date.UTC(2026, 9, 3, 6, 0) / 1000;
  assert.equal(srDate(ts), '2026-Oct-03');
  assert.equal(expectedOn({ provider: 'shiprocket', delivered_at: ts }), '2026-10-11');
  assert.equal(expectedOn({ provider: 'shipprime', delivered_at: ts }), null);
});
