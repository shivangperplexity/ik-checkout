import test from 'node:test';
import assert from 'node:assert/strict';
import { addressCheck, decide, codDue, pinRisk, cfg, quoteFlag } from './partial-cod.js';
import { diagnose } from './ship-audit.js';

const env = (partial, db) => ({ SETTINGS: { partial }, DB: db });

test('vague addresses: landmark / lane only', () => {
  for (const a of ['Mandir ke paas gali no 5', 'Gali number 3, Shiv mandir ke samne', '5 no gali, hanuman mandir ke pass', 'Sector 15, Noida', 'Behind SBI bank, Station road', 'near bus stand']) {
    assert.equal(addressCheck(a).vague, true, a);
  }
  assert.equal(addressCheck('Sai Heights, Baner Road').why, 'flat_missing');
  assert.equal(addressCheck('Plot no, near water tank').why, 'no_number');
  assert.equal(addressCheck('abc').why, 'too_short');
});

test('identified addresses: door number, business or named house', () => {
  for (const a of ['H.No 23, gali no 5, near mandir', 'Flat 402, Sai Heights, Baner', 'B-12 Sector 15 Noida', '123/4 MG Road, Pune', '#45, 3rd main, Indiranagar',
    'ABC Mobile Shop, main market', 'Raj Kirana Store, Gandhi chowk', 'Shanti Niwas, Shivaji Nagar', 'A/402 Rutu Apartment, Thane west', 'Shop number 4 near mandir']) {
    assert.equal(addressCheck(a).vague, false, a);
  }
  /* the landmark's own number never counts as the door's */
  assert.equal(addressCheck('Near gate no 2, opp petrol pump 4').vague, true);
});

test('modes: off, all, test numbers, risky', async () => {
  const b = { phone: '9876543210', pincode: '411001', address1: 'Mandir ke paas gali no 5' };
  assert.equal((await decide(env({ mode: 'off' }), b, 49900)).partial, false);
  const all = await decide(env({ mode: 'all', advance: 99 }), { ...b, address1: 'Flat 1, X Heights' }, 49900);
  assert.deepEqual([all.partial, all.advance, all.balance], [true, 9900, 40000]);
  assert.equal((await decide(env({ mode: 'test', test_phones: '9999999999' }), b, 49900)).partial, false);
  assert.equal((await decide(env({ mode: 'test', test_phones: '+91 98765 43210' }), b, 49900)).partial, true);
  const r = await decide(env({ mode: 'risky' }), b, 49900);
  assert.equal(r.partial, true); assert.match(r.reasons[0], /^vague_address/); assert.ok(r.hint);
  assert.equal((await decide(env({ mode: 'risky' }), { ...b, address1: 'H.No 23 gali 5' }, 49900)).partial, false);
  assert.equal((await decide(env({ mode: 'risky', vague_address: false }), b, 49900)).partial, false);
  /* never ask for an advance bigger than the order */
  assert.equal((await decide(env({ mode: 'all', advance: 99 }), b, 9900)).partial, false);
  assert.equal((await decide(env({ mode: 'risky', high_value: 1000 }), { ...b, address1: 'Flat 12, Sai Heights' }, 120000)).reasons[0], 'high_value');
});

test('PIN rules: listed prefixes and own return rate', async () => {
  const c = cfg(env({ pins: '845, 303007', rto_rate: 40, rto_min: 2 }));
  assert.equal(pinRisk(c, '845401', {}), 'listed');
  assert.equal(pinRisk(c, '303007', {}), 'listed');
  assert.equal(pinRisk(c, '411001', { 411001: { rto: 3, delivered: 3 } }), 'rto 3/6');
  assert.equal(pinRisk(c, '411001', { 411001: { rto: 1, delivered: 0 } }), '');   // too few returns
  assert.equal(pinRisk(c, '411001', { 411001: { rto: 2, delivered: 8 } }), '');   // 20% < 40%
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ pin: '560001', rto: 4, delivered: 2 }] }), first: async () => ({ rto: 0, cancelled: 0 }) }) }) };
  const r = await decide(env({ mode: 'risky', vague_address: false }, db), { phone: '9876543210', pincode: '560001' }, 49900);
  assert.equal(r.partial, true); assert.match(r.reasons[0], /^rto_pin/); assert.equal(r.hint, '');
});

test('what the courier collects', () => {
  assert.equal(codDue({ method: 'cod', status: 'placed', total_paise: 49900 }), 49900);
  assert.equal(codDue({ method: 'cod', status: 'placed', total_paise: 49900, advance_paise: 9900 }), 40000);
  assert.equal(codDue({ method: 'cod', status: 'paid', total_paise: 49900, converted_at: 1 }), 0);   // paid online later
  assert.equal(codDue({ method: 'prepaid', status: 'paid', total_paise: 44900 }), 0);
  assert.deepEqual(quoteFlag(env({ mode: 'risky', advance: 149 })), { mode: 'check', advance: 14900 });
});

test('reconciliation: wrong COD amount on the booking, refund after cancel', () => {
  const shop = { cancelled: false, tags: [], fulfilments: [{ id: 'f', numbers: ['A1'] }], awbs: ['A1'], status: 'FULFILLED' };
  const o = { order_id: '1', status: 'placed', method: 'cod', total_paise: 49900, advance_paise: 9900, created_at: 1 };
  const ship = { awb: 'A1', status: 'booked', stage: 'pickup_pending', sr_total_paise: 49900 };
  assert.ok(diagnose(o, ship, shop).some((x) => x.kind === 'cod_amount_mismatch'));
  assert.ok(!diagnose(o, { ...ship, sr_total_paise: 40000 }, shop).some((x) => x.kind === 'cod_amount_mismatch'));
  assert.ok(!diagnose(o, { ...ship, stage: 'transit' }, shop).some((x) => x.kind === 'cod_amount_mismatch'));   // too late to rebook
  const cancelled = diagnose({ ...o, status: 'cancelled' }, null, { ...shop, cancelled: true, fulfilments: [], awbs: [] });
  assert.ok(cancelled.some((x) => x.kind === 'partial_refund_due'));
  assert.ok(diagnose(o, ship, { ...shop, tags: ['partial-cod', 'needs-payment-entry'] }).some((x) => x.kind === 'partial_payment_missing'));
});
