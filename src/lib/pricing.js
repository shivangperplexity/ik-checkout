// Fees removed: no COD handling fee (8 Oct 2026) and no delivery fee (9 Oct 2026).
// The original pricing rules are unchanged in ./pricing.orig.js; this wrapper
// forces codFee and shippingFee to 0 everywhere, including any value passed in from settings.
import * as orig from './pricing.orig.js';

export * from './pricing.orig.js';

orig.DEFAULTS.codFee = 0;
orig.DEFAULTS.shippingFee = 0;

const noFees = (a) =>
  a && typeof a === 'object' && !Array.isArray(a) && ('codFee' in a || 'shippingFee' in a)
    ? { ...a, codFee: 0, shippingFee: 0 }
    : a;

export function priceCart(lines, method, cfg = {}) {
  return orig.priceCart(lines, method, { ...cfg, codFee: 0, shippingFee: 0 });
}

export function quoteBoth(...args) {
  return orig.quoteBoth(...args.map(noFees));
}
