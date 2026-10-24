import test from 'node:test';
import assert from 'node:assert/strict';
import { validNdrDates, nextNdrDate } from './shiprocket.js';
import { planNdr, ndrCfg } from './ndr-rules.js';

test('valid dates are read from Shiprocket\'s rejection', () => {
  assert.deepEqual(validNdrDates('Please choose a valid date; Valid dates are 26 Oct,27 Oct,28 Oct', '2026-10-25'), ['2026-10-26', '2026-10-27', '2026-10-28']);
  assert.deepEqual(validNdrDates('Valid dates are 31 Dec, 1 Jan', '2026-12-30'), ['2026-12-31', '2027-01-01']);
  assert.deepEqual(validNdrDates('Data Updated Sucessfully'), []);
});
test('next delivery day skips Sunday', () => {
  assert.equal(nextNdrDate('2026-10-24'), '2026-10-26');   // Sat -> Mon
  assert.equal(nextNdrDate('2026-10-26'), '2026-10-27');
});
test('no return by us; 3 attempts', () => {
  const cfg = ndrCfg({ SETTINGS: { ndr: { v: 3, rules: { refused: { first: 'return' } } } } });
  const t = 2000000000;
  const nd = (attempts, reason) => ({ awb: '1', reason, attempts, date: '' });
  assert.equal(planNdr(cfg, nd(1, 'Customer refused'), { first_seen: t }, {}, false, t).act, 'reattempt');
  assert.equal(planNdr(cfg, nd(2, 'Consignee Uncontactable'), { first_seen: t }, {}, false, t).act, 'reattempt');
  assert.equal(planNdr(cfg, nd(3, 'Consignee Uncontactable'), { first_seen: t }, {}, false, t).act, 'none');
});

test('door failures read as NDR, not cancelled; manifest address scans stay pre-pickup', async () => {
  const { stageOf } = await import('./sr-scan.js');
  assert.equal(stageOf('Customer Refused To Accept', true), 'ndr');
  assert.equal(stageOf('Pending - Code verified cancellation', true), 'ndr');
  assert.equal(stageOf('Consignee Uncontactable', true), 'ndr');
  assert.equal(stageOf('Return To Origin', true), 'rto');
  assert.notEqual(stageOf('Manifested - Bad/Incomplete Address', true), 'ndr');
  assert.equal(stageOf('Pickup cancelled by seller', false), 'pickup_failed');
});

test('COD courier pick weighs each courier\'s RTO record', async () => {
  const { pickByRisk, courierFamily } = await import('./rates.js');
  assert.equal(courierFamily('Xpressbees Surface 1kg'), 'xpressbees'); assert.equal(courierFamily('Blue Dart Air'), 'bluedart'); assert.equal(courierFamily('Delhivery Surface'), 'delhivery');
  const d = new Date(Date.now() + 3 * 86400000);
  const opts = [{ id: 'x', courier: 'Xpressbees Surface', charge: 92, eddDate: d }, { id: 'd', courier: 'Delhivery Surface', charge: 100, eddDate: d }, { id: 'b', courier: 'Blue Dart Air', charge: 140, eddDate: d }];
  const stats = { xpressbees: { delivered: 16, rto: 25 }, delhivery: { delivered: 10, rto: 6 }, bluedart: { delivered: 8, rto: 0 } };
  const r = pickByRisk(opts, stats, { loss: 150 });
  assert.notEqual(r.pick.id, 'x'); assert.match(r.note, /instead of Xpressbees/);
  /* no history yet: leave the normal pick alone */
  assert.equal(pickByRisk(opts, { delhivery: { delivered: 2, rto: 1 } }), null);
});
