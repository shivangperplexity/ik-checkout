import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setHidden, checkPin, hiddenSet, hasPin, assertVisible } from './inbox-hide.js';

function fakeEnv() {
  const kv = new Map();
  const DB = { prepare(sql) { let args = []; return {
    bind(...a) { args = a; return this; },
    async first() { return sql.startsWith('SELECT v FROM settings') && kv.has(args[0]) ? { v: kv.get(args[0]) } : null; },
    async run() { if (sql.startsWith('INSERT INTO settings')) kv.set(args[0], args[1]); return {}; },
  }; } };
  return { DB, kv };
}

test('first hide sets the lock code; the code is stored hashed, never in plain text', async () => {
  const env = fakeEnv();
  assert.equal(await hasPin(env), false);
  await assert.rejects(setHidden(env, { phone: '9000000001', hide: true }), /lock code/);
  const r = await setHidden(env, { phone: '+91 90000 00001', hide: true, new_pin: '2580' });
  assert.equal(r.hidden, true);
  assert.ok((await hiddenSet(env)).has('9000000001'));
  const raw = env.kv.get('inbox_hidden');
  assert.ok(!raw.includes('2580'), 'code must not be stored in plain text');
  assert.equal(await hasPin(env), true);
});

test('right code opens, wrong code does not; hidden chat needs the code, others do not', async () => {
  const env = fakeEnv();
  await setHidden(env, { phone: '9000000001', hide: true, new_pin: '2580' });
  assert.equal((await checkPin(env, '2580')).ok, true);
  assert.equal((await checkPin(env, '1234')).ok, false);
  await assert.rejects(assertVisible(env, '9000000001', '0000'), /locked/);
  await assertVisible(env, '9000000001', '2580');
  await assertVisible(env, '9876543210', undefined);           // a normal chat needs no code
});

test('five wrong codes lock it for 15 minutes, even for the right code', async () => {
  const env = fakeEnv();
  await setHidden(env, { phone: '9000000001', hide: true, new_pin: '2580' });
  for (let i = 0; i < 5; i++) assert.equal((await checkPin(env, '1111')).ok, false);
  const r = await checkPin(env, '2580');
  assert.equal(r.ok, false); assert.match(r.error, /Too many wrong tries/);
});

test('second hide and unhide need the code; later hides keep the same code', async () => {
  const env = fakeEnv();
  await setHidden(env, { phone: '9000000001', hide: true, new_pin: '2580' });
  await assert.rejects(setHidden(env, { phone: '9876543210', hide: true, pin: '9999' }), /Wrong lock code/);
  await setHidden(env, { phone: '9876543210', hide: true, pin: '2580', new_pin: '0000' });  // new_pin ignored once a code exists
  assert.equal((await checkPin(env, '2580')).ok, true);
  await setHidden(env, { phone: '9000000001', hide: false, pin: '2580' });
  assert.deepEqual([...(await hiddenSet(env))], ['9876543210']);
});
