import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNdr, planNdr, ndrCfg, nextWorkingDay, NDR_DEFAULTS } from './ndr-rules.js';

test('courier reasons sort into categories', () => {
  const cases = {
    'Customer not available': 'not_available',
    'Consignee not available at the address': 'not_available',
    'Door locked': 'not_available',
    'Premises closed': 'not_available',
    'Consignee phone switched off': 'phone',
    'Customer not responding to calls': 'phone',
    'Incomplete address': 'address',
    'Address not found, need landmark': 'address',
    'COD amount not ready': 'cash',
    'Customer requested future delivery': 'future',
    'Customer refused to accept': 'refused',
    'Code verified cancellation': 'refused',
    'Customer wants open delivery': 'refused',
    'ODA location': 'courier',
    'Entry restricted in society': 'courier',
    '70': 'other',
    '': 'other',
  };
  for (const [r, want] of Object.entries(cases)) assert.equal(classifyNdr(r), want, r);
});

const cfg = ndrCfg({ SETTINGS: { ndr: NDR_DEFAULTS } });
const T = 1_800_000_000;

test('ask first, then act after the wait; a customer / team choice wins', () => {
  const nd = { awb: 'A', reason: 'Customer not available', attempts: 1 };
  let p = planNdr(cfg, nd, { first_seen: T }, {}, false, T + 3600);
  assert.equal(p.act, 'wait'); assert.equal(p.due, T + 6 * 3600); assert.equal(p.then, 'reattempt');
  p = planNdr(cfg, nd, { first_seen: T }, {}, false, T + 6 * 3600 + 1);
  assert.equal(p.act, 'reattempt');
  assert.equal(planNdr(cfg, nd, { first_seen: T }, { ndr_choice: 'reattempt', ndr_choice_at: T + 100, ndr_by: 'customer' }, false, T + 7 * 3600).act, 'none');
  /* a choice from the previous attempt does not count */
  assert.equal(planNdr(cfg, nd, { first_seen: T }, { ndr_choice: 'reattempt', ndr_choice_at: T - 2 * 86400 }, false, T + 7 * 3600).act, 'reattempt');
  assert.equal(planNdr(cfg, nd, { first_seen: T, action: 'reattempt' }, {}, false, T + 9 * 3600).act, 'none');
});

test('courier-side reasons re-attempt at once; refused waits then comes to you', () => {
  assert.equal(planNdr(cfg, { reason: 'ODA location' }, { first_seen: T }, {}, false, T).act, 'reattempt');
  assert.equal(planNdr(cfg, { reason: 'Customer refused' }, { first_seen: T }, {}, false, T + 13 * 3600).act, 'manual');
});

test('attempt limit, prepaid never returned automatically, off does nothing', () => {
  const c2 = ndrCfg({ SETTINGS: { ndr: { ...NDR_DEFAULTS, after_max: 'return', rules: { ...NDR_DEFAULTS.rules, refused: { first: 'return', wait: 0, then: 'return' } } } } });
  assert.equal(planNdr(c2, { reason: 'Customer not available', attempts: 3 }, { first_seen: T }, {}, false, T).act, 'return');
  assert.equal(planNdr(c2, { reason: 'Customer not available', attempts: 3 }, { first_seen: T }, {}, true, T).act, 'manual');
  assert.equal(planNdr(c2, { reason: 'Customer refused' }, { first_seen: T }, {}, false, T).act, 'return');
  assert.equal(planNdr(c2, { reason: 'Customer refused' }, { first_seen: T }, {}, true, T).act, 'manual');
  assert.equal(planNdr(ndrCfg({ SETTINGS: { ndr: { mode: 'off' } } }), { reason: 'x' }, {}, {}, false, T).act, 'none');
});

test('settings are clamped; next working day skips Sunday', () => {
  const c = ndrCfg({ SETTINGS: { ndr: { max_attempts: 99, rules: { phone: { first: 'nonsense', wait: 500, then: 'x' } } } } });
  assert.equal(c.max_attempts, 5);
  assert.deepEqual(c.rules.phone, { first: 'ask', wait: 72, then: 'reattempt' });
  /* Sat 24 Oct 2026, 10:00 IST -> Mon 26 Oct */
  assert.equal(nextWorkingDay(Date.parse('2026-10-24T04:30:00Z')), '2026-10-26');
  assert.equal(nextWorkingDay(Date.parse('2026-10-22T04:30:00Z')), '2026-10-23');
});
