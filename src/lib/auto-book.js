/**
 * Daily booking (Nov 2026: parcels picked up 4+ days after the order came back 63% of the time, against 47-49%).
 * From `hour` IST (default 11) to hour + 3, each cron run books up to PER ready orders with ShipPrime (smart courier
 * choice, Blue Dart test included) and sends the customer the "booked + track page + how to apply" WhatsApp.
 *
 * Ready = prepaid (paid), partial COD (advance paid), or COD that is confirmed (WhatsApp YES or checkout OTP);
 * placed at least an hour ago and within 10 days; no live booking; not cancelled; no open cancellation request;
 * a typed address (no link / map code); and no Shopify tag hold / do-not-ship / risk-high.
 * Unconfirmed COD is never booked here (77% of those came back).
 * Settings shipping.auto_book { on (default true), hour (default 11), per (default 6) }.
 */
const now = () => Math.floor(Date.now() / 1000);
const HOLD_TAG = /^(hold|on-hold|do-not-ship|dont-ship|risk-high|fraud)$/i;

export function bookCfg(env) {
  const c = env.SETTINGS?.shipping?.auto_book || {};
  return { on: c.on !== false, hour: Math.max(0, Math.min(20, Number(c.hour ?? 11))), per: Math.max(1, Math.min(10, Number(c.per) || 6)) };
}

export async function readyOrders(env, { limit = 40 } = {}) {
  const t = now();
  const rows = (await env.DB.prepare(`SELECT o.* FROM orders o
      LEFT JOIN shipments s ON s.order_id=o.order_id AND COALESCE(s.status,'')<>'cancelled' AND s.awb IS NOT NULL AND s.awb<>''
      LEFT JOIN cancel_requests r ON r.order_id=o.order_id AND r.status='open'
      WHERE o.order_id IS NOT NULL AND s.order_id IS NULL AND r.id IS NULL AND o.shipped_at IS NULL
        AND o.created_at < ? AND o.created_at > ?
        AND ((o.method='prepaid' AND o.status='paid') OR (o.method='cod' AND o.status='placed' AND (COALESCE(o.advance_paise,0)>0 OR o.confirmed_at IS NOT NULL OR o.otp_at IS NOT NULL OR o.converted_at IS NOT NULL)))
      ORDER BY o.created_at LIMIT ?`).bind(t - 3600, t - 10 * 86400, limit).all()).results;
  if (!rows.length) return [];
  /* Shopify: still open, and not held by a tag */
  const { gql } = await import('./shopify.js');
  const d = await gql(env, `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Order { legacyResourceId tags cancelledAt displayFulfillmentStatus shippingAddress { address1 address2 } } } }`, { ids: rows.map((r) => `gid://shopify/Order/${r.order_id}`) });
  const by = Object.fromEntries((d.nodes || []).filter(Boolean).map((n) => [String(n.legacyResourceId), n]));
  const { addressProblem } = await import('./address-check.js');
  return rows.filter((r) => {
    const n = by[String(r.order_id)];
    if (!n || n.cancelledAt || (n.displayFulfillmentStatus && n.displayFulfillmentStatus !== 'UNFULFILLED')) return false;
    if ((n.tags || []).some((x) => HOLD_TAG.test(String(x).trim()))) return false;
    return !addressProblem(n.shippingAddress?.address1, n.shippingAddress?.address2 || 'x');
  });
}

export async function autoBook(env) {
  const c = bookCfg(env);
  if (!c.on || !env.DB) return { skipped: 'off' };
  const h = new Date(Date.now() + 19800000).getUTCHours();
  if (h < c.hour || h >= c.hour + 3) return { skipped: 'outside the booking hours' };
  const { spConnected } = await import('./shipprime.js');
  if (!spConnected(env)) return { skipped: 'ShipPrime not connected' };
  const list = (await readyOrders(env)).slice(0, c.per);
  const { action } = await import('./admin.js');
  const { nextPickup } = await import('./addr-fix.js');
  const { trackLink } = await import('./self-cancel.js');
  const { fireTrigger } = await import('./whatsapp.js');
  const A = await import('./apply-guide.js');
  const out = { booked: [], failed: [] };
  for (const r of list) {
    try {
      const b = await action('ship_book')(env, { id: r.order_id, provider: 'shipprime' });
      const sh = b.shipment || {};
      if (!sh.awb) throw new Error(b.note || 'no AWB');
      out.booked.push(`${r.order_name} ${sh.courier || ''}`);
      const courier = String(sh.courier || '').replace(/\s+(Premium|Surface|Air)$/i, '') || 'our courier';
      await fireTrigger(env, 'ship_booked', { to: r.phone, vars: { name: String(r.first_name || 'there').split(/\s+/)[0], order: r.order_name, courier, pickup: nextPickup(), edd: '3-6 days after pickup', track: await trackLink(env, r.order_id), ytid: A.ytId(A.applyVideo(env)) }, orderName: r.order_name, force: true }).catch(() => {});
    } catch (e) {
      out.failed.push(`${r.order_name}: ${String(e.message || e).slice(0, 120)}`);
      /* wallet empty / ShipPrime down: stop this run, the next one tries again */
      if (/wallet|balance|insufficient|recharge|did not answer|401/i.test(String(e.message))) break;
    }
  }
  if (out.booked.length || out.failed.length) console.log('auto book', JSON.stringify(out));
  return out;
}
