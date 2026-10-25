import test from 'node:test';
import assert from 'node:assert/strict';
import { nudgeBlock, nudgeTrigger, nudgeOrders, lastMsgAt, GAP } from './cod-nudge.js';

const T = 1_800_000_000, H = 3600;
const base = { order_id: '1', order_name: '#1900', method: 'cod', status: 'placed', phone: '9876543210', first_name: 'Riya Shah', total_paise: 39900, created_at: T - 5 * H };

test('who can be nudged', () => {
  assert.equal(nudgeBlock(base, T), '');
  assert.equal(nudgeBlock({ ...base, confirmed_at: T - H }, T), 'Already confirmed');
  assert.equal(nudgeBlock({ ...base, status: 'cancelled' }, T), 'Cancelled');
  assert.equal(nudgeBlock({ ...base, converted_at: T }, T), 'Already paid online');
  assert.equal(nudgeBlock({ ...base, advance_paise: 9900 }, T), 'Already paid online');
  assert.equal(nudgeBlock(base, T, true), 'Already shipped');
  assert.equal(nudgeBlock({ ...base, method: 'prepaid' }, T), 'Not a COD order');
  /* 2 hours between any two messages about the order */
  assert.match(nudgeBlock({ ...base, created_at: T - 30 * 60 }, T), /Messaged 30 min ago/);
  assert.match(nudgeBlock({ ...base, warned_at: T - H }, T), /can nudge again in 1 h/);
  assert.equal(nudgeBlock({ ...base, warned_at: -(T - 10 * 60) }, T), '');  /* failed warning does not count */
  assert.match(nudgeBlock({ ...base, nudged_at: T - 10 * 60 }, T), /Messaged 10 min ago/);
  assert.equal(nudgeBlock({ ...base, nudged_at: T - GAP }, T), '');
  assert.equal(lastMsgAt({ ...base, reminded_at: T - H }), T - H);
});

test('deadline message only inside the auto-cancel window', () => {
  const env = { COD_AUTOCANCEL_HOURS: '48', COD_AUTOCANCEL_SINCE: String(T - 100 * H) };
  assert.equal(nudgeTrigger(base, env, T), 'cod_cancel_warning');
  assert.equal(nudgeTrigger({ ...base, created_at: T - 120 * H }, env, T), 'cod_confirm');   /* before auto-cancel was on */
  assert.equal(nudgeTrigger(base, {}, T), 'cod_confirm');                                     /* auto-cancel off */
});

function fakeDb(rows, booked = {}) {
  const upd = [];
  return {
    upd,
    prepare(sql) {
      return { bind: (...a) => ({
        first: async () => (/FROM shipments/.test(sql) ? (booked[a[0]] ? { x: 1 } : null) : rows[a[0]] || null),
        run: async () => { upd.push({ sql, a }); return {}; },
      }) };
    },
  };
}

test('nudgeOrders sends, records, skips and falls back to the first confirmation', async () => {
  const now = Math.floor(Date.now() / 1000);
  const rows = {
    1: { ...base, created_at: now - 5 * H },
    2: { ...base, order_id: '2', order_name: '#1901', confirmed_at: now },
    3: { ...base, order_id: '3', order_name: '#1902', created_at: now - 6 * H },
    4: { ...base, order_id: '4', order_name: '#1903', created_at: now - 6 * H },
  };
  const db = fakeDb(rows, { 4: true });
  const sent = [];
  const fire = async (env, key, args) => { sent.push([key, args.orderId, args.vars.name, args.force]); return key === 'cod_cancel_warning' && args.orderId === '3' ? { ok: false, error: 'template not approved' } : { ok: true }; };
  const env = { DB: db, COD_AUTOCANCEL_HOURS: '48', COD_AUTOCANCEL_SINCE: String(now - 100 * H) };
  const r = await nudgeOrders(env, ['1', '2', '3', '4', '1'], { fire });
  assert.deepEqual(r.map((x) => [x.id, x.ok]), [['1', true], ['2', false], ['3', true], ['4', false]]);
  assert.equal(r[1].note, 'Already confirmed'); assert.equal(r[3].note, 'Already shipped');
  assert.deepEqual(sent, [['cod_cancel_warning', '1', 'Riya', true], ['cod_cancel_warning', '3', 'Riya', true], ['cod_confirm', '3', 'Riya', true]]);
  assert.equal(r[2].message, 'confirmation message');
  assert.equal(db.upd.filter((u) => /nudge_count/.test(u.sql)).length, 2);
});
