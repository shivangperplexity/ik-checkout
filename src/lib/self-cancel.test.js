import test from 'node:test';
import assert from 'node:assert/strict';
import { cancellable, isPrepaid, trackKey, readTrackKey } from './self-cancel.js';
test('self cancel: only before the courier has it', () => {
  assert.equal(cancellable({ status: 'placed', stage: null }), true);
  assert.equal(cancellable({ status: 'placed', stage: 'pickup_pending' }), true);
  assert.equal(cancellable({ status: 'placed', stage: 'transit' }), false);
  assert.equal(cancellable({ status: 'placed', stage: 'pickup_pending', picked_at: 1 }), false);
  assert.equal(cancellable({ status: 'cancelled' }), false);
  assert.equal(cancellable({ status: 'placed', stage: 'ndr' }), false);
});
test('self cancel: never for orders paid online', () => {
  assert.equal(isPrepaid({ method: 'cod' }), false);
  assert.equal(isPrepaid({ method: 'prepaid' }), true);
  assert.equal(isPrepaid({ method: 'payu' }), true);
  assert.equal(isPrepaid({ method: 'cod', converted_at: 1700000000 }), true);
});
test('track link key: signed, tamper fails', async () => {
  const env = { ADMIN_SECRET: 's' };
  const k = await trackKey(env, '18983563919595');
  assert.equal(await readTrackKey(env, k), '18983563919595');
  assert.equal(await readTrackKey(env, k.replace(/^1/, '2')), '');
  assert.equal(await readTrackKey(env, 'junk'), '');
});
