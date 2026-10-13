import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { mergeLabels, buildLabels } from './labels.js';

const pdf = async (w, h, pages = 1) => {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([w, h]).drawText('label', { x: 10, y: 10 });
  return d.save();
};
const sizes = async (bytes) => (await PDFDocument.load(bytes)).getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);

test('every page ends up 6x4 inch (432x288 pt), portrait labels as 4x6', async () => {
  const out = await mergeLabels([await pdf(288, 432), await pdf(432, 288), await pdf(595, 842), await pdf(288, 432, 2)]);
  assert.deepEqual(await sizes(out), [[288, 432], [432, 288], [288, 432], [288, 432], [288, 432]]);
});

test('buildLabels joins booked orders, reports cancelled/unbooked and failed downloads as missing', async () => {
  const rows = [
    { order_id: '1', order_name: '#1001', awb: 'A1', sr_shipment_id: '11', label_url: 'https://x.test/1.pdf', status: 'booked' },
    { order_id: '2', order_name: '#1002', awb: 'A2', sr_shipment_id: '12', label_url: 'https://x.test/2.pdf', status: 'booked' },
    { order_id: '3', order_name: '#1003', awb: 'A3', sr_shipment_id: '13', label_url: 'https://x.test/3.pdf', status: 'cancelled' },
  ];
  const env = { DB: { prepare(sql) { return { bind(...ids) { return { all: async () => ({ results: rows.filter((r) => ids.includes(r.order_id) && r.status !== 'cancelled') }), run: async () => ({}) }; } }; } } };
  const real = globalThis.fetch;
  const a = await pdf(288, 432);
  globalThis.fetch = async (u) => (String(u).endsWith('1.pdf') ? new Response(a) : new Response('nope', { status: 404 }));
  try {
    const r = await buildLabels(env, ['1', '2', '3', '9']);
    assert.equal(r.count, 1);
    assert.deepEqual((await sizes(r.pdf)), [[288, 432]]);
    assert.deepEqual(r.missing.map((m) => m.name).sort(), ['#1002', '3', '9'].sort());
    await assert.rejects(buildLabels(env, []), /No orders selected/);
    await assert.rejects(buildLabels(env, ['3']), /None of these orders/);
  } finally { globalThis.fetch = real; }
});
