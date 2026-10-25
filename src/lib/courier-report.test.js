import test from 'node:test';
import assert from 'node:assert/strict';
import { familyOf, modeOf, wilson, parcelOf, buildReport } from './courier-report.js';
import { courierName } from './revenue.js';

const T = 1_800_000_000, D = 86400;

test('courier names', () => {
  assert.equal(familyOf('Blue Dart Surface'), 'Blue Dart'); assert.equal(familyOf('Bluedart Air'), 'Blue Dart');
  assert.equal(familyOf('Xpressbees Air'), 'Xpressbees'); assert.equal(familyOf('Amazon Surface 1KG_Stressed'), 'Amazon');
  assert.equal(modeOf('Delhivery Air'), 'Air'); assert.equal(modeOf('Delhivery Surface'), 'Surface');
  assert.equal(courierName({ fulfillments: [{ displayStatus: 'CANCELED', trackingInfo: [{ company: 'Xpressbees Air' }] }, { displayStatus: 'DELIVERED', trackingInfo: [{ company: 'Blue Dart Surface' }] }] }), 'Blue Dart Surface');
  assert.deepEqual(wilson(0, 8), [0, 32]);
});

test('parcels from Shiprocket and NimbusPost rows', () => {
  const sr = parcelOf({ name: '#1', pay: 'cod', region: 'Maharashtra', sr_awb: '1', sr_courier: 'Blue Dart Surface', sr_stage: 'delivered', sr_rto: true, sr_created: T, sr_charge: 12500 }, T);
  assert.equal(sr.outcome, 'rto'); assert.equal(sr.via, 'Shiprocket'); assert.equal(sr.charge, 125);
  assert.equal(parcelOf({ sr_awb: '1', sr_courier: 'Delhivery Air', sr_stage: 'pickup_pending' }, T), null);
  const nb = parcelOf({ name: '#2', pay: 'cod', region: 'DELHI', carrier: 'nimbuspost', courier: 'Xpressbees Air', state: 'returned', shipped_at: T - 9 * D }, T);
  assert.equal(nb.via, 'NimbusPost'); assert.equal(nb.outcome, 'rto'); assert.equal(nb.state, 'Delhi');
  assert.equal(parcelOf({ carrier: 'nimbuspost', courier: 'Xpressbees Air', state: 'shipped', shipped_at: T - 40 * D }, T).outcome, 'stale');
  assert.equal(parcelOf({ carrier: 'nimbuspost', courier: '', state: 'delivered' }, T), null);
});

test('report: RTO %, state adjustment, speed, cost', () => {
  const P = (family, state, outcome, extra = {}) => ({ via: 'Shiprocket', family, mode: 'Surface', state, outcome, pay: 'cod', booked: T, delivered_at: outcome === 'delivered' ? T + 3 * D : null, first_scan: T + 20 * 3600, charge: 100, attempts: outcome === 'rto' ? 1 : null, ...extra });
  const parcels = [
    ...Array(8).fill(0).map(() => P('Blue Dart', 'Maharashtra', 'delivered')),
    ...Array(5).fill(0).map(() => P('Xpressbees', 'Maharashtra', 'delivered')), ...Array(5).fill(0).map(() => P('Xpressbees', 'Maharashtra', 'rto')),
    ...Array(2).fill(0).map(() => P('Xpressbees', 'Assam', 'rto')), P('Xpressbees', 'Assam', 'transit'),
  ];
  const r = buildReport(parcels);
  const bd = r.families.find((f) => f.key === 'Blue Dart'), xb = r.families.find((f) => f.key === 'Xpressbees');
  assert.equal(bd.rto_pct, 0); assert.equal(xb.rto_pct, 58); assert.equal(xb.transit, 1);
  assert.equal(bd.adj, 0); assert.ok(xb.adj > 1);
  assert.equal(bd.days_to_deliver, 3); assert.equal(bd.hours_to_scan, 20); assert.equal(bd.scanned_48h, 100);
  assert.equal(bd.cost_per_delivered, 100); assert.equal(xb.cost_per_delivered, Math.round((5 * 100 + 7 * 200) / 5));
  const mh = r.head_to_head.rows.find((x) => x.state === 'Maharashtra');
  assert.deepEqual(mh['Blue Dart'], { n: 8, rto: 0 }); assert.deepEqual(mh.Xpressbees, { n: 10, rto: 5 });
});
