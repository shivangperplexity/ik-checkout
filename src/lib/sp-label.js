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
