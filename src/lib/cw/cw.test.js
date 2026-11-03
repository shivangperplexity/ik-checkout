import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySessionToken, signSessionToken, verifyWebhook, seal, unseal, shopFromUrl } from './shopify.js';
import { cleanSettings } from './app.js';
import crypto from 'node:crypto';

const cfg = { key: 'client123', secret: 'shh-secret' };
const t0 = 1800000000;
const base = { iss: 'https://demo.myshopify.com/admin', dest: 'https://demo.myshopify.com', aud: 'client123', sub: '42', exp: t0 + 60, nbf: t0 - 5, iat: t0 - 5 };

test('session token: valid one gives the shop', () => {
  const r = verifySessionToken(signSessionToken(base, cfg.secret), cfg, t0);
  assert.equal(r.shop, 'demo.myshopify.com');
});
test('session token: wrong secret, audience, expiry and shop mismatch are refused', () => {
  assert.throws(() => verifySessionToken(signSessionToken(base, 'other'), cfg, t0), /signature/);
  assert.throws(() => verifySessionToken(signSessionToken({ ...base, aud: 'x' }, cfg.secret), cfg, t0), /audience/);
  assert.throws(() => verifySessionToken(signSessionToken(base, cfg.secret), cfg, t0 + 3600), /expired/);
  assert.throws(() => verifySessionToken(signSessionToken({ ...base, iss: 'https://evil.myshopify.com/admin' }, cfg.secret), cfg, t0), /shop/);
});
test('webhook hmac', () => {
  const body = '{"a":1}'; const h = crypto.createHmac('sha256', cfg.secret).update(body).digest('base64');
  assert.equal(verifyWebhook(body, h, cfg.secret), true);
  assert.equal(verifyWebhook(body + ' ', h, cfg.secret), false);
  assert.equal(verifyWebhook(body, '', cfg.secret), false);
});
test('seal/unseal round trip and tamper check', () => {
  const box = seal('rzp_secret_value', cfg.secret);
  assert.equal(unseal(box, cfg.secret), 'rzp_secret_value');
  assert.throws(() => unseal(box, 'other'));
});
test('shopFromUrl only accepts myshopify domains', () => {
  assert.equal(shopFromUrl('Demo-1.myshopify.com'), 'demo-1.myshopify.com');
  assert.equal(shopFromUrl('https://evil.com/?x=a.myshopify.com'), null);
});
test('cleanSettings: types, bounds, secrets split, states normalised', () => {
  const { settings, secrets } = cleanSettings({ gateway: 'razorpay', razorpay_key_secret: ' abc ', cod_otp: false, prepaid_discount: '99999', partial_states: 'rj, mp ,x', junk: 1 });
  assert.deepEqual(secrets, { razorpay_key_secret: 'abc' });
  assert.equal(settings.gateway, 'razorpay');
  assert.equal(settings.cod_otp, false);
  assert.equal(settings.prepaid_discount, 5000);
  assert.equal(settings.partial_states, 'RJ,MP');
  assert.equal('junk' in settings, false);
  assert.equal(cleanSettings({ gateway: 'stripe' }).settings.gateway, 'none');
});

import { quote, charge, followUpText, stepNo } from './pricing.js';
import { orderInput, rzpSignatureOk, publicCfg } from './store.js';

const S = { gateway: 'razorpay', cod_on: true, prepaid_discount: 50, cod_fee: 29, partial_advance: 0, partial_states: '', cod_max: 0 };
const L = [{ price: 79900, quantity: 1 }, { price: 49900, quantity: 2 }];

