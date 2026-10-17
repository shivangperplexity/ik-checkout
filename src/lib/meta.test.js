import test from 'node:test';
import assert from 'node:assert/strict';
import { sendPurchase, metaCfg, resendDue, resendPurchases, capiStats, fbcOf } from './meta.js';

const NOW = Math.floor(Date.now() / 1000);
const fakeDb = (rows, log = []) => ({
  prepare(sql) {
    let args = [];
    const st = {
      bind(...a) { args = a; return st; },
      async all() { return { results: rows.filter((r) => Number(r.created_at) > args[0]) }; },
      async run() { log.push({ sql, args }); if (/UPDATE orders SET capi_at/.test(sql)) { const r = rows.find((x) => x.event_id === args[5]); if (r) Object.assign(r, { capi_at: args[0], capi_ok: args[1], capi_pixel: args[2], capi_test: args[3], capi_error: args[4] }); } return {}; },
      async first() { return null; },
    };
    return st;
  },
});

function mockFetch(reply) {
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null }); const r = typeof reply === 'function' ? reply(url) : reply; return new Response(JSON.stringify(r.body), { status: r.status || 200 }); };
  return calls;
}

const order = (o) => ({ event_id: 'ik_' + o.n, order_name: '#' + o.n, status: 'placed', created_at: NOW - 3600, total_paise: 49900, phone: '9876543210', contents_json: '[{"id":"1","quantity":1}]', ...o });

test('the env test code is ignored; the dashboard one and pixel override are used', async () => {
  const env = { META_PIXEL_ID: '111', META_CAPI_TOKEN: 't', META_TEST_EVENT_CODE: 'TEST123' };
  let calls = mockFetch({ body: { events_received: 1, fbtrace_id: 'x' } });
  let r = await sendPurchase(env, { eventId: 'e1', valuePaise: 49900, phone: '9876543210', ua: 'Mozilla' });
  assert.equal(r.ok, true);
  assert.equal(calls[0].body.test_event_code, undefined);
  assert.match(calls[0].url, /\/111\/events/);
  assert.equal(calls[0].body.data[0].action_source, 'website');
  calls = mockFetch({ body: { events_received: 1 } });
  r = await sendPurchase({ ...env, SETTINGS: { meta: { pixel_id: '222', test_code: 'T9' } } }, { eventId: 'e1', valuePaise: 100 });
  assert.match(calls[0].url, /\/222\/events/);
  assert.equal(calls[0].body.test_event_code, 'T9');
  assert.equal(calls[0].body.data[0].action_source, 'other');
  assert.equal(r.test, true);
});

test('a Meta rejection comes back as ok:false with the message', async () => {
  mockFetch({ status: 400, body: { error: { message: 'Invalid OAuth access token', fbtrace_id: 'ab' } } });
  const r = await sendPurchase({ META_PIXEL_ID: '111', META_CAPI_TOKEN: 't' }, { eventId: 'e', valuePaise: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Invalid OAuth access token');
  assert.equal(r.fbtrace, 'ab');
  assert.equal((await sendPurchase({ META_CAPI_TOKEN: 't' }, { eventId: 'e' })).skipped, true);
});

test('resend: never twice to the same pixel; failed and moved ones go again', async () => {
  const rows = [
    order({ n: 1 }), /* before tracking: assumed sent to META_PIXEL_ID */
    order({ n: 2, capi_at: NOW, capi_ok: true, capi_pixel: '111' }),
    order({ n: 3, capi_at: NOW, capi_ok: false, capi_pixel: '111', capi_tries: 1 }),
    order({ n: 4, capi_at: NOW, capi_ok: false, capi_pixel: '111', capi_tries: 4 }), /* gave up */
    order({ n: 5, status: 'cancelled' }),
    order({ n: 6, created_at: NOW - 8 * 86400 }), /* too old for Meta */
  ];
  const env = { META_PIXEL_ID: '111', META_CAPI_TOKEN: 't', DB: fakeDb(rows) };
  assert.deepEqual((await resendDue(env)).map((r) => r.order_name), ['#3']);
  assert.deepEqual((await resendDue(env, { anyTries: true })).map((r) => r.order_name).sort(), ['#3', '#4']);
  const moved = { ...env, SETTINGS: { meta: { pixel_id: '999' } } };
  assert.deepEqual((await resendDue(moved)).map((r) => r.order_name).sort(), ['#1', '#2', '#3', '#4']);
  const calls = mockFetch({ body: { events_received: 1 } });
  const out = await resendPurchases(moved);
  assert.equal(out.ok, 4);
  assert.ok(calls.every((c) => /\/999\/events/.test(c.url)));
  assert.ok(calls.every((c) => c.body.data[0].event_time === NOW - 3600));
  assert.equal((await resendDue(moved)).length, 0);
});

test('stats per day and the click id helper', async () => {
  const rows = [order({ n: 1, fbc: 'fb.1.1.x' }), order({ n: 2, capi_at: NOW, capi_ok: true, capi_pixel: '111' }), order({ n: 3, capi_at: NOW, capi_ok: false, capi_pixel: '111', capi_error: 'bad token' }), order({ n: 4, status: 'cancelled', capi_at: NOW, capi_ok: true, capi_pixel: '111', capi_test: true })];
  const s = await capiStats({ META_PIXEL_ID: '111', DB: fakeDb(rows) }, 14);
  const d = s.days.reduce((a, x) => { for (const k in x) if (typeof x[k] === 'number') a[k] = (a[k] || 0) + x[k]; return a; }, {});
  assert.deepEqual([d.orders, d.accepted, d.rejected, d.unknown, d.cancelled, d.test, d.fbc], [4, 2, 1, 1, 1, 1, 1]);
  assert.deepEqual(s.errors, [{ error: 'bad token', n: 1 }]);
  assert.equal(fbcOf('', 'abc', 5), 'fb.1.5.abc');
  assert.equal(metaCfg({ META_PIXEL_ID: '1', SETTINGS: { meta: { browser: false } } }).browser, false);
});
