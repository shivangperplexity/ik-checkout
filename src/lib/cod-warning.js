/**
 * One more nudge for COD orders nobody confirmed: an hour after the order (9 am to 9:30 pm IST; a night order gets it
 * at 9 am), a WhatsApp saying the order is cancelled automatically if it is not confirmed within 48 hours of ordering,
 * with "Yes, confirm order" / "Cancel order" buttons (the same CONFIRM / CANCEL as the first message).
 * Only for orders placed after auto-cancel was switched on (COD_AUTOCANCEL_SINCE), so the warning is always true.
 */
export const WARN_TEMPLATE = 'cod_cancel_warning_v1';
const now = () => Math.floor(Date.now() / 1000);
const rupees = (p) => '₹' + Math.round(Number(p || 0) / 100).toLocaleString('en-IN');

export function warningTemplate() {
  return {
    name: WARN_TEMPLATE, language: 'en', category: 'UTILITY', allow_category_change: true,
    components: [
      { type: 'BODY', text: 'Hi {{1}}, your Ink Kulture order {{2}} ({{3}}, Cash on Delivery) is not confirmed yet.\n\nPlease tap "Yes, confirm order" so we can pack and ship it. Orders that are not confirmed within 48 hours of ordering are cancelled automatically.',
        example: { body_text: [['Riya', '#1763', '₹399']] } },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes, confirm order' }, { type: 'QUICK_REPLY', text: 'Cancel order' }] },
    ],
  };
}

/** 9:00 to 21:30 IST */
export function awake(t = now()) { const m = Math.floor(((t + 19800) % 86400) / 60); return m >= 9 * 60 && m < 21 * 60 + 30; }

/** New templates go to Meta once, straight away (the general auto-submit runs only every 6 hours). */
export async function ensureTemplates(env) {
  for (const [flagKey, act, args] of [['cod_warning_tpl', 'cod_warning_template', {}], ['apply_yt_tpl', 'apply_guide', { submit: true }], ['cod_otp_tpl', 'cod_otp_template', {}], ['ref_tpl', 'referral_templates', {}]]) {
    try {
      if (await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(flagKey).first()) continue;
      const { action } = await import('./admin.js');
      const r = await action(act)(env, args);
      await env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v').bind(flagKey, JSON.stringify({ at: now(), created: r.created || [], status: r.status || '' })).run();
      console.log('template submitted', act, JSON.stringify(r.created || r.status || ''));
    } catch (e) { console.error('template submit', act, e.message); }
  }
}

/** Cron. */
export async function codWarnings(env, { max = 20 } = {}) {
  await ensureTemplates(env);
  const hours = Number(env.COD_AUTOCANCEL_HOURS || 0), since = Number(env.COD_AUTOCANCEL_SINCE || 0);
  if (!hours || !since) return { skipped: 'auto-cancel off' };
  const { triggerConfig } = await import('./settings.js');
  if (!triggerConfig(env, 'cod_cancel_warning').enabled) return { skipped: 'off' };
  if (!awake()) return { skipped: 'night' };
  const t = now();
  const rows = (await env.DB.prepare(`SELECT * FROM orders WHERE method='cod' AND status='placed' AND confirmed_at IS NULL AND converted_at IS NULL AND COALESCE(advance_paise,0)=0
      AND order_id IS NOT NULL AND created_at>=? AND created_at<? AND created_at>? AND (warned_at IS NULL OR (warned_at<0 AND warned_at>?)) ORDER BY created_at LIMIT ?`)
    .bind(since, t - 3600, t - (hours - 2) * 3600, -(t - 3600), max).all()).results;
  const { fireTrigger } = await import('./whatsapp.js');
  let sent = 0, failed = 0;
  for (const o of rows) {
    const r = await fireTrigger(env, 'cod_cancel_warning', { to: o.phone, vars: { name: o.first_name || 'there', order: o.order_name, total: rupees(o.total_paise) }, orderId: o.order_id, orderName: o.order_name });
    const ok = r.ok || r.skipped;
    await env.DB.prepare('UPDATE orders SET warned_at=? WHERE order_id=?').bind(ok ? t : -t, String(o.order_id)).run();
    if (r.ok) sent++; else if (!r.skipped) failed++;
  }
  return { sent, failed };
}