test('quote: online discount, COD fee, COD limit', () => {
  const q = quote(L, S, { online: true });
  assert.equal(q.subtotal, 179700);
  assert.deepEqual(q.online, { total: 174700, discount: 5000 });
  assert.deepEqual(q.cod, { total: 182600, fee: 2900 });
  assert.equal(q.partial, null);
  assert.equal(quote(L, S, { online: false }).online, null, 'no gateway -> no online tile');
  assert.equal(quote(L, { ...S, cod_max: 1000 }, { online: true }).cod, null, 'over the COD limit');
  assert.equal(quote(L, { ...S, cod_on: false }, { online: true }).cod, null);
  assert.equal(quote([{ price: 3000, quantity: 1 }], S, { online: true }).online.total, 0, 'discount never goes below zero');
});
test('quote: partial COD only where asked, and only with online payment', () => {
  const P = { ...S, partial_advance: 99, partial_states: 'RJ,MP' };
  const rj = quote(L, P, { online: true, state: 'Rajasthan' });
  assert.deepEqual(rj.partial, { total: 182600, advance: 9900, rest: 172700, fee: 2900 });
  assert.equal(rj.cod, null, 'partial replaces plain COD');
  assert.ok(quote(L, P, { online: true, state: 'Delhi' }).cod, 'other states keep COD');
  assert.ok(quote(L, P, { online: true, state: '' }).cod, 'no state yet: COD');
  assert.ok(quote(L, { ...P, partial_states: '' }, { online: true, state: 'Delhi' }).partial, 'blank list = every state');
  assert.ok(quote(L, P, { online: false, state: 'Rajasthan' }).cod, 'no gateway: cannot take an advance');
});
test('charge picks the amount to take now', () => {
  const q = quote(L, { ...S, partial_advance: 99 }, { online: true, state: 'Goa' });
  assert.deepEqual(charge(q, 'online'), { now: 174700, total: 174700, discount: 5000, fee: 0 });
  assert.equal(charge(q, 'cod'), null);
  assert.equal(charge(q, 'partial').now, 9900);
});
test('order input: real prices, discount code, COD fee line, paid transaction', () => {
  const items = [{ gid: 'gid://shopify/ProductVariant/1', quantity: 2, price: 49900 }];
  const buyer = { first: 'Asha', last: 'K', phone: '9876543210', address1: '12 MG Road', address2: '', city: 'Jaipur', state: 'Rajasthan', pincode: '302001', email: '' };
  const on = orderInput({ items, buyer, method: 'online', c: { now: 94800, total: 94800, discount: 5000, fee: 0 }, payment: 'pay_1' });
  assert.equal(on.financialStatus, 'PAID');
  assert.equal(on.discountCode.itemFixedDiscountCode.amountSet.shopMoney.amount, '50.00');
  assert.equal(on.transactions[0].amountSet.shopMoney.amount, '948.00');
  assert.equal(on.shippingAddress.provinceCode, 'RJ');
  const cod = orderInput({ items, buyer, method: 'cod', c: { now: 0, total: 102700, discount: 0, fee: 2900 }, payment: null });
  assert.equal(cod.financialStatus, 'PENDING');
  assert.equal(cod.shippingLines[0].priceSet.shopMoney.amount, '29.00');
  assert.equal(cod.transactions, undefined);
  assert.equal(cod.discountCode, undefined);
});
test('razorpay signature', () => {
  const sig = crypto.createHmac('sha256', 'rk').update('order_1|pay_1').digest('hex');
  assert.equal(rzpSignatureOk('order_1', 'pay_1', sig, 'rk'), true);
  assert.equal(rzpSignatureOk('order_1', 'pay_2', sig, 'rk'), false);
  assert.equal(rzpSignatureOk('order_1', 'pay_1', '', 'rk'), false);
});
test('follow-up text and steps', () => {
  assert.equal(stepNo('order'), 7); assert.equal(stepNo('nope'), 0);
  const t = followUpText({ name: 'Priya Sharma', items: [{ t: 'Tee' }, { t: 'Cap' }, { t: 'Bag' }], store: 'Your Store', link: 'https://x.in/?cwr=1' });
  assert.match(t, /^Hi Priya! You left Tee and Cap and 1 more in your cart at Your Store\..*https:\/\/x\.in\/\?cwr=1$/);
});
test('public config never exposes secrets', () => {
  const c = publicCfg({ name: 'X', settings: { ...S, razorpay_key_id: 'rzp_live_1', cod_otp: true, wa_phone_id: '1' }, set: { razorpay_key_secret: true, wa_token: true } });
  assert.equal(c.online, true); assert.equal(c.otp, true);
  assert.ok(!JSON.stringify(c).includes('rzp_live_1'));
});

