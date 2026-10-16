// src/lib/rates.js — Shiprocket's couriers for one parcel, with the pick rule.
//
// Provider: shiprocket  GET /v1/external/courier/serviceability/ (lib/shiprocket.js)
// Add another by writing one function that returns [{ courier, charge, freight, cod, edd }] and listing it in PROVIDERS.
//
// Pick rule (dashboard "Shipping" card):
//   cheapest (default)  lowest total charge among options that are at most `tolerance_days` slower than the fastest one
//   fastest             earliest delivery, ties broken by price
// "charge" is what we pay the courier for this parcel in rupees, including the COD fee when the order is COD.

import { cfg, eddDate } from './shipping.js';
import { srRates } from './shiprocket.js';
import { packOrder, packCfg } from './packing.js';

const SR = 'https://apiv2.shiprocket.in/v1/external';
const TIMEOUT = 7000;
const DAY = 86400000;

const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
const rupees = (v) => { const n = num(v); return n === null ? null : Math.round(n * 100) / 100; };

function withTimeout(promise, label) {
  let t;
  return Promise.race([promise, new Promise((_, bad) => { t = setTimeout(() => bad(new Error(label + ' timed out')), TIMEOUT); })]).finally(() => clearTimeout(t));
}

/* ---------- Shiprocket (lib/shiprocket.js) ---------- */
async function shiprocketRates(c, q, env) {
  if (!c.shiprocketEmail || !c.shiprocketPassword) return null;        // not connected
  const pack = q.pack || packOrder([{ quantity: 1 }], packCfg(env.SETTINGS?.shipping?.pack));   // checkout default: one small envelope
  return srRates(env, { pin: q.pin, cod: q.cod, amount: q.amount, pack });
}

export const PROVIDERS = {
  shiprocket: { label: 'Shiprocket', run: (c, q, env) => shiprocketRates(c, q, env) },
};

/** Pure: choose the option to ship with. options = [{ charge, eddDate }] */
export function pickOption(options, { policy = 'cheapest', toleranceDays = 2 } = {}) {
  const priced = options.filter((o) => o.charge !== null && o.charge !== undefined);
  if (!priced.length) return options[0] || null;
  const dated = priced.filter((o) => o.eddDate);
  const fastest = dated.length ? Math.min(...dated.map((o) => +o.eddDate)) : null;
  const byPrice = (a, b) => a.charge - b.charge || (+(a.eddDate || 9e15)) - (+(b.eddDate || 9e15));
  const byDate = (a, b) => (+(a.eddDate || 9e15)) - (+(b.eddDate || 9e15)) || a.charge - b.charge;
  if (policy === 'fastest') return priced.slice().sort(byDate)[0];
  /* options without a date are only used when nothing has one (we can't tell how slow they are) */
  const pool = fastest === null ? priced : dated.filter((o) => +o.eddDate <= fastest + toleranceDays * DAY);
  return pool.slice().sort(byPrice)[0];
}

/**
 * Ask every connected carrier, in parallel. A carrier that is down or rejects its login is reported in `errors`
 * and the others still decide. Returns { options (cheapest first), pick, cheapest, fastest, errors, tried, connected }.
 */
export async function compareRates(env, { pin, cod = false, amount = 499, pack = null }) {
  const c = cfg(env);
  const q = { pin, cod: !!cod, amount: Number(amount) || 499, pack };
  const only = Object.keys(PROVIDERS);
  const errors = [];
  let tried = 0;
  const connected = [];
  const results = await Promise.all(Object.entries(PROVIDERS).filter(([k]) => only.includes(k)).map(async ([key, p]) => {
    try {
      const rows = await withTimeout(p.run(c, q, env), p.label);
      if (rows === null) return [];
      tried++; connected.push(key);
      return rows.map((o) => ({ ...o, provider: key, providerLabel: p.label }));
    } catch (e) { tried++; connected.push(key); errors.push(String(e.message || e)); return []; }
  }));
  const options = results.flat().map((o) => ({ ...o, eddDate: eddDate(o.edd) })).filter((o) => o.charge !== null || o.eddDate);
  options.sort((a, b) => (a.charge ?? 9e9) - (b.charge ?? 9e9));
  const pick = pickOption(options, { policy: c.policy, toleranceDays: c.toleranceDays });
  const dated = options.filter((o) => o.eddDate).sort((a, b) => a.eddDate - b.eddDate);
  return { options, pick, cheapest: options.find((o) => o.charge !== null) || null, fastest: dated[0] || null, errors, tried, connected, policy: c.policy, toleranceDays: c.toleranceDays };
}
