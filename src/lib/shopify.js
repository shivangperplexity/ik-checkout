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

/** Undo our Shopify fulfilment(s) for this AWB (when the Shiprocket shipment is cancelled before pickup). Returns how many. */
export async function cancelFulfilmentsFor(env, id, awb) {
  const d = await gql(env, `query($id:ID!){ order(id:$id){ cancelledAt fulfillments(first:10){ id status trackingInfo{ number } } } }`, { id: `gid://shopify/Order/${id}` });
  const list = (d.order?.fulfillments || []).filter((f) => f.status === 'SUCCESS' && (!awb || (f.trackingInfo || []).some((t) => String(t.number) === String(awb))));
  for (const f of list) {
    const r = await gql(env, `mutation($id:ID!){ fulfillmentCancel(id:$id){ fulfillment{ id status } userErrors{ message } } }`, { id: f.id });
    const e = r.fulfillmentCancel?.userErrors;
    if (e && e.length) throw new Error('fulfillmentCancel: ' + e.map((x) => x.message).join('; '));
  }
  return list.length;
}

/** { <orderId>: { cancelled, tags } } for many orders at once (50 per Shopify call). */
export async function ordersCancelState(env, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const d = await gql(env, `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Order { legacyResourceId cancelledAt tags } } }`, { ids: ids.slice(i, i + 50).map((x) => `gid://shopify/Order/${x}`) });
    for (const n of d.nodes || []) if (n && n.legacyResourceId) out[String(n.legacyResourceId)] = { cancelled: !!n.cancelledAt, tags: n.tags || [] };
  }
  return out;
}
