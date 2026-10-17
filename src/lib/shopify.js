// Emoji fix (8 Oct 2026): load the address guard before the Shopify client so
// customer names/addresses with emojis no longer make draftOrderCreate fail.
// The original Shopify code is unchanged in ./shopify.orig.js.
import './address-guard.js';
export * from './shopify.orig.js';
import { gql } from './shopify.orig.js';
import { toPaise } from './pricing.js';

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

/**
 * Partial COD: turn the checkout's draft into a real order that Shopify shows as PARTIALLY_PAID — the advance as a
 * successful PayU sale, the rest outstanding (collected by the courier). draftOrderComplete can only leave an order
 * fully pending or fully paid, and recording part of a payment later (orderCreateManualPayment amount) needs Shopify
 * Plus, so the order is created with orderCreate from the draft's own lines, discount, shipping, address and tags.
 * Returns the same shape as completeDraft: { id, name, legacyResourceId, statusPageUrl, total (paise), outstanding (paise) }.
 */
export async function createPartialOrder(env, { draftId, advancePaise, txnid }) {
  const d = await gql(env, `query($id:ID!){ draftOrder(id:$id){ id name email phone note2 tags customAttributes{ key value }
    shippingAddress{ firstName lastName address1 address2 city provinceCode zip countryCodeV2 phone }
    appliedDiscount{ title amountSet{ shopMoney{ amount } } }
    shippingLine{ title originalPriceSet{ shopMoney{ amount } } }
    lineItems(first:50){ nodes{ quantity title variant{ id } originalUnitPriceSet{ shopMoney{ amount } } } }
    totalPriceSet{ shopMoney{ amount } } } }`, { id: draftId });
  const dr = d.draftOrder;
  if (!dr) throw new Error('draft order not found: ' + draftId);
  const money = (a) => ({ shopMoney: { amount: String(a), currencyCode: 'INR' } });
  const a = dr.shippingAddress || {};
  const addr = { firstName: a.firstName || 'Customer', lastName: a.lastName || '', address1: a.address1 || '', address2: a.address2 || '', city: a.city || '', provinceCode: a.provinceCode || undefined, zip: a.zip || '', countryCode: a.countryCodeV2 || 'IN', phone: a.phone || dr.phone || undefined };
  const disc = Number(dr.appliedDiscount?.amountSet?.shopMoney?.amount || 0);
  const advance = (advancePaise / 100).toFixed(2);
  const order = {
    lineItems: dr.lineItems.nodes.filter((l) => l.variant?.id).map((l) => ({ variantId: l.variant.id, quantity: l.quantity, priceSet: money(l.originalUnitPriceSet.shopMoney.amount) })),
    shippingAddress: addr, billingAddress: addr,
    phone: dr.phone || undefined, email: dr.email || undefined,
    tags: [...new Set([...(dr.tags || []), 'partial-cod'])],
    customAttributes: (dr.customAttributes || []).map((x) => ({ key: x.key, value: String(x.value ?? '') })),
    note: dr.note2 || undefined,
    shippingLines: dr.shippingLine ? [{ title: dr.shippingLine.title || 'Shipping', priceSet: money(dr.shippingLine.originalPriceSet?.shopMoney?.amount || '0') }] : [],
    financialStatus: 'PARTIALLY_PAID',
    transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: 'PayU (partial COD advance)', authorizationCode: txnid || undefined, amountSet: money(advance) }],
    currency: 'INR',
  };
  if (disc > 0) order.discountCode = { itemFixedDiscountCode: { code: (dr.appliedDiscount.title || 'Offer').slice(0, 60), amountSet: money(disc) } };
  const nm = [addr.firstName, addr.lastName];
  const tries = [
    { ...order, sourceName: 'web', customer: dr.phone ? { toUpsert: { phone: dr.phone, firstName: nm[0], lastName: nm[1] || undefined, email: dr.email || undefined } } : undefined },
    { ...order },
  ];
  let last;
  for (const input of tries) {
    try {
      const r = await gql(env, `mutation($o:OrderCreateOrderInput!,$opt:OrderCreateOptionsInput){ orderCreate(order:$o, options:$opt){
        order{ id name legacyResourceId statusPageUrl displayFinancialStatus totalPriceSet{ shopMoney{ amount } } totalOutstandingSet{ shopMoney{ amount } } }
        userErrors{ field message } } }`, { o: input, opt: { inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', sendReceipt: false, sendFulfillmentReceipt: false } });
      const e = r.orderCreate.userErrors;
      if (e && e.length) throw new Error('orderCreate: ' + e.map((x) => (x.field ? x.field.join('.') + ': ' : '') + x.message).join('; '));
      const o = r.orderCreate.order;
      /* the draft served its purpose (price check); remove it so it doesn't sit in Drafts looking unpaid */
      gql(env, `mutation($id:ID!){ draftOrderDelete(input:{id:$id}){ deletedId } }`, { id: draftId }).catch(() => {});
      return { ...o, total: toPaise(o.totalPriceSet.shopMoney.amount), outstanding: toPaise(o.totalOutstandingSet?.shopMoney?.amount || 0), draftTotal: toPaise(dr.totalPriceSet.shopMoney.amount) };
    } catch (e) { last = e; console.warn('createPartialOrder attempt failed', e.message); }
  }
  throw last;
}
