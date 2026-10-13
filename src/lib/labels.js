// src/lib/labels.js — download many shipping labels as ONE print-ready PDF made of 6 x 4 inch pages.
//
// Shiprocket gives one label PDF per shipment (its own page size). Here each label page is scaled to fit a
// 6 x 4 inch page (never stretched) and all of them are joined, so a single print job covers the whole batch.
// A landscape label gets a 6 wide x 4 tall page; a portrait label gets 4 wide x 6 tall, so nothing is rotated.

import { PDFDocument } from 'pdf-lib';
import { ensureLabel } from './shiprocket.js';

const PT = 72;                 // PDF points per inch
const LONG = 6 * PT, SHORT = 4 * PT;
export const MAX_LABELS = 40;  // per request, keeps the PDF under the serverless response limit
const now = () => Math.floor(Date.now() / 1000);

/** Join label PDFs (Uint8Array each) into one document of 6 x 4 inch pages. */
export async function mergeLabels(buffers) {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    const pages = await out.embedPdf(src, src.getPageIndices());
    for (const p of pages) {
      const land = p.width >= p.height;
      const pw = land ? LONG : SHORT, ph = land ? SHORT : LONG;
      const k = Math.min(pw / p.width, ph / p.height);
      const w = p.width * k, h = p.height * k;
      out.addPage([pw, ph]).drawPage(p, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
  }
  return out.save();
}

async function download(url) {
  if (!/^https:\/\//i.test(url || '')) throw new Error('no label link');
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('download failed (' + r.status + ')');
  const buf = new Uint8Array(await r.arrayBuffer());
  if (String.fromCharCode(...buf.slice(0, 4)) !== '%PDF') throw new Error('not a PDF');
  return buf;
}

/** One order's label PDF: the stored link first; if that is missing or no longer works, ask Shiprocket for a fresh one. */
async function labelFor(env, rec) {
  try { return await download(await ensureLabel(env, rec)); }
  catch (first) {
    if (!rec.sr_shipment_id) throw first;
    const url = await ensureLabel(env, rec, true);
    const buf = await download(url);
    if (url && url !== rec.label_url) await env.DB.prepare('UPDATE shipments SET label_url=?, updated_at=? WHERE order_id=?').bind(url, now(), String(rec.order_id)).run();
    return buf;
  }
}

/** Build the combined PDF for these Shopify order ids. Cancelled / unbooked orders are skipped. */
export async function buildLabels(env, ids) {
  ids = [...new Set((ids || []).map(String).filter(Boolean))].slice(0, MAX_LABELS);
  if (!ids.length) throw new Error('No orders selected');
  const rows = (await env.DB.prepare(`SELECT * FROM shipments WHERE order_id IN (${ids.map(() => '?').join(',')}) AND awb IS NOT NULL AND awb<>'' AND COALESCE(status,'')<>'cancelled'`).bind(...ids).all()).results;
  const byId = Object.fromEntries(rows.map((r) => [String(r.order_id), r]));
  const list = ids.map((id) => byId[id]).filter(Boolean);
  if (!list.length) throw new Error('None of these orders has a Shiprocket label yet. Book them first.');

  const got = new Array(list.length), missing = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      try { got[i] = await labelFor(env, list[i]); } catch (e) { missing.push({ name: list[i].order_name || list[i].order_id, why: String(e.message || e).slice(0, 80) }); }
    }
  }));
  for (const id of ids) if (!byId[id]) missing.push({ name: id, why: 'not booked with Shiprocket, or its shipment was cancelled' });
  const buffers = got.filter(Boolean);
  if (!buffers.length) throw new Error('Could not get any label from Shiprocket: ' + missing.map((m) => `${m.name} (${m.why})`).join(', '));
  return { pdf: await mergeLabels(buffers), count: buffers.length, missing };
}
