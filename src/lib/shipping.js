// src/lib/shipping.js — "Express shipping" delivery estimate for the IK checkout, from Shiprocket.
//
// What the shopper sees: ONE option, "Express shipping · FREE · Arrives by Mon, 13 Oct".
// Where the date comes from: Shiprocket serviceability from the pickup PIN (lib/rates.js picks the courier we would
// actually book). Courier names never reach the storefront.
//
// Wire-up — src/lib/app.js: if (path === '/api/shipping' && req.method === 'GET') return shippingEstimate(req, env);
// Reads env.SETTINGS.shipping { shiprocket_email, shiprocket_password, origin_pin, weight_g } (set in the dashboard).

const DEFAULT_ORIGIN = '410206';
const TTL = 30 * 60 * 1000;                                 // cache an estimate per PIN for 30 min

const cache = new Map();

export function cfg(env) {
  const s = (env.SETTINGS && env.SETTINGS.shipping) || {};
  return {
    origin: s.origin_pin || env.SHIPROCKET_ORIGIN_PIN || DEFAULT_ORIGIN,
    weight: Number(s.weight_g || 50),
    shiprocketEmail: s.shiprocket_email || env.SHIPROCKET_EMAIL || '',
    shiprocketPassword: s.shiprocket_password || env.SHIPROCKET_PASSWORD || '',
    shiprocketCouriers: s.shiprocket_couriers || '',          // blank = every courier Shiprocket offers
    toleranceDays: Number(s.tolerance_days ?? 2),             // how much slower than the fastest the cheapest may be
    policy: s.policy === 'fastest' ? 'fastest' : 'cheapest',
  };
}

// Serviceability rows name the estimate differently per courier/version: edd, etd, tat,
// estimated_delivery_days, delivery_days, expected_delivery … and the value is either a date
// ("2026-10-13", "13-10-2026", "Oct 13, 2026"), a day count ("3", "3-5 days", "3 Days"), or empty.
const EDD_KEYS = ['edd', 'etd', 'tat', 'estimated_delivery_days', 'estimated_delivery', 'expected_delivery_date', 'expected_delivery', 'delivery_days', 'delivery_time', 'days'];
export function eddRaw(c) {
  for (const k of EDD_KEYS) if (c[k] !== undefined && c[k] !== null && String(c[k]).trim() !== '') return c[k];
  return '';
}
export function eddDate(edd) {
  if (edd === undefined || edd === null || edd === '') return null;
  const s = String(edd).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);                       // 2026-10-13
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(s);                      // 13-10-2026
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  const d = /^(\d+(?:\.\d+)?)\s*(?:-\s*\d+)?\s*(?:days?|d)?\s*$/i.exec(s); // "3", "3-5 days"
  if (d) { const t = new Date(); t.setUTCDate(t.getUTCDate() + Math.ceil(Number(d[1]))); return t; }
  const p = Date.parse(s);                                             // "Oct 13, 2026"
  return Number.isNaN(p) ? null : new Date(p);
}
export const fmt = d => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=600' },
  });
}

export async function shippingEstimate(req, env) {
  const url = new URL(req.url);
  const pin = url.searchParams.get('pin') || '';
  const cod = url.searchParams.get('cod') === '1';
  const amount = Number(url.searchParams.get('amount') || 499);
  if (!/^\d{6}$/.test(pin)) return reply({ ok: false, error: 'bad pin' }, 400);

  const key = pin + ':' + (cod ? 'cod' : 'prepaid');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return reply({ ...hit.body, cached: true });

  try {
    // All connected carriers are compared (lib/rates.js). The shopper still sees only the date of the courier we'd
    // actually book: the cheapest one that is not more than `tolerance_days` slower than the fastest.
    const { compareRates } = await import('./rates.js');
    const r = await compareRates(env, { pin, cod, amount });
    if (!r.options.length) {
      if (!r.connected.length) throw new Error('No courier account connected');
      if (r.errors.length) throw new Error(r.errors.join('; ')); // a failed lookup says nothing about serviceability
      const body = { ok: true, serviceable: false, edd: '' }; // nothing we ship with reaches this PIN
      cache.set(key, { at: Date.now(), body });
      return reply(body);
    }
    const best = r.pick.eddDate;
    const days = best ? Math.max(1, Math.round((best - Date.now()) / 86400000)) : null;
    const body = { ok: true, serviceable: true, edd: best ? fmt(best) : '', days, courier: r.pick.courier };
    cache.set(key, { at: Date.now(), body });
    return reply(body);
  } catch (e) {
    // Never block checkout on a courier API: the theme shows "Express shipping · 2–5 business days".
    return reply({ ok: false, error: String(e.message || e), edd: '' });
  }
}

