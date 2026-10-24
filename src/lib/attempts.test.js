import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptsOf } from './sr-scan.js';

const s = (at, text, label = '') => ({ at, text, label });
test('delivery attempts before RTO: one per day with an out-for-delivery or failed-delivery scan', () => {
  const scans = [
    s('2026-10-12 10:00:00', 'In Transit - Shipment picked up'),
    s('2026-10-15 08:10:00', 'Out for Delivery'),
    s('2026-10-15 19:40:00', 'Undelivered - Customer not available', 'UNDELIVERED'),
    s('2026-10-16 09:00:00', 'Out for Delivery'),
    s('2026-10-16 18:00:00', 'Undelivered - Customer not available'),
    s('2026-10-18 11:00:00', 'Undelivered - Consignee refused to accept'),
    s('2026-10-19 10:00:00', 'RTO Initiated'),
    s('2026-10-21 10:00:00', 'Out for Delivery'),          /* RTO leg: not an attempt */
  ].reverse();
  const a = attemptsOf(scans);
  assert.equal(a.attempts, 3);
  assert.deepEqual(a.reasons, ['Customer not available', 'Consignee refused to accept']);
  assert.equal(attemptsOf([s('2026-10-12 10:00:00', 'In Transit')]).attempts, 0);
});
