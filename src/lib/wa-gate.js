/**
 * Back-off for WhatsApp template sends after Meta's "Rate limit hit" (130429).
 *
 * Meta asks senders to back off when it throttles a number. Retrying every 5 minutes keeps the throttle alive, so
 * after a 130429 every template send pauses: 20 minutes, doubling while the throttle continues (up to 3 hours).
 * During a pause the messages that matter right now (COD confirmation, payment received, out for delivery,
 * delivery failed, cancel warning) may go out as a probe, one every 4 minutes; the first one that is delivered
 * ends the pause. Everything else waits and is sent by its own retry once the pause is over.
 * State: settings row 'wa_pause' = { until, step, probe_at, since, hits }.
 */
const now = () => Math.floor(Date.now() / 1000);
const KEY = 'wa_pause';
export const URGENT = new Set(['cod_confirm', 'cod_cancel_warning', 'prepaid_paid', 'ship_ofd', 'ship_failed', 'ndr_refused', 'creator_approved', 'admin_new_order', 'admin_high_risk']);
const FIRST = 20 * 60, MAX = 3 * 3600, PROBE_GAP = 4 * 60;
export const RATE_LIMIT = /130429|rate limit hit/i;

async function read(env) {
  const r = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(KEY).first().catch(() => null);
  try { return r ? JSON.parse(r.v) || {} : {}; } catch { return {}; }
}
const write = (env, v) => env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v').bind(KEY, JSON.stringify(v)).run().catch(() => {});

/** Before a template send. { go: true } or { go: false, until }. A probe claims its slot atomically enough for a 5-minute cron. */
export async function gate(env, key) {
  const p = await read(env);
  const t = now();
  if (!p.until || p.until <= t) return { go: true };
  if (URGENT.has(key) && (p.probe_at || 0) <= t) { await write(env, { ...p, probe_at: t + PROBE_GAP }); return { go: true, probe: true }; }
  return { go: false, until: p.until };
}

/** Meta said 130429 (at send time or in a status webhook): pause, longer each time it repeats. */
export async function pushback(env) {
  const p = await read(env);
  const t = now();
  if (p.until > t && p.last_hit > t - 60) { await write(env, { ...p, hits: (p.hits || 0) + 1, last_hit: t }); return; }   /* same burst */
  const step = p.until > t - 15 * 60 ? Math.min(MAX, (p.step || FIRST / 2) * 2) : FIRST;   /* still throttled shortly after a pause: double */
  await write(env, { until: t + step, step, probe_at: t + PROBE_GAP, since: p.until > t - 15 * 60 ? (p.since || t) : t, hits: (p.hits || 0) + 1, last_hit: t });
  console.log('wa pause', JSON.stringify({ minutes: Math.round(step / 60) }));
}

/** A template message was delivered: the throttle is over. */
export async function clear(env) {
  const p = await read(env);
  if (!p.until && !p.step) return;
  await write(env, {});
  console.log('wa pause cleared', JSON.stringify({ after_minutes: p.since ? Math.round((now() - p.since) / 60) : null, hits: p.hits || 0 }));
}

/** For the dashboard / logs. */
export async function pauseState(env) {
  const p = await read(env);
  return p.until > now() ? { paused: true, until: p.until, minutes_left: Math.ceil((p.until - now()) / 60), hits: p.hits || 0 } : { paused: false };
}
