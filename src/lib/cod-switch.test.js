import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from './app.js';
import { codOn } from './settings.js';

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
const post = (path, body) => new Request('https://ik-checkout.vercel.app' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://www.inkkulture.in' }, body: JSON.stringify(body) });

test('COD is on unless switched off', () => {
  assert.equal(codOn({ SETTINGS: {} }), true);
  assert.equal(codOn({ SETTINGS: { checkout: { cod: true } } }), true);
  assert.equal(codOn({ SETTINGS: { checkout: { cod: false } } }), false);
});

test('COD off: COD and partial COD orders are refused before anything is created', async () => {
  for (const method of ['cod', 'partial']) {
    const r = await (await handle(post('/api/order', { idem: 'x' + method, method, lines: [] }), fakeEnv({ cod: false }))).json();
    assert.equal(r.ok, false); assert.equal(r.cod_off, true); assert.match(r.error, /not available/);
  }
});

test('COD off: no WhatsApp code is sent, cod-check says full prepaid', async () => {
  const o = await (await handle(post('/api/otp/send', { phone: '9876543210' }), fakeEnv({ cod: false }))).json();
  assert.equal(o.cod_off, true);
  const c = await (await handle(post('/api/cod-check', { phone: '9876543210', pincode: '411001', address1: 'Flat 2', total: 39900 }), fakeEnv({ cod: false }))).json();
  assert.equal(c.partial, false); assert.equal(c.cod_off, true);
});

test('COD off: a prepaid order is never refused by the switch', async () => {
  const r = await (await handle(post('/api/order', { idem: 'p1', method: 'prepaid', lines: [] }), fakeEnv({ cod: false }))).json();
  assert.notEqual(r.cod_off, true);
});
