/**
 * Atomic "only once in this window" claim, shared by every serverless instance (a row in msg_once).
 * claim(env, key, secs) -> true for the first caller; false for everyone else until `secs` have passed.
 * release(env, key) gives the slot back (the send failed, so a retry may go out).
 * Without a database it always says yes (tests, local runs).
 */
const now = () => Math.floor(Date.now() / 1000);
export async function claim(env, key, secs) {
  if (!env?.DB) return true;
  const t = now();
  try {
    const r = await env.DB.prepare('INSERT INTO msg_once (k, at) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET at=EXCLUDED.at WHERE msg_once.at < ? RETURNING k')
      .bind(String(key).slice(0, 400), t, t - secs).first();
    if (r) return true;
    /* no row back: someone holds the slot, unless the row does not exist at all (a database that ignores RETURNING) */
    return !(await env.DB.prepare('SELECT at FROM msg_once WHERE k=?').bind(String(key).slice(0, 400)).first());
  } catch (e) { console.error('once claim', e.message); return true; }
}
export async function release(env, key) {
  if (!env?.DB) return;
  await env.DB.prepare('DELETE FROM msg_once WHERE k=?').bind(String(key).slice(0, 400)).run().catch(() => {});
}
/** short stable hash for long keys (message text) */
export function h(s) { let x = 2166136261; for (const c of String(s)) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619) >>> 0; } return x.toString(36); }
