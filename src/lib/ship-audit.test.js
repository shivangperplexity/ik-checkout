import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, audit, fix, listIssues } from './ship-audit.js';

/* ---- diagnose(): pure, one order at a time ---- */
const shop = (o = {}) => ({ name: '#1', cancelled: false, status: 'UNFULFILLED', tags: [], cancelTag: '', fulfilments: [], awbs: [], ...o });
const fulfilled = (awb, extra = {}) => shop({ status: 'FULFILLED', fulfilments: [{ id: 'gid://shopify/Fulfillment/9', numbers: [awb], company: 'Delhivery' }], awbs: [awb], ...extra });
const order = (o = {}) => ({ order_id: '1', order_name: '#1', status: 'placed', shipped_at: 1, method: 'cod', ...o });
const live = (o = {}) => ({ order_id: '1', awb: 'A1', status: 'booked', stage: 'pickup_pending', courier: 'Delhivery', ...o });
const kinds = (...a) => diagnose(...a).map((x) => x.kind);

test('everything agrees: no issues', () => {
  assert.deepEqual(kinds(order(), live(), fulfilled('A1')), []);
  assert.deepEqual(kinds(order({ status: 'cancelled', shipped_at: null }), null, shop({ cancelled: true })), []);
  assert.deepEqual(kinds(order({ shipped_at: null }), null, shop()), []);
  assert.deepEqual(kinds(order(), live({ stage: 'delivered' }), fulfilled('A1')), []);
});

test('cancelled in Shopify but still fulfilled / still booked', () => {
  assert.deepEqual(kinds(order(), live(), fulfilled('A1', { cancelled: true })), ['shop_cancelled_fulfilled', 'shop_cancelled_db_open']);
  assert.deepEqual(kinds(order(), live(), shop({ cancelled: true })), ['shop_cancelled_shipping', 'shop_cancelled_db_open']);
  assert.deepEqual(kinds(order({ status: 'cancelled' }), live(), fulfilled('A1', { cancelled: true })), ['shop_cancelled_fulfilled']);
  assert.deepEqual(kinds(order({ status: 'cancelled' }), null, fulfilled('A1', { cancelled: true })), ['shop_cancelled_fulfilled']);
  /* a COD app's tag counts as cancelled too */
  assert.deepEqual(kinds(order(), live(), shop({ tags: ['❌ COD-Cancelled'], cancelTag: '❌ COD-Cancelled' })), ['shop_cancelled_shipping', 'shop_cancelled_db_open']);
});

test('cancelled after the courier already has it: flagged, not "fixable"', () => {
  assert.deepEqual(kinds(order(), live({ stage: 'transit' }), fulfilled('A1', { cancelled: true })), ['cancelled_after_pickup']);
  assert.deepEqual(kinds(order(), live({ cancel_state: 'picked' }), fulfilled('A1', { cancelled: true })), ['cancelled_after_pickup']);
  assert.deepEqual(kinds(order(), live({ stage: 'delivered' }), fulfilled('A1', { cancelled: true })), ['cancelled_delivered']);
});

test('Shiprocket booking cancelled, Shopify still fulfilled with that AWB', () => {
  assert.deepEqual(kinds(order(), live({ status: 'cancelled' }), fulfilled('A1')), ['sr_cancelled_fulfilled']);
  /* the dashboard already unfulfilled it and reset shipped_at: clean */
  assert.deepEqual(kinds(order({ shipped_at: null }), live({ status: 'cancelled' }), shop()), []);
});

test('booked but not fulfilled; fulfilled but no booking; AWB mismatch; stale shipped flag', () => {
  assert.deepEqual(kinds(order({ shipped_at: null }), live(), shop()), ['booked_not_fulfilled']);
  assert.deepEqual(kinds(order(), null, fulfilled('ZZ9')), ['fulfilled_no_booking']);
  assert.deepEqual(kinds(order(), live({ awb: 'A2' }), fulfilled('A1')), ['awb_mismatch']);
  assert.deepEqual(kinds(order(), null, shop()), ['shipped_flag_stale']);
  assert.deepEqual(kinds(order({ status: 'cancelled' }), null, shop()), ['db_cancelled_shop_open']);
});

