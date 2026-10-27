import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCode, normCode, applyTo, quoteRef, friendOffer, referralTemplates, REF_OFF, MIN_TOTAL } from './referral.js';

/* a stand-in for the few statements friendOffer / quoteRef run */
const db = (codes = {}, ordered = new Set()) => ({
  prepare(sql) {
    return { bind: (...a) => ({
      first: async () => {
        if (/FROM ref_codes WHERE code=/.test(sql)) return codes[a[0]] || null;
        if (/FROM orders WHERE phone=/.test(sql)) return ordered.has(a[0]) ? { x: 1 } : null;
        return null;
      },
    }) };
  },
});

test('codes: from the first name, cleaned, upper case', () => {
  assert.match(makeCode('Riya Sharma', 123456), /^RIYASH\d{3}$/);
  assert.match(makeCode('', 5), /^INK\d{3}$/);
  assert.equal(normCode(' riya-123 '), 'RIYA123');
});

test('discount and credit never take an order below ₹1, credit after the referral', () => {
  assert.deepEqual(applyTo(39900, { ref: 10000, credit: 10000 }), { ref: 10000, credit: 10000, total: 19900 });
  assert.deepEqual(applyTo(15000, { ref: 10000, credit: 10000 }), { ref: 10000, credit: 15000 - MIN_TOTAL - 10000, total: MIN_TOTAL });
  assert.deepEqual(applyTo(5000, { ref: 10000 }), { ref: 5000 - MIN_TOTAL, credit: 0, total: MIN_TOTAL });
});

test('friend offer: valid code, first order only, not your own code', async () => {
  const env = { DB: db({ RIYA123: { code: 'RIYA123', phone: '9876543210', name: 'Riya Sharma' } }, new Set(['9123456789'])) };
  assert.equal((await friendOffer(env, 'riya123')).ok, true);
  assert.equal((await friendOffer(env, 'RIYA123', '9000000001')).amount, REF_OFF);
  assert.match((await friendOffer(env, 'RIYA123', '9876543210')).why, /own referral code/);
  assert.match((await friendOffer(env, 'RIYA123', '9123456789')).why, /first orders only/);
  assert.match((await friendOffer(env, 'NOPE1')).why, /not valid/);
});

test('quote: ₹100 off the online-payment price only, COD unchanged', async () => {
  const env = { DB: db({ RIYA123: { code: 'RIYA123', phone: '9876543210', name: 'Riya' } }) };
  const q = { cod: { total: 39900 }, prepaid: { total: 35900, prepaid: 4000 } };
  const r = await quoteRef(env, q, { ref: 'RIYA123' });
  assert.equal(r.prepaid.total, 25900); assert.equal(r.prepaid.ref, 10000); assert.equal(r.cod.total, 39900);
  assert.deepEqual(r.ref, { code: 'RIYA123', name: 'Riya', amount: 10000 });
  assert.equal(await quoteRef(env, q, { ref: 'BAD' }), q);
  assert.equal(await quoteRef(env, q, {}), q);
});

test('templates: invite has the code and link, credit message says how much and till when', () => {
  const [inv, cr] = referralTemplates();
  assert.match(inv.components[0].text, /\{\{2\}\}[\s\S]*\{\{3\}\}/);
  assert.equal(inv.category, 'MARKETING');
  assert.match(cr.components[0].text, /₹\{\{2\}\}[\s\S]*\{\{3\}\}/);
});

test('templates v2: credit as soon as the friend orders', () => {
  const [inv, cr] = referralTemplates();
  assert.equal(inv.name, 'ik_refer_v2'); assert.equal(cr.name, 'ik_ref_credit_v2');
  assert.match(inv.components[0].text, /as soon as they order/);
  assert.match(cr.components[0].text, /just ordered/);
  assert.doesNotMatch(cr.components[0].text, /\{\{\d\}\}\.?'?$/);
});
