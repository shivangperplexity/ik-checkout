import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStats, rtoChance, slowPickup, smartPick, familyOf } from './allocate.js';

const T = 2000000000;
function rows() {
  const out = [];
  const add = (courier, state, pin, n, rto) => { for (let i = 0; i < n; i++) out.push({ courier, stage: i < rto ? 'rto' : 'delivered', method: 'cod', state_code: state, pincode: pin, booked_at: T - 10 * 86400, picked_at: T - 10 * 86400 + 3600 }); };
  add('Xpressbees Surface', 'UP', '201001', 30, 18);   // 60% in UP
  add('Xpressbees Surface', 'MH', '400001', 30, 9);    // 30% in MH
  add('Delhivery Surface', 'UP', '201301', 20, 6);     // 30% in UP
  add('Delhivery Surface', 'MH', '400601', 20, 8);     // 40% in MH
  for (let i = 0; i < 10; i++) out.push({ courier: 'Blue Dart', stage: null, method: 'cod', booked_at: T - 10 * 86400, picked_at: i < 7 ? T - 6 * 86400 : null }); // slow pickups
  return out;
}

test('allocate: family names', () => {
  assert.equal(familyOf('XPRESSBEES_PREMIUM'), 'Xpressbees');
  assert.equal(familyOf('Blue Dart Air'), 'Blue Dart');
  assert.equal(familyOf('SHREE_MARUTI'), 'Shree Maruti');
});

test('allocate: RTO chance follows the state, shrunk towards the courier average', () => {
  const S = buildStats(rows(), T);
  const xUP = rtoChance(S, 'Xpressbees', 'UP', '201001'), dUP = rtoChance(S, 'Delhivery', 'UP', '201301');
  const xMH = rtoChance(S, 'Xpressbees', 'MH', '400001'), dMH = rtoChance(S, 'Delhivery', 'MH', '400601');
  assert.ok(xUP > dUP, 'Delhivery better in UP');
  assert.ok(xMH < dMH, 'Xpressbees better in MH');
  assert.ok(xUP < 0.6 && xUP > 0.45, 'shrunk, not raw 60%');
  assert.ok(slowPickup(S, 'Blue Dart') > 0.4);
});

test('allocate: picks by expected cost per parcel, not by price alone', () => {
  const S = buildStats(rows(), T);
  const opts = [{ courier: 'Xpressbees Surface', charge: 60 }, { courier: 'Delhivery Surface', charge: 70 }];
  assert.equal(smartPick(opts, S, { cod: true, state: 'UP', pin: '201001', loss: 250 }).pick.courier, 'Delhivery Surface');
  assert.equal(smartPick(opts, S, { cod: true, state: 'MH', pin: '400001', loss: 250 }).pick.courier, 'Xpressbees Surface');
  assert.equal(smartPick(opts, S, { cod: false, state: 'UP', pin: '201001', loss: 0 }).pick.courier, 'Xpressbees Surface', 'prepaid: cheapest');
  /* slow pickups count against a courier */
  const withBD = [...opts, { courier: 'Blue Dart', charge: 62 }];
  assert.notEqual(smartPick(withBD, S, { cod: true, state: 'MH', pin: '400001', loss: 250 }).pick.courier, 'Blue Dart');
  /* never a courier known not to deliver */
  assert.equal(smartPick([{ courier: 'Delhivery', charge: 70, ok: false }, { courier: 'Xpressbees', charge: 60 }, { courier: 'DTDC', charge: 90 }], S, { cod: true, state: 'UP' }).pick.courier !== 'Delhivery', true);
  assert.equal(smartPick(opts, buildStats([], T), { cod: true }), null, 'no history: keep the old rule');
});

test('allocate: Shiprocket network scores steer a PIN with little own data, and slow-pickup scores count', async () => {
  const { perfFor, perfOf } = await import('./allocate.js');
  const S = buildStats(rows(), T);
  /* Rajasthan: no own parcels there; network says Delhivery delivers far better at this PIN */
  const opts = [{ courier: 'Xpressbees Surface', charge: 60, perf: { rto: 3.0, delivery: 3.0, pickup: 4.6 } }, { courier: 'Delhivery Surface', charge: 64, perf: { rto: 5, delivery: 5, pickup: 4.6 } }];
  assert.equal(smartPick(opts, S, { cod: true, state: 'RJ', pin: '302001', loss: 250 }).pick.courier, 'Delhivery Surface');
  /* pickup score 1/5 (Blue Dart Surface at 201001 in Oct 2026) keeps a cheap courier out */
  const bd = [{ courier: 'Blue Dart Surface', charge: 55, perf: { rto: 5, delivery: 5, pickup: 1 } }, { courier: 'Delhivery Surface', charge: 64, perf: { rto: 5, delivery: 4.5, pickup: 4.6 } }];
  assert.equal(smartPick(bd, S, { cod: true, state: 'RJ', pin: '302001', loss: 250 }).pick.courier, 'Delhivery Surface');
  assert.deepEqual(perfOf({ rto_performance: 4.9, delivery_performance: 3.1, pickup_performance: 1.7, rating: 3.5 }), { rto: 4.9, delivery: 3.1, pickup: 1.7, rating: 3.5 });
  const sr = [{ courier: 'Blue Dart Surface', perf: { rto: 5, pickup: 1 } }, { courier: 'Blue Dart Air', perf: { rto: 5, pickup: 3.9 } }];
  assert.equal(perfFor('BLUEDART_AIR', sr).pickup, 3.9);
  assert.equal(perfFor('BLUEDART', sr).pickup, 1);
});
