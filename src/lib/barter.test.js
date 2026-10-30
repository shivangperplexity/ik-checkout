import test from 'node:test';
import assert from 'node:assert/strict';
import { eligible, postWindow, refOf, MAX_ITEMS } from './barter.js';

test('barter: only 10+ in stock, never sleeves', () => {
  assert.equal(eligible({ title: 'Koi Fish Tattoo', stock: 10 }), true);
  assert.equal(eligible({ title: 'Koi Fish Tattoo', stock: 9 }), false);
  assert.equal(eligible({ title: 'Dragon Full Sleeve Tattoo', stock: 50 }), false);
  assert.equal(eligible({ title: 'Sleeve', stock: 50 }), false);
  assert.equal(eligible({ title: 'Tribal Arm Band Tattoo', stock: 12 }), true);
  assert.equal(eligible({ title: 'Chest Piece Tattoo', stock: 11 }), true);
  assert.equal(eligible({ title: 'Chest Piece Tattoo', stock: 3 }), false);
  assert.equal(eligible({ title: 'Rose', stock: 20, collections: ['full-sleeves'] }), false);
  assert.equal(eligible({ title: 'Rose', stock: 20, available: false }), false);
  assert.equal(MAX_ITEMS, 4);
});

test('barter: reel date 4 to 10 days after delivery, 6 by default', () => {
  assert.deepEqual(postWindow('2026-11-05'), { min: '2026-11-09', def: '2026-11-11', max: '2026-11-15' });
  assert.deepEqual(postWindow('2026-12-28'), { min: '2027-01-01', def: '2027-01-03', max: '2027-01-07' });
  const w = postWindow('');
  assert.ok(w.min < w.def && w.def < w.max);
  assert.equal(refOf(1), 'IKC-1001');
});

test('barter: email typo fix', async () => {
  const { emailFix } = await import('./barter.js');
  assert.equal(emailFix('ankitajuyal211@gmail.con'), 'ankitajuyal211@gmail.com');
  assert.equal(emailFix(' Riya@GMIAL.com '), 'riya@gmail.com');
  assert.equal(emailFix('a@company.in'), 'a@company.in');
});
