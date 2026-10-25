/**
 * Free mystery tattoo with every fully prepaid order (Oct 2026): on top of Buy 1 Get 1 and the 10% prepaid discount.
 * Not for COD or part-paid COD (₹99 advance). Checkout orders paid online get a ₹0 "Mystery Tattoo" line on the
 * Shopify order (so it shows on the order, the packing list and Shiprocket); COD orders converted to prepaid later
 * get the tag + a note instead (the order already exists). The packer picks any in-stock design.
 */
export const MYSTERY_TAG = 'mystery-gift';
export function mysteryCfg(env) {
  const m = env.SETTINGS?.mystery || {};
  return { on: m.on !== false, title: String(m.title || 'Mystery Tattoo').slice(0, 60), worth: Math.max(0, Math.round(Number(m.worth) || 399)) };
}
/** The ₹0 custom line added to a prepaid draft order */
export function mysteryLine(env) {
  const c = mysteryCfg(env);
  return { title: `🎁 ${c.title} (FREE gift with online payment)`, originalUnitPrice: '0.00', quantity: 1, requiresShipping: true, taxable: false, sku: 'MYSTERY-GIFT' };
}
export const MYSTERY_NOTE = '🎁 FREE Mystery Tattoo: paid online. Pack 1 extra surprise design (any in stock) in this parcel.';
