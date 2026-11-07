import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDashToken, dashCfg, ndrOrders, autoReattempt } from './sp-ndr.js';

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE5NTA1NjkzNTB9.abc_DEF-123';
test('sp-ndr: token from bare / Bearer / session JSON; junk refused', () => {
  assert.equal(parseDashToken(jwt), jwt);
  assert.equal(parseDashToken('Bearer ' + jwt), jwt);
  assert.equal(parseDashToken(JSON.stringify({ user: {}, token: jwt, expires: 'x' })), jwt);
  assert.equal(parseDashToken('hello'), '');
  assert.equal(dashCfg({ SETTINGS: { shipping: { sp_dash_token: jwt } } }).shop, '84439761131');
});

test('sp-ndr: list body matches the dashboard, re-open only pending + not cancelled + not customer-return, once per attempt', async () => {
  const calls = [];
  const orders = [
    { order_id: 1, direct_shipper_order_id: '1855', awb_number: 'A1', order_status: 'UNDELIVERED', is_action_taken: false, reattempt_count: 1, ndr_reason: 'Door step delivery not attempted', tpl_vendor: 'XPRESSBEES' },
    { order_id: 2, direct_shipper_order_id: '1719', awb_number: 'A2', order_status: 'UNDELIVERED', is_action_taken: true, reattempt_count: 1 },
    { order_id: 3, direct_shipper_order_id: '1900', awb_number: 'A3', order_status: 'UNDELIVERED', is_action_taken: false, reattempt_count: 2 },
    { order_id: 4, direct_shipper_order_id: '1901', awb_number: 'A4', order_status: 'UNDELIVERED', is_action_taken: false, reattempt_count: 1 },
  ];
  const old = globalThis.fetch;
  globalThis.fetch = async (u, init) => { calls.push([u, init.method, JSON.parse(init.body || '{}'), init.headers]); return { ok: true, status: 200, text: async () => JSON.stringify(/\/orders\?/.test(u) ? { orders, total_count: 4 } : { message: 'ok' }) }; };
  const once = new Map();
  const DB = { prepare: (sql) => ({ bind: (...a) => ({
    first: async () => { if (/^INSERT INTO msg_once/.test(sql)) { if (once.has(a[0])) return null; once.set(a[0], 1); return { k: a[0] }; } if (/^SELECT at FROM msg_once/.test(sql)) return once.has(a[0]) ? { at: 1 } : null; return null; },
    all: async () => ({ results: [{ awb: 'A3', order_name: '#1900', order_status: 'cancelled' }, { awb: 'A4', order_name: '#1901', ndr_choice: 'return', ndr_by: 'customer' }] }),
    run: async () => ({}),
  }) }) };
  const env = { DB, SETTINGS: { shipping: { sp_dash_token: jwt } } };
  try {
    const rows = await ndrOrders(env);
    assert.equal(rows[0].order, '#1855');
    assert.deepEqual(calls[0][2].filters.status, ['UNDELIVERED', 'OUT_FOR_DELIVERY']);
    assert.equal(calls[0][3].Authorization, 'Bearer ' + jwt);
    assert.equal(calls[0][3]['X-Source'], 'shipprime');
    await ndrOrders(env, { type: 'RTO' });
    assert.deepEqual(calls[1][2].filters.status, ['RTO']);
    assert.equal(calls[1][2].filters.type, undefined);
    calls.length = 0;
    const r = await autoReattempt(env, { force: true });
    assert.equal(r.open, 3);
    assert.deepEqual(r.reopened.map((x) => x.split(' ')[0]), ['#1855']);
    assert.equal(r.skipped.length, 2);
    const re = calls.filter((c) => /reattempt$/.test(c[0]));
    assert.equal(re.length, 1);
    assert.deepEqual(re[0][2], { order_id: 1, shop_id: 84439761131 });
    const again = await autoReattempt(env, { force: true });
    assert.equal(again.reopened.length, 0);
  } finally { globalThis.fetch = old; }
});

test('isOpenNdr: Delhivery failures stay OUT_FOR_DELIVERY in ShipPrime but carry a reason', async () => {
  const { isOpenNdr } = await import('./sp-ndr.js');
  assert.equal(isOpenNdr({ status: 'UNDELIVERED', reason: 'Customer not available', action_taken: false }), true);
  assert.equal(isOpenNdr({ status: 'OUT_FOR_DELIVERY', reason: 'Consignee Unavailable', action_taken: false }), true);
  assert.equal(isOpenNdr({ status: 'OUT_FOR_DELIVERY', reason: '', action_taken: false }), false);
  assert.equal(isOpenNdr({ status: 'OUT_FOR_DELIVERY', reason: 'Consignee Unavailable', action_taken: true }), false);
});
