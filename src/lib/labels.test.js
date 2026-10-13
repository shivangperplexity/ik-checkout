import test from 'node:test';
import assert from 'node:assert/strict';
import * as PDFLib from 'pdf-lib';
import { labelPdf } from './labels.js';

globalThis.PDFLib = PDFLib;
await import('../public/labels6x4.js');   // the browser-side merger, loaded the same way the dashboard loads it

const pdf = async (w, h, pages = 1) => {
  const d = await PDFLib.PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([w, h]).drawText('label ' + i, { x: 10, y: 10 });
  return d.save();
};
const sizes = async (bytes) => (await PDFLib.PDFDocument.load(bytes)).getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);

test('one 6x4 inch page per label; portrait labels are 4x6 so nothing is rotated; only the first page of a label is used', async () => {
  const out = await globalThis.mergeLabels6x4([await pdf(288, 432), await pdf(432, 288), await pdf(595, 842), await pdf(288, 432, 3)]);
  assert.deepEqual(await sizes(out), [[288, 432], [432, 288], [288, 432], [288, 432]]);
});

test('any number of labels ends up in a single PDF', async () => {
  const one = await pdf(288, 432);
  const out = await globalThis.mergeLabels6x4(Array.from({ length: 120 }, () => one));
  assert.equal((await sizes(out)).length, 120);
});

/* A made-up 4x6 label: a colour "brand logo" picture drawn at (x,y) plus text. */
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
async function fakeLabel(x, y) {
  const d = await PDFLib.PDFDocument.create(), p = d.addPage([288, 432]);
  p.drawImage(await d.embedPng(PNG), { x, y, width: 101.25, height: 63.75 });
  p.drawText('Ship To', { x: 10, y: 410, size: 10 });
  return d.save();
}
async function logoSwaps(bufs, opts) {
  const seen = [], orig = PDFLib.PDFPage.prototype.drawRectangle;
  PDFLib.PDFPage.prototype.drawRectangle = function (o) { seen.push([o.x, o.y, o.width, o.height].map(Math.round)); return orig.call(this, o); };
  try { await globalThis.mergeLabels6x4(bufs, opts); } finally { PDFLib.PDFPage.prototype.drawRectangle = orig; }
  return seen;
}

test('the Shiprocket brand logo (top right) is covered and replaced; a picture elsewhere is left alone', async () => {
  assert.deepEqual(await logoSwaps([await fakeLabel(173, 346)]), [[173, 346, 102, 65]]);
  assert.deepEqual(await logoSwaps([await fakeLabel(10, 20)]), []);            // bottom-left: not the logo spot
  assert.deepEqual(await logoSwaps([await fakeLabel(173, 346)], { keepLogo: true }), []);
});

const rows = [
  { order_id: '1', awb: 'A1', sr_shipment_id: '11', label_url: 'https://x.test/1.pdf', status: 'booked' },
  { order_id: '3', awb: 'A3', sr_shipment_id: '13', label_url: 'https://x.test/3.pdf', status: 'cancelled' },
];
const env = { DB: { prepare() { return { bind: (id) => ({ first: async () => rows.find((r) => r.order_id === id && r.status !== 'cancelled') || null, run: async () => ({}) }) }; } } };

test('labelPdf returns the booked order\'s PDF and refuses cancelled / unbooked orders', async () => {
  const real = globalThis.fetch, a = await pdf(288, 432);
  globalThis.fetch = async () => new Response(a);
  try {
    assert.equal((await sizes(await labelPdf(env, '1')))[0][0], 288);
    await assert.rejects(labelPdf(env, '3'), /not booked/);
    await assert.rejects(labelPdf(env, '9'), /not booked/);
  } finally { globalThis.fetch = real; }
});
