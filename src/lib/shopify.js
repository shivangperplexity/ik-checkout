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

/** Shown when the custom app's Admin API token cannot undo a fulfilment. */
export const SCOPE_HINT = 'Shopify did not allow undoing the fulfilment: the app token is missing the "write_fulfillments" scope. In Shopify admin open Settings > Apps and sales channels > Develop apps > your app > Configuration > Admin API integration > Edit, tick Fulfillments: write_fulfillments, save, then press "Install app" / "Update" on the app. The token stays the same; try again after that.';

/** Undo our Shopify fulfilment(s) for this AWB (when the Shiprocket shipment is cancelled before pickup). Returns how many. */
export async function cancelFulfilmentsFor(env, id, awb) {
  const d = await gql(env, `query($id:ID!){ order(id:$id){ cancelledAt fulfillments(first:10){ id status trackingInfo{ number } } } }`, { id: `gid://shopify/Order/${id}` });
  const list = (d.order?.fulfillments || []).filter((f) => f.status === 'SUCCESS' && (!awb || (f.trackingInfo || []).some((t) => String(t.number) === String(awb))));
  for (const f of list) {
    let r;
    try { r = await gql(env, `mutation($id:ID!){ fulfillmentCancel(id:$id){ fulfillment{ id status } userErrors{ message } } }`, { id: f.id }); }
    catch (e) {
      if (/Access denied for fulfillmentCancel/i.test(String(e.message))) throw new Error(SCOPE_HINT);
      throw e;
    }
    const e = r.fulfillmentCancel?.userErrors;
    if (e && e.length) throw new Error('fulfillmentCancel: ' + e.map((x) => x.message).join('; '));
  }
  return list.length;
}

/** Active (SUCCESS) fulfilments of one order with their tracking numbers. */
export async function activeFulfilments(env, id) {
  const d = await gql(env, `query($id:ID!){ order(id:$id){ cancelledAt displayFulfillmentStatus fulfillments(first:10){ id status trackingInfo{ number company url } } } }`, { id: `gid://shopify/Order/${id}` });
  const o = d.order || {};
  return { cancelled: !!o.cancelledAt, status: o.displayFulfillmentStatus || '', list: (o.fulfillments || []).filter((f) => f.status === 'SUCCESS').map((f) => ({ id: f.id, numbers: (f.trackingInfo || []).map((t) => String(t.number || '')).filter(Boolean), company: f.trackingInfo?.[0]?.company || '', url: f.trackingInfo?.[0]?.url || '' })) };
}
/** Point an existing Shopify fulfilment at another AWB (after a rebook). */
export async function updateTracking(env, fulfillmentId, { company, number, url }) {
  const d = await gql(env, `mutation($id:ID!,$t:FulfillmentTrackingInput!){ fulfillmentTrackingInfoUpdate(fulfillmentId:$id, trackingInfoInput:$t, notifyCustomer:false){ userErrors{ message } } }`,
    { id: fulfillmentId, t: { company, number, url: url || undefined } });
  const e = d.fulfillmentTrackingInfoUpdate?.userErrors;
  if (e && e.length) throw new Error('fulfillmentTrackingInfoUpdate: ' + e.map((x) => x.message).join('; '));
}

/** What Shopify says about many orders' shipping at once (50 per call): cancelled?, fulfilment status, tags, active fulfilments with tracking. */
export async function ordersShipState(env, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const d = await gql(env, `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Order { legacyResourceId name cancelledAt displayFulfillmentStatus tags
      fulfillments(first:10){ id status createdAt trackingInfo{ number company url } } } } }`, { ids: ids.slice(i, i + 50).map((x) => `gid://shopify/Order/${x}`) });
    for (const n of d.nodes || []) {
      if (!n || !n.legacyResourceId) continue;
      const active = (n.fulfillments || []).filter((f) => f.status === 'SUCCESS').map((f) => ({ id: f.id, at: Math.floor(Date.parse(f.createdAt || '') / 1000) || 0, numbers: (f.trackingInfo || []).map((t) => String(t.number || '')).filter(Boolean), company: f.trackingInfo?.[0]?.company || '', url: f.trackingInfo?.[0]?.url || '' }));
      out[String(n.legacyResourceId)] = { name: n.name, cancelled: !!n.cancelledAt, status: n.displayFulfillmentStatus || '', tags: n.tags || [], fulfilments: active, awbs: active.flatMap((f) => f.numbers) };
    }
  }
  return out;
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

/** Packing view for many orders at once: items with design image, size, SKU and quantity (50 per Shopify call). Nothing stored. */
export async function packingItems(env, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const d = await gql(env, `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Order { legacyResourceId name shippingAddress{ firstName city }
      lineItems(first:30){ nodes{ title quantity variantTitle sku image{ url } product{ productType tags featuredImage{ url } } variant{ inventoryItem{ measurement{ weight{ value unit } } } } } } } } }`,
      { ids: ids.slice(i, i + 50).map((x) => `gid://shopify/Order/${x}`) });
    for (const n of d.nodes || []) {
      if (!n || !n.legacyResourceId) continue;
      out[String(n.legacyResourceId)] = { name: n.name, first_name: n.shippingAddress?.firstName || '', city: n.shippingAddress?.city || '',
        items: (n.lineItems?.nodes || []).map((l) => {
          const w = l.variant?.inventoryItem?.measurement?.weight;
          return { title: l.title, quantity: l.quantity, variantTitle: l.variantTitle || '', sku: l.sku || '', image: l.image?.url || l.product?.featuredImage?.url || '',
            tags: l.product?.tags || [], productType: l.product?.productType || '', weightG: w ? Math.round(Number(w.value) * (GRAMS[w.unit] || 1)) : 0 };
        }) };
    }
  }
  return out;
}
