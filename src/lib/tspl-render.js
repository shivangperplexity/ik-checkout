/**
 * Label PDF -> ready printer commands (TSPL), made on the server so the packing Mac only has to pass bytes to the
 * printer over Bluetooth.
 *
 * Each page is drawn with PDF.js at the printer's own resolution (8 dots per mm = 203 dpi) onto a white canvas
 * (@napi-rs/canvas), turned into pure black and white with one threshold (no dithering: sharp text, barcodes that
 * scan) and sent as one TSPL BITMAP with the label size, gap, darkness, speed and direction from Settings.
 * The same packing as public/btprint.js (Bluetooth from the browser): bit 0 = print a dot.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
let PDFJS = null;
async function pdfjs() {
  if (PDFJS) return PDFJS;
  /* PDF.js draws glyphs with the global Path2D / DOMMatrix / ImageData: use the canvas library's own */
  const C = await import('@napi-rs/canvas');
  for (const k of ['Path2D', 'DOMMatrix', 'ImageData']) if (C[k]) globalThis[k] = C[k];
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  lib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  PDFJS = lib;
  return lib;
}
const fontDir = () => path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
const concat = (list) => { const out = new Uint8Array(list.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of list) { out.set(x, o); o += x.length; } return out; };

/** RGBA pixels -> TSPL label. Returns { bytes, black } (black = dots printed). */
export function tsplFromPixels(rgba, W, H, t) {
  const wb = Math.ceil(W / 8), bits = new Uint8Array(wb * H).fill(0xff), thr = Number(t.threshold) || 160;
  let black = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, a = rgba[i + 3];
      const r = (rgba[i] * a + 255 * (255 - a)) / 255, g = (rgba[i + 1] * a + 255 * (255 - a)) / 255, b = (rgba[i + 2] * a + 255 * (255 - a)) / 255;
      let dark = (r * 299 + g * 587 + b * 114) / 1000 < thr;
      if (t.invert) dark = !dark;
      if (dark) { bits[y * wb + (x >> 3)] &= ~(0x80 >> (x & 7)); black++; }
    }
  }
  const head = `SIZE ${t.w} mm,${t.h} mm\r\nGAP ${t.gap} mm,0 mm\r\nSPEED ${t.speed}\r\nDENSITY ${t.density}\r\nDIRECTION ${t.direction ? 1 : 0},0\r\n`
    + `REFERENCE 0,0\r\nOFFSET 0 mm\r\nSET TEAR ON\r\nCLS\r\nBITMAP 0,0,${wb},${H},0,`;
  return { bytes: concat([ascii(head), bits, ascii('\r\nPRINT 1,1\r\n')]), black };
}

/** PDF bytes -> one TSPL job for all pages (blank pages skipped). */
export async function pdfToTspl(pdf, tune) {
  const t = { w: 100, h: 150, gap: 2, density: 12, speed: 3, direction: 1, threshold: 160, invert: false, ...(tune || {}) };
  const { createCanvas } = await import('@napi-rs/canvas');
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(pdf), standardFontDataUrl: fontDir(), disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const W = Math.round(t.w * 8), H = Math.round(t.h * 8), jobs = [];
  let pages = 0, black = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const v0 = page.getViewport({ scale: 1 });
    const turn = (v0.width > v0.height) !== (W > H);
    const vr = page.getViewport({ scale: 1, rotation: (v0.rotation + (turn ? 90 : 0)) % 360 });
    const k = Math.min(W / vr.width, H / vr.height);
    const vp = page.getViewport({ scale: k, rotation: (v0.rotation + (turn ? 90 : 0)) % 360 });
    const cv = createCanvas(W, H), g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    g.translate(Math.round((W - vp.width) / 2), Math.round((H - vp.height) / 2));
    await page.render({ canvasContext: g, viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
    const img = g.getImageData(0, 0, W, H);
    const job = tsplFromPixels(img.data, W, H, t);
    page.cleanup();
    if (job.black < 50) continue;
    jobs.push(job.bytes); pages++; black += job.black;
  }
  await doc.destroy();
  if (!jobs.length) throw new Error('the label PDF has nothing to print');
  return { bytes: concat(jobs), pages, black, W, H };
}
