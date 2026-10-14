import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './sr-scan.js';
import { adaptTrack } from './shiprocket.js';
import { classify } from './wa-ship.js';

/* Shiprocket courier/track/awb replies shaped like this account's real parcels (scan texts from shiprocket.co/tracking, 15 Oct 2026).
   The overall status / per-scan labels are deliberately set to the misleading values seen before pickup. */
const reply = (current, scans) => ({ tracking_data: { track_status: 1, shipment_track: [{ current_status: current }],
  shipment_track_activities: scans.map(([date, activity, label]) => ({ date, activity, 'sr-status-label': label || 'NA', location: 'Navi Mumbai' })) } });

const XB_1521 = reply('IN TRANSIT', [   // Xpressbees: hub scans, then "Pickup Not Done"
  ['2026-10-13 23:10:00', 'Order Received'], ['2026-10-13 23:11:00', 'Data Received', 'SHIPPED'],
  ['2026-10-14 00:02:00', 'Out For Pickup', 'OUT FOR PICKUP'], ['2026-10-14 12:40:00', 'Pickup Not Done', 'PICKUP EXCEPTION']]);
const BD_1526 = reply('PICKUP EXCEPTION', [ // Blue Dart
  ['2026-10-13 23:10:00', 'Order Received'], ['2026-10-14 21:04:00', 'PICKUP WRONGLY REGISTERED BY SHIPPER']]);
const DL_1410 = reply('IN TRANSIT', [   // Delhivery: manifested, courier on the way, not collected yet
  ['2026-10-13 22:54:00', 'Order Received'], ['2026-10-14 12:13:00', 'Manifested - Out for Pickup', 'IN TRANSIT']]);
const DL_1550 = reply('In Transit', [   // Delhivery: really picked up and moving
  ['2026-10-13 23:10:00', 'Order Received'], ['2026-10-14 12:13:00', 'Manifested - Out for Pickup'], ['2026-10-14 15:30:00', 'In Transit - Shipment picked up'],
  ['2026-10-14 18:51:00', 'In Transit - Shipment Recieved at Origin Center'], ['2026-10-14 20:13:00', 'In Transit - Bag Added To Trip'], ['2026-10-15 00:22:00', 'In Transit - Trip Arrived']]);

test('real parcels: pickup exception / pending / really picked up', () => {
  assert.equal(summarize(XB_1521).stage, 'pickup_failed', 'Xpressbees "Pickup Not Done" even though Shiprocket says IN TRANSIT');
  assert.equal(summarize(BD_1526).stage, 'pickup_failed', 'Blue Dart "PICKUP WRONGLY REGISTERED BY SHIPPER"');
  assert.equal(summarize(DL_1410).stage, 'pickup_pending', 'Delhivery "Manifested - Out for Pickup" is not picked up');
  const s = summarize(DL_1550);
  assert.equal(s.stage, 'transit');
  assert.equal(s.pickedAt, '2026-10-14 15:30:00', 'the real pickup scan time');
});

test('a failed pickup followed by a new attempt is waiting again; later stages', () => {
  assert.equal(summarize(reply('PICKUP EXCEPTION', [['2026-10-14 12:40:00', 'Pickup Not Done'], ['2026-10-15 09:00:00', 'Out For Pickup']])).stage, 'pickup_pending');
  const moving = [['2026-10-14 15:30:00', 'Shipment Picked Up']];
  assert.equal(summarize(reply('OUT FOR DELIVERY', [...moving, ['2026-10-16 08:00:00', 'Out For Delivery']])).stage, 'ofd');
  assert.equal(summarize(reply('UNDELIVERED', [...moving, ['2026-10-16 18:00:00', 'Undelivered - Consignee refused']])).stage, 'ndr');
  assert.equal(summarize(reply('DELIVERED', [...moving, ['2026-10-17 12:00:00', 'Delivered']])).stage, 'delivered');
  assert.equal(summarize(reply('RTO INITIATED', [...moving, ['2026-10-18 12:00:00', 'RTO Initiated']])).stage, 'rto');
  assert.equal(summarize(reply('CANCELED', [])).stage, 'cancelled');
  assert.equal(summarize(reply('', [])).stage, 'pickup_pending');
});

test('WhatsApp updates: no "picked up" / "in transit" for parcels not collected yet', () => {
  for (const r of [XB_1521, BD_1526, DL_1410]) {
    const t = adaptTrack(r);
    assert.equal(t.status, 'pickup_pending');
    assert.equal(classify(t).stage, 'pending');
  }
  const moving = classify(adaptTrack(DL_1550));
  assert.ok(['transit', 'picked'].includes(moving.stage), moving.stage);
});
