import test from 'node:test';
import assert from 'node:assert/strict';
import { srPriorityPick } from './shiprocket.js';
import { spPriority } from './shipprime.js';

const opts = [
  { courier: 'Xpressbees DS New', charge: 60 },
  { courier: 'Delhivery Surface', charge: 65 },
  { courier: 'Ekart Logistics', charge: 80 },
  { courier: 'Blue Dart Surface', charge: 95 },
  { courier: 'Delhivery Air', charge: 90 },
];
test('Delhivery Air first, even when Xpressbees is cheaper', () => {
  assert.equal(srPriorityPick(opts, spPriority({})).courier, 'Delhivery Air');
});
test('then the cheaper of Blue Dart / Ekart, Xpressbees last', () => {
  assert.equal(srPriorityPick(opts.filter((o) => !/Air/.test(o.courier)), spPriority({})).courier, 'Ekart Logistics');
  assert.equal(srPriorityPick([opts[0], opts[1]], spPriority({})).courier, 'Xpressbees DS New');
});
test('off setting keeps the old logic', () => {
  assert.equal(srPriorityPick(opts, spPriority({ sp_priority: 'off' })), null);
});