/* ---- audit() + fix(): with a tiny in-memory DB and a fake Shopify / Shiprocket over fetch ---- */
function world({ orders = {}, shipments = {}, shop = {} }) {
  const issues = {}, settings = {}, calls = [];
  const db = { prepare(sql) {
    const q = sql.replace(/\s+/g, ' ');
    const ops = (a) => ({
      run: async () => {
        if (/^INSERT INTO ship_issues/.test(q)) { const k = a[0] + '|' + a[1], cur = issues[k]; issues[k] = { order_id: a[0], kind: a[1], order_name: a[2], detail: a[3], first_seen: cur && !cur.resolved_at ? cur.first_seen : a[4], last_seen: a[5], resolved_at: null, dismissed_at: cur && !cur.resolved_at ? cur.dismissed_at : null }; }
        else if (/^UPDATE ship_issues SET resolved_at/.test(q)) { const k = a[1] + '|' + a[2]; if (issues[k]) issues[k].resolved_at = a[0]; }
        else if (/^UPDATE ship_issues SET dismissed_at/.test(q)) { const k = a[1] + '|' + a[2]; if (issues[k]) issues[k].dismissed_at = a[0]; }
        else if (/^INSERT INTO settings/.test(q)) settings.ship_audit_at = a[0];
        else if (/^UPDATE orders SET status='cancelled'/.test(q)) Object.assign(orders[a[0]], { status: 'cancelled' });
        else if (/^UPDATE orders SET shipped_at=NULL/.test(q)) Object.assign(orders[a[0]], { shipped_at: null });
        else if (/^UPDATE orders SET status='placed'/.test(q)) orders[a[0]].status = 'placed';
        else if (/^INSERT INTO shipments/.test(q)) shipments[a[0]] = { order_id: a[0], order_name: a[1], awb: a[2], courier: a[3], status: 'booked', provider: a[4], track_url: a[5] };
        else if (/^UPDATE shipments SET track_url/.test(q)) shipments[a[1]].track_url = a[0];
        else if (/^UPDATE orders SET shipped_at=COALESCE/.test(q)) orders[a[2]].shipped_at = orders[a[2]].shipped_at || a[0];
        else if (/^UPDATE shipments SET status='cancelled', cancel_state='cancelled'/.test(q)) Object.assign(shipments[a[2]], { status: 'cancelled' });
        else if (/^UPDATE shipments SET cancel_state=\?/.test(q)) Object.assign(shipments[a[3]], { cancel_state: a[0] });
        return {};
      },
      first: async () => {
        if (/FROM orders WHERE order_id=\?$/.test(q)) return orders[a[0]] || null;
        if (/FROM shipments WHERE order_id=\? AND awb/.test(q)) { const s = shipments[a[0]]; return s && s.awb && s.status !== 'cancelled' ? s : null; }
        if (/FROM shipments WHERE order_id=\?$/.test(q)) return shipments[a[0]] || null;
        if (/FROM settings/.test(q)) return settings.ship_audit_at ? { v: settings.ship_audit_at } : null;
        return null;
      },
      all: async () => {
        if (/FROM orders WHERE order_id IN/.test(q)) return { results: a.map((id) => orders[id]).filter(Boolean) };
        if (/FROM orders WHERE order_id IS NOT NULL/.test(q)) return { results: Object.values(orders) };
        if (/FROM shipments WHERE order_id IN/.test(q)) return { results: a.map((id) => shipments[id]).filter(Boolean) };
        if (/SELECT order_id, kind FROM ship_issues/.test(q)) return { results: Object.values(issues).filter((i) => !i.resolved_at && a.includes(i.order_id)) };
        if (/FROM ship_issues WHERE resolved_at IS NULL/.test(q)) return { results: Object.values(issues).filter((i) => !i.resolved_at) };
        return { results: [] };
      },
    });
    return { bind: (...a) => ops(a), ...ops([]) };
  } };
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u), ok = (j) => new Response(JSON.stringify(j), { status: 200 });
    if (/shiprocket/.test(url)) {
      if (/auth\/login/.test(url)) return ok({ token: 't' });
      if (/track\/awb\/ZZ/.test(url)) return ok({ tracking_data: { track_status: 0, shipment_status: 0, error: 'Invalid AWB' } });   // not a Shiprocket parcel
      if (/track\/awb/.test(url)) return ok({ tracking_data: { track_status: 1, shipment_track: [{ current_status: 'PICKUP SCHEDULED' }], shipment_track_activities: [] } });
      if (/orders\/cancel/.test(url)) { calls.push('sr-cancel'); return ok({ message: 'cancelled' }); }
      return ok({});
    }
    const body = JSON.parse(o?.body || '{}'), q = body.query || '', v = body.variables || {};
    if (/nodes\(ids/.test(q)) return ok({ data: { nodes: v.ids.map((g) => { const id = g.split('/').pop(), s = shop[id]; return s ? { legacyResourceId: id, name: '#' + id, cancelledAt: s.cancelled ? 'x' : null, displayFulfillmentStatus: s.fulfilments?.length ? 'FULFILLED' : 'UNFULFILLED', tags: s.tags || [],
      fulfillments: (s.fulfilments || []).map((f, i) => ({ id: 'gid://shopify/Fulfillment/' + id + i, status: 'SUCCESS', trackingInfo: [{ number: f, company: 'Delhivery', url: 'https://x.example/t/' + f }] })) } : null; }) } });
    if (/fulfillments\(first/.test(q)) { const id = v.id.split('/').pop(), s = shop[id]; return ok({ data: { order: { cancelledAt: null, fulfillments: (s.fulfilments || []).map((f, i) => ({ id: 'gid://shopify/Fulfillment/' + id + i, status: 'SUCCESS', trackingInfo: [{ number: f }] })) } } }); }
    if (/fulfillmentCancel/.test(q)) { const id = v.id.split('/').pop().slice(0, -1); calls.push('unfulfil ' + id); shop[id].fulfilments = []; return ok({ data: { fulfillmentCancel: { fulfillment: { id: v.id, status: 'CANCELLED' }, userErrors: [] } } }); }
    if (/fulfillmentTrackingInfoUpdate/.test(q)) { const id = v.id.split('/').pop().slice(0, -1); calls.push('retrack ' + v.t.number); shop[id].fulfilments = [v.t.number]; return ok({ data: { fulfillmentTrackingInfoUpdate: { userErrors: [] } } }); }
    if (/orderCancel/.test(q)) { const id = v.id.split('/').pop(); calls.push('shopify-cancel ' + id); shop[id].cancelled = true; return ok({ data: { orderCancel: { orderCancelUserErrors: [] } } }); }
    if (/tagsAdd/.test(q)) { calls.push('tag ' + v.t.join(',')); return ok({ data: { tagsAdd: { userErrors: [] } } }); }
    return ok({ data: {} });
  };
  const env = { DB: db, SHOP_DOMAIN: 'x.myshopify.com', SHOPIFY_ADMIN_TOKEN: 't', SETTINGS: { shipping: { shiprocket_email: 'a', shiprocket_password: 'b' } } };
  return { env, calls, issues, orders, shipments, shop, done: () => { globalThis.fetch = real; } };
}
const o = (id, x = {}) => ({ order_id: id, order_name: '#' + id, status: 'placed', shipped_at: 1, method: 'cod', created_at: 1, ...x });
const s = (id, x = {}) => ({ order_id: id, order_name: '#' + id, awb: 'A' + id, sr_order_id: '90' + id, status: 'booked', stage: 'pickup_pending', courier: 'Delhivery', ...x });

