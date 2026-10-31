import test from 'node:test';
import assert from 'node:assert/strict';
import { claim, release } from './once.js';
function fakeDb() {
  const rows = new Map();
  return { prepare: (sql) => ({ bind: (...a) => ({
    first: async () => {
      if (/^INSERT INTO msg_once/.test(sql)) { const [k, t, cut] = a; const old = rows.get(k); if (old != null && old >= cut) return null; rows.set(k, t); return { k }; }
      if (/^SELECT at FROM msg_once/.test(sql)) return rows.has(a[0]) ? { at: rows.get(a[0]) } : null;
      return null;
    },
    run: async () => { if (/^DELETE FROM msg_once/.test(sql)) rows.delete(a[0]); return {}; },
  }) }) };
}
test('once: parallel claims, only the first wins; release frees it', async () => {
  const env = { DB: fakeDb() };
  const r = await Promise.all(Array.from({ length: 8 }, () => claim(env, 't:1:ship_booked:#1951', 600)));
  assert.equal(r.filter(Boolean).length, 1);
  await release(env, 't:1:ship_booked:#1951');
  assert.equal(await claim(env, 't:1:ship_booked:#1951', 600), true);
  assert.equal(await claim({ DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } }, 'k', 60), true);
});
