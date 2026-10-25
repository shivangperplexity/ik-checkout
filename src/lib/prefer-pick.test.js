import test from 'node:test';
import assert from 'node:assert/strict';
import { preferPick } from './shiprocket.js';

const day = (n) => new Date(Date.UTC(2026, 9, 25 + n));
const XB = { id: '1', courier: 'Xpressbees Surface', charge: 100, eddDate: day(4) };
const BD = { id: '2', courier: 'Blue Dart Surface', charge: 118, eddDate: day(4) };
const BA = { id: '3', courier: 'Blue Dart Air', charge: 190, eddDate: day(2) };
const DL = { id: '4', courier: 'Delhivery Surface', charge: 107, eddDate: day(5) };

test('COD prefers Blue Dart Surface within the extra and the tolerance', () => {
  const r = preferPick([XB, BD, BA, DL], XB, { cod: true, prefer: 'Blue Dart Surface', extra: 25, toleranceDays: 4 });
  assert.equal(r.pick.id, '2'); assert.match(r.note, /Blue Dart Surface: preferred for COD.*₹18 more than Xpressbees Surface/);
});
test('keeps the normal pick when Blue Dart is too dear, too slow, missing, prepaid or off', () => {
  assert.equal(preferPick([XB, { ...BD, charge: 140 }], XB, { cod: true, prefer: 'Blue Dart Surface', extra: 25 }), null);
  assert.equal(preferPick([XB, BA, { ...BD, eddDate: day(9) }], XB, { cod: true, prefer: 'Blue Dart Surface', extra: 25, toleranceDays: 4 }), null);
  assert.equal(preferPick([XB, DL], XB, { cod: true, prefer: 'Blue Dart Surface' }), null);
  assert.equal(preferPick([XB, BD], XB, { cod: false, prefer: 'Blue Dart Surface' }), null);
  assert.equal(preferPick([XB, BD], XB, { cod: true, prefer: '' }), null);
  assert.equal(preferPick([XB, BD], BD, { cod: true, prefer: 'Blue Dart Surface' }), null);
});
