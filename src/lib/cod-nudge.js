/**
 * "Nudge again": the owner re-sends the COD confirmation on WhatsApp to customers who have not tapped Yes yet.
 *
 * - Within the auto-cancel window (orders placed after COD_AUTOCANCEL_SINCE, younger than COD_AUTOCANCEL_HOURS) the
 *   "not confirmed yet, cancelled automatically after 48 h" message goes out, so the deadline is stated and true.
 *   Otherwise (or if that template fails) the original confirmation message is sent again.
 * - Both carry the same Yes / Cancel buttons, so a tap confirms or cancels the order exactly like the first message.
 * - At least 2 hours between any two messages about one order (first confirmation, automatic warning, nudges),
 *   so one tap on "Nudge all" never spams anyone.
 */
export const GAP = 2 * 3600;
const num = (v) => Number(v) || 0;
const now = () => Math.floor(Date.now() / 1000);
const rupees = (p) => '₹' + Math.round(num(p) / 100).toLocaleString('en-IN');

/** When the customer last got a WhatsApp about this order (warned_at < 0 marks a failed warning). */
export function lastMsgAt(o) {
  return Math.max(num(o.created_at), num(o.warned_at) > 0 ? num(o.warned_at) : 0, num(o.reminded_at), num(o.nudged_at));
}

/** Why this order cannot be nudged now ('' = it can). booked: it has a live courier booking. */
export function nudgeBlock(o, t = now(), booked = false) {
  if (!o) return 'Order not found';
  if (o.method !== 'cod') return 'Not a COD order';
  if (o.status === 'cancelled') return 'Cancelled';
  if (o.confirmed_at) return 'Already confirmed';
  if (o.converted_at || num(o.advance_paise) > 0) return 'Already paid online';
  if (o.shipped_at || booked) return 'Already shipped';
  if (o.status !== 'placed' || !o.order_id) return 'Not a placed order';
  if (!o.phone) return 'No phone number';
  const ago = t - lastMsgAt(o);
  if (ago < GAP) {
    const left = Math.ceil((GAP - ago) / 60);
    return `Messaged ${Math.max(1, Math.round(ago / 60))} min ago; can nudge again in ${left >= 60 ? Math.round(left / 6) / 10 + ' h' : left + ' min'}`;
  }
  return '';
}

/** Which message: the cancel-deadline one inside the auto-cancel window, else the original confirmation. */
export function nudgeTrigger(o, env, t = now()) {
  const hours = num(env.COD_AUTOCANCEL_HOURS), since = num(env.COD_AUTOCANCEL_SINCE), c = num(o.created_at);
  return hours && since && c >= since && c > t - hours * 3600 ? 'cod_cancel_warning' : 'cod_confirm';
}

/** ids: Shopify order ids. Per-order results; nothing stops the batch. */
export async function nudgeOrders(env, ids, { fire } = {}) {
  if (!fire) ({ fireTrigger: fire } = await import('./whatsapp.js'));
  const t = now(), results = [];
  for (const id of [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 100)) {
    const o = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(id).first();
    const booked = o && (await env.DB.prepare("SELECT 1 AS x FROM shipments WHERE order_id=? AND awb IS NOT NULL AND awb<>'' AND COALESCE(status,'')<>'cancelled' LIMIT 1").bind(id).first().catch(() => null));
    const why = nudgeBlock(o, t, !!booked);
    if (why) { results.push({ id, name: o?.order_name || id, ok: false, skipped: true, note: why }); continue; }
    const args = { to: o.phone, vars: { name: (o.first_name || 'there').split(' ')[0], order: o.order_name, total: rupees(o.total_paise) }, orderId: o.order_id, orderName: o.order_name, force: true };
    let key = nudgeTrigger(o, env, t), r = await fire(env, key, args);
    if (!r.ok && !r.skipped && key !== 'cod_confirm') { key = 'cod_confirm'; r = await fire(env, key, args); }
    if (r.ok) {
      await env.DB.prepare('UPDATE orders SET nudged_at=?, nudge_count=COALESCE(nudge_count,0)+1 WHERE order_id=?').bind(t, id).run();
      results.push({ id, name: o.order_name, ok: true, message: key === 'cod_cancel_warning' ? 'confirm-or-cancelled reminder' : 'confirmation message' });
    } else {
      const note = r.skipped === 'nowa' ? 'WhatsApp is not connected' : r.skipped === 'nophone' ? 'No phone number' : r.skipped ? 'Not sent: ' + r.skipped : 'WhatsApp refused it: ' + (r.error || 'see the message log');
      results.push({ id, name: o.order_name, ok: false, note });
    }
  }
  return results;
}
