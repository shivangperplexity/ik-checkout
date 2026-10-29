import test from 'node:test';
import assert from 'node:assert/strict';
import { combine } from './edd.js';
import { arrivalDate } from './shipprime.js';

const thu = Date.UTC(2026, 9, 29, 6);   /* Thu 29 Oct 2026, 11:30 IST */
test('date: pickup next working day + ShipPrime max days, Sundays skipped', () => {
  const r = combine({ options: [{ charge: 60 }], pick: null }, { rates: [], edd: { min: 2, max: 4 } }, { from: thu, arrivalDate });
  assert.equal(r.serviceable, true);
  assert.equal(r.date, '2026-11-04');     /* pickup Fri 30, +4 working days: Sat 31, Mon 2, Tue 3, Wed 4 */
  assert.equal(r.via, 'shipprime');
});
test('no ShipPrime EDD: Shiprocket date + 1 pickup day', () => {
  const r = combine({ options: [{ charge: 60 }], pick: { eddDate: new Date(Date.UTC(2026, 10, 2, 6)) } }, null, { from: thu, arrivalDate });
  assert.equal(r.date, '2026-11-03');
});
test('serviceability: either carrier yes = yes; Shiprocket no + ShipPrime unknown = no; a failed carrier never blocks', () => {
  const none = { options: [], pick: null };
  assert.equal(combine(none, { rates: [{ code: 'X', serviceable: true }], edd: null }, { arrivalDate }).serviceable, true);
  assert.equal(combine(none, { rates: [{ code: 'X', serviceable: null }], edd: null }, { arrivalDate }).serviceable, false);
  assert.equal(combine(none, null, { arrivalDate }).serviceable, false);
  assert.equal(combine(none, null, { arrivalDate, spFailed: true }).serviceable, null);
  assert.equal(combine(null, { rates: [{ code: 'X', serviceable: null }], edd: { max: 3 } }, { arrivalDate }).serviceable, null);
  assert.equal(combine(none, { rates: [], edd: null }, { arrivalDate }).edd, '');
});
