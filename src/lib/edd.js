/**
 * When will a parcel to this PIN arrive, and can we deliver there at all?
 *
 * We ship with ShipPrime (Shiprocket as the second carrier). Pickup takes a day, so the date is: next working day
 * pickup + the courier's transit days (ShipPrime's own EDD, the slower end of its range so the promise holds),
 * Sundays skipped (lib/shipprime.js arrivalDate). Without a ShipPrime EDD, Shiprocket's date for the courier it
 * would pick, plus the pickup day.
 *
 * Serviceable: Shiprocket has a courier for the PIN, or ShipPrime marks one serviceable. When both carriers answer
 * and neither can deliver, the order is not taken. When a carrier API fails we never block (unknown != no).
 *
 * Cached per PIN + payment for 6 hours (table edd_cache), so product pages don't hit the courier APIs on every view.
 */
const now = () => Math.floor(Date.now() / 1000);
const TTL = 6 * 3600;
const mem = new Map();

export const fmtDay = (iso) => new Date(iso + 'T12:00:00+05:30').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const istIso = (d) => new Date(+d + 19800000).toISOString().slice(0, 10);

/** Pure: combine the two carriers' answers. sr = compareRates() result or null (failed); sp = { rates, edd } or null. */
export function combine(sr, sp, { from = Date.now(), arrivalDate, spFailed = false } = {}) {
  const srOk = sr ? sr.options.length > 0 : null;                                   /* null = unknown */
  const spRates = sp?.rates || [];
  const spOk = sp ? (spRates.some((r) => r.serviceable === true) ? true : spRates.length && spRates.every((r) => r.serviceable === false) ? false : null) : null;
  /* yes if either carrier can; no only when Shiprocket says no and ShipPrime didn't fail (its "unknown" defers to Shiprocket) */
  const serviceable = srOk === true || spOk === true ? true : srOk === false && !spFailed ? false : null;
  let date = '', via = '';
  if (serviceable !== false) {
    if (sp?.edd && (sp.edd.max != null || sp.edd.min != null)) { date = arrivalDate(sp.edd.max ?? sp.edd.min, from); via = 'shipprime'; }
    else if (sr?.pick?.eddDate) {
      /* Shiprocket counts from today: add our pickup day (Sunday skipped) */
      const d = new Date(+sr.pick.eddDate); d.setUTCDate(d.getUTCDate() + 1); if (new Date(+d + 19800000).getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
      date = istIso(d); via = 'shiprocket';
    }
  }
  const days = date ? Math.max(1, Math.round((Date.parse(date + 'T12:00:00+05:30') - from) / 86400000)) : null;
  return { serviceable, date, edd: date ? fmtDay(date) : '', days, via };
}

export async function deliveryEstimate(env, { pin, cod = false, amount = 499 } = {}) {
  if (!/^\d{6}$/.test(String(pin || ''))) return { ok: false, error: 'bad pin' };
  const key = `${pin}:${cod ? 'cod' : 'pp'}`;
  const m = mem.get(key);
  if (m && m.at > now() - TTL) return m.body;
  const row = await env.DB?.prepare('SELECT body, at FROM edd_cache WHERE k=?').bind(key).first().catch(() => null);
  if (row && Number(row.at) > now() - TTL) { const body = JSON.parse(row.body); mem.set(key, { at: Number(row.at), body }); return body; }

  const { compareRates } = await import('./rates.js');
  const SP = await import('./shipprime.js');
  const [a, b] = await Promise.allSettled([
    compareRates(env, { pin, cod, amount }),
    (async () => {
      if (!SP.spConnected(env)) return null;
      const pickup = await SP.spPickup(env);
      const [r, e] = await Promise.allSettled([SP.spRates(env, { from: pickup.pincode, pin, weightGrams: Number(env.SETTINGS?.shipping?.weight_g) || 50, cod, amount }), SP.spEdd(env, pickup.pincode, pin)]);
      if (r.status === 'rejected' && e.status === 'rejected') throw r.reason;
      return { rates: r.status === 'fulfilled' ? r.value : [], edd: e.status === 'fulfilled' ? e.value : null };
    })(),
  ]);
  let sr = a.status === 'fulfilled' ? a.value : null;
  if (sr && !sr.options.length && sr.errors.length) sr = null;                     /* a failed lookup is not a "no" */
  const sp = b.status === 'fulfilled' ? b.value : null;
  if (!sr && !sp) return { ok: false, error: 'courier lookup failed', serviceable: null, edd: '' };
  const c = combine(sr, sp, { arrivalDate: SP.arrivalDate, spFailed: b.status === 'rejected' });
  const body = { ok: true, pin, ...c };
  mem.set(key, { at: now(), body });
  await env.DB?.prepare('INSERT INTO edd_cache (k, body, at) VALUES (?,?,?) ON CONFLICT (k) DO UPDATE SET body=EXCLUDED.body, at=EXCLUDED.at').bind(key, JSON.stringify(body), now()).run().catch(() => {});
  return body;
}

/** Rough location from the visitor's IP (Vercel adds these headers). PIN when known, else just the city. */
export function ipPlace(req) {
  const h = (k) => { try { return decodeURIComponent(req.headers.get(k) || ''); } catch { return req.headers.get(k) || ''; } };
  const country = h('x-vercel-ip-country');
  const pin = /^\d{6}$/.test(h('x-vercel-ip-postal-code')) ? h('x-vercel-ip-postal-code') : '';
  return { country, pin: country === 'IN' ? pin : '', city: country === 'IN' ? h('x-vercel-ip-city') : '' };
}
