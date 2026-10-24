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
test('no automatic return before 3 attempts', () => {
  const cfg = ndrCfg({ SETTINGS: { ndr: { v: 2, max_attempts: 2, rules: { refused: { first: 'return' } } } } });
  const t = 2000000000;
  const nd = (attempts, reason) => ({ awb: '1', reason, attempts, date: '' });
  assert.equal(planNdr(cfg, nd(1, 'Customer refused'), { first_seen: t }, {}, false, t).act, 'reattempt');
  assert.equal(planNdr(cfg, nd(2, 'Consignee Uncontactable'), { first_seen: t - 99999 }, {}, false, t).act, 'reattempt');
  assert.equal(planNdr(cfg, nd(3, 'Consignee Uncontactable'), { first_seen: t }, {}, false, t).act, 'return');
  const c2 = ndrCfg({ SETTINGS: { ndr: { v: 2, max_attempts: 5 } } });
  assert.equal(planNdr(c2, nd(2, 'Customer refused'), { first_seen: t - 99999 }, {}, false, t).act, 'reattempt');
  assert.equal(planNdr(c2, nd(3, 'Customer refused'), { first_seen: t - 99999 }, {}, false, t).act, 'return');
  /* customer said return on WhatsApp after the NDR: their choice stands */
  assert.equal(planNdr(c2, nd(1, 'Customer refused'), { first_seen: t - 100 }, { ndr_choice: 'return', ndr_choice_at: t }, false, t).act, 'none');
});
