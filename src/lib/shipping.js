// src/lib/shipping.js — "Express shipping" delivery estimate for the IK checkout, from NimbusPost.
//
// What the shopper sees: ONE option, "Express shipping · FREE · Arrives by Mon, 13 Oct".
// Where the date comes from: NimbusPost serviceability for Delhivery + Xpressbees (the couriers you ship with),
// from the 410206 warehouse; the earliest EDD of the two wins. Courier names never reach the storefront.
//
// Wire-up — src/lib/app.js, inside handle(req, env) next to the other routes (the API uses Web Request/Response,
// and the dashboard settings are already loaded onto env.SETTINGS by withSettings()):
//   import { shippingEstimate } from './shipping.js';
//   if (path === '/api/shipping' && req.method === 'GET') return shippingEstimate(req, env);
// This module reads nimbus_email, nimbus_password, nimbus_origin_pin, nimbus_weight_g from env.SETTINGS,
// falling back to the NIMBUS_* env vars.
//
// Admin dashboard (public/admin.html): add these three fields to the Settings section so they can be changed
// without a redeploy — see ADMIN_FIELDS at the bottom for the exact keys/labels.
//
// NimbusPost API (https://documentation.nimbuspost.com):
//   POST /v1/users/login            { email, password }                     → { status, data: "<token>" }
//   POST /v1/courier/serviceability { origin, destination, payment_type, order_amount, weight, length, breadth, height }
//                                   → { status, data: [ { id, name, edd, freight_charges, total_charges, ... } ] }

const NB = 'https://api.nimbuspost.com/v1';
const COURIERS = /delhivery|xpress\s*bees|xpressbees/i;   // only the partners you actually ship with
const DEFAULT_ORIGIN = '410206';
const TTL = 30 * 60 * 1000;                                 // cache an estimate per PIN for 30 min

let tok = { value: '', exp: 0, key: '' };
const cache = new Map();

function cfg(env) {
  const s = env.SETTINGS || {};
  return {
    email: s.nimbus_email || env.NIMBUS_EMAIL || '',
    password: s.nimbus_password || env.NIMBUS_PASSWORD || '',
    origin: s.nimbus_origin_pin || env.NIMBUS_ORIGIN_PIN || DEFAULT_ORIGIN,
    weight: Number(s.nimbus_weight_g || env.NIMBUS_WEIGHT_G || 50),
  };
}

async function token(c) {
  const key = c.email + ':' + c.password;
  if (tok.value && tok.key === key && Date.now() < tok.exp) return tok.value;
  if (!c.email || !c.password) throw new Error('NimbusPost email/password not set');
  const r = await fetch(NB + '/users/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: c.email, password: c.password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.status || !j.data) throw new Error('NimbusPost login failed');
  tok = { value: j.data, key, exp: Date.now() + 11 * 60 * 60 * 1000 }; // tokens last ~12h
  return tok.value;
}

// NimbusPost returns edd as "YYYY-MM-DD" for most couriers, sometimes "3-5 days". Normalise to a date.
function eddDate(edd) {
  if (!edd) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(edd));
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = /(\d+)\s*(?:-\s*\d+)?\s*day/i.exec(String(edd));
  if (d) { const t = new Date(); t.setUTCDate(t.getUTCDate() + Number(d[1])); return t; }
  return null;
}
const fmt = d => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

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
    const c = cfg(env);
    const t = await token(c);
    const r = await fetch(NB + '/courier/serviceability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({
        origin: c.origin, destination: pin, payment_type: cod ? 'cod' : 'prepaid',
        order_amount: amount, weight: c.weight, length: 20, breadth: 15, height: 2,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.status || !Array.isArray(j.data)) throw new Error('serviceability failed');

    const ours = j.data.filter(x => COURIERS.test(String(x.name || '')));
    const dates = ours.map(x => eddDate(x.edd)).filter(Boolean).sort((a, b) => a - b);
    if (!ours.length) {
      const body = { ok: true, serviceable: false, edd: '' }; // nothing we ship with reaches this PIN
      cache.set(key, { at: Date.now(), body });
      return reply(body);
    }
    const best = dates[0] || null;
    const days = best ? Math.max(1, Math.round((best - Date.now()) / 86400000)) : null;
    const body = { ok: true, serviceable: true, edd: best ? fmt(best) : '', days,
      // internal, for your dashboard/booking — not shown to the shopper
      courier: ours.sort((a, b) => (eddDate(a.edd) || 9e15) - (eddDate(b.edd) || 9e15))[0].name };
    cache.set(key, { at: Date.now(), body });
    return reply(body);
  } catch (e) {
    // Never block checkout on a courier API: the theme shows "Express shipping · 2–5 business days".
    return reply({ ok: false, error: String(e.message || e), edd: '' });
  }
}

// Fields for the admin dashboard settings form (public/admin.html). Store them in the same settings table the
// WhatsApp/template settings use; `nimbus_password` should be rendered as type="password".
export const ADMIN_FIELDS = [
  { key: 'nimbus_email', label: 'NimbusPost email', type: 'email', placeholder: 'login email for app.nimbuspost.com' },
  { key: 'nimbus_password', label: 'NimbusPost password', type: 'password' },
  { key: 'nimbus_origin_pin', label: 'Pickup PIN code', type: 'text', placeholder: DEFAULT_ORIGIN, def: DEFAULT_ORIGIN },
  { key: 'nimbus_weight_g', label: 'Parcel weight (g)', type: 'number', def: 50 },
];
