/**
 * Blue Dart pickup watchdog (Nov 2026). Blue Dart is routed for COD into the low-RTO states (lib/shipprime.js), but
 * its Navi Mumbai pickups have slipped for days before. A Blue Dart parcel still at pickup_pending 48 h after booking
 * is cancelled and rebooked on ShipPrime's next courier (Xpressbees first); the customer's tracking follows the new
 * AWB through the usual rebook path. At most 10 per tick, 09:00-20:00 IST, never twice for one order.
 */
import { claim } from './once.js';

const HOURS = Number(process.env.BLUEDART_PICKUP_HOURS) || 48;
const nowSec = () => Math.floor(Date.now() / 1000);
const istHour = () => new Date((nowSec() + 19800) * 1000).getUTCHours();

/** Pure: shipment rows overdue for a Blue Dart pickup. */
export function overdue(rows, t = nowSec(), hours = HOURS) {
  return rows.filter((r) => /blue\s*dart/i.test(r.courier || '') && r.provider === 'shipprime' && r.status === 'booked' && (r.stage || 'pickup_pending') === 'pickup_pending'
    && !r.picked_at && !r.bd_rebooked_at && Number(r.created_at) < t - hours * 3600);
}

export async function bluedartWatch(env, { max = 10, force = false } = {}) {
  if (!env.DB) return { skipped: 'no db' };
  if (!force) { const h = istHour(); if (h < 9 || h >= 20) return { skipped: 'hour' }; if (!(await claim(env, 'bd:watch', 1800))) return { skipped: 'slot' }; }
  const rows = (await env.DB.prepare("SELECT * FROM shipments WHERE provider='shipprime' AND status='booked' AND courier ILIKE '%blue%' AND bd_rebooked_at IS NULL ORDER BY created_at LIMIT 50").all()).results;
  const due = overdue(rows).slice(0, max);
  const out = { checked: rows.length, rebooked: [], failed: [] };
  if (!due.length) return out;
  const { shipCtx, fulfilBooked } = await import('./admin.js');
  const { stopShipment } = await import('./ship-cancel.js');
  const { spBook } = await import('./shipprime.js');
  for (const r of due) {
    try {
      await env.DB.prepare('UPDATE shipments SET bd_rebooked_at=? WHERE order_id=? AND bd_rebooked_at IS NULL').bind(nowSec(), r.order_id).run();
      const x = await stopShipment(env, r.order_id, `Blue Dart did not collect in ${HOURS} h; rebooking`);
      if (x.state !== 'cancelled') { out.failed.push({ order: r.order_name, note: x.note || x.state }); continue; }
      const { fresh, row, order } = await shipCtx(env, r.order_id);
      fresh.SETTINGS.shipping = { ...fresh.SETTINGS.shipping, bluedart_cod_off: true }; /* not Blue Dart again for this one */
      const b = await spBook(fresh, order, row, { tpl: 'XPRESSBEES' });
      await fulfilBooked(env, r.order_id).catch(() => '');
      out.rebooked.push({ order: r.order_name, old_awb: r.awb, awb: b.rec?.awb || '', courier: b.rec?.courier || '' });
    } catch (e) { out.failed.push({ order: r.order_name, note: String(e.message).slice(0, 160) }); }
  }
  return out;
}
