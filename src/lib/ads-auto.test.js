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

import { pickLosers } from './ads-auto.js';
test('pickLosers: reel ads with ₹150+ and no purchase, never the last live ad of a set', () => {
  const rows = [
    { id: 'a', name: 'Reel - Top likes', adset_id: 's1', status: 'ACTIVE', spend: 900, purchases: 30 },
    { id: 'b', name: 'Reel - 1.4k likes', adset_id: 's1', status: 'ACTIVE', spend: 241, purchases: 0 },
    { id: 'c', name: 'Reel X (auto)', adset_id: 's1', status: 'ACTIVE', spend: 120, purchases: 0 },
    { id: 'd', name: 'IK05 static', adset_id: 's2', status: 'ACTIVE', spend: 500, purchases: 0 },
    { id: 'e', name: 'Reel lonely (auto)', adset_id: 's3', status: 'ACTIVE', spend: 400, purchases: 0 },
    { id: 'f', name: 'Reel paused', adset_id: 's1', status: 'PAUSED', spend: 400, purchases: 0 },
  ];
  assert.deepEqual(pickLosers(rows).map((x) => x.id), ['b']);
});

import { pickShift, pickLaggards } from './ads-auto.js';
test('pickShift moves budget from the worst CPA ad set to the best, total unchanged', () => {
  const rows = [
    { id: 'good', name: 'Reels', status: 'ACTIVE', daily: 1200, spend: 1500, purchases: 50 },   // ₹30
    { id: 'mid', name: 'Winners', status: 'ACTIVE', daily: 1000, spend: 1300, purchases: 16 },  // ₹81
    { id: 'bad', name: 'Sales1', status: 'ACTIVE', daily: 750, spend: 900, purchases: 4 },      // ₹225
  ];
  const s = pickShift(rows, { target: 80 });
  assert.equal(s.from.id, 'bad'); assert.equal(s.to.id, 'good'); assert.equal(s.amount, 200);
  assert.equal(s.from.to + s.to.to, 750 + 1200);
  /* floor: never below ₹300 */
  assert.equal(pickShift([rows[0], { ...rows[2], daily: 380 }], { target: 80 }), null);
  /* cap on the best ad set */
  assert.equal(pickShift(rows, { target: 80, cap: 1300 }).amount, 100);
  /* nothing clearly worse: no move */
  assert.equal(pickShift([rows[0], { ...rows[1], spend: 600, purchases: 16 }], { target: 80 }), null);
  /* zero purchases after 2x target spend counts as worst */
  assert.equal(pickShift([rows[0], { id: 'z', name: 'Z', status: 'ACTIVE', daily: 600, spend: 200, purchases: 0 }], { target: 80 }).from.id, 'z');
});
test('pickLaggards pauses an expensive ad next to a cheap sibling, never the last one', () => {
  const sets = [{ name: 'Winners', ads: [
    { id: 'mom', name: 'Mom Chat', status: 'ACTIVE', spend: 1100, purchases: 4 },     // ₹275
    { id: 'b1g1', name: 'B1G1', status: 'ACTIVE', spend: 300, purchases: 4 },          // ₹75
    { id: 'ugc', name: 'UGC', status: 'ACTIVE', spend: 120, purchases: 0 },
  ] }, { name: 'Solo', ads: [{ id: 'x', name: 'X', status: 'ACTIVE', spend: 900, purchases: 1 }] }];
  const p = pickLaggards(sets, { target: 80 });
  assert.deepEqual(p.map((x) => x.id), ['mom']);
  /* not 2.5x worse: kept */
  assert.equal(pickLaggards([{ name: 'W', ads: [{ id: 'a', status: 'ACTIVE', spend: 500, purchases: 4 }, { id: 'b', status: 'ACTIVE', spend: 300, purchases: 4 }] }], { target: 80 }).length, 0);
});
