/**
 * "Address confirmed" on the Shopify order: Shopify has no custom status badges, so every COD order the customer
 * confirmed (WhatsApp YES / one-tap page / confirmed from this dashboard) gets this readable tag. It shows on the
 * order page and the order list can be filtered by it. Orders already paid online (converted) or with a paid advance
 * (partial COD) show their payment state in Shopify instead and are not tagged.
 * New confirmations are tagged at once; older ones (and any the instant call missed) by the cron sweep.
 */
import { addTags } from './shopify.js';

export const ADDR_TAG = 'Address confirmed';
const now = () => Math.floor(Date.now() / 1000);

/** Tag one order now (best effort). */
export async function tagAddressConfirmed(env, orderId) {
  try {
    await addTags(env, `gid://shopify/Order/${orderId}`, [ADDR_TAG]);
    await env.DB.prepare('UPDATE orders SET addr_tagged_at=? WHERE order_id=?').bind(now(), String(orderId)).run();
    return true;
  } catch (e) { console.error('address tag', orderId, e.message); return false; }
}

/** Cron: confirmed COD orders not tagged yet, newest first, up to `max` per run. */
export async function tagConfirmedSweep(env, { max = 40 } = {}) {
  const rows = (await env.DB.prepare(`SELECT order_id FROM orders WHERE method='cod' AND confirmed_at IS NOT NULL AND addr_tagged_at IS NULL
      AND converted_at IS NULL AND COALESCE(advance_paise,0)=0 AND status<>'cancelled' AND order_id<>''
      ORDER BY confirmed_at DESC LIMIT ?`).bind(max).all()).results;
  let tagged = 0, failed = 0;
  for (const r of rows) {
    if (await tagAddressConfirmed(env, r.order_id)) tagged++;
    else { failed++; await env.DB.prepare('UPDATE orders SET addr_tagged_at=? WHERE order_id=?').bind(-now(), String(r.order_id)).run().catch(() => {}); }
  }
  return { tagged, failed, left: Math.max(0, rows.length - tagged - failed) };
}
