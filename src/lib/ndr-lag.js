/**
 * How fast does the courier really come back after a failed delivery? For every parcel that had a failed attempt
 * (last `days`, Shiprocket and ShipPrime), read the courier's scans and, for each day with a failed attempt, find the
 * next "out for delivery" scan. Grouped by carrier (provider) and courier:
 *   next_day / same_day / d2 / d3plus = the next attempt came 1 / 0 / 2 / 3+ days after the failure
 *   none = no further attempt (RTO or still waiting)
 *   no_ofd = the failure was scanned on a day with no "out for delivery" scan before it (attempt likely never made)
 */
import { trackRaw } from './shiprocket.js';

const FAIL = /undeliver|not deliver|ndr|not available|unavailable|refused|door ?step|not attempted|future delivery|deferred|incomplete address|address|unreachable|no response|not ready|reschedul|could not be delivered|delivery attempted/i;
const OFD = /out for delivery|dispatched for delivery|\bofd\b/i;
const RTO = /\brto\b|return to origin|returned to|return initiated/i;
const DELIVERED = /\bdelivered\b/i;
const day = (s) => String(s || '').slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/** Pure: scans [{date, text}] (any order) -> [{fail_day, next_day|null, gap|null, no_ofd}] one per failed-attempt day */
export function lagEvents(scans) {
  const acts = scans.filter((a) => a.date).map((a) => ({ t: String(a.date).replace('T', ' ').slice(0, 19), text: String(a.text || '').replace(/_/g, ' ') }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const out = [], seen = new Set();
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    if (RTO.test(a.text) || OFD.test(a.text) || (DELIVERED.test(a.text) && !/undeliver|not deliver/i.test(a.text)) || !FAIL.test(a.text)) continue;
    const d = day(a.t);
    if (seen.has(d)) continue;
    seen.add(d);
    const ofdBefore = acts.slice(0, i).some((x) => day(x.t) === d && OFD.test(x.text));
    const next = acts.slice(i + 1).find((x) => day(x.t) > d && (OFD.test(x.text) || (DELIVERED.test(x.text) && !/undeliver|not deliver|rto/i.test(x.text))));
    const sameDayRetry = acts.slice(i + 1).some((x) => day(x.t) === d && OFD.test(x.text));
    out.push({ fail_day: d, next_day: next ? day(next.t) : sameDayRetry ? d : null, gap: next ? dayDiff(d, day(next.t)) : sameDayRetry ? 0 : null, no_ofd: !ofdBefore });
  }
  return out;
}

export async function ndrLag(env, { days = 30, max = 150, awb = '', provider = '' } = {}) {
  if (awb) { const j = await trackRaw(env, awb); return { awb, acts: (j?.tracking_data?.shipment_track_activities || []).slice(0, 40) }; }
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = (await env.DB.prepare(`SELECT awb, order_name, provider, courier FROM shipments WHERE awb IS NOT NULL AND LENGTH(awb) > 0
      AND COALESCE(status,'') <> 'cancelled' AND created_at > ? AND (sp_ndr_at IS NOT NULL OR ndr_choice IS NOT NULL OR COALESCE(rto,false) OR stage IN ('ndr','rto'))
      AND (? = '' OR COALESCE(provider,'shiprocket') = ?) ORDER BY created_at DESC LIMIT ?`).bind(since, provider, provider, max).all()).results;
  const groups = {}, slow = [];
  let i = 0, errors = 0;
  const work = async () => {
    while (i < rows.length) {
      const r = rows[i++];
      try {
        const j = await trackRaw(env, r.awb, r);
        const td = j?.tracking_data || {};
        const acts = (td.shipment_track_activities || []).map((a) => ({ date: a.date, text: [a.activity, a['sr-status-label'], a.status].filter(Boolean).join(' ') }));
        const ev = lagEvents(acts);
        if (!ev.length) continue;
        const k = `${r.provider === 'shipprime' ? 'ShipPrime' : 'Shiprocket'} · ${r.courier || td.shipment_track?.[0]?.courier_name || '?'}`;
        const g = (groups[k] ||= { parcels: 0, failures: 0, same_day: 0, next_day: 0, d2: 0, d3plus: 0, none: 0, no_ofd: 0 });
        g.parcels++;
        for (const e of ev) {
          g.failures++;
          if (e.no_ofd) g.no_ofd++;
          if (e.gap === null) g.none++; else if (e.gap === 0) g.same_day++; else if (e.gap === 1) g.next_day++; else if (e.gap === 2) g.d2++; else g.d3plus++;
          if (e.gap !== null && e.gap >= 2 && slow.length < 25) slow.push(`${r.order_name} ${k}: failed ${e.fail_day}, next attempt ${e.next_day} (${e.gap} days)`);
        }
      } catch { errors++; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, work));
  for (const g of Object.values(groups)) {
    const came = g.failures - g.none;
    g.next_day_pct = came ? Math.round(((g.same_day + g.next_day) / came) * 100) : null;
    g.no_ofd_pct = g.failures ? Math.round((g.no_ofd / g.failures) * 100) : null;
  }
  return { days, parcels: rows.length, errors, groups, slow };
}
