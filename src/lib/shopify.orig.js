import { stateCode } from './util.js';
import { rupees, toPaise } from './pricing.js';

const API_VERSION = '2025-07';

// Shopify Dev Dashboard apps have no permanent token: exchange client id + secret (client credentials grant)
// for a ~24h token and cache it per warm instance. A static SHOPIFY_ADMIN_TOKEN still works if set.
let cached = { token: '', exp: 0 };
async function adminToken(env) {
  const t = env.SHOPIFY_ADMIN_TOKEN;
  if (t && t !== 'REPLACE_ME') return t;
  if (cached.token && Date.now() < cached.exp) return cached.token;
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET || env.SHOPIFY_CLIENT_ID === 'REPLACE_ME') throw new Error('shopify: no credentials configured');
  const r = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET, grant_type: 'client_credentials' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('shopify token exchange failed: ' + r.status);
  cached = { token: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 3600) - 300) * 1000 };
  return cached.token;
}

export async function gql(env, query, variables = {}) {
  const res = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await adminToken(env) },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (!res.ok || data.errors) throw new Error('shopify: ' + JSON.stringify(data.errors || res.status));
  return data.data;
}

function userErr(r, key) {
  const e = r[key].userErrors;
  if (e && e.length) throw new Error(`${key}: ${e.map((x) => x.message).join('; ')}`);
}

/** Authoritative prices/types from Shopify; never trust the browser. */
export async function loadLines(env, cartLines) {
  const ids = cartLines.map((l) => `gid://shopify/ProductVariant/${l.variant_id}`);
  const d = await gql(
    env,
    `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant { id title price availableForSale product { title productType handle } } } }`,
    { ids },
  );
  return cartLines.map((l, i) => {
    const v = d.nodes[i];
    if (!v) throw new Error('unknown variant ' + l.variant_id);
    if (!v.availableForSale) throw new Error('sold out: ' + v.product.title);
    return {
      variantId: v.id,
      title: v.product.title,
      qty: Math.max(1, Math.min(20, parseInt(l.quantity, 10) || 1)),
      unit: toPaise(v.price),
      productType: v.product.productType,
      handle: v.product.handle,
    };
  });
}

export async function createDraft(env, { lines, price, method, buyer, tags, attributes }) {
  const addr = {
    firstName: buyer.firstName,
    lastName: buyer.lastName || '',
    address1: buyer.address1,
    address2: buyer.address2 || '',
    city: buyer.city,
    provinceCode: stateCode(buyer.state),
    zip: buyer.pincode,
    countryCode: 'IN',
    phone: '+91' + buyer.phone,
  };
  const discount = price.bogo + price.prepaid + (price.upsell || 0) + (price.ref || 0) + (price.credit || 0);
  const title = [price.bogo ? 'Buy 1 Get 1 Free' : '', price.upsell ? 'Add-on offer' : '', price.prepaid ? 'Prepaid discount' : '', price.ref ? 'Referral ₹' + price.ref / 100 : '', price.credit ? 'Store credit ₹' + price.credit / 100 : ''].filter(Boolean).join(' + ');
  const input = {
    lineItems: lines.map((l) => ({ variantId: l.variantId, quantity: l.qty })),
    shippingAddress: addr,
    billingAddress: addr,
    phone: '+91' + buyer.phone,
    tags,
    customAttributes: attributes,
    shippingLine: {
      title: price.cod ? (price.shipping ? 'Shipping + COD fee' : 'COD fee') : price.shipping ? 'Shipping' : 'Free shipping',
      price: rupees(price.shipping + price.cod),
    },
  };
  if (buyer.email) input.email = buyer.email;
  /* Sales-channel attribution: 'web' is the Online Store channel handle, so these orders show up under
     Online Store in Shopify Analytics / Marketing like a normal checkout would, instead of "Draft Orders". */
  input.sourceName = 'web';
  const utm = (attributes || []).filter((x) => /^utm_|^landing$|^fbclid$/.test(x.key)).map((x) => `${x.key}=${x.value}`).join('\n');
  if (utm) input.note = `Attribution\n${utm}`.slice(0, 5000);
  if (discount > 0) input.appliedDiscount = { title: title || 'Discount', description: title, value: Number(rupees(discount)), valueType: 'FIXED_AMOUNT' };
  const d = await gql(
    env,
    `mutation($input:DraftOrderInput!){ draftOrderCreate(input:$input){ draftOrder{ id name totalPriceSet{ shopMoney{ amount } } } userErrors{ field message } } }`,
    { input },
  );
  userErr(d, 'draftOrderCreate');
  const dr = d.draftOrderCreate.draftOrder;
  return { id: dr.id, name: dr.name, total: toPaise(dr.totalPriceSet.shopMoney.amount) };
}

