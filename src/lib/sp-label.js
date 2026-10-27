/**
 * ShipPrime labels print the pickup contact's name under "Shipped By" (bookings made before 27 Oct 2026 21:00 sent
 * the Shiprocket pickup contact, a person's name). This puts the brand there instead: the name lines right under
 * "Shipped By" (the bold one and the one that starts the return address) are covered with white and the brand is
 * written in the same place and size. The address, barcode and everything else stay as ShipPrime drew them.
 * Any problem reading the PDF returns it unchanged.
 */
import * as PDFLib from 'pdf-lib';
import { LOGO_BOX, LOGO_PATH } from './brand-logo.js';
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
const W = 288, H = 432, L = 14.5, R = 274.5, BOTTOM = 13;   /* lines up with ShipPrime's own frame */
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
  const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold), reg = await doc.embedFont(PDFLib.StandardFonts.Helvetica), ital = await doc.embedFont(PDFLib.StandardFonts.HelveticaOblique);
  const ink = PDFLib.rgb(0, 0, 0), white = PDFLib.rgb(1, 1, 1), grey = PDFLib.rgb(0.32, 0.32, 0.32), soft = PDFLib.rgb(0.62, 0.62, 0.62), hair = PDFLib.rgb(0.82, 0.82, 0.82);
  const X0 = L + 7, X1 = R - 7;
  /* letter-spaced caps, the label's "voice" */
  const caps = (t, x, yy, size, font, color, gap = 0.9) => { let cx = x; for (const ch of t) { page.drawText(ch, { x: cx, y: yy, size, font, color }); cx += font.widthOfTextAtSize(ch, size) + gap; } return cx - gap; };
  const capsW = (t, size, font, gap = 0.9) => [...t].reduce((n, ch) => n + font.widthOfTextAtSize(ch, size) + gap, 0) - gap;
  const rounded = (x, yb, w, h, r) => `M ${x + r} ${-yb - h} H ${x + w - r} Q ${x + w} ${-yb - h} ${x + w} ${-yb - h + r} V ${-yb - r} Q ${x + w} ${-yb} ${x + w - r} ${-yb} H ${x + r} Q ${x} ${-yb} ${x} ${-yb - r} V ${-yb - h + r} Q ${x} ${-yb - h} ${x + r} ${-yb - h} Z`;
  const box = (x, yb, w, h, r, o) => page.drawSvgPath(rounded(x, yb, w, h, r), { x: 0, y: 0, ...o });

  /* the outer frame, continued below the kept part */
  page.drawRectangle({ x: L, y: BOTTOM, width: R - L, height: cut - BOTTOM, borderColor: soft, borderWidth: 0.6, color: white });

  /* 1. brand strip: [SHIPPED BY] tab · INK KULTURE wordmark · SEMI-PERMANENT TATTOOS / inkkulture.in */
  const bandTop = cut - 5, bandH = 24, bandY = bandTop - bandH;
  box(X0, bandY, 34, bandH, 3, { color: ink });
  caps('SHIPPED', X0 + 17 - capsW('SHIPPED', 4.6, bold, 0.5) / 2, bandY + 13.5, 4.6, bold, white, 0.5);
  caps('BY', X0 + 17 - capsW('BY', 4.6, bold, 0.5) / 2, bandY + 6.5, 4.6, bold, white, 0.5);
  const lh = 15, ls = lh / LOGO_BOX.h, lx = X0 + 41, ly = bandY + (bandH - lh) / 2;
  page.drawSvgPath(LOGO_PATH, { x: lx - LOGO_BOX.x * ls, y: ly + lh + LOGO_BOX.y * ls, scale: ls, color: ink, borderWidth: 0 });
  const tag = 'SEMI-PERMANENT TATTOOS';
  caps(tag, X1 - capsW(tag, 4.4, bold, 0.6), bandY + 13.5, 4.4, bold, grey, 0.6);
  page.drawText(site, { x: X1 - bold.widthOfTextAtSize(site, 7.5), y: bandY + 4.5, size: 7.5, font: bold, color: ink });

  /* 2. return address */
  let y = bandY - 8;
  const rt = 'RETURN TO  ';
  caps('RETURN TO', X0, y, 4.6, bold, ink, 0.5);
  const addrLines = wrap(reg, `${brand}, ${addr}`, 5.3, X1 - X0 - capsW(rt, 4.6, bold, 0.5), 2);
  addrLines.forEach((t, k) => page.drawText(t, { x: X0 + capsW(rt, 4.6, bold, 0.5), y: y - k * 6.5, size: 5.3, font: reg, color: grey }));
  y -= addrLines.length * 6.5 + 2;
  /* perforation-style divider */
  for (let x = X0; x < X1; x += 4) page.drawLine({ start: { x, y }, end: { x: Math.min(x + 2, X1), y }, thickness: 0.6, color: soft });

  /* 3. what's inside */
  const rows = contentsRows(items), pcs = rows.reduce((n, r) => n + r.qty, 0);
  y -= 12;
  const pill = "WHAT'S INSIDE", pw = capsW(pill, 5.2, bold, 0.6) + 10;
  box(X0, y - 3, pw, 10.5, 5.25, { color: ink });
  caps(pill, X0 + 5, y, 5.2, bold, white, 0.6);
  if (rows.length) page.drawText(`${rows.length} design${rows.length > 1 ? 's' : ''}  /  ${pcs} pc${pcs > 1 ? 's' : ''}`, { x: X0 + pw + 6, y, size: 6.5, font: reg, color: grey });
  caps('QTY', X1 - capsW('QTY', 4.6, bold, 0.6) - 3, y, 4.6, bold, soft, 0.6);
  y -= 6;
  const footH = 11, room = y - (BOTTOM + footH);
  /* one design per row while they fit at 15 pt; more than that: two columns of compact cells */
  const drawThumb = async (pic, bx, by, img) => {
    box(bx, by, img, img, Math.min(3, img / 6), { borderColor: hair, borderWidth: 0.5, color: white });
    if (!pic) return;
    try {
      const im = pic.kind === 'png' ? await doc.embedPng(pic.b) : await doc.embedJpg(pic.b);
      const inner = img - 2, sc = Math.min(inner / im.width, inner / im.height);
      page.drawImage(im, { x: bx + (img - im.width * sc) / 2, y: by + (img - im.height * sc) / 2, width: im.width * sc, height: im.height * sc });
    } catch { /* empty frame */ }
  };
  const badge = (r, qx, cy, rr) => {
    const q = String(r.qty);
    if (r.qty > 1) page.drawCircle({ x: qx, y: cy, size: rr, color: ink });
    else page.drawCircle({ x: qx, y: cy, size: rr, borderColor: ink, borderWidth: 0.7 });
    const qs = Math.min(8, rr * 1.15);
    page.drawText(q, { x: qx - bold.widthOfTextAtSize(q, qs) / 2, y: cy - qs * 0.36, size: qs, font: bold, color: r.qty > 1 ? white : ink });
  };
  let shown = rows, used = 0;
  if (rows.length && rows.length * 15 <= room) {
    const rowH = Math.min(40, room / rows.length);
    const pics = await Promise.all(rows.map((r) => thumb(r.image)));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], top = y - i * rowH, img = rowH - 5, cy = top - rowH / 2;
      if (i) page.drawLine({ start: { x: X0 + img + 6, y: top }, end: { x: X1, y: top }, thickness: 0.3, color: hair });
      await drawThumb(pics[i], X0, top - 2.5 - img, img);
      const tx = X0 + img + 7, tw = X1 - 18 - tx, ts = rowH >= 24 ? 8 : rowH >= 18 ? 7 : 6.5, two = r.size && rowH >= 18;
      page.drawText(fit(bold, r.title, ts, tw), { x: tx, y: two ? cy + 1.2 : cy - ts / 3, size: ts, font: bold, color: ink });
      if (two) page.drawText(fit(reg, r.size, 6, tw), { x: tx, y: cy - 7, size: 6, font: reg, color: grey });
      /* quantity badge: filled when more than one, so doubles are hard to miss while packing */
      badge(r, X1 - Math.min(6.5, rowH / 2 - 1.5) - 1, cy, Math.min(6.5, rowH / 2 - 1.5));
    }
    used = rows.length * rowH;
  } else if (rows.length) {
    const gap = 8, colW = (X1 - X0 - gap) / 2, perCol = Math.max(1, Math.floor((room - 8) / 12.5));
    const fitsAll = rows.length <= perCol * 2;
    shown = rows.slice(0, fitsAll ? rows.length : perCol * 2 - 1);
    const nCol = Math.ceil(shown.length / 2), rowH = Math.min(18, (room - (fitsAll ? 0 : 9)) / nCol);
    const pics = await Promise.all(shown.map((r) => thumb(r.image)));
    for (let i = 0; i < shown.length; i++) {
      const r = shown[i], col = i < nCol ? 0 : 1, k = col ? i - nCol : i, cx0 = X0 + col * (colW + gap);
      const top = y - k * rowH, img = rowH - 3, cy = top - rowH / 2, rr = Math.min(5, rowH / 2 - 1.5);
      if (k) page.drawLine({ start: { x: cx0, y: top }, end: { x: cx0 + colW, y: top }, thickness: 0.3, color: hair });
      await drawThumb(pics[i], cx0, top - 1.5 - img, img);
      page.drawText(fit(bold, r.title, 6, colW - img - 5 - rr * 2 - 4), { x: cx0 + img + 4, y: cy - 2, size: 6, font: bold, color: ink });
      badge(r, cx0 + colW - rr - 0.5, cy, rr);
    }
    if (nCol > 1 || shown.length > 1) page.drawLine({ start: { x: X0 + colW + gap / 2, y: y - 1 }, end: { x: X0 + colW + gap / 2, y: y - nCol * rowH + 1 }, thickness: 0.3, color: hair });
    used = nCol * rowH;
  }
  if (shown.length < rows.length) {
    const more = rows.slice(shown.length), mp = more.reduce((n, r) => n + r.qty, 0);
    page.drawText(fit(reg, `+ ${more.length} more design${more.length > 1 ? 's' : ''} (${mp} pc${mp > 1 ? 's' : ''}): ${more.map((r) => r.title + (r.qty > 1 ? ' x' + r.qty : '')).join(', ')}`, 6, X1 - X0), { x: X0, y: y - used - 7, size: 6, font: reg, color: grey });
  }
  if (!rows.length) page.drawText('See the order in the dashboard', { x: X0, y: y - 12, size: 6.5, font: reg, color: grey });

  /* 4. sign-off */
  const thanks = 'Thank you for wearing Ink Kulture';
  const tw2 = ital.widthOfTextAtSize(thanks, 6.2);
  page.drawText(thanks, { x: (L + R) / 2 - tw2 / 2, y: BOTTOM + 4.5, size: 6.2, font: ital, color: grey });
  page.drawLine({ start: { x: X0, y: BOTTOM + 6.5 }, end: { x: (L + R) / 2 - tw2 / 2 - 6, y: BOTTOM + 6.5 }, thickness: 0.4, color: hair });
  page.drawLine({ start: { x: (L + R) / 2 + tw2 / 2 + 6, y: BOTTOM + 6.5 }, end: { x: X1, y: BOTTOM + 6.5 }, thickness: 0.4, color: hair });
  return doc.save();
}
