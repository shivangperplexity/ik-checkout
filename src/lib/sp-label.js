/**
 * ShipPrime labels print the pickup contact's name under "Shipped By" (bookings made before 27 Oct 2026 21:00 sent
 * the Shiprocket pickup contact, a person's name). This puts the brand there instead: the name lines right under
 * "Shipped By" (the bold one and the one that starts the return address) are covered with white and the brand is
 * written in the same place and size. The address, barcode and everything else stay as ShipPrime drew them.
 * Any problem reading the PDF returns it unchanged.
 */
import * as PDFLib from 'pdf-lib';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const fontDir = () => path.join(path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')), '..', '..', 'standard_fonts') + path.sep;

let PDFJS = null;
async function pdfjs() {
  if (PDFJS) return PDFJS;
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  PDFJS = lib;
  return lib;
}

/** Text lines of page 1: [{ str, x, y, w, h }] (PDF points, y up). */
export async function textLines(bytes) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, standardFontDataUrl: fontDir(), verbosity: 0 }).promise;
  try {
    const pg = await doc.getPage(1);
    const tc = await pg.getTextContent();
    return tc.items.filter((t) => String(t.str || '').trim()).map((t) => ({ str: String(t.str).trim(), x: t.transform[4], y: t.transform[5], w: t.width, h: Math.abs(t.transform[3]) || t.height || 7 }));
  } finally { await doc.destroy().catch(() => {}); }
}

/** Pure: which text lines to replace. The lines under "Shipped By" in its column that repeat the first name line. */
export function shipperLines(lines, brand) {
  const head = lines.find((l) => /^shipped by$/i.test(l.str));
  if (!head) return [];
  const below = lines.filter((l) => l.y < head.y - 2 && l.y > head.y - 40 && Math.abs(l.x - head.x) < 4).sort((a, b) => b.y - a.y);
  const name = below[0];
  if (!name || name.str.toLowerCase() === String(brand).toLowerCase() || /\d/.test(name.str)) return [];
  return below.slice(0, 3).filter((l) => l.str === name.str);
}

export async function rebrandShipper(bytes, brand = 'Ink Kulture') {
  try {
    const hits = shipperLines(await textLines(bytes), brand);
    if (!hits.length) return bytes;
    const doc = await PDFLib.PDFDocument.load(bytes);
    const page = doc.getPages()[0];
    const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold), reg = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const top = Math.max(...hits.map((l) => l.h));
    for (const l of hits) {
      page.drawRectangle({ x: l.x - 1, y: l.y - l.h * 0.3, width: Math.max(l.w, 60) + 2, height: l.h * 1.35, color: PDFLib.rgb(1, 1, 1) });
      page.drawText(brand, { x: l.x, y: l.y, size: l.h, font: l.h >= top ? bold : reg, color: PDFLib.rgb(0, 0, 0) });
    }
    return await doc.save();
  } catch (e) {
    console.error('shipprime label rebrand', e.message);
    return bytes;
  }
}

/* ---------- the Ink Kulture ShipPrime label ---------- */
/*
 * ShipPrime's 4x6 label, top part kept exactly as ShipPrime drew it (ship-to, COD amount, QR, courier, AWB barcode:
 * what the courier scans), and the bottom part (ShipPrime's "Shipped By" block) redrawn:
 *   SHIPPED BY  Ink Kulture                         inkkulture.in
 *   If undelivered, return to: <pickup address>
 *   PACKED INSIDE · 3 designs · 4 pcs
 *   [img] Design name                     Size        x2
 * Design pictures come from Shopify. Anything missing (no "Shipped By" found, Shopify down) falls back to the
 * rebranded ShipPrime label.
 */
