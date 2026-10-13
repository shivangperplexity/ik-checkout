// Emoji fix (8 Oct 2026): load the address guard before the Shopify client so
// customer names/addresses with emojis no longer make draftOrderCreate fail.
// The original Shopify code is unchanged in ./shopify.orig.js.
import './address-guard.js';
export * from './shopify.orig.js';
import { gql } from './shopify.orig.js';

const GRAMS = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.3495, POUNDS: 453.592 };
/** Everything Shiprocket + the package-size engine need from one order. Read live; nothing here is stored. */
export async function orderForShipping(env, id) {
  const d = await gql(env, `query($id:ID!){ order(id:$id){ id name email cancelledAt displayFulfillmentStatus
    shippingAddress{ name firstName lastName address1 address2 city province zip phone }
    lineItems(first:50){ nodes{ title quantity sku variantTitle discountedUnitPriceSet{shopMoney{amount}}
      product{ productType tags } variant{ inventoryItem{ measurement{ weight{ value unit } } } } } } } }`, { id: `gid://shopify/Order/${id}` });
  const o = d.order; if (!o) return null;
  return {
    name: o.name, email: o.email || '', cancelled: !!o.cancelledAt, fulfillment: o.displayFulfillmentStatus, address: o.shippingAddress || {},
    items: (o.lineItems?.nodes || []).map((l) => {
      const w = l.variant?.inventoryItem?.measurement?.weight;
      return { title: l.title, quantity: l.quantity, sku: l.sku || '', variantTitle: l.variantTitle || '', tags: l.product?.tags || [], productType: l.product?.productType || '',
        weightG: w ? Math.round(Number(w.value) * (GRAMS[w.unit] || 1)) : 0, unitPrice: Number(l.discountedUnitPriceSet?.shopMoney?.amount || 0) };
    }),
  };
}
