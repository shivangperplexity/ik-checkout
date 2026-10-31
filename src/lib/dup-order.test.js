import test from 'node:test';
import assert from 'node:assert/strict';
import { sameItems } from './dup-order.js';
test('dup order: same designs again is a duplicate, a new design is not', () => {
  assert.equal(sameItems([{ id: '1' }, { id: '2' }], [{ id: '2', quantity: 1 }, { id: '1', quantity: 1 }]), true);
  assert.equal(sameItems([{ id: '1' }], [{ id: '1' }, { id: '3' }]), true);
  assert.equal(sameItems([{ id: '1' }, { id: '4' }], [{ id: '1' }]), false);
  assert.equal(sameItems([], [{ id: '1' }]), false);
});
