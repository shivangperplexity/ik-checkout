// src/lib/sr-scan.js — read a Shiprocket tracking reply the way Shiprocket's own tracking page does.
//
// The overall `current_status` and the per-scan labels are not reliable on their own before pickup: couriers send
// "Order Received", "Data Received", "Manifested - Out for Pickup" scans from their hub long before anyone
// collects the parcel, and Shiprocket labels some of those as shipped / in transit. So:
//   * a parcel counts as PICKED UP only after a real pickup / movement scan
//     ("In Transit - Shipment picked up", "Shipment Recieved at Origin Center", "Picked Up", "Trip Arrived" ...);
//   * before that, the NEWEST scan decides: "Pickup Not Done", "Pickup Exception", "PICKUP WRONGLY REGISTERED BY
//     SHIPPER", "Shipment Not Ready" ... = pickup failed; anything else = waiting for pickup.
// Examples are from this account's real parcels (Oct 2026: Delhivery, Xpressbees, Blue Dart).

/** Scans that happen before the courier has the parcel. */
export const PRE = /order received|data received|manifest|out for pickup|pickup (scheduled|generated|queued|rescheduled|requested|not done|exception|error|failed|cancel)|pickup request cancel|wrongly registered|not picked|shipment not ready|not ready|no pickup|awb assigned|label generated|ready to ship|shipment booked|soft data/i;
/** Scans that mean the pickup failed. */
export const FAIL = /pickup not done|pickup exception|pickup error|pickup failed|wrongly registered|not picked|shipment not ready|not ready|no pickup|pickup (request )?cancel|cancelled by seller/i;
/** Physical movement: the courier has the parcel. */
const MOVE = /picked|pick ?up done|pickup completed|in ?transit|rece?ie?ved at|origin|bag|trip|hub|arrived|departed|dispatched|connected|reached|out for delivery|delivered|undelivered|\brto\b|return|shipped|forwarded|misrouted/i;

export const isPickupScan = (text) => !PRE.test(text) && MOVE.test(text);

/** Stage from one status text (also used for Shiprocket's overall status and older stored values). */
export function stageOf(text, scanned = false) {
  const t = String(text || '').toLowerCase().replace(/_/g, ' ');
  if (!t.trim()) return scanned ? 'transit' : 'pickup_pending';
  if (/cancel/.test(t) && !/pickup|seller/.test(t)) return 'cancelled';
  if (/\brto\b|return to origin|returned|return initiated/.test(t)) return 'rto';
  if (/lost|damaged|destroyed|untraceable|disposed/.test(t)) return 'lost';
  if (/undelivered|\bndr\b|delivery attempt|failed delivery|not delivered/.test(t)) return 'ndr';
  if (/out for delivery/.test(t)) return 'ofd';
  if (/delivered/.test(t)) return 'delivered';
  if (FAIL.test(t)) return scanned ? 'transit' : 'pickup_failed';
  if (PRE.test(t)) return scanned ? 'transit' : 'pickup_pending';
  if (MOVE.test(t)) return 'transit';
  return scanned ? 'transit' : 'pickup_pending';
}

/**
 * Summary of a Shiprocket `courier/track/awb` reply:
 * { stage, picked, current, newest, newestAt, pickedAt, edd, scans }.
 */
export function summarize(raw) {
  const td = raw?.tracking_data || {};
  const trk = Array.isArray(td.shipment_track) ? td.shipment_track[0] || {} : {};
  const scans = (Array.isArray(td.shipment_track_activities) ? td.shipment_track_activities : [])
    .map((a) => ({ text: String(a.activity || a.status || '').trim(), label: String(a['sr-status-label'] || ''), at: String(a.date || '').replace('T', ' ').slice(0, 19), location: String(a.location || '') }))
    .sort((x, y) => (y.at > x.at ? 1 : y.at < x.at ? -1 : 0));
  const current = String(trk.current_status || '').trim();
  const pickScans = scans.filter((s) => isPickupScan(s.text));
  const picked = pickScans.length > 0;
  const newest = scans[0]?.text || '';
  let stage;
  if (!picked) {
    const c = stageOf(current);
    if (c === 'cancelled' || c === 'lost') stage = c;
    else stage = FAIL.test(newest || current) ? 'pickup_failed' : 'pickup_pending';
  } else {
    const n = stageOf(newest, true);
    if (['ofd', 'ndr', 'delivered', 'rto', 'lost'].includes(n)) stage = n;
    else {
      const c = stageOf(current, true);
      stage = ['ofd', 'ndr', 'delivered', 'rto', 'lost', 'cancelled'].includes(c) ? c : 'transit';
    }
  }
  return { stage, picked, current, newest, newestAt: scans[0]?.at || '', pickedAt: pickScans.length ? pickScans[pickScans.length - 1].at : '',
    edd: String(td.etd || trk.edd || '').slice(0, 10), scans };
}
