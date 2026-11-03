import test from 'node:test';
import assert from 'node:assert/strict';
import { overdue } from './ship-watch.js';
test('overdue: Blue Dart, booked on ShipPrime, still pickup_pending after 48 h', () => {
  const t = 1_000_000;
  const rows = [
    { order_name: 'a', courier: 'Blue Dart', provider: 'shipprime', status: 'booked', stage: 'pickup_pending', created_at: t - 49 * 3600 },
    { order_name: 'b', courier: 'Bluedart Surface', provider: 'shipprime', status: 'booked', stage: 'pickup_pending', created_at: t - 20 * 3600 },
    { order_name: 'c', courier: 'Blue Dart', provider: 'shipprime', status: 'booked', stage: 'transit', created_at: t - 90 * 3600 },
    { order_name: 'd', courier: 'Xpressbees', provider: 'shipprime', status: 'booked', stage: 'pickup_pending', created_at: t - 90 * 3600 },
    { order_name: 'e', courier: 'Blue Dart', provider: 'shipprime', status: 'booked', stage: 'pickup_pending', created_at: t - 90 * 3600, bd_rebooked_at: 5 },
  ];
  assert.deepEqual(overdue(rows, t).map((r) => r.order_name), ['a']);
});
