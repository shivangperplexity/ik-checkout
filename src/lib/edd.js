/**
 * When will a parcel to this PIN arrive, and can we deliver there at all?
 *
 * We ship with ShipPrime (Shiprocket as the second carrier). Pickup takes a day, so the date is: next working day
 * pickup + the courier's transit days (ShipPrime's own EDD range, its middle rounded up),
 * Sundays skipped (lib/shipprime.js arrivalDate). Without a ShipPrime EDD, Shiprocket's date for the courier it
 * would pick, plus the pickup day.
 *
 * Serviceable: Shiprocket has a courier for the PIN, or ShipPrime marks one serviceable. When both carriers answer
 * and neither can deliver, the order is not taken. When a carrier API fails we never block (unknown != no).
 *
 * Nov 2026: ShipPrime only. Every PIN in India is asked ahead of time by the cron (pinWarm) and kept 7 days in table
 * pin_edd, so the checkout and product pages answer instantly; an unknown or stale PIN is asked live once.
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
  /* yes if either carrier can; no when Shiprocket's whole network has no courier for the PIN and ShipPrime didn't fail
     (ShipPrime's own answer is "unknown" until it books) */
  const serviceable = srOk === true || spOk === true ? true : srOk === false && !spFailed ? false : null;
  let date = '', via = '';
  if (serviceable !== false) {
    if (sp?.edd && (sp.edd.max != null || sp.edd.min != null)) {
      /* ShipPrime's range is per state (coarse): the middle of it, rounded up */
      const lo = sp.edd.min ?? sp.edd.max, hi = sp.edd.max ?? sp.edd.min;
      date = arrivalDate(Math.ceil((lo + hi) / 2), from); via = 'shipprime';
    }
    else if (sr?.pick?.eddDate) {
      /* Shiprocket counts from today: add our pickup day (Sunday skipped) */
      const d = new Date(+sr.pick.eddDate); d.setUTCDate(d.getUTCDate() + 1); if (new Date(+d + 19800000).getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
      date = istIso(d); via = 'shiprocket';
    }
  }
  const days = date ? Math.max(1, Math.round((Date.parse(date + 'T12:00:00+05:30') - from) / 86400000)) : null;
  return { serviceable, date, edd: date ? fmtDay(date) : '', days, via };
}

/* Maharashtra (PIN 40-44, not Goa 403): we ship it with Delhivery Air first, so the date follows Air's transit
   (settings shipping.mh_air_days, default 2 days after the pickup day), not ShipPrime's coarse per-state range. */
export const mhPin = (pin) => /^4[0-4]\d{4}$/.test(String(pin || '')) && !/^403/.test(String(pin));
const ZONE_DAYS = { 1: 4, 2: 4, 3: 3, 4: 3, 5: 4, 6: 4, 7: 5, 8: 5 };
/** Instant date with no courier call: Maharashtra = Delhivery Air, elsewhere a typical transit for the PIN's zone. */
export async function quickEstimate(env, pin, from = Date.now()) {
  const { arrivalDate } = await import('./shipprime.js');
  const mh = mhPin(pin), transit = mh ? Number(env.SETTINGS?.shipping?.mh_air_days ?? 2) : (ZONE_DAYS[String(pin)[0]] || 4);
  const date = arrivalDate(transit, from);
  return { date, edd: fmtDay(date), days: Math.max(1, Math.round((Date.parse(date + 'T12:00:00+05:30') - from) / 86400000)), via: mh ? 'delhivery_air' : 'zone' };
}
export async function deliveryEstimate(env, opts = {}) {
  const body = await deliveryEstimate0(env, opts);
  if (body && body.ok && body.serviceable !== false && body.air !== false && mhPin(opts.pin)) return { ...body, ...(await quickEstimate(env, opts.pin)) };
  return body;
}
/* Per PIN, from ShipPrime: serviceable for prepaid / COD (1, 0, null = unknown), transit days (min/max after pickup)
   and whether Delhivery Air serves it. Stored in pin_edd for 7 days; the date itself is worked out on each request. */