test('audit records every mismatch, resolves the ones that are gone on the next run, keeps dismissals', async () => {
  const w = world({
    orders: { 1: o('1'), 2: o('2'), 3: o('3', { shipped_at: null }), 4: o('4') },
    shipments: { 1: s('1'), 2: s('2'), 3: s('3') },
    shop: { 1: { cancelled: true, fulfilments: ['A1'] }, 2: { fulfilments: ['A2'] }, 3: {}, 4: { fulfilments: ['ZZ'] } },
  });
  try {
    const r = await audit(w.env, {});
    assert.equal(r.checked, 4);
    assert.deepEqual(r.issues.issues.map((x) => x.order_name + ':' + x.kind).sort(), ['#1:shop_cancelled_db_open', '#1:shop_cancelled_fulfilled', '#3:booked_not_fulfilled', '#4:fulfilled_no_booking']);
    const i1 = r.issues.issues.find((x) => x.kind === 'shop_cancelled_fulfilled');
    assert.match(i1.shopify, /Cancelled · Fulfilled \(A1\)/); assert.match(i1.shiprocket, /pickup pending · Delhivery A1/); assert.match(i1.here, /Shipped · COD/);
    /* owner dismisses #4, and #3 gets fulfilled by hand */
    await (await import('./ship-audit.js')).dismissIssue(w.env, '4', 'fulfilled_no_booking');
    w.shop[3].fulfilments = ['A3'];
    const r2 = await audit(w.env, {});
    const open = r2.issues.issues;
    assert.ok(!open.some((x) => x.kind === 'booked_not_fulfilled'), 'resolved');
    assert.ok(open.find((x) => x.order_id === '4').dismissed_at, 'dismissal kept while the issue persists');
  } finally { w.done(); }
});

