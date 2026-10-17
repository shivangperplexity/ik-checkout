import test from 'node:test';
import assert from 'node:assert/strict';
import { customerNdr, ndrReply, handleNdr, signNdr } from './wa-ndr.js';
import { replyAction } from './go4whatsup.js';

function world() {
  const ships = { 1: { order_id: '1', order_name: '#1601', awb: 'A1', status: 'booked', stage: 'ndr', created_at: Math.floor(Date.now() / 1000) - 3600, phone: '9999999999', first_name: 'Asha' } };
  const calls = [], texts = [];
  const db = { prepare(sql) { const q = sql.replace(/\s+/g, ' '); return { all: async () => ({ results: [] }), bind: (...a) => ({
    first: async () => { if (/WHERE s\.order_id=\?/.test(q)) return ships[a[0]] || null; if (/WHERE o\.phone=\?/.test(q)) return Object.values(ships).find((s) => s.phone === a[0]) || null; return null; },
    run: async () => { if (/SET ndr_choice=\?/.test(q)) Object.assign(ships[a[4]], { ndr_choice: a[0], ndr_choice_at: a[1], ndr_date: a[2] }); if (/INSERT INTO messages/.test(q)) calls.push('log ' + a[3] + ' ' + a[4]); return {}; },
  }) }; } };
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => { const url = String(u); if (/auth\/login/.test(url)) return new Response('{"token":"t"}'); if (/ndr\//.test(url)) { calls.push('sr ' + JSON.parse(o.body).action + ' ' + (JSON.parse(o.body).deferred_date || '')); return new Response('{"message":"ok"}'); } if (/messages/.test(url)) { texts.push(JSON.parse(o.body)); return new Response('{"messages":[{"id":"m"}]}'); } return new Response('{}'); };
  const env = { DB: db, WORKER_URL: 'https://ik.example', ADMIN_TOKEN: 'secret', SHIPROCKET_EMAIL: 'a', SHIPROCKET_PASSWORD: 'b', SETTINGS: { shipping: { shiprocket_email: 'a', shiprocket_password: 'b' }, wa: {} }, WA_PHONE_ID: 'p', WA_TOKEN: 't' };
  return { env, ships, calls, texts, done: () => { globalThis.fetch = real; } };
}

test('reply words map to re-attempt / return', () => {
  assert.equal(replyAction('Re-attempt'), 'REATTEMPT'); assert.equal(replyAction('deliver again'), 'REATTEMPT'); assert.equal(replyAction('Return'), 'RETURN');
  assert.equal(replyAction('yes'), 'CONFIRM'); assert.equal(replyAction('hello'), null);
});

test('customer asks for a re-attempt on a day: Shiprocket NDR action with that date, remembered on the parcel, not repeated', async () => {
  const w = world();
  try {
    const d = new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10);
    const r = await customerNdr(w.env, { orderId: '1', what: 'reattempt', date: d });
    assert.equal(r.status, 'reattempt'); assert.ok(w.calls.includes('sr re-attempt ' + d)); assert.equal(w.ships[1].ndr_choice, 'reattempt'); assert.equal(w.ships[1].ndr_date, d);
    assert.equal((await customerNdr(w.env, { orderId: '1', what: 'reattempt' })).status, 'already');
    assert.equal(w.calls.filter((c) => /^sr/.test(c)).length, 1);
    assert.equal((await customerNdr(w.env, { orderId: '9', what: 'reattempt' })).status, 'no-shipment');
  } finally { w.done(); }
});

test('a WhatsApp reply from the phone with a parcel in NDR: acted on and answered', async () => {
  const w = world();
  try {
    assert.equal(await ndrReply(w.env, '9999999999', 'RETURN'), true);
    assert.ok(w.calls.includes('sr return ')); assert.equal(w.ships[1].ndr_choice, 'return');
    assert.equal(await ndrReply(w.env, '8888888888', 'REATTEMPT'), false, 'no parcel for that number');
  } finally { w.done(); }
});

test('the link page: bad signature refused, good one shows the choices, POST applies', async () => {
  const w = world();
  try {
    const bad = await handleNdr(new Request('https://ik.example/api/wa/ndr?o=1&s=000000000000'), w.env);
    assert.match(await bad.text(), /Link not valid/);
    const sig = await signNdr(w.env, '1');
    const ok = await handleNdr(new Request(`https://ik.example/api/wa/ndr?o=1&s=${sig}`), w.env);
    const html = await ok.text(); assert.match(html, /Deliver again/); assert.match(html, /Return the parsel|Return the parcel/); assert.match(html, /type="date"/);
    const post = await handleNdr(new Request(`https://ik.example/api/wa/ndr?o=1&s=${sig}&d=r`, { method: 'POST', body: new URLSearchParams({ date: '' }) }), w.env);
    assert.match(await post.text(), /re-attempted on the next working day/); assert.ok(w.calls.includes('sr re-attempt '));
  } finally { w.done(); }
});
