import test from 'node:test';
import assert from 'node:assert/strict';
import { customerStatus } from './site.js';

test('customer-facing status and step', () => {
  assert.equal(customerStatus({ method: 'cod', status: 'placed' }).key, 'confirm');
  assert.equal(customerStatus({ method: 'prepaid', status: 'placed' }).step, 1);
  assert.equal(customerStatus({ awb: 'A', stage: 'pickup_pending' }).key, 'packed');
  assert.equal(customerStatus({ awb: 'A', stage: 'transit' }).step, 3);
  assert.equal(customerStatus({ awb: 'A', stage: 'ofd' }).step, 4);
  assert.equal(customerStatus({ awb: 'A', stage: 'delivered', delivered_at: 1793180000 }).step, 5);
  assert.equal(customerStatus({ awb: 'A', stage: 'rto' }).key, 'returned');
  assert.equal(customerStatus({ status: 'cancelled' }).key, 'cancelled');
});
