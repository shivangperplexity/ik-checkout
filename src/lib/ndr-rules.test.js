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

test('v3: every NDR re-attempted at once; a customer / team choice wins; handled once', () => {
  const nd = { awb: 'A', reason: 'Customer not available', attempts: 1 };
  assert.equal(planNdr(cfg, nd, { first_seen: T }, {}, false, T + 60).act, 'reattempt');
  assert.equal(planNdr(cfg, nd, { first_seen: T }, { ndr_choice: 'reattempt', ndr_choice_at: T + 100, ndr_by: 'customer' }, false, T + 7 * 3600).act, 'none');
  /* a choice from the previous attempt does not count */
  assert.equal(planNdr(cfg, nd, { first_seen: T }, { ndr_choice: 'reattempt', ndr_choice_at: T - 2 * 86400 }, false, T + 60).act, 'reattempt');
  assert.equal(planNdr(cfg, nd, { first_seen: T, action: 'reattempt' }, {}, false, T + 9 * 3600).act, 'none');
});

test('v3: courier "refused" is re-attempted; OTP refusal and the 3rd attempt are left to the courier; never returned by us', () => {
  assert.equal(planNdr(cfg, { reason: 'ODA location' }, { first_seen: T }, {}, false, T).act, 'reattempt');
  assert.equal(planNdr(cfg, { reason: 'Customer Refused To Accept', attempts: 1 }, { first_seen: T }, {}, false, T).act, 'reattempt');
  assert.equal(planNdr(cfg, { reason: 'Customer Refused To Accept', attempts: 2 }, { first_seen: T }, {}, false, T).act, 'reattempt');
  assert.equal(planNdr(cfg, { reason: 'Code verified cancellation', attempts: 1 }, { first_seen: T }, {}, false, T).act, 'none');
  assert.equal(planNdr(cfg, { reason: 'Customer Refused To Accept', attempts: 3 }, { first_seen: T }, {}, false, T).act, 'none');
  assert.equal(planNdr(cfg, { reason: 'Consignee Uncontactable', attempts: 3 }, { first_seen: T }, {}, false, T).act, 'none');
  const c2 = ndrCfg({ SETTINGS: { ndr: { ...NDR_DEFAULTS, rules: { ...NDR_DEFAULTS.rules, refused: { first: 'return', wait: 0, then: 'return' } } } } });
  assert.equal(planNdr(c2, { reason: 'Customer refused', attempts: 1 }, { first_seen: T }, {}, false, T).act, 'reattempt');
  assert.equal(planNdr(ndrCfg({ SETTINGS: { ndr: { mode: 'off' } } }), { reason: 'x' }, {}, {}, false, T).act, 'none');
});

test('rules saved before v3 move to the v3 defaults (no customer messages, autopilot off); on/off is kept', () => {
  const old = ndrCfg({ SETTINGS: { ndr: { v: 2, mode: 'on', max_attempts: 5, rules: { refused: { first: 'ask', wait: 12, then: 'return' } }, pilot: { on: true } } } });
  assert.equal(old.v, 3); assert.equal(old.message, false); assert.equal(old.pilot.on, false); assert.equal(old.rules.refused.first, 'reattempt');
  assert.equal(ndrCfg({ SETTINGS: { ndr: { v: 2, mode: 'off' } } }).mode, 'off');
  const v3 = ndrCfg({ SETTINGS: { ndr: { v: 3, message: true, pilot: { on: true } } } });
  assert.equal(v3.message, true); assert.equal(v3.pilot.on, true);
});

test('settings are clamped; next working day skips Sunday', () => {
  const c = ndrCfg({ SETTINGS: { ndr: { v: 3, max_attempts: 99, rules: { phone: { first: 'nonsense', wait: 500, then: 'x' } } } } });
  assert.equal(c.max_attempts, 5);
  assert.deepEqual(c.rules.phone, { first: 'reattempt', wait: 72, then: 'reattempt' });
  /* Sat 24 Oct 2026, 10:00 IST -> Mon 26 Oct */
  assert.equal(nextWorkingDay(Date.parse('2026-10-24T04:30:00Z')), '2026-10-26');
  assert.equal(nextWorkingDay(Date.parse('2026-10-22T04:30:00Z')), '2026-10-23');
});
