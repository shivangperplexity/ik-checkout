import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from './app.js';
import { codOn, putSetting } from './settings.js';

/* Settings > Checkout > Cash on delivery off: the API refuses COD, partial COD and the COD WhatsApp code. */
function fakeEnv(checkout) {
  const DB = {
    prepare(sql) {
      const q = {
        all: async () => ({ results: /FROM settings/.test(sql) && checkout ? [{ k: 'checkout', v: JSON.stringify(checkout) }] : [] }),
        first: async () => (/INTO rl/.test(sql) ? { n: 1 } : null),
        run: async () => ({}),
      };
      return { ...q, bind: () => q };
    },
  };
  return { DB, STORE_URL: 'https://www.inkkulture.in', STORE_ORIGINS: 'https://www.inkkulture.in' };
}
/* settings are cached for 15 s per process: forget them so each request reads this env's switch */
const call = async (path, body, env) => { await putSetting(env, '_t', 1); return (await handle(post(path, body), env)).json(); };
const post = (path, body) => new Request('https://ik-checkout.vercel.app' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://www.inkkulture.in' }, body: JSON.stringify(body) });

test('COD is on unless switched off', () => {
  assert.equal(codOn({ SETTINGS: {} }), true);
  assert.equal(codOn({ SETTINGS: { checkout: { cod: true } } }), true);
  assert.equal(codOn({ SETTINGS: { checkout: { cod: false } } }), false);
});

test('COD off: COD and partial COD orders are refused before anything is created', async () => {
  for (const method of ['cod', 'partial']) {
    const r = await call('/api/order', { idem: 'x' + method, method, lines: [] }, fakeEnv({ cod: false }));
    assert.equal(r.ok, false); assert.equal(r.cod_off, true); assert.match(r.error, /not available/);
  }
});

test('COD off: no WhatsApp code is sent, cod-check says full prepaid', async () => {
  const o = await call('/api/otp/send', { phone: '9876543210' }, fakeEnv({ cod: false }));
  assert.equal(o.cod_off, true);
  const c = await call('/api/cod-check', { phone: '9876543210', pincode: '411001', address1: 'Flat 2', total: 39900 }, fakeEnv({ cod: false }));
  assert.equal(c.partial, false); assert.equal(c.cod_off, true);
});

test('COD off: a prepaid order is never refused by the switch', async () => {
  const r = await call('/api/order', { idem: 'p1', method: 'prepaid', lines: [] }, fakeEnv({ cod: false }));
  assert.notEqual(r.cod_off, true);
});

/* ---- COD only for non-ad traffic (cod_mode 'organic') ---- */
import { fbclidIsAd, cameFromAd } from './attribution.js';
/* real fbclids from Ink Kulture orders */
const AD_IG = 'PAZXh0bgNhZW0BMABwZG9mAmFkaWQBqziInphRwnNydGMGYXBwX2lkDzU2NzA2NzM0MzM1MjQyNwABp5XmI1cGgGyZOYDG5rYq0PQMX1dIb0LwuvYNgwXBhqk6lzIVlGmQ06JabJ02_aem_cy7An8HJbNcjW9tqRd-4-g';
const AD_FB = 'IwZXh0bgNhZW0BMABwZG9mBWFkaWQBqziInphRwnNydGMGYXBwX2lkDDM1MDY4NTUzMTcyOAABHsraDnR5pprvmS-uID6j6ZFImIBq85JxxqaDgnMLcH-87Vh9M0eD9TuY1k_4_aem_lyozK4m1exjU4JEY0SnOIg';
const AD_FDID = 'PAZXh0bgNhZW0BMABwZG9mAmZkaWQWUQ5srrVgI3NanVk-n4JLG-yTJUKBSGFkaWQBqziInphRwnNydGMGYXBwX2lkDzEyNDAyNDU3NDI4NzQxNAABp2ydiUcnFgLeEkHAUzKCc1o0DQiNVco68dvDUvOpGuKIXtbBSnUP8rsL45GP_aem_49vOkk2JrPJyZaUqWLKAng';
const BIO = 'PAZXh0bgNhZW0CMTEAcGRvZgJzcnRjBmFwcF9pZA81NjcwNjczNDMzNTI0MjcAAaedrAbFSDTDaGC8r28wIhrPkUqLDyFg7XUkHAl8R8jbxPrbm1XGjW0WHcfFEA_aem_4rrjy5NXhO_MGBHwqcVb_Q';
const BIO2 = 'PAZXh0bgNhZW0CMTEAcGRvZgJmZGlkFlEQ7dO8xa9T3H9SDQbkRslsT9zeCFFzcnRjBmFwcF9pZA8xMjQwMjQ1NzQyODc0MTQAAacDPIBVqRcD6QY32bVqnKEZ4XJSUnxIp6U6bxC-64pKZnhGPsy0SdFeLBT1dA_aem_tYdXmCheS8iM9GI5XxEcKQ';
const BIO3 = 'PAZXh0bgNhZW0DMTAwAHBkb2YCc3J0YwZhcHBfaWQPNTY3MDY3MzQzMzUyNDI3AAGnkxPSwjmXOEEuYMlGGML2cPob5YCx4bjAzQ1XErNGZOtPhIuHgj7lCIcNK9Y_aem_Y0WSk0d6gfMXaabsH5VK5Q';

test('fbclid: ad clicks carry an ad id, organic bio clicks do not', () => {
  for (const f of [AD_IG, AD_FB, AD_FDID]) assert.equal(fbclidIsAd(f), true, f.slice(0, 30));
  for (const f of [BIO, BIO2, BIO3, '', 'abc']) assert.equal(fbclidIsAd(f), false, f.slice(0, 30));
});

test('cameFromAd: ad links, bio, direct, and coming back after an ad', () => {
  const now = Date.now();
  const adLanding = 'https://www.inkkulture.in/products/x?utm_content=Facebook_UA&utm_source=facebook&variant=1&fbclid=' + AD_IG;
  assert.equal(cameFromAd({ utm_source: 'facebook', utm_medium: 'paid', utm_content: 'Facebook_UA', fbclid: AD_IG, landing: adLanding }), true);
  assert.equal(cameFromAd({ utm_source: 'facebook', utm_content: 'Facebook_UA', landing: adLanding.replace(/&fbclid=.*/, '') }), true, 'ad link without fbclid');
  assert.equal(cameFromAd({ utm_source: 'ig', utm_medium: 'social', utm_content: 'link_in_bio', fbclid: BIO, landing: 'https://www.inkkulture.in/?utm_source=ig&fbclid=' + BIO }), false, 'bio link');
  assert.equal(cameFromAd({ utm_source: 'ig', utm_medium: 'social', utm_content: 'link_in_bio', fbclid: AD_IG }), true, 'bio link opened from an ad');
  assert.equal(cameFromAd({ utm_source: 'whatsapp', utm_medium: 'nudge' }), false);
  assert.equal(cameFromAd({ landing: 'https://www.inkkulture.in/?srsltid=AYCX9v' }), false, 'Google search');
  assert.equal(cameFromAd({ landing: 'https://www.inkkulture.in/' }), false, 'direct');
  assert.equal(cameFromAd({ gclid: 'Cj0K' }), true, 'Google ad');
  /* direct visit, last click remembered by the browser */
  assert.equal(cameFromAd({ landing: 'https://www.inkkulture.in/', click: { utm_source: 'facebook', utm_content: 'Facebook_UA', fbclid: AD_IG, at: now - 3 * 864e5 } }), true, 'back 3 days after an ad');
  assert.equal(cameFromAd({ landing: 'https://www.inkkulture.in/', click: { utm_source: 'facebook', utm_content: 'Facebook_UA', fbclid: AD_IG, at: now - 40 * 864e5 } }), false, 'ad click too old');
  assert.equal(cameFromAd({ landing: 'https://www.inkkulture.in/', click: { utm_source: 'ig', utm_content: 'link_in_bio', fbclid: BIO, at: now - 864e5 } }), false, 'back after a bio click');
  assert.equal(cameFromAd({ landing: 'https://www.inkkulture.in/', fbc: 'fb.1.' + (now - 864e5) + '.' + AD_IG }), true, 'Meta _fbc cookie from an ad');
  /* this visit's link decides over an older click */
  assert.equal(cameFromAd({ utm_source: 'ig', utm_content: 'link_in_bio', fbclid: BIO, click: { utm_source: 'facebook', utm_content: 'Facebook_UA', at: now } }), false);
});

test('organic mode: ad shoppers cannot place COD, bio and direct shoppers can get past the switch', async () => {
  const env = () => fakeEnv({ cod: true, cod_mode: 'organic' });
  const ad = { utm_source: 'facebook', utm_medium: 'paid', utm_content: 'Facebook_UA', fbclid: AD_IG };
  for (const method of ['cod', 'partial']) {
    const r = await call('/api/order', { idem: 'o' + method, method, lines: [], attribution: ad }, env());
    assert.equal(r.cod_off, true); assert.match(r.error, /not available for this order/);
  }
  for (const attribution of [{ utm_source: 'ig', utm_content: 'link_in_bio', fbclid: BIO }, { landing: 'https://www.inkkulture.in/' }]) {
    const r = await call('/api/order', { idem: 'b' + Math.random(), method: 'cod', lines: [], attribution }, env());
    assert.notEqual(r.cod_off, true);
  }
  const o = await call('/api/otp/send', { phone: '9876543210', attribution: ad }, env());
  assert.equal(o.cod_off, true);
});

test('modes: off beats everything, all ignores the source', () => {
  const ad = { utm_source: 'facebook', utm_medium: 'paid', fbclid: AD_IG };
  assert.equal(codOn({ SETTINGS: { checkout: { cod: false, cod_mode: 'organic' } } }, {}), false);
  assert.equal(codOn({ SETTINGS: { checkout: { cod: true, cod_mode: 'all' } } }, ad), true);
  assert.equal(codOn({ SETTINGS: { checkout: { cod: true, cod_mode: 'organic' } } }, ad), false);
  assert.equal(codOn({ SETTINGS: { checkout: { cod: true, cod_mode: 'organic' } } }, undefined), true, 'older theme without attribution: decided at order time');
});