const PIN_TTL = 7 * 86400;
const tri = (v) => (v === true ? 1 : v === false ? 0 : null);
const spServ = (rates) => (!rates.length ? null : rates.some((x) => x.serviceable === true) ? true : rates.every((x) => x.serviceable === false) ? false : null);
async function spPin(env, pin, { both = true } = {}) {
  const SP = await import('./shipprime.js');
  let pick = mem.get('sp:pickup');
  if (!pick || pick.at < now() - 86400) { pick = { at: now(), pin: (await SP.spPickup(env)).pincode }; mem.set('sp:pickup', pick); }
  const w = Number(env.SETTINGS?.shipping?.weight_g) || 50;
  const [rc, e] = await Promise.allSettled([SP.spRates(env, { from: pick.pin, pin, weightGrams: w, cod: true, amount: 499 }), SP.spEdd(env, pick.pin, pin)]);
  if (rc.status === 'rejected' && e.status === 'rejected') throw rc.reason;
  const cod = rc.status === 'fulfilled' ? rc.value : [];
  let okCod = spServ(cod), okPp = okCod;
  /* COD serviceable implies prepaid; otherwise ask once more for prepaid */
  if (okCod !== true && both) { const rp = await SP.spRates(env, { from: pick.pin, pin, weightGrams: w, cod: false }).catch(() => null); if (rp) okPp = spServ(rp); }
  const edd = e.status === 'fulfilled' ? e.value : null;
  const air = [...cod].some((x) => /^DELHIVERY_AIR$/i.test(x.code || '') && x.serviceable !== false);
  const row = { pin, ok_pp: tri(okPp), ok_cod: tri(okCod), emin: edd?.min ?? null, emax: edd?.max ?? null, air: air ? 1 : 0, at: now() };
  await env.DB?.prepare('INSERT INTO pin_edd (pin, ok_pp, ok_cod, emin, emax, air, at) VALUES (?,?,?,?,?,?,?) ON CONFLICT (pin) DO UPDATE SET ok_pp=EXCLUDED.ok_pp, ok_cod=EXCLUDED.ok_cod, emin=EXCLUDED.emin, emax=EXCLUDED.emax, air=EXCLUDED.air, at=EXCLUDED.at')
    .bind(row.pin, row.ok_pp, row.ok_cod, row.emin, row.emax, row.air, row.at).run().catch(() => {});
  return row;
}
/** Pure-ish: a stored pin_edd row -> the estimate body for prepaid / COD (date counted from now). */
async function fromRow(row, cod) {
  const SP = await import('./shipprime.js');
  const ok = cod ? row.ok_cod : row.ok_pp;
  const serviceable = ok === 1 || ok === true ? true : ok === 0 || ok === false ? false : null;
  const edd = row.emin != null || row.emax != null ? { min: row.emin ?? row.emax, max: row.emax ?? row.emin } : null;
  const c = combine(null, { rates: serviceable === true ? [{ serviceable: true }] : [], edd }, { arrivalDate: SP.arrivalDate });
  return { ok: true, pin: row.pin, ...c, serviceable, air: !!Number(row.air) };
}
async function deliveryEstimate0(env, { pin, cod = false } = {}) {
  if (!/^\d{6}$/.test(String(pin || ''))) return { ok: false, error: 'bad pin' };
  const SP = await import('./shipprime.js');
  if (!SP.spConnected(env)) return { ok: false, error: 'ShipPrime not connected', serviceable: null, edd: '' };
  const m = mem.get('pin:' + pin);
  let row = m && m.at > now() - PIN_TTL ? m : await env.DB?.prepare('SELECT * FROM pin_edd WHERE pin=?').bind(String(pin)).first().catch(() => null);
  if (!row || Number(row.at) < now() - PIN_TTL) {
    try { row = await spPin(env, String(pin)); } catch (e) { return { ok: false, error: String(e.message || e), serviceable: null, edd: '' }; }
  }
  mem.set('pin:' + pin, { ...row, at: Number(row.at) });
  return fromRow(row, cod);
}

/**
 * Cron: fill pin_edd for every PIN in India (lib/pins-in.js), PINs from our own orders first, then the rest in order;
 * rows older than 7 days are asked again. Stops after `budgetMs`. Returns { done, left }.
 */
export async function pinWarm(env, { budgetMs = 15000, conc = 6 } = {}) {
  const SP = await import('./shipprime.js');
  if (!env.DB || !SP.spConnected(env)) return { skipped: 'no db / ShipPrime' };
  const t0 = Date.now(), stale = now() - PIN_TTL;
  const fresh = new Set((await env.DB.prepare('SELECT pin FROM pin_edd WHERE at > ?').bind(stale).all()).results.map((r) => String(r.pin)));
  const ours = (await env.DB.prepare("SELECT DISTINCT pincode FROM orders WHERE pincode IS NOT NULL").all().catch(() => ({ results: [] }))).results.map((r) => String(r.pincode)).filter((p) => /^\d{6}$/.test(p));
  const { pinList } = await import('./pins-in.js');
  const todo = [...new Set([...ours, ...pinList()])].filter((p) => !fresh.has(p));
  let i = 0, done = 0, failed = 0;
  const work = async () => { while (i < todo.length && Date.now() - t0 < budgetMs) { const p = todo[i++]; try { await spPin(env, p); done++; } catch { failed++; } } };
  await Promise.all(Array.from({ length: conc }, work));
  return { done, failed, left: todo.length - done, total_fresh: fresh.size + done };
}

/** Rough location from the visitor's IP (Vercel adds these headers). PIN when known, else just the city. */
export function ipPlace(req) {
  const h = (k) => { try { return decodeURIComponent(req.headers.get(k) || ''); } catch { return req.headers.get(k) || ''; } };
  const country = h('x-vercel-ip-country');
  const pin = /^\d{6}$/.test(h('x-vercel-ip-postal-code')) ? h('x-vercel-ip-postal-code') : '';
  return { country, pin: country === 'IN' ? pin : '', city: country === 'IN' ? h('x-vercel-ip-city') : '' };
}
