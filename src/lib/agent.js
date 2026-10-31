/**
 * GET /api/agent/run?ts=<unix>&act=<admin action>&p=<base64url JSON args>&s=<hex HMAC-SHA256(AGENT_KEY, ts.a.p)>
 *
 * Lets the owner's Claude run the same admin actions as the dashboard (Meta Ads, shipping, NDR, reports) without
 * a browser session. Off unless AGENT_KEY (32+ chars) is set in Vercel. A request is valid for 5 minutes and only
 * once (the signature is claimed in msg_once), so a URL that ends up in a log cannot be replayed.
 * Remove AGENT_KEY in Vercel to switch it off.
 */
import { json, hmacSha256hex, safeEqual } from './util.js';

const unb64 = (s) => decodeURIComponent(escape(atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))));

export async function handleAgent(req, env) {
  const key = String(env.AGENT_KEY || '');
  if (key.length < 32) return json({ ok: false, error: 'not found' }, 404);
  const q = new URL(req.url).searchParams;
  const ts = Number(q.get('ts')), a = String(q.get('act') || ''), p = String(q.get('p') || ''), s = String(q.get('s') || '');
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return json({ ok: false, error: 'expired' }, 401);
  if (!/^[a-z0-9_]{2,40}$/.test(a) || !/^[0-9a-f]{64}$/.test(s)) return json({ ok: false, error: 'bad request' }, 400);
  if (!safeEqual(await hmacSha256hex(key, `${ts}.${a}.${p}`), s)) return json({ ok: false, error: 'unauthorized' }, 401);
  const { claim } = await import('./once.js');
  if (!(await claim(env, 'agent:' + s, 900))) return json({ ok: false, error: 'already used' }, 409);
  let args = {};
  try { args = p ? JSON.parse(unb64(p)) : {}; } catch { return json({ ok: false, error: 'bad args' }, 400); }
  const { runAction } = await import('./admin.js');
  try { return json({ ok: true, ...(await runAction(env, a, args)) }); } catch (e) { return json({ ok: false, error: String(e.message || e) }, 200); }
}
