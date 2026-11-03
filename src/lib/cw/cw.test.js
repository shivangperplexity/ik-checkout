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
