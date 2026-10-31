// Fees removed: no COD handling fee (8 Oct 2026) and no delivery fee (9 Oct 2026). Pricing v2 (Nov 2026) brings back
// a ₹29 COD fee for checkouts that ask for it (pricingCfg below).
// The original pricing rules are unchanged in ./pricing.orig.js; this wrapper
// forces codFee and shippingFee to 0 everywhere, including any value passed in from settings.
import * as orig from './pricing.orig.js';

export * from './pricing.orig.js';

orig.DEFAULTS.codFee = 0;
orig.DEFAULTS.shippingFee = 0;

export function priceCart(lines, method, cfg = {}) {
  return orig.priceCart(lines, method, { ...cfg, codFee: cfg.v2 ? cfg.codFee || 0 : 0, shippingFee: 0 });
}

/**
 * Pricing v2 (Nov 2026, checkouts that send pv: 2): prepaid gets ₹50 off or 10%, whichever is more, and COD carries a
 * ₹29 handling fee. Older theme builds keep v1 (10% prepaid, no fee) so the price they show is the price charged.
 * Amounts from Settings > checkout (prepaid_flat, cod_fee, in rupees) when set.
 */
export function pricingCfg(env, body) {
  if (!(Number(body?.pv) >= 2)) return {};
  const c = env?.SETTINGS?.checkout || {};
  const r = (v, d) => Math.max(0, Math.round((Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d) * 100));
  return { v2: true, prepaidFlat: r(c.prepaid_flat, 50), codFee: r(c.cod_fee, 29) };
}

export function quoteBoth(lines, cfg = {}) {
  return { cod: priceCart(lines, 'cod', cfg), prepaid: priceCart(lines, 'prepaid', cfg) };
}