const W = 288, H = 432, L = 15, R = 275, BOTTOM = 13;   /* ShipPrime's own frame: x 15..275 */
const ascii = (s) => String(s || '').normalize('NFKD').replace(/[×✕]/g, 'x').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
function fit(font, text, size, max) {
  let t = ascii(text);
  if (font.widthOfTextAtSize(t, size) <= max) return t;
  while (t.length > 1 && font.widthOfTextAtSize(t + '...', size) > max) t = t.slice(0, -1);
  return t.trimEnd() + '...';
}
function wrap(font, text, size, max, lines = 2) {
  const words = ascii(text).split(' '), out = [];
  let cur = '';
  for (const w of words) {
    const nx = cur ? cur + ' ' + w : w;
    if (font.widthOfTextAtSize(nx, size) <= max) cur = nx;
    else { if (cur) out.push(cur); cur = w; if (out.length === lines) break; }
  }
  if (cur && out.length < lines) out.push(cur);
  if (out.length === lines && words.join(' ').length > out.join(' ').length) out[lines - 1] = fit(font, out[lines - 1] + ' ...', size, max);
  return out;
}
/** Shopify image -> small JPEG/PNG bytes (pdf-lib takes no WebP), or null. */
async function thumb(url) {
  if (!/^https:\/\//.test(url || '')) return null;
  try {
    const u = new URL(url); u.searchParams.set('width', '160'); if (/cdn\.shopify\.com|\/cdn\/shop\//.test(u.href)) u.searchParams.set('format', 'jpg');
    const r = await fetch(u.href, { headers: { Accept: 'image/jpeg,image/png;q=0.9' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    if (b[0] === 0xff && b[1] === 0xd8) return { kind: 'jpg', b };
    if (b[0] === 0x89 && b[1] === 0x50) return { kind: 'png', b };
    return null;
  } catch { return null; }
}
/** Same design + size listed twice (two Shopify lines) -> one row with the quantities added. Pure. */
export function contentsRows(items) {
  const rows = [];
  for (const i of items || []) {
    const title = ascii(String(i.title || 'Tattoo').replace(/\s*[-|]?\s*semi[- ]?permanent tattoo\s*$/i, '')), size = ascii(i.variantTitle || i.size || '').replace(/^default title$/i, '');
    const same = rows.find((r) => r.title === title && r.size === size);
    if (same) { same.qty += Number(i.quantity || i.qty) || 1; continue; }
    rows.push({ title, size, qty: Number(i.quantity || i.qty) || 1, image: i.image || '' });
  }
  return rows;
}

/** ShipPrime label bytes + the order's items -> the designed label. */
export async function designSpLabel(bytes, { items = [], brand = 'Ink Kulture', site = 'inkkulture.in' } = {}) {
  const lines = await textLines(bytes);
  const head = lines.find((l) => /^shipped by$/i.test(l.str));
  if (!head || head.y < 60 || head.y > 260) return rebrandShipper(bytes, brand);
  const below = lines.filter((l) => l.y < head.y - 2 && l.y > head.y - 80 && Math.abs(l.x - head.x) < 4).sort((a, b) => b.y - a.y);
  const name = below[0]?.str || '';
  const addr = below.filter((l) => l.str !== name).map((l) => l.str).join(', ');

  const src = await PDFLib.PDFDocument.load(bytes);
  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([W, H]);
  const cut = head.y + 9;                                             /* everything above ShipPrime's "Shipped By" */
  const top = await doc.embedPage(src.getPages()[0], { left: 0, bottom: cut, right: W, top: H });
  page.drawPage(top, { x: 0, y: cut, width: W, height: H - cut });
  const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold), reg = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const ink = PDFLib.rgb(0, 0, 0), grey = PDFLib.rgb(0.35, 0.35, 0.35), line = PDFLib.rgb(0.6, 0.6, 0.6);
  /* the outer frame, continued below the kept part */
  page.drawRectangle({ x: L, y: BOTTOM, width: R - L, height: cut - BOTTOM, borderColor: line, borderWidth: 0.6, color: PDFLib.rgb(1, 1, 1) });
  page.drawLine({ start: { x: L, y: cut }, end: { x: L, y: BOTTOM }, thickness: 0.6, color: line });

  let y = cut - 12;
  /* SHIPPED BY  Ink Kulture ............ inkkulture.in */
  page.drawText('SHIPPED BY', { x: L + 7, y, size: 6, font: bold, color: grey });
  page.drawText(ascii(brand).toUpperCase(), { x: L + 7 + bold.widthOfTextAtSize('SHIPPED BY', 6) + 6, y: y - 1, size: 11, font: bold, color: ink });
  page.drawText(site, { x: R - 7 - reg.widthOfTextAtSize(site, 7), y, size: 7, font: reg, color: grey });
  y -= 10;
  for (const t of wrap(reg, `If undelivered, return to: ${brand}, ${addr}`, 5.5, R - L - 14, 2)) { page.drawText(t, { x: L + 7, y, size: 5.5, font: reg, color: grey }); y -= 7; }
  y -= 1;
  page.drawLine({ start: { x: L + 6, y }, end: { x: R - 6, y }, thickness: 0.6, color: line });

  /* PACKED INSIDE */
  const rows = contentsRows(items), pcs = rows.reduce((n, r) => n + r.qty, 0);
  y -= 10;
  page.drawText('PACKED INSIDE', { x: L + 7, y, size: 7, font: bold, color: ink });
  if (rows.length) page.drawText(`${rows.length} design${rows.length > 1 ? 's' : ''} · ${pcs} pc${pcs > 1 ? 's' : ''}`.replace('·', '-'), { x: L + 7 + bold.widthOfTextAtSize('PACKED INSIDE', 7) + 6, y, size: 7, font: reg, color: grey });
  page.drawText('QTY', { x: R - 7 - bold.widthOfTextAtSize('QTY', 6), y, size: 6, font: bold, color: grey });
  y -= 4;
  const room = y - (BOTTOM + 4);
  let rowH = rows.length ? Math.min(40, room / rows.length) : 0, shown = rows;
  if (rowH < 15) { const k = Math.max(1, Math.floor((room - 9) / 15)); shown = rows.slice(0, k); rowH = 15; }
  const pics = await Promise.all(shown.map((r) => thumb(r.image)));
  for (let i = 0; i < shown.length; i++) {
    const r = shown[i], top = y - i * rowH, img = rowH - 4, cy = top - rowH / 2;
    if (i) page.drawLine({ start: { x: L + 6, y: top }, end: { x: R - 6, y: top }, thickness: 0.3, color: PDFLib.rgb(0.8, 0.8, 0.8) });
    const box = { x: L + 7, y: top - 2 - img, width: img, height: img };
    let drawn = false;
    if (pics[i]) {
      try {
        const im = pics[i].kind === 'png' ? await doc.embedPng(pics[i].b) : await doc.embedJpg(pics[i].b);
        const s = Math.min(img / im.width, img / im.height);
        page.drawImage(im, { x: box.x + (img - im.width * s) / 2, y: box.y + (img - im.height * s) / 2, width: im.width * s, height: im.height * s });
        drawn = true;
      } catch { /* drawn as an empty box */ }
    }
    if (!drawn) page.drawRectangle({ x: box.x, y: box.y, width: img, height: img, borderColor: line, borderWidth: 0.5 });
    const tx = box.x + img + 6, qtyW = 22, tw = R - 7 - qtyW - tx;
    const ts = rowH >= 22 ? 7.5 : 6.5;
    page.drawText(fit(bold, r.title, ts, tw), { x: tx, y: r.size && rowH >= 18 ? cy + 1 : cy - ts / 3, size: ts, font: bold, color: ink });
    if (r.size && rowH >= 18) page.drawText(fit(reg, r.size, 6, tw), { x: tx, y: cy - 7, size: 6, font: reg, color: grey });
    const q = 'x' + r.qty;
    page.drawText(q, { x: R - 7 - bold.widthOfTextAtSize(q, r.qty > 1 ? 10 : 8), y: cy - 3, size: r.qty > 1 ? 10 : 8, font: bold, color: ink });
  }
  if (shown.length < rows.length) {
    const more = rows.slice(shown.length), mp = more.reduce((n, r) => n + r.qty, 0);
    page.drawText(fit(reg, `+ ${more.length} more design${more.length > 1 ? 's' : ''} (${mp} pc${mp > 1 ? 's' : ''}): ${more.map((r) => r.title + (r.qty > 1 ? ' x' + r.qty : '')).join(', ')}`, 6, R - L - 14), { x: L + 7, y: BOTTOM + 5, size: 6, font: reg, color: grey });
  }
  if (!rows.length) page.drawText('See the order in the dashboard', { x: L + 7, y: y - 12, size: 6.5, font: reg, color: grey });
  return doc.save();
}
