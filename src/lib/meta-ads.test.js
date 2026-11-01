import test from 'node:test';
import assert from 'node:assert/strict';
import { hashRow, setBudget, setStatus, graph } from './meta-ads.js';
import { handleAgent } from './agent.js';
import { hmacSha256hex, sha256hex } from './util.js';

test('meta-ads: customer rows are normalised and SHA-256 hashed; empty fields stay empty', async () => {
  const h = await hashRow({ phone: '91 98765-43210', fn: 'Riya ', ln: '', ct: 'Navi Mumbai', st: 'MH', zip: '410206' });
  assert.equal(h[0], await sha256hex('919876543210'));
  assert.equal(h[1], await sha256hex('riya'));
  assert.equal(h[2], '');
  assert.equal(h[3], await sha256hex('navimumbai'));
  assert.equal(h[4], await sha256hex('mh'));
  assert.equal(h[6], await sha256hex('in'));
});

test('meta-ads: budget cap and status guard; token never in the error', async () => {
  const env = { SETTINGS: { meta: { ads_token: 'SECRET', ads_max_daily: 2000 } } };
  await assert.rejects(setBudget(env, '120252142549410354', 5000), /cap of ₹2000/);
  /* account total: other active budgets count against the limit */
  const old0 = globalThis.fetch;
  globalThis.fetch = async (u) => ({ ok: true, json: async () => (/\/adsets/.test(String(u)) ? { data: [{ id: '1', daily_budget: '75000' }, { id: '120252142549410354', daily_budget: '100000' }] } : /\/campaigns/.test(String(u)) ? { data: [] } : { name: 'Winning reels', daily_budget: '100000' }) });
  try { await assert.rejects(setBudget({ SETTINGS: { meta: { ads_token: 'SECRET', ads_max_total: 1750 } } }, '120252142549410354', 1200), /limit is ₹1750/); } finally { globalThis.fetch = old0; }
  await assert.rejects(setBudget(env, '120252142549410354', 10), /at least/);
  await assert.rejects(setStatus(env, '120252142549410354', 'DELETED'), /ACTIVE or PAUSED/);
  await assert.rejects(graph(env, 'GET', 'act_1/ads?x=1'), /bad path/);
  const calls = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (u, init) => { calls.push([String(u), init]); return { ok: true, json: async () => (init?.method === 'POST' ? { success: true } : { name: 'Winning reels', daily_budget: '100000' }) }; };
  try {
    const r = await setBudget(env, '120252142549410354', 1200);
    assert.deepEqual(r, { id: '120252142549410354', name: 'Winning reels', from: 1000, to: 1200 });
    assert.equal(calls.find((c) => c[1]?.method === 'POST')[1].body.get('daily_budget'), '120000');
  } finally { globalThis.fetch = old; }
  assert.equal(await setBudget({ SETTINGS: { meta: {} } }, '120252142549410354', 500).catch((e) => /token not set/.test(e.message)), true);
});

test('agent: off without a key, rejects bad / old signatures, runs a signed action once', async () => {
  const rows = new Map();
  const DB = { prepare: (sql) => ({ bind: (...a) => ({ first: async () => {
    if (/^INSERT INTO msg_once/.test(sql)) { if (rows.has(a[0])) return null; rows.set(a[0], a[1]); return { k: a[0] }; }
    if (/^SELECT at FROM msg_once/.test(sql)) return rows.has(a[0]) ? { at: rows.get(a[0]) } : null;
    return null;
  }, run: async () => ({}), all: async () => ({ results: [] }) }) }) };
  const key = 'k'.repeat(40);
  const url = async (act, args, ts = Math.floor(Date.now() / 1000), k = key) => {
    const p = Buffer.from(JSON.stringify(args)).toString('base64url');
    return `https://x/api/agent/run?ts=${ts}&act=${act}&p=${p}&s=${await hmacSha256hex(k, `${ts}.${act}.${p}`)}`;
  };
  assert.equal((await handleAgent(new Request(await url('ads_probe', {})), { DB })).status, 404);
  const env = { DB, AGENT_KEY: key };
  assert.equal((await handleAgent(new Request(await url('ads_probe', {}, 1000)), env)).status, 401);
  assert.equal((await handleAgent(new Request(await url('ads_probe', {}, undefined, 'x'.repeat(40))), env)).status, 401);
  const u = await url('change_password', { password: 'x' });
  const r1 = await (await handleAgent(new Request(u), env)).json();
  assert.equal(r1.ok, false);
  assert.match(r1.error, /unknown action/);
  assert.equal((await handleAgent(new Request(u), env)).status, 409);
});
