import test from 'node:test';
import assert from 'node:assert/strict';
import * as PDFLib from 'pdf-lib';
import { rebrandShipper, textLines, shipperLines } from './sp-label.js';

/* the ShipPrime label's "Shipped By" block, as it came on 27 Oct 2026 (positions from a real label) */
async function label(name = 'Shivang Gupta') {
  const d = await PDFLib.PDFDocument.create(), p = d.addPage([288, 432]);
  const b = await d.embedFont(PDFLib.StandardFonts.HelveticaBold), r = await d.embedFont(PDFLib.StandardFonts.Helvetica);
  p.drawText('Shipped To', { x: 23, y: 402, size: 9, font: b });
  p.drawText('Uday Gowda', { x: 23, y: 386, size: 7, font: b });
  p.drawText('Shipped By', { x: 23, y: 153, size: 8, font: b });
  p.drawText('(If undelivered, return to)', { x: 102, y: 154, size: 6, font: r });
  p.drawText(name, { x: 23, y: 139, size: 7, font: b });
  p.drawText(name, { x: 23, y: 128, size: 6, font: r });
  p.drawText('shop no 1 plot no 26 sector 18 ulwe', { x: 23, y: 118, size: 6, font: r });
  p.drawText('410206', { x: 23, y: 88, size: 6, font: r });
  return d.save();
}

test('the name under "Shipped By" becomes Ink Kulture; the customer and the address stay', async () => {
  const lines = await textLines(await rebrandShipper(await label()));
  const s = lines.map((l) => l.str);
  assert.equal(s.filter((x) => x === 'Ink Kulture').length, 2);
  assert.ok(s.includes('Uday Gowda'));
  assert.ok(s.includes('shop no 1 plot no 26 sector 18 ulwe'));
  assert.ok(s.includes('410206'));
});

test('nothing to change: already the brand, or no "Shipped By" block', async () => {
  assert.deepEqual(shipperLines(await textLines(await label('Ink Kulture')), 'Ink Kulture'), []);
  assert.deepEqual(shipperLines([{ str: 'Ship To', x: 10, y: 400, w: 30, h: 9 }], 'Ink Kulture'), []);
  const bad = Uint8Array.from([1, 2, 3]);
  assert.equal(await rebrandShipper(bad), bad);
});

test('designed label: ShipPrime top kept, brand + return address + contents table below', async () => {
  const { designSpLabel, contentsRows } = await import('./sp-label.js');
  assert.deepEqual(contentsRows([{ title: 'Rose Semi Permanent Tattoo', variantTitle: '5 x 5 cm', quantity: 1 }, { title: 'Rose Semi Permanent Tattoo', variantTitle: '5 x 5 cm', quantity: 2 }, { title: 'Om', variantTitle: 'Default Title', quantity: 1 }])
    .map((r) => [r.title, r.size, r.qty]), [['Rose', '5 x 5 cm', 3], ['Om', '', 1]]);
  const out = await designSpLabel(await label(), { items: [{ title: 'Dragon', variantTitle: 'Large', quantity: 2, image: '' }] });
  const d = await PDFLib.PDFDocument.load(out);
  assert.deepEqual(d.getPages().map((p) => [p.getWidth(), p.getHeight()]), [[288, 432]]);
  const s = (await textLines(out)).map((l) => l.str);
  for (const t of ['INK KULTURE', 'PACKED INSIDE', 'Dragon', 'x2', 'Uday Gowda']) assert.ok(s.includes(t), t);
  /* ShipPrime's own 'Shipped By' block is clipped off by the embedded page's box (still in its text, never drawn) */
  assert.ok(s.some((x) => /return to: Ink Kulture, shop no 1/.test(x)));
});
