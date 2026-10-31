import test from 'node:test';
import assert from 'node:assert/strict';
import { cancellable, trackKey, readTrackKey } from './self-cancel.js';
test('self cancel: only before the courier has it', () => {
  assert.equal(cancellable({ status: 'placed', stage: null }), true);
  assert.equal(cancellable({ status: 'placed', stage: 'pickup_pending' }), true);
  assert.equal(cancellable({ status: 'placed', stage: 'transit' }), false);
  assert.equal(cancellable({ status: 'placed', stage: 'pickup_pending', picked_at: 1 }), false);
  assert.equal(cancellable({ status: 'cancelled' }), false);
  assert.equal(cancellable({ status: 'placed', stage: 'ndr' }), false);
});
test('track link key: signed, tamper fails', async () => {
  const env = { ADMIN_SECRET: 's' };
  const k = await trackKey(env, '18983563919595');
  assert.equal(await readTrackKey(env, k), '18983563919595');
  assert.equal(await readTrackKey(env, k.replace(/^1/, '2')), '');
  assert.equal(await readTrackKey(env, 'junk'), '');
});
