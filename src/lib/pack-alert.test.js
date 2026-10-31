import test from 'node:test';
import assert from 'node:assert/strict';
import { dueSlot, orderList, packCfg, pickupText } from './pack-alert.js';
import { TRIGGERS } from './settings.js';
import { ALL } from './notify-templates.js';

const ist = (hh, mm) => Date.UTC(2026, 10, 2, hh, mm) / 1000 - 19800;

test('pack-alert: slots fire for 30 minutes at 10:00, 12:00, 14:30 and 16:45 IST only', () => {
  assert.equal(dueSlot(ist(9, 59)), null);
  assert.equal(dueSlot(ist(10, 0)).id, 'am');
  assert.equal(dueSlot(ist(10, 29)).id, 'am');
  assert.equal(dueSlot(ist(10, 30)), null);
  assert.equal(dueSlot(ist(12, 5)).id, 'noon');
  assert.equal(dueSlot(ist(14, 40)).id, 'mid');
  assert.equal(dueSlot(ist(17, 10)).id, 'last');
  assert.equal(dueSlot(ist(18, 0)), null);
  assert.equal(dueSlot(ist(3, 44)), null);
});

test('pack-alert: numbers, pickup window and order list', () => {
  const c = packCfg({});
  assert.deepEqual(c.to, ['9987453483', '7039128567']);
  assert.deepEqual(c.packed_to, ['9987453483']);
  assert.equal(pickupText(c), '12:30 pm – 6 pm');
  assert.deepEqual(packCfg({ SETTINGS: { shipping: { pack_alert: { to: '+91 70391 28567, 123', pickup: 'bad' } } } }).to, ['7039128567']);
  const rows = Array.from({ length: 28 }, (_, i) => ({ name: '#' + (1900 + i) }));
  assert.equal(orderList(rows.slice(0, 2)), '#1900, #1901');
  assert.match(orderList(rows), /#1924 \+3 more$/);
  assert.ok(!/\n/.test(orderList(rows)));
});

test('pack-alert: triggers point at submitted templates with the same variables', () => {
  for (const k of ['pack_pending', 'pack_done']) {
    const tpl = ALL.find((t) => t.name === TRIGGERS[k].def);
    assert.ok(tpl, k);
    const body = tpl.components.find((c) => c.type === 'BODY').text;
    for (const v of TRIGGERS[k].vars) assert.ok(body.includes(`{{${v}}}`), `${k}: ${v}`);
  }
});
