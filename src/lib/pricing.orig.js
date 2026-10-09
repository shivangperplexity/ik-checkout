// All money is integer paise. Rules copied from the live theme (ikl-bogo-cart.liquid) and RabbitPay setup:
//  - Buy 1 Get 1 Free: cheapest floor(n/2) tattoo units are free
//  - Shipping: Rs 60 when the post-B1G1 subtotal is under Rs 499, else free
//  - Prepaid: 10% off the post-B1G1 subtotal
//  - COD: flat Rs 60 handling fee
export const DEFAULTS = {
  codFee: 6000,
  shippingFee: 6000,
  freeShippingAbove: 49900,
  prepaidPct: 10,
  tattooTypes: ['Semi-Permanent Tattoo'],
};

export function toPaise(money) {
  return Math.round(parseFloat(money) * 100);
}

export function rupees(paise) {
  return (paise / 100).toFixed(2);
}

/** lines: [{ variantId, title, qty, unit (paise), productType }] */
export function priceCart(lines, method, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  let subtotal = 0, upsell = 0;
  const units = [];
  for (const l of lines) {
    subtotal += l.unit * l.qty;
    if (l.upsellPct) upsell += Math.round((l.unit * l.qty * l.upsellPct) / 100);
    if (c.tattooTypes.includes(l.productType)) for (let i = 0; i < l.qty; i++) units.push(l.unit);
  }
  units.sort((a, b) => a - b);
  const freeUnits = Math.floor(units.length / 2);
  const bogo = units.slice(0, freeUnits).reduce((s, v) => s + v, 0);
  const afterBogo = subtotal - bogo - upsell;
  const prepaid = method === 'prepaid' ? Math.round((afterBogo * c.prepaidPct) / 10000) * 100 : 0;
  const shipping = afterBogo >= c.freeShippingAbove ? 0 : c.shippingFee;
  const cod = method === 'cod' ? c.codFee : 0;
  const total = afterBogo - prepaid + shipping + cod;
  return { subtotal, bogo, upsell, freeUnits, afterBogo, prepaid, shipping, cod, total, method };
}

/** Both options at once, for the popup's payment chooser. */
export function quoteBoth(lines, cfg) {
  return { cod: priceCart(lines, 'cod', cfg), prepaid: priceCart(lines, 'prepaid', cfg) };
}
