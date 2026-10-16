import test from 'node:test';
import assert from 'node:assert/strict';
import { action } from './admin.js';

/* The label scanner: an in-memory shipments / orders / old-AWB store, no network. */
function world() {
  const orders = { 1: { order_id: '1', order_name: '#1571', status: 'placed', first_name: 'Asha', last_name: 'K' }, 2: { order_id: '2', order_name: '#1572', status: 'placed', first_name: 'Ravi', last_name: '' }, 3: { order_id: '3', order_name: '#1573', status: 'cancelled', first_name: 'Neha', last_name: '' }, 4: { order_id: '4', order_name: '#1574', status: 'placed', first_name: 'Dev', last_name: '' } };
  const ships = { 1: { order_id: '1', order_name: '#1571', awb: '111111', courier: 'Delhivery', status: 'booked', stage: 'pickup_pending' }, 2: { order_id: '2', order_name: '#1572', awb: '222222', courier: 'Xpressbees', status: 'booked', stage: 'pickup_failed' },
    3: { order_id: '3', order_name: '#1573', awb: '333333', courier: 'Delhivery', status: 'booked', stage: 'pickup_pending' }, 4: { order_id: '4', order_name: '#1574', awb: '444444', courier: 'Delhivery', status: 'booked', stage: 'transit' } };
  const old = { 100000: { awb: '100000', order_id: '1', order_name: '#1571', courier: 'Bluedart' }, 999999: { awb: '999999', order_id: '9', order_name: '#1500', courier: 'Bluedart' } };
  const join = (s) => s ? { ...s, order_status: orders[s.order_id]?.status, first_name: orders[s.order_id]?.first_name, last_name: orders[s.order_id]?.last_name, packed_at: null } : null;
  const db = { prepare(sql) { const q = sql.replace(/\s+/g, ' '); return { bind: (...a) => ({
    all: async () => {
      if (/WHERE s\.awb=\? OR s\.awb=\?/.test(q)) return { results: Object.values(ships).filter((s) => s.awb === a[0] || s.awb === a[1]).map(join) };
      if (/WHERE s\.order_name=\? OR s\.order_name=\?/.test(q)) return { results: Object.values(ships).filter((s) => s.order_name === a[0] || s.order_name === a[1]).map(join) };
      return { results: [] };
    },
    first: async () => {
      if (/FROM ship_old_awbs/.test(q)) return old[a[0]] || old[a[1]] || null;
      if (/WHERE s\.order_id=\?/.test(q)) return join(ships[a[0]]);
      if (/SELECT order_name FROM orders/.test(q)) return orders[a[0]] || null;
      return null;
    },
    run: async () => { if (/SET verified_at=\?/.test(q)) ships[a[1]].verified_at = a[0]; if (/SET verified_at=NULL/.test(q)) ships[a[0]].verified_at = null; return {}; },
  }) }; } };
  return { env: { DB: db }, ships };
}
const scan = (w, code, expect) => action('verify_scan')(w.env, { code, expect });

test('right label on a parcel waiting for pickup: ready, marked verified', async () => {
  const w = world();
  const r = await scan(w, '111111');
  assert.equal(r.state, 'ok'); assert.equal(r.order.order_name, '#1571'); assert.ok(w.ships[1].verified_at);
  assert.equal((await scan(w, 'AWB 222222 ')).state, 'ok', 'digits inside printed text still match');
  assert.equal((await scan(w, '#1571')).state, 'ok', 'the order-number barcode works too');
  assert.equal((await scan(w, '1571-R0421')).state, 'ok', 'rebook order id form');
});

test('label from another order than the one being checked: wrong', async () => {
  const w = world();
  const r = await scan(w, '222222', '1');
  assert.equal(r.state, 'wrong'); assert.equal(r.order.order_name, '#1572'); assert.equal(r.expected.order_name, '#1571'); assert.ok(!w.ships[2].verified_at);
  assert.equal((await scan(w, '111111', '1')).state, 'ok');
});

test('label of a cancelled (rebooked) booking: update label, pointing at the current AWB', async () => {
  const w = world();
  const r = await scan(w, '100000');
  assert.equal(r.state, 'cancelled'); assert.equal(r.current.awb, '111111'); assert.match(r.note, /current AWB is 111111/);
  const r2 = await scan(w, '999999');
  assert.equal(r2.state, 'cancelled'); assert.equal(r2.current, null); assert.match(r2.note, /no live booking/);
});

test('cancelled order, already picked up, unknown code', async () => {
  const w = world();
  assert.equal((await scan(w, '333333')).state, 'order_cancelled');
  assert.equal((await scan(w, '444444')).state, 'picked');
  assert.equal((await scan(w, '555555')).state, 'unknown');
  await action('verify_clear')(w.env, { id: '1' });
});
