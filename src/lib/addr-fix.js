/**
 * Address was a link (Google Maps URL, a URL the browser autofilled, a Plus Code): stop the pickup, ask the customer
 * for the written address (template address_fix_v1 with an Edit address button -> the signed address form), and
 * book the parcel again with ShipPrime the moment they save it (lib/wa-address.js calls rebookAfterFix).
 */
export const FIX_NOTE = 'Address fix: the address was a link, asked the customer for the written one';

export async function startFix(env, orderId) {
  const { stopShipment } = await import('./ship-cancel.js');
  const { fireTrigger } = await import('./whatsapp.js');
  const id = String(orderId);
  const o = await env.DB.prepare('SELECT order_name, phone, first_name FROM orders WHERE order_id=?').bind(id).first();
  if (!o) return { id, ok: false, note: 'order not found' };
  const stop = await stopShipment(env, id, FIX_NOTE);
  if (stop.state !== 'cancelled' && stop.state !== 'none') return { id, name: o.order_name, ok: false, note: stop.note || stop.state };
  const r = await fireTrigger(env, 'addr_fix', { to: o.phone, vars: { name: o.first_name || 'there', order: o.order_name }, orderId: id, orderName: o.order_name, force: true });
  return { id, name: o.order_name, ok: true, pickup: stop.state, message: r.ok ? 'sent' : r.error || r.skipped || '' };
}

/** Next working day (Sundays off), e.g. 'Mon, 2 Nov'. After 2 pm IST the pickup is the day after. */
export function nextPickup(from = Date.now()) {
  const d = new Date(from + 19800000);
  if (d.getUTCHours() >= 14 || d.getUTCDay() === 0) do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export async function rebookAfterFix(env, orderId, provider = 'shipprime') {
  const { action } = await import('./admin.js');
  const id = String(orderId);
  const r = await action('ship_book')(env, { id, provider });
  const awb = r.shipment?.awb;
  if (!awb) return r;
  const o = await env.DB.prepare('SELECT order_name, phone, first_name FROM orders WHERE order_id=?').bind(id).first();
  const { withSettings } = await import('./settings.js');
  const { fireTrigger } = await import('./whatsapp.js');
  const { spTrackUrl } = await import('./shipprime.js');
  const A = await import('./apply-guide.js');
  const e2 = await withSettings(env);
  const courier = String(r.shipment?.courier || '').replace(/\s+(Premium|Surface|Air)$/i, '') || 'our courier';
  await fireTrigger(e2, 'ship_booked', { to: o.phone, vars: { name: o.first_name || 'there', order: o.order_name, courier, pickup: nextPickup(), edd: r.shipment?.edd || '4-7 days after pickup', track: await (await import('./self-cancel.js')).trackLink(env, id), ytid: A.ytId(A.applyVideo(e2)) }, orderName: o.order_name, force: true });
  return r;
}