import { pickCourier, parcelOf, shipReady, shapeOrder } from './ship.js';
import { onlineReady } from './pricing.js';

test('courier pick: fewer returns for COD within the extra limit, cheapest otherwise', () => {
  const R = [{ id: 'x', courier: 'X', charge: 54, rto: 2.8, delivery: 3.9, days: 4 }, { id: 'd', courier: 'D', charge: 61, rto: 4.3, delivery: 4.4, days: 4 }, { id: 'b', courier: 'B', charge: 118, rto: 4.9, delivery: 4.8, days: 2 }];
  assert.equal(pickCourier(R, { cod: true, rule: 'rto', maxExtra: 15 }).pick.id, 'd');
  assert.match(pickCourier(R, { cod: true, rule: 'rto', maxExtra: 15 }).why, /Fewer returns.*₹7 more/);
  assert.equal(pickCourier(R, { cod: true, rule: 'rto', maxExtra: 5 }).pick.id, 'x', 'too expensive');
  assert.equal(pickCourier(R, { cod: false, rule: 'cheapest' }).pick.id, 'x');
  assert.equal(pickCourier(R, { rule: 'fastest' }).pick.id, 'b');
  assert.equal(pickCourier(R.map((r) => ({ ...r, rto: null })), { cod: true }).pick.id, 'x', 'no scores: cheapest');
  assert.equal(pickCourier([{ id: 'n', charge: 40, ok: false }], {}).pick, null);
});
test('parcel and shipping readiness', () => {
  assert.deepEqual(parcelOf({ pkg_weight_g: 300, pkg_extra_g: 50 }, [{ quantity: 3 }]), { weight_g: 400, weight_kg: 0.4, length: 20, breadth: 15, height: 5 });
  assert.equal(shipReady({ ship_provider: 'shiprocket', sr_email: 'a@b.c', sr_pickup: 'Home' }, { sr_password: true }), true);
  assert.equal(shipReady({ ship_provider: 'shiprocket', sr_email: 'a@b.c' }, { sr_password: true }), false, 'needs a pickup');
  assert.equal(shipReady({ ship_provider: 'shipprime', pickup_pin: '400001', pickup_address1: 'x', pickup_phone: '+91 98765 43210' }, { sp_token: true }), true);
  assert.equal(onlineReady({ gateway: 'payu', payu_key: 'k' }, { payu_salt: true }), true);
  assert.equal(onlineReady({ gateway: 'payu', payu_key: 'k' }, {}), false);
});
test('Shopify order -> COD amount to collect', () => {
  const o = shapeOrder({ id: 'gid://shopify/Order/55', name: '#1001', createdAt: '2026-11-03T10:00:00Z', totalPriceSet: { shopMoney: { amount: '828.00' } }, totalOutstandingSet: { shopMoney: { amount: '729.00' } },
    shippingAddress: { firstName: 'A', lastName: 'B', address1: 'x', city: 'Jaipur', province: 'Rajasthan', provinceCode: 'RJ', zip: '302 001', phone: '+919876543210' }, lineItems: { nodes: [{ title: 'Tee', quantity: 1, originalUnitPriceSet: { shopMoney: { amount: '799.00' } } }] } });
  assert.equal(o.id, '55'); assert.equal(o.cod, true); assert.equal(o.collect, 72900); assert.equal(o.address.pin, '302001'); assert.equal(o.phone, '9876543210');
});

import { peekAud, vaultOf, defaultApp } from './apps.js';
test('per-seller apps: audience read from the token, vault key from server secrets', () => {
  const tok = signSessionToken({ ...base, aud: 'abc123' }, 'x');
  assert.equal(peekAud(tok), 'abc123');
  assert.equal(peekAud('nonsense'), '');
  assert.equal(vaultOf({}), '');
  assert.equal(vaultOf({ CRON_SECRET: 'a' }).length, 64);
  assert.notEqual(vaultOf({ CRON_SECRET: 'a' }), vaultOf({ CRON_SECRET: 'b' }));
  assert.deepEqual(defaultApp({ CW_SHOPIFY_API_KEY: 'k' }), { key: 'k', secret: '' });
});