test('fix "stop": pickup cancelled, Shopify unfulfilled, order cancelled here; then the order is clean', async () => {
  const w = world({ orders: { 1: o('1') }, shipments: { 1: s('1') }, shop: { 1: { cancelled: true, fulfilments: ['A1'] } } });
  try {
    const r = await fix(w.env, { id: '1', fix: 'stop' });
    assert.ok(w.calls.includes('sr-cancel') && w.calls.includes('unfulfil 1'), w.calls.join());
    assert.equal(w.orders[1].status, 'cancelled');
    assert.deepEqual(r.left, []);
  } finally { w.done(); }
});

test('fix "unfulfil" on a Shiprocket-cancelled booking sends the order back to To ship', async () => {
  const w = world({ orders: { 1: o('1') }, shipments: { 1: s('1', { status: 'cancelled' }) }, shop: { 1: { fulfilments: ['A1'] } } });
  try {
    assert.deepEqual((await audit(w.env, {})).issues.issues.map((x) => x.kind), ['sr_cancelled_fulfilled']);
    const r = await fix(w.env, { id: '1', fix: 'unfulfil' });
    assert.equal(w.orders[1].shipped_at, null); assert.equal(w.orders[1].status, 'placed');
    assert.deepEqual(r.left, []);
  } finally { w.done(); }
});

test('fix "import" turns a hand-made Shopify fulfilment into a tracked booking here; "retrack" points Shopify at the live AWB', async () => {
  const w = world({ orders: { 1: o('1'), 2: o('2') }, shipments: { 2: s('2', { awb: 'NEW2' }) }, shop: { 1: { fulfilments: ['ZZ1'] }, 2: { fulfilments: ['OLD2'] } } });
  try {
    const r = await fix(w.env, { id: '1', fix: 'import' });
    assert.equal(w.shipments[1].awb, 'ZZ1'); assert.match(r.note, /Imported AWB ZZ1/); assert.deepEqual(r.left, []);
    assert.equal(w.shipments[1].provider, 'other', 'Shiprocket does not know this AWB, so it is not tracked there');
    assert.equal(w.shipments[1].track_url, 'https://x.example/t/ZZ1', 'keeps the tracking link Shopify has');
    const r2 = await fix(w.env, { id: '2', fix: 'retrack' });
    assert.ok(w.calls.includes('retrack NEW2')); assert.deepEqual(r2.left, []);
  } finally { w.done(); }
});

test('fix "cancel_shop" refuses while fulfilled; "reopen_db" and "sync_cancel" flip the local status', async () => {
  const w = world({ orders: { 1: o('1', { status: 'cancelled' }), 2: o('2', { status: 'cancelled', shipped_at: null }), 3: o('3', { shipped_at: null }) }, shipments: {}, shop: { 1: { fulfilments: ['A1'] }, 2: {}, 3: { cancelled: true } } });
  try {
    await assert.rejects(fix(w.env, { id: '1', fix: 'cancel_shop' }), /unfulfil it first/);
    await fix(w.env, { id: '2', fix: 'cancel_shop' }); assert.ok(w.calls.includes('shopify-cancel 2'));
    await fix(w.env, { id: '1', fix: 'reopen_db' }); assert.equal(w.orders[1].status, 'placed');
    await fix(w.env, { id: '3', fix: 'sync_cancel' }); assert.equal(w.orders[3].status, 'cancelled');
    assert.deepEqual((await listIssues(w.env)).issues.filter((x) => x.order_id === '3'), []);
  } finally { w.done(); }
});