export async function completeDraft(env, draftId, paymentPending) {
  /* paymentPending=false marks the order PAID at completion (prepaid, after PayU confirms); true leaves it
     pending (COD). sourceName:"web" attributes the order to the Online Store channel; if Shopify ever
     rejects that for this app, we retry without it so an order is never lost over attribution. */
  const run = (withSource) => gql(
    env,
    `mutation($id:ID!,$pp:Boolean,$src:String){ draftOrderComplete(id:$id, paymentPending:$pp, sourceName:$src){ draftOrder{ id order{ id name legacyResourceId statusPageUrl } } userErrors{ field message } } }`,
    { id: draftId, pp: paymentPending, src: withSource ? 'web' : null },
  );
  let d;
  try { d = await run(true); userErr(d, 'draftOrderComplete'); }
  catch (e) {
    if (!/sourceName|source_name|channel/i.test(String(e.message))) throw e;
    console.warn('draftOrderComplete: sourceName rejected, retrying without', e.message);
    d = await run(false); userErr(d, 'draftOrderComplete');
  }
  return d.draftOrderComplete.draftOrder.order;
}

export async function addTags(env, id, tags) {
  const d = await gql(env, `mutation($id:ID!,$t:[String!]!){ tagsAdd(id:$id, tags:$t){ userErrors{ message } } }`, { id, t: tags });
  userErr(d, 'tagsAdd');
}
export async function removeTags(env, id, tags) {
  const d = await gql(env, `mutation($id:ID!,$t:[String!]!){ tagsRemove(id:$id, tags:$t){ userErrors{ message } } }`, { id, t: tags });
  userErr(d, 'tagsRemove');
}

export async function cancelOrder(env, orderGid, staffNote) {
  const d = await gql(
    env,
    `mutation($id:ID!,$n:String){ orderCancel(orderId:$id, reason:CUSTOMER, refund:false, restock:true, notifyCustomer:false, staffNote:$n){ orderCancelUserErrors{ message } } }`,
    { id: orderGid, n: staffNote },
  );
  const e = d.orderCancel.orderCancelUserErrors;
  if (e && e.length) throw new Error('orderCancel: ' + e.map((x) => x.message).join('; '));
}

export async function orderDetail(env, id) {
  const d = await gql(env, `query($id:ID!){ order(id:$id){ id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus tags note
    totalPriceSet{shopMoney{amount}} shippingAddress{name address1 address2 city province zip phone}
    lineItems(first:30){nodes{title quantity variantTitle originalUnitPriceSet{shopMoney{amount}} image{url}}}
    fulfillments(first:5){trackingInfo{company number url} status}
    fulfillmentOrders(first:5){nodes{id status}} } }`, { id: `gid://shopify/Order/${id}` });
  return d.order;
}
export async function shipOrder(env, id, { company, number, url, notify }) {
  const o = await gql(env, `query($id:ID!){ order(id:$id){ fulfillmentOrders(first:10){nodes{id status}} } }`, { id: `gid://shopify/Order/${id}` });
  const fos = (o.order?.fulfillmentOrders?.nodes || []).filter((f) => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(f.status));
  if (!fos.length) throw new Error('Nothing left to fulfil (already shipped, cancelled, or on hold in Shopify)');
  const d = await gql(env, `mutation($f:FulfillmentInput!){ fulfillmentCreate(fulfillment:$f){ fulfillment{ id status } userErrors{ message } } }`, {
    f: { notifyCustomer: !!notify, trackingInfo: { company, number, url: url || undefined }, lineItemsByFulfillmentOrder: fos.map((f) => ({ fulfillmentOrderId: f.id })) },
  });
  userErr(d, 'fulfillmentCreate');
}
export async function searchProducts(env, q) {
  const d = await gql(env, `query($q:String){ products(first:12, query:$q){ nodes{ title productType featuredImage{url} status variants(first:5){nodes{id title price availableForSale}} } } }`, { q: q ? `title:*${q.replace(/[^\w ]/g, '')}* status:active` : 'status:active' });
  return d.products.nodes.flatMap((p) => p.variants.nodes.filter((v) => v.availableForSale).map((v) => ({ variantId: v.id.split('/').pop(), title: p.title + (v.title !== 'Default Title' ? ' - ' + v.title : ''), price: v.price, image: p.featuredImage?.url || '', type: p.productType })));
}