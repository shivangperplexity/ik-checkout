// src/lib/rates.js — compare shipping rates across every connected carrier account and pick the cheapest.
//
// Providers (each is an aggregator that returns several couriers with a price and a delivery estimate):
//   nimbus     NimbusPost   POST /v1/courier/serviceability
//   shiprocket Shiprocket   GET  /v1/external/courier/serviceability/
// Add another by writing one function that returns [{ courier, charge, freight, cod, edd }] and listing it in PROVIDERS.
//
// Pick rule (dashboard "Shipping" card):
//   cheapest (default)  lowest total charge among options that are at most `tolerance_days` slower than the fastest one
//   fastest             earliest delivery, ties broken by price
// "charge" is what we pay the courier for this parcel in rupees, including the COD fee when the order is COD.

import { cfg, token, eddRaw, eddDate } from './shipping.js';

const NB = 'https://api.nimbuspost.com/v1';
const SR = 'https://apiv2.shiprocket.in/v1/external';
const TIMEOUT = 7000;
const DAY = 86400000;

const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
const rupees = (v) => { const n = num(v); return n === null ? null : Math.round(n * 100) / 100; };

function withTimeout(promise, label) {
  let t;
  return Promise.race([promise, new Promise((_, bad) => { t = setTimeout(() => bad(new Error(label + ' timed out')), TIMEOUT); })]).finally(() => clearTimeout(t));
}
function safeRe(src) { try { return src ? new RegExp(src, 'i') : null; } catch { return null; } }

/* ---------- NimbusPost ---------- */
async function nimbusRates(c, q) {
  if (!c.email || !c.password) return null;                            // not connected
  const t = await token(c);
  const r = await fetch(NB + '/courier/serviceability', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    body: JSON.stringify({ origin: c.origin, destination: q.pin, payment_type: q.cod ? 'cod' : 'prepaid', order_amount: q.amount, weight: c.weight, length: 20, breadth: 15, height: 2 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.status || !Array.isArray(j.data)) throw new Error('NimbusPost: ' + (j.message || 'serviceability failed'));
  const only = safeRe(c.nimbusCouriers);
  return j.data.filter((x) => !only || only.test(String(x.name || ''))).map((x) => ({
    courier: String(x.name || 'Courier'),
    charge: rupees(x.total_charges ?? x.freight_charges),
    freight: rupees(x.freight_charges),
    cod: rupees(x.cod_charges),
    edd: eddRaw(x),
  }));
}

/* ---------- Shiprocket ---------- */
let srTok = { value: '', exp: 0, key: '' };
async function shiprocketToken(c) {
  const key = c.shiprocketEmail + ':' + c.shiprocketPassword;
  if (srTok.value && srTok.key === key && Date.now() < srTok.exp) return srTok.value;
  const r = await fetch(SR + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: c.shiprocketEmail, password: c.shiprocketPassword }) });
  const j = await r.json().catch(() => ({}));
  if (!j.token) throw new Error('Shiprocket login failed' + (j.message ? ': ' + j.message : ''));
  srTok = { value: j.token, key, exp: Date.now() + 9 * 24 * 60 * 60 * 1000 }; // tokens last 10 days
  return srTok.value;
}
async function shiprocketRates(c, q) {
  if (!c.shiprocketEmail || !c.shiprocketPassword) return null;        // not connected
  const t = await shiprocketToken(c);
  const kg = Math.max(0.05, c.weight / 1000);
  const qs = new URLSearchParams({ pickup_postcode: c.origin, delivery_postcode: q.pin, weight: String(kg), cod: q.cod ? '1' : '0', declared_value: String(q.amount), length: '20', breadth: '15', height: '2' });
  const r = await fetch(SR + '/courier/serviceability/?' + qs, { headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) srTok = { value: '', exp: 0, key: '' };
  const list = j.data && j.data.available_courier_companies;
  if (!Array.isArray(list)) {
    if (r.status === 404 || /no courier|not serviceable/i.test(String(j.message || ''))) return [];   // PIN not served
    throw new Error('Shiprocket: ' + (j.message || 'serviceability failed'));
  }
  const only = safeRe(c.shiprocketCouriers);
  return list.filter((x) => !only || only.test(String(x.courier_name || ''))).map((x) => ({
    courier: String(x.courier_name || 'Courier'),
    charge: rupees(x.rate ?? (num(x.freight_charge) ?? 0) + (num(x.cod_charges) ?? 0)),
    freight: rupees(x.freight_charge),
    cod: rupees(x.cod_charges),
    edd: x.etd || x.estimated_delivery_days || '',
  }));
}

export const PROVIDERS = {
  nimbus: { label: 'NimbusPost', run: (c, q) => nimbusRates({ ...c }, q) },
  shiprocket: { label: 'Shiprocket', run: shiprocketRates },
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
export async function compareRates(env, { pin, cod = false, amount = 499 }) {
  const c = cfg(env);
  const q = { pin, cod: !!cod, amount: Number(amount) || 499 };
  const errors = [];
  let tried = 0;
  const connected = [];
  const results = await Promise.all(Object.entries(PROVIDERS).map(async ([key, p]) => {
    try {
      const rows = await withTimeout(p.run(c, q), p.label);
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
