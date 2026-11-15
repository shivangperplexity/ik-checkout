// Tracking-update emails through Shopify's own customer notifications (no mail provider needed).
// When the courier status moves we add a fulfilment event to the Shopify order; Shopify then emails the customer
// with its "Out for delivery" / "Delivered" templates (Settings -> Notifications), and the order status page shows
// the same timeline. The first email ("Shipping confirmation", with the tracking link) goes out when we fulfil.
// Each stage is sent once per parcel (shipments.mailed). Off with settings mail.ship = false.
import { gql, activeFulfilments } from './shopify.js';

const EVENT = { transit: 'IN_TRANSIT', ofd: 'OUT_FOR_DELIVERY', ndr: 'ATTEMPTED_DELIVERY', delivered: 'DELIVERED' };

export const mailOn = (env) => (env.SETTINGS?.mail || {}).ship !== false;

/** Tell Shopify a parcel reached `stage` (Shopify emails the customer for OFD / delivered). Never throws. */
export async function mailStage(env, rec, stage) {
  try {
    if (!EVENT[stage] || !mailOn(env) || !rec?.awb || rec.status === 'cancelled') return '';
    const done = String(rec.mailed || '').split(',').filter(Boolean);
    if (done.includes(stage)) return '';
    const f = await activeFulfilments(env, String(rec.order_id));
    const ful = f.list.find((x) => x.numbers.includes(String(rec.awb)));
    if (!ful) return 'no Shopify fulfilment with this AWB';
    const d = await gql(env, `mutation($e:FulfillmentEventInput!){ fulfillmentEventCreate(fulfillmentEvent:$e){ fulfillmentEvent{ id } userErrors{ message } } }`,
      { e: { fulfillmentId: ful.id, status: EVENT[stage], happenedAt: new Date().toISOString() } });
    const ue = d.fulfillmentEventCreate?.userErrors || [];
    if (ue.length) throw new Error(ue.map((x) => x.message).join('; '));
    done.push(stage);
    await env.DB.prepare('UPDATE shipments SET mailed=? WHERE order_id=?').bind(done.join(','), String(rec.order_id)).run();
    rec.mailed = done.join(',');
    return 'sent';
  } catch (e) {
    console.error('ship-mail', rec?.order_id, stage, e.message);
    return String(e.message || e);
  }
}
