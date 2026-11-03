import test from 'node:test';
import assert from 'node:assert/strict';
import { isNight, pickScale, pickReel } from './ads-auto.js';

test('night window wraps midnight', () => {
  assert.equal(isNight(23), true); assert.equal(isNight(2), true); assert.equal(isNight(6), false); assert.equal(isNight(14), false);
});
test('pickScale grows the cheapest confirmed CPA by 100 or 50', () => {
  const rows = [
    { id: 'a', name: 'A', status: 'ACTIVE', daily: 1100, spend: 900, purchases: 20, custom: { 1141111382186066: 10 } },
    { id: 'b', name: 'B', status: 'ACTIVE', daily: 750, spend: 700, purchases: 9, custom: { 1141111382186066: 5 } },
    { id: 'c', name: 'C', status: 'PAUSED', daily: 500, spend: 100, purchases: 9, custom: { 1141111382186066: 9 } },
  ];
  const p = pickScale(rows, { target: 80 });
  assert.equal(p.id, 'a'); assert.equal(p.to, 1200);
  assert.equal(pickScale(rows, { target: 65 }).to, 1150);
  assert.equal(pickScale(rows, { target: 40 }), null);
});
test('pickReel wants a reel clearly above the median and unused', () => {
  const reels = [1, 2, 3, 4, 40].map((v, i) => ({ id: 'r' + i, type: 'REELS', views: v * 1000 }));
  assert.equal(pickReel(reels).id, 'r4');
  assert.equal(pickReel(reels, { used: { r4: {} } }), null);
  assert.equal(pickReel([{ id: 'x', type: 'FEED', views: 9e6 }]), null);
});
