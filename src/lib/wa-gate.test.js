import test from 'node:test';
import assert from 'node:assert/strict';
import { gate, pushback, clear, pauseState } from './wa-gate.js';

const fakeEnv = () => { const kv = {}; return { kv, DB: { prepare: (q) => ({ bind: (...a) => ({
  first: async () => (/SELECT v FROM settings/.test(q) ? (kv[a[0]] ? { v: kv[a[0]] } : null) : null),
  run: async () => { if (/INSERT INTO settings/.test(q)) kv[a[0]] = a[1]; return {}; } }) }) } }; };

test('rate limit pause: everything waits, urgent ones probe every few minutes, a delivery ends it', async () => {
  const env = fakeEnv();
  assert.equal((await gate(env, 'ship_picked')).go, true);
  await pushback(env);
  const st = await pauseState(env);
  assert.equal(st.paused, true); assert.ok(st.minutes_left >= 19 && st.minutes_left <= 20);
  assert.equal((await gate(env, 'ship_picked')).go, false);
  assert.equal((await gate(env, 'review_ask')).go, false);
  assert.equal((await gate(env, 'cod_confirm')).go, false);             /* first probe only after 4 minutes */
  const p = JSON.parse(env.kv.wa_pause); p.probe_at = 0; p.last_hit = 0; env.kv.wa_pause = JSON.stringify(p);
  assert.equal((await gate(env, 'cod_confirm')).go, true);              /* the probe */
  assert.equal((await gate(env, 'prepaid_paid')).go, false);            /* one probe per gap */
  await pushback(env);                                                  /* probe failed too: longer */
  assert.ok((await pauseState(env)).minutes_left > 30);
  await clear(env);
  assert.equal((await pauseState(env)).paused, false);
  assert.equal((await gate(env, 'ship_picked')).go, true);
});
