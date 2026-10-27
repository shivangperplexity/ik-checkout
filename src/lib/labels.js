// src/lib/labels.js — the Shiprocket label PDF for ONE booked order.
//
// The dashboard asks for each label separately (small, fast responses) and joins them into a single
// 6 x 4 inch PDF in the browser (public/labels6x4.js). That way any number of labels works: nothing here
// has a page-count or response-size limit.

import { ensureLabel } from './shiprocket.js';

const now = () => Math.floor(Date.now() / 1000);

async function download(url) {
  if (!/^https:\/\//i.test(url || '')) throw new Error('no label link');
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('download failed (' + r.status + ')');
  const buf = new Uint8Array(await r.arrayBuffer());
  if (String.fromCharCode(...buf.slice(0, 4)) !== '%PDF') throw new Error('not a PDF');
  return buf;
}

/** Label PDF bytes for a Shopify order id: the stored link first; if it is missing or no longer works, ask Shiprocket for a fresh one. */
export async function labelPdf(env, orderId) {
  const id = String(orderId || '');
  const rec = await env.DB.prepare("SELECT * FROM shipments WHERE order_id=? AND awb IS NOT NULL AND awb<>'' AND COALESCE(status,'')<>'cancelled'").bind(id).first();
  if (!rec) throw new Error('not booked with Shiprocket, or its shipment was cancelled');
  if (rec.provider === 'shipprime') {
    /* ShipPrime: "Shipped By" shows the brand, whatever name the booking carried */
    const { rebrandShipper } = await import('./sp-label.js');
    return rebrandShipper(await download(await ensureLabel(env, rec)));
  }
  try { return await download(await ensureLabel(env, rec)); }
  catch (first) {
    if (!rec.sr_shipment_id) throw first;
    const url = await ensureLabel(env, rec, true);
    const buf = await download(url);
    if (url && url !== rec.label_url) await env.DB.prepare('UPDATE shipments SET label_url=?, updated_at=? WHERE order_id=?').bind(url, now(), id).run();
    return buf;
  }
}
