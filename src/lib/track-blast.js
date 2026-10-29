/**
 * One-off: every customer whose parcel is in transit gets their tracking link on WhatsApp (the "Shipment in transit"
 * message), asked for on 30 Oct after the WhatsApp rate-limit days lost many tracking updates.
 * Daytime only (9 am - 8 pm IST), 8 a run (every 5 minutes, after the WhatsApp back-off allows), never twice to one
 * order, and not to a parcel that got a tracking message delivered in the last 24 hours.
 * State: settings 'track_blast' = { at, done: [order_id...], sent, skipped, finished }.
 */
const now = () => Math.floor(Date.now() / 1000);
const KEY = 'track_blast';

async function state(env) {
  const r = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(KEY).first().catch(() => null);
  try { return r ? JSON.parse(r.v) : null; } catch { return null; }
}
const save = (env, v) => env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v').bind(KEY, JSON.stringify(v)).run();

export async function trackBlast(env, { per = 8 } = {}) {
  let st = await state(env);
  if (!st) { st = { at: now(), done: [], sent: 0, skipped: 0 }; await save(env, st); }
  if (st.finished) return { finished: true, sent: st.sent };
  const h = new Date(Date.now() + 19800000).getUTCHours();
  if (h < 9 || h >= 20) return { waiting: 'daytime only' };
  const { pauseState } = await import('./wa-gate.js');
  if ((await pauseState(env)).paused) return { waiting: 'WhatsApp pause' };
  const rows = (await env.DB.prepare(`SELECT s.order_id, s.order_name, s.awb, s.courier, s.provider, s.edd, o.phone, o.first_name, o.status
      FROM shipments s JOIN orders o ON o.order_id = s.order_id
      WHERE s.stage='transit' AND COALESCE(s.status,'')<>'cancelled' AND s.awb IS NOT NULL AND o.phone IS NOT NULL AND o.status<>'cancelled'
      ORDER BY s.updated_at DESC LIMIT 400`).all()).results.filter((r) => !st.done.includes(String(r.order_id)));
  if (!rows.length) { st.finished = now(); await save(env, st); return { finished: true, sent: st.sent }; }
  const { fireTrigger } = await import('./whatsapp.js');
  const { trackUrlOf } = await import('./shipprime.js');
  let n = 0;
  for (const r of rows) {
    if (n >= per) break;
    st.done.push(String(r.order_id));
    const recent = await env.DB.prepare("SELECT 1 AS x FROM messages WHERE direction='out' AND order_name=? AND trigger IN ('ship_picked','ship_transit','ship_ofd') AND status IN ('delivered','read') AND ts>? LIMIT 1").bind(r.order_name, now() - 86400).first();
    if (recent) { st.skipped++; continue; }
    const edd = /^\d{4}-\d{2}-\d{2}/.test(String(r.edd || '')) ? new Date(String(r.edd).slice(0, 10) + 'T12:00:00+05:30').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : String(r.edd || 'in a few days');
    const res = await fireTrigger(env, 'ship_transit', { to: r.phone, vars: { name: r.first_name || 'there', order: r.order_name, location: 'a courier hub', edd, track: trackUrlOf(r) }, orderName: r.order_name }).catch((e) => ({ ok: false, error: e.message }));
    if (res.deferred) { st.done.pop(); break; }                                   /* WhatsApp pause: retry later */
    if (res.ok) st.sent++; else st.skipped++;
    n++;
  }
  await save(env, st);
  return { sent: st.sent, skipped: st.skipped, left: rows.length - n };
}
