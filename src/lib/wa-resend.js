/**
 * WhatsApp messages Meta accepted and then failed for a rate limit ("Rate limit hit", status webhook) are not
 * retried by their senders: they look sent. This puts them back through the normal path once, slowly:
 *  - tracking updates (picked / in transit / out for delivery) and the how-to-apply video: the ship_track flag is
 *    cleared, so the next tracking check sends what is still true (an "out for delivery" for a parcel that has
 *    since been delivered is not sent again);
 *  - review request: the order goes back to "delivered", the review sender asks again (10 am - 8 pm);
 *  - COD confirmation (only while the order is still unconfirmed) and "payment received": sent again directly.
 * Never while WhatsApp is still pushing back (a rate-limit failure in the last 20 minutes), at most `max` a run,
 * each failed message once (messages.retried_at).
 */
import { fireTrigger } from './whatsapp.js';
import { rupees } from './pricing.js';

const now = () => Math.floor(Date.now() / 1000);
const dayOf = (ts) => new Date((ts || now()) * 1000 + 19800000).toISOString().slice(0, 10);
const TRIGGERS = ['ship_picked', 'ship_transit', 'ship_ofd', 'ship_delivered', 'review_ask', 'cod_confirm', 'prepaid_paid'];

export async function resendFailed(env, { max = 6, hours = 36 } = {}) {
  const t = now();
  const { pauseState } = await import('./wa-gate.js');
  if ((await pauseState(env)).paused) return { paused: 'WhatsApp rate limit pause' };
  const hot = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction='out' AND status='failed' AND error ILIKE '%rate limit%' AND ts>?").bind(t - 20 * 60).first();
  if (Number(hot?.n) > 0) return { paused: 'rate limit in the last 20 minutes' };
  const rows = (await env.DB.prepare(`SELECT m.id, m.ts, m.trigger, m.order_name, m.phone FROM messages m
      WHERE m.direction='out' AND m.status='failed' AND m.error ILIKE '%rate limit%' AND m.retried_at IS NULL AND m.ts>? AND COALESCE(m.order_name,'')<>''
        AND m.trigger IN (${TRIGGERS.map(() => '?').join(',')})
      ORDER BY m.ts LIMIT ?`).bind(t - hours * 3600, ...TRIGGERS, max).all()).results;
  const out = { done: 0, skipped: 0 };
  for (const m of rows) {
    await env.DB.prepare('UPDATE messages SET retried_at=? WHERE id=?').bind(t, m.id).run();
    /* sent fine later (another run already managed it): nothing to do */
    const later = await env.DB.prepare("SELECT 1 AS x FROM messages WHERE direction='out' AND trigger=? AND order_name=? AND ts>? AND status IN ('sent','delivered','read','accepted') LIMIT 1")
      .bind(m.trigger, m.order_name, m.ts).first();
    const o = await env.DB.prepare('SELECT order_id, order_name, phone, first_name, total_paise, method, status, confirmed_at FROM orders WHERE order_name=? ORDER BY created_at DESC LIMIT 1').bind(m.order_name).first();
    if (later || !o) { out.skipped++; continue; }
    try {
      if (m.trigger.startsWith('ship_')) {
        const st = await env.DB.prepare('SELECT sent FROM ship_track WHERE order_id=?').bind(String(o.order_id)).first();
        if (!st) { out.skipped++; continue; }
        let s = {}; try { s = JSON.parse(st.sent || '{}') || {}; } catch { s = {}; }
        if (m.trigger === 'ship_picked') delete s.picked;
        if (m.trigger === 'ship_transit') delete s.transit;
        if (m.trigger === 'ship_ofd') s.ofd = (s.ofd || []).filter((d) => d !== dayOf(m.ts));
        if (m.trigger === 'ship_delivered') { delete s.guide; delete s.guide_fail; }
        await env.DB.prepare('UPDATE ship_track SET sent=?, done=FALSE, checked_at=0 WHERE order_id=?').bind(JSON.stringify(s), String(o.order_id)).run();
      } else if (m.trigger === 'review_ask') {
        await env.DB.prepare("UPDATE review_asks SET state='delivered', hold_until=NULL, note='resend after WhatsApp rate limit' WHERE order_id=? AND state='sent'").bind(String(o.order_id)).run();
      } else if (m.trigger === 'cod_confirm') {
        if (o.method !== 'cod' || o.confirmed_at || /cancel/.test(String(o.status))) { out.skipped++; continue; }
        await fireTrigger(env, 'cod_confirm', { to: o.phone, vars: { name: o.first_name || 'there', order: o.order_name, total: rupees(Number(o.total_paise) || 0) }, orderId: String(o.order_id), orderName: o.order_name });
      } else if (m.trigger === 'prepaid_paid') {
        await fireTrigger(env, 'prepaid_paid', { to: o.phone, vars: { name: o.first_name || 'there', order: o.order_name, total: rupees(Number(o.total_paise) || 0) }, orderName: o.order_name });
      }
      out.done++;
    } catch (e) { console.error('wa-resend', m.order_name, e.message); out.skipped++; }
  }
  return out;
}
