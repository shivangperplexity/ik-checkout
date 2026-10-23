import test from 'node:test';
import assert from 'node:assert/strict';
import { stopShipment, sweepCancelled } from './ship-cancel.js';
import { applyAction } from './wa-g4w.js';

/* ---- fakes: a tiny in-memory DB for the queries used here, Shiprocket and Shopify over fetch ---- */
const PENDING = { tracking_data: { shipment_track: [{ current_status: 'PICKUP SCHEDULED' }], shipment_track_activities: [] } };
const PICKED = { tracking_data: { shipment_track: [{ current_status: 'PICKED UP' }], shipment_track_activities: [{ 'sr-status': '42', activity: 'Shipment Picked Up', date: '2026-10-13 10:00:00', location: 'Navi Mumbai' }] } };

function world({ shipments = {}, orders = {}, track = {}, shop = {} } = {}) {
  const calls = [];
  const db = { prepare(sql) {
    const q = sql.replace(/\s+/g, ' ');
    return { bind: (...a) => ({
      first: async () => {
        if (/^SELECT \* FROM shipments WHERE order_id=\? AND awb/.test(q)) { const s = shipments[a[0]]; return s && s.awb && s.status !== 'cancelled' ? s : null; }
        if (/^UPDATE orders SET status='cancelled' WHERE order_id=\? AND status='placed'/.test(q)) { const o = orders[a[0]]; if (o && o.status === 'placed' && !o.confirmed_at) { o.status = 'cancelled'; return { order_id: a[0] }; } return null; }
        return null;
      },
      all: async () => {
        if (/FROM shipments s LEFT JOIN orders o/.test(q)) return { results: Object.values(shipments).filter((s) => s.awb && s.status !== 'cancelled' && !['picked', 'cancelled'].includes(s.cancel_state)).map((s) => ({ order_id: s.order_id, order_name: s.order_name, cancel_state: s.cancel_state, order_status: orders[s.order_id]?.status })) };
        return { results: [] };
      },
      run: async () => {
        if (/^UPDATE shipments SET cancel_state=\?/.test(q)) Object.assign(shipments[a[3]], { cancel_state: a[0], cancel_note: a[1] });
        else if (/^UPDATE shipments SET status='cancelled', cancel_state='cancelled'/.test(q)) Object.assign(shipments[a[2]], { status: 'cancelled', cancel_state: 'cancelled', cancel_note: a[0] });
        else if (/^UPDATE orders SET shipped_at=NULL/.test(q)) Object.assign(orders[a[0]] || {}, { shipped_at: null });
        else if (/^UPDATE orders SET status='placed'/.test(q)) orders[a[0]].status = 'placed';
        else if (/^UPDATE orders SET status='cancelled' WHERE order_id=\?$/.test(q)) orders[a[0]].status = 'cancelled';
        return {};
      },
    }) };
  } };
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u), ok = (j) => new Response(JSON.stringify(j), { status: 200 });
    if (/shiprocket/.test(url)) {
      if (/auth\/login/.test(url)) return ok({ token: 't' });
      const m = /track\/awb\/([^?]+)/.exec(url);
      if (m) { calls.push('track ' + m[1]); const t = track[m[1]]; return t === 'down' ? new Response('{}', { status: 503 }) : ok(t || PENDING); }
      if (/orders\/cancel\/shipment\/awbs/.test(url)) { calls.push('sr-cancel-awb ' + JSON.parse(o.body).awbs.join(',')); return globalThis.__srDown === 'all' ? new Response('{}', { status: 503 }) : ok({ message: 'cancelled' }); }
      if (/orders\/cancel/.test(url)) { calls.push('sr-cancel ' + JSON.parse(o.body).ids.join(',')); return globalThis.__srDown ? new Response('{"message":"503 Service Unavailable"}', { status: 503 }) : ok({ message: 'cancelled' }); }
      return ok({});
    }
    const body = JSON.parse(o?.body || '{}'), q = body.query || '', v = body.variables || {};
    if (/nodes\(ids/.test(q)) return ok({ data: { nodes: v.ids.map((g) => { const id = g.split('/').pop(); return { legacyResourceId: id, cancelledAt: shop[id]?.cancelled ? '2026-10-13T00:00:00Z' : null, tags: shop[id]?.tags || [] }; }) } });
    if (/fulfillments\(first/.test(q)) { const id = v.id.split('/').pop(); return ok({ data: { order: { cancelledAt: null, fulfillments: [{ id: 'gid://shopify/Fulfillment/' + id, status: 'SUCCESS', trackingInfo: [{ number: shipments[id]?.awb }] }] } } }); }
    if (/fulfillmentCancel/.test(q)) { calls.push('shopify-unfulfil ' + v.id.split('/').pop()); return ok({ data: { fulfillmentCancel: { fulfillment: { id: v.id, status: 'CANCELLED' }, userErrors: [] } } }); }
    if (/orderCancel/.test(q)) { calls.push('shopify-cancel ' + v.id.split('/').pop()); return ok({ data: { orderCancel: { orderCancelUserErrors: [] } } }); }
    if (/tagsAdd/.test(q)) { calls.push('tag ' + v.t.join(',')); return ok({ data: { tagsAdd: { userErrors: [] } } }); }
    if (/tagsRemove/.test(q)) return ok({ data: { tagsRemove: { userErrors: [] } } });
    return ok({ data: {} });
  };
  const env = { DB: db, SHOP_DOMAIN: 'x.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't', SETTINGS: { shipping: { shiprocket_email: 'a@b.c', shiprocket_password: 'p' } } };
  return { env, calls, shipments, orders, done: () => { globalThis.fetch = real; } };
}
const ship = (id, awb, extra = {}) => ({ order_id: id, order_name: '#' + id, awb, sr_order_id: '90' + id, sr_shipment_id: 'SH' + id, status: 'booked', ...extra });
const order = (id, extra = {}) => ({ order_id: id, order_name: '#' + id, method: 'cod', status: 'placed', confirmed_at: null, shipped_at: 1, phone: '9999999999', ...extra });

test('not picked up yet: Shiprocket shipment cancelled, Shopify fulfilment undone, order no longer "shipped"', async () => {
  const w = world({ shipments: { 1: ship('1', 'A1') }, orders: { 1: order('1') } });
  try {
    const r = await stopShipment(w.env, '1', 'Customer cancelled');
    assert.equal(r.state, 'cancelled');
    assert.deepEqual(w.calls, ['track A1', 'sr-cancel-awb A1', 'sr-cancel 901', 'shopify-unfulfil Fulfillment/1'.replace('Fulfillment/', '')]);
    assert.equal(w.shipments[1].status, 'cancelled');
    assert.equal(w.orders[1].shipped_at, null);
  } finally { w.done(); }
});

test('already picked up: nothing is cancelled, it is flagged for RTO', async () => {
  const w = world({ shipments: { 1: ship('1', 'A1') }, orders: { 1: order('1') }, track: { A1: PICKED } });
  try {
    const r = await stopShipment(w.env, '1', 'Customer cancelled');
    assert.equal(r.state, 'picked');
    assert.ok(!w.calls.some((c) => /sr-cancel|unfulfil/.test(c)));
    assert.equal(w.shipments[1].cancel_state, 'picked');
    assert.ok(w.calls.includes('tag cancelled-after-pickup'));
  } finally { w.done(); }
});

test('tracking unreachable: nothing is cancelled blind, retried later', async () => {
  const w = world({ shipments: { 1: ship('1', 'A1') }, orders: { 1: order('1') }, track: { A1: 'down' } });
  try {
    assert.equal((await stopShipment(w.env, '1')).state, 'error');
    assert.ok(!w.calls.some((c) => /sr-cancel/.test(c)));
    assert.equal(w.shipments[1].cancel_state, 'error');
  } finally { w.done(); }
});

test('customer taps Cancel on a shipped, unconfirmed COD order: pickup cancelled, then the Shopify order', async () => {
  const w = world({ shipments: { 1: ship('1', 'A1') }, orders: { 1: order('1') } });
  try {
    assert.equal(await applyAction(w.env, w.orders[1], 'CANCEL'), 'cancelled');
    const i = (s) => w.calls.findIndex((c) => c.startsWith(s));
    assert.ok(i('sr-cancel') >= 0 && i('sr-cancel') < i('shopify-unfulfil') && i('shopify-unfulfil') < i('shopify-cancel'), w.calls.join(' | '));
    assert.equal(w.orders[1].status, 'cancelled');
  } finally { w.done(); }
});

test('customer cancels after pickup: order kept, flagged, customer told the team will help', async () => {
  const w = world({ shipments: { 1: ship('1', 'A1') }, orders: { 1: order('1') }, track: { A1: PICKED } });
  try {
    await assert.rejects(applyAction(w.env, w.orders[1], 'CANCEL'), /already picked/);
    assert.equal(w.orders[1].status, 'placed');
    assert.ok(!w.calls.some((c) => /shopify-cancel|sr-cancel/.test(c)));
  } finally { w.done(); }
});

test('the "no reply" auto-cancel never cancels an order you already shipped', async () => {
  const w = world({ shipments: { 1: ship('1', 'A1') }, orders: { 1: order('1') } });
  try {
    assert.equal(await applyAction(w.env, w.orders[1], 'CANCEL', { auto: true }), 'already-shipped');
    assert.equal(w.orders[1].status, 'placed');
    assert.deepEqual(w.calls, []);
  } finally { w.done(); }
});

test('cron sweep: catches orders cancelled in Shopify or tagged by another COD app; leaves the rest', async () => {
  const w = world({
    shipments: { 1: ship('1', 'A1'), 2: ship('2', 'A2'), 3: ship('3', 'A3'), 4: ship('4', 'A4'), 5: ship('5', 'A5') },
    orders: { 1: order('1'), 2: order('2'), 3: order('3'), 4: order('4'), 5: order('5', { status: 'cancelled' }) },
    shop: { 1: { cancelled: true }, 2: { tags: ['❌ COD-Cancelled'] }, 3: { tags: ['cod-confirmed'] }, 4: { cancelled: true } },
    track: { A4: PICKED },
  });
  try {
    const r = await sweepCancelled(w.env);
    assert.deepEqual({ stopped: r.stopped, late: r.late, retry: r.retry }, { stopped: 3, late: 1, retry: 0 });
    assert.ok(w.calls.includes('sr-cancel 901') && w.calls.includes('sr-cancel 902') && w.calls.includes('sr-cancel 905'));
    assert.ok(!w.calls.includes('sr-cancel 903') && !w.calls.includes('sr-cancel 904'));
    assert.ok(w.calls.includes('shopify-cancel 2') && w.calls.includes('shopify-cancel 5'), 'not yet cancelled in Shopify -> cancelled there too');
    assert.ok(!w.calls.includes('shopify-cancel 1'), 'already cancelled in Shopify');
    assert.equal(w.shipments[4].cancel_state, 'picked');
    assert.equal(w.orders[3].status, 'placed');
    assert.equal(w.orders[2].status, 'cancelled');
    const again = await sweepCancelled(w.env);          // next run: nothing left to do, no repeat calls
    assert.equal(again.stopped + again.late, 0);
  } finally { w.done(); }
});

test('orders cancelled in Shopify or tagged cancelled by another COD app are marked cancelled here', async () => {
  const { syncCancelledOrders } = await import('./ship-cancel.js');
  const st = { 1: 'placed', 2: 'placed', 3: 'placed', 4: 'placed' }, real = globalThis.fetch;
  const env = { SHOP_DOMAIN: 'x.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't', DB: { prepare: (sql) => ({ bind: (id) => ({ run: async () => { if (/SET status='cancelled'/.test(sql)) st[id] = 'cancelled'; return {}; } }) }) } };
  const shop = { 1: { cancelled: true }, 2: { tags: ['❌ COD-Cancelled'] }, 3: { tags: ['cod-confirmed'] }, 4: { tags: ['cod-cancelled-by-customer'] } };
  globalThis.fetch = async (u, o) => { const v = JSON.parse(o.body).variables; return new Response(JSON.stringify({ data: { nodes: v.ids.map((g) => { const id = g.split('/').pop(); return { legacyResourceId: id, cancelledAt: shop[id]?.cancelled ? 'x' : null, tags: shop[id]?.tags || [] }; }) } })); };
  try {
    assert.deepEqual(await syncCancelledOrders(env, ['1', '2', '3', '4']), ['1', '2', '4']);
    assert.deepEqual(st, { 1: 'cancelled', 2: 'cancelled', 3: 'placed', 4: 'cancelled' });
  } finally { globalThis.fetch = real; }
});

test('orders Shopify shows as fulfilled (another app / by hand) are marked shipped here, with the tracking Shopify has', async () => {
  const { syncFulfilledOrders } = await import('./ship-cancel.js');
  const st = { 1: { shipped_at: null, tracking: null }, 2: { shipped_at: null, tracking: null }, 3: { shipped_at: null, tracking: null }, 4: { shipped_at: 5, tracking: 'x' } }, real = globalThis.fetch;
  const env = { SHOP_DOMAIN: 'x.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't', DB: { prepare: (sql) => ({ bind: (...a) => ({ run: async () => { if (/SET shipped_at=\?, tracking=\?/.test(sql) && st[a[2]].shipped_at == null) { st[a[2]].shipped_at = a[0]; st[a[2]].tracking = a[1]; } return {}; } }) }) } };
  const shop = { 1: [{ status: 'SUCCESS', createdAt: '2026-10-16T13:22:25Z', trackingInfo: [{ number: '153768760633697', company: 'Xpressbees Surface' }] }], 2: [{ status: 'SUCCESS', createdAt: '2026-10-16T13:22:25Z', trackingInfo: [] }], 3: [], 4: [{ status: 'SUCCESS', createdAt: '2026-10-16T13:22:25Z', trackingInfo: [] }] };
  globalThis.fetch = async (u, o) => { const v = JSON.parse(o.body).variables; return new Response(JSON.stringify({ data: { nodes: v.ids.map((g) => { const id = g.split('/').pop(); return { legacyResourceId: id, cancelledAt: null, displayFulfillmentStatus: shop[id].length ? 'FULFILLED' : 'UNFULFILLED', tags: [], fulfillments: shop[id] }; }) } })); };
  try {
    assert.deepEqual(await syncFulfilledOrders(env, ['1', '2', '3', '4']), ['1', '2', '4']);
    assert.equal(st[1].tracking, 'Xpressbees Surface 153768760633697'); assert.equal(st[1].shipped_at, Math.floor(Date.parse('2026-10-16T13:22:25Z') / 1000));
    assert.equal(st[2].tracking, 'Fulfilled in Shopify');
    assert.equal(st[3].shipped_at, null, 'unfulfilled stays to ship');
    assert.equal(st[4].tracking, 'x', 'already shipped here: untouched');
  } finally { globalThis.fetch = real; }
});

test('Shiprocket down: a dashboard cancel is queued and the cron finishes it; the AWB cancel works while the order cancel is down', async () => {
  const w = world({ shipments: { 7: ship('7', 'A7') }, orders: { 7: order('7') } });
  try {
    globalThis.__srDown = 'all';
    const r1 = await stopShipment(w.env, '7', 'test');
    assert.equal(r1.state, 'error');
    assert.equal(w.calls.filter((c) => c === 'sr-cancel-awb A7').length, 3, 'retried twice');
    w.shipments[7].cancel_state = 'queued';                     /* what cancelOne records */
    const r2 = await sweepCancelled(w.env);                     /* still down: stays queued */
    assert.equal(r2.retry, 1); assert.equal(w.shipments[7].cancel_state, 'queued');
    globalThis.__srDown = 'order';                              /* order cancel down, AWB cancel works */
    const r3 = await sweepCancelled(w.env);
    assert.equal(r3.stopped, 1); assert.ok(w.calls.includes('sr-cancel-awb A7'));
    assert.ok(w.calls.includes('shopify-cancel 7')); assert.equal(w.orders[7].status, 'cancelled');
  } finally { delete globalThis.__srDown; w.done(); }
});
