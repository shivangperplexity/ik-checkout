/**
 * CodWing storefront API: called by sf.js on the seller's own store (any domain), so every answer carries
 * Access-Control-Allow-Origin: * and requests are text/plain JSON (no preflight).
 *   GET  /api/cw/cfg?shop=        what the script should do on this store (cached 60 s)
 *   POST /api/cw/track            one row per visitor session: furthest checkout step, phone, cart
 *   GET  /api/cw/pin?pin=         city + state for a PIN code
 *   POST /api/cw/quote            real prices from the store's Admin API + the seller's payment rules
 *   POST /api/cw/otp              WhatsApp code for cash on delivery (seller's own WhatsApp number)
 *   POST /api/cw/order            COD -> Shopify order now; online / partial -> Razorpay order to pay
 *   POST /api/cw/paid             Razorpay success -> signature check -> Shopify order (paid / partly paid)
 *   GET  /api/cw/restore?shop=&sid=  the saved cart and details behind a WhatsApp follow-up link
 * shop "demo.codwing.com" is the public demo (app.codwing.com/demo): prices come from the page, nothing is stored.
 */
import crypto from 'node:crypto';
import { unseal, adminGraphql, shopFromUrl } from './shopify.js';
import { quote, charge, onlineReady, waReady, stepNo } from './pricing.js';
import { cleanPhone, stateCode } from '../util.js';

export const DEMO = 'demo.codwing.com';
export const STORE_DDL = [
  `CREATE TABLE IF NOT EXISTS cw_sessions (shop TEXT, sid TEXT, first_at BIGINT, last_at BIGINT, step INT DEFAULT 0, phone TEXT, name TEXT, pincode TEXT, city TEXT, cart TEXT, value BIGINT, src TEXT, page TEXT, order_name TEXT, contacted_at BIGINT, PRIMARY KEY (shop, sid))`,
  `CREATE INDEX IF NOT EXISTS cw_sessions_last ON cw_sessions (shop, last_at)`,
  `CREATE TABLE IF NOT EXISTS cw_orders (id SERIAL PRIMARY KEY, shop TEXT, sid TEXT, method TEXT, status TEXT, total BIGINT, paid BIGINT, rzp_order TEXT, rzp_payment TEXT, payload TEXT, order_id TEXT, order_name TEXT, error TEXT, created_at BIGINT, updated_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS cw_otps (shop TEXT, phone TEXT, code_hash TEXT, sent_at BIGINT, sends INT DEFAULT 0, tries INT DEFAULT 0, verified_at BIGINT, PRIMARY KEY (shop, phone))`,
  `ALTER TABLE cw_shops ADD COLUMN IF NOT EXISTS domain TEXT`,
  `ALTER TABLE cw_shops ADD COLUMN IF NOT EXISTS name TEXT`,
];

const now = () => Math.floor(Date.now() / 1000);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
export const sj = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...h } });
const rupees = (p) => (Math.round(p) / 100).toFixed(2);
const money = (p) => ({ shopMoney: { amount: rupees(p), currencyCode: 'INR' } });

/* Seller context, cached for 60 s per instance. */
const cache = new Map();
export async function seller(env, shop, { secret, view, fresh = false }) {
  shop = shopFromUrl(shop);
  if (!shop) return null;
  const hit = cache.get(shop);
  if (!fresh && hit && hit.at > Date.now() - 60000) return hit.v;
  const row = await env.DB.prepare('SELECT * FROM cw_shops WHERE shop = ?').bind(shop).first();
  let v = null;
  if (row && row.token_box && !row.uninstalled_at) {
    let secrets = {};
    try { secrets = row.secrets_box ? JSON.parse(unseal(row.secrets_box, secret)) : {}; } catch { secrets = {}; }
    const vw = view(row);
    v = { shop, row, token: unseal(row.token_box, secret), settings: vw.settings, set: vw.secrets_set, secrets, domain: row.domain || 'https://' + shop, name: row.name || shop.replace('.myshopify.com', '') };
  }
  cache.set(shop, { at: Date.now(), v });
  return v;
}
export function forget(shop) { cache.delete(shop); }

export function demoSeller() {
  return { shop: DEMO, demo: true, domain: 'https://app.codwing.com/demo', name: 'Your Store',
    settings: { gateway: 'razorpay', razorpay_key_id: 'rzp_test_demo', cod_on: true, cod_otp: true, prepaid_discount: 50, cod_fee: 29, partial_advance: 0, partial_states: '', cod_max: 0, brand_color: '#111111', sheet_on: true, open_on_add: true, wa_phone_id: 'demo' },
    set: { razorpay_key_secret: true, wa_token: true }, secrets: {} };
}

async function body(req) { try { return JSON.parse(await req.text()); } catch { return {}; } }

/** Real prices for the cart lines. Sold-out lines are returned separately so the rest can still be ordered. */
async function priceLines(sel, lines) {
  lines = (Array.isArray(lines) ? lines : []).slice(0, 50)
    .map((l) => ({ variant_id: String(l.variant_id || '').replace(/\D/g, ''), quantity: Math.min(99, Math.max(0, Math.round(Number(l.quantity) || 0))), price: Number(l.price) || 0, title: l.title, image: l.image }))
    .filter((l) => l.variant_id && l.quantity > 0);
  if (!lines.length) return { items: [], soldOut: [] };
  if (sel.demo) return { items: lines.map((l) => ({ ...l, title: String(l.title || 'Item').slice(0, 80), price: Math.min(l.price, 1000000) })), soldOut: [] };
  const d = await adminGraphql(sel.shop, sel.token, `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant { id title price availableForSale image{ url } product{ title featuredImage{ url } } } } }`,
    { ids: lines.map((l) => `gid://shopify/ProductVariant/${l.variant_id}`) });
  const items = [], soldOut = [];
  lines.forEach((l, i) => {
    const v = d.nodes[i];
    if (!v) return soldOut.push({ variant_id: l.variant_id, title: '' });
    const title = v.product.title + (v.title && v.title !== 'Default Title' ? ' · ' + v.title : '');
    if (v.availableForSale === false) return soldOut.push({ variant_id: l.variant_id, title });
    items.push({ variant_id: l.variant_id, gid: v.id, quantity: l.quantity, price: Math.round(Number(v.price) * 100), title, image: v.image?.url || v.product.featuredImage?.url || '' });
  });
  return { items, soldOut };
}

export function publicCfg(sel) {
  const s = sel.settings;
  return {
    ok: true, on: s.sheet_on !== false, open_on_add: s.open_on_add !== false, color: s.brand_color || '#111111', name: sel.name,
    online: onlineReady(s, sel.set), otp: !!s.cod_otp && waReady(s, sel.set), cod: s.cod_on !== false,
    prepaid_discount: s.prepaid_discount || 0, cod_fee: s.cod_fee || 0, support_phone: s.support_phone || '',
  };
}

function cleanBuyer(b) {
  const phone = cleanPhone(b.phone);
  const first = String(b.first_name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const last = String(b.last_name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const pincode = String(b.pincode || '').replace(/\D/g, '');
  const address1 = String(b.address1 || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  const address2 = String(b.address2 || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const city = String(b.city || '').trim().slice(0, 60);
  const state = String(b.state || '').trim().slice(0, 60);
  const email = String(b.email || '').trim().slice(0, 120);
  const error = !phone ? 'Enter a valid 10-digit mobile number'
    : !first ? 'Enter your name'
    : !/^[1-9]\d{5}$/.test(pincode) ? 'Enter a valid 6-digit PIN code'
    : address1.length < 6 ? 'Enter your full address (house no., street, area)'
    : /https?:|www\.|maps\.app|goo\.gl/i.test(address1 + ' ' + address2) ? 'Please type the address, not a link'
    : !city ? 'Enter your city'
    : !stateCode(state) ? 'Pick your state'
    : email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'Check your email address' : '';
  return { error, phone, first, last, pincode, address1, address2, city, state, email };
}

/* WhatsApp OTP, codes kept only as HMACs */
const otpHash = (secret, shop, phone, code) => crypto.createHmac('sha256', 'cw-otp|' + secret).update(`${shop}:${phone}:${code}`).digest('hex');
export async function sendWaTemplate(sel, phone, name, components) {
  const r = await fetch(`https://graph.facebook.com/v21.0/${sel.settings.wa_phone_id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sel.secrets.wa_token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: '91' + phone, type: 'template', template: { name, language: { code: 'en' }, components } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.messages?.[0]?.id) throw new Error(j.error?.message || 'HTTP ' + r.status);
  return j.messages[0].id;
}

async function rzp(sel, path, payload) {
  const auth = Buffer.from(sel.settings.razorpay_key_id + ':' + sel.secrets.razorpay_key_secret).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1' + path, { method: payload ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth }, body: payload ? JSON.stringify(payload) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Razorpay: ' + (j.error?.description || 'HTTP ' + r.status));
  return j;
}
export function rzpSignatureOk(orderId, paymentId, signature, secret) {
  const want = crypto.createHmac('sha256', String(secret)).update(orderId + '|' + paymentId).digest('hex');
  const got = String(signature || '');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** The Shopify order: lines at their real prices, the prepaid discount as a code, the COD fee as a shipping line. */
export function orderInput({ items, buyer, method, c, payment, src }) {
  const addr = { firstName: buyer.first, lastName: buyer.last || '', address1: buyer.address1, address2: buyer.address2 || '', city: buyer.city, provinceCode: stateCode(buyer.state) || undefined, zip: buyer.pincode, countryCode: 'IN', phone: '+91' + buyer.phone };
  const o = {
    lineItems: items.map((l) => ({ variantId: l.gid, quantity: l.quantity, priceSet: money(l.price) })),
    shippingAddress: addr, billingAddress: addr, phone: '+91' + buyer.phone, email: buyer.email || undefined, currency: 'INR',
    tags: ['codwing', method === 'online' ? 'prepaid' : method === 'partial' ? 'partial-cod' : 'cod'],
    shippingLines: c.fee ? [{ title: 'COD fee', priceSet: money(c.fee) }] : [{ title: 'Free delivery', priceSet: money(0) }],
    customAttributes: [{ key: 'Checkout', value: 'CodWing' }, { key: 'Payment', value: method === 'online' ? 'Paid online' : method === 'partial' ? 'Partial COD' : 'Cash on delivery' }].concat(src ? [{ key: 'Source', value: String(src).slice(0, 200) }] : []),
    financialStatus: method === 'online' ? 'PAID' : method === 'partial' ? 'PARTIALLY_PAID' : 'PENDING',
  };
  if (c.discount > 0) o.discountCode = { itemFixedDiscountCode: { code: 'PREPAID', amountSet: money(c.discount) } };
  if (payment) o.transactions = [{ kind: 'SALE', status: 'SUCCESS', gateway: 'Razorpay', authorizationCode: payment, amountSet: money(c.now) }];
  return o;
}

async function createOrder(sel, input, buyer) {
  const tries = [{ ...input, customer: { toUpsert: { phone: input.phone, firstName: buyer.first, lastName: buyer.last || undefined, email: buyer.email || undefined } } }, input];
  let last;
  for (const o of tries) {
    try {
      const r = await adminGraphql(sel.shop, sel.token, `mutation($o:OrderCreateOrderInput!,$opt:OrderCreateOptionsInput){ orderCreate(order:$o, options:$opt){ order{ id name statusPageUrl } userErrors{ field message } } }`,
        { o, opt: { inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', sendReceipt: true, sendFulfillmentReceipt: true } });
      const e = r.orderCreate.userErrors;
      if (e?.length) throw new Error(e.map((x) => x.message).join('; '));
      return r.orderCreate.order;
    } catch (e) { last = e; }
  }
  throw last;
}

async function markSession(env, shop, sid, fields) {
  if (!sid) return;
  await env.DB.prepare(`UPDATE cw_sessions SET step = GREATEST(step, ?), order_name = COALESCE(?, order_name), last_at = ? WHERE shop = ? AND sid = ?`)
    .bind(fields.step || 0, fields.order_name || null, now(), shop, sid).run().catch(() => {});
}

export async function handleStore(req, env, path, ctx) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
  const name = path.slice('/api/cw/'.length);
  const b = req.method === 'POST' ? await body(req) : {};
  const shopIn = req.method === 'POST' ? b.shop : url.searchParams.get('shop');
  const sel = shopIn === DEMO ? demoSeller() : await seller(env, shopIn, ctx);

  if (name === 'pin') {
    const pin = String(url.searchParams.get('pin') || '');
    if (!/^[1-9]\d{5}$/.test(pin)) return sj({ ok: false }, 400);
    const r = await fetch(`https://api.postalpincode.in/pincode/${pin}`).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    const po = d?.[0]?.Status === 'Success' ? d[0].PostOffice?.[0] : null;
    if (po) return sj({ ok: true, city: po.District, state: po.State }, 200, { 'Cache-Control': 'public, max-age=86400' });
    return sj(d?.[0]?.Status === 'Error' ? { ok: false, notfound: true } : { ok: false });
  }
  if (!sel) return sj({ ok: false, error: 'store not connected' }, 404);
  const s = sel.settings;

  if (name === 'cfg') return sj(publicCfg(sel), 200, { 'Cache-Control': 'public, max-age=60' });

  if (name === 'track') {
    if (sel.demo) return sj({ ok: true });
    const sid = String(b.sid || '').replace(/[^\w-]/g, '').slice(0, 64);
    const step = stepNo(String(b.step || ''));
    if (!sid || !step) return sj({ ok: false }, 400);
    const t = now();
    const phone = cleanPhone(b.phone);
    const cart = Array.isArray(b.cart) ? JSON.stringify(b.cart.slice(0, 30).map((i) => ({ v: String(i.v || '').replace(/\D/g, ''), q: Math.min(99, Number(i.q) || 1), t: String(i.t || '').slice(0, 80), p: Math.round(Number(i.p) || 0) }))) : null;
    const value = cart ? JSON.parse(cart).reduce((x, i) => x + i.p * i.q, 0) : null;
    await env.DB.prepare(`INSERT INTO cw_sessions (shop, sid, first_at, last_at, step, phone, name, pincode, city, cart, value, src, page) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (shop, sid) DO UPDATE SET last_at = EXCLUDED.last_at, step = GREATEST(cw_sessions.step, EXCLUDED.step),
        phone = COALESCE(EXCLUDED.phone, cw_sessions.phone), name = COALESCE(EXCLUDED.name, cw_sessions.name),
        pincode = COALESCE(EXCLUDED.pincode, cw_sessions.pincode), city = COALESCE(EXCLUDED.city, cw_sessions.city),
        cart = COALESCE(EXCLUDED.cart, cw_sessions.cart), value = COALESCE(EXCLUDED.value, cw_sessions.value),
        src = COALESCE(cw_sessions.src, EXCLUDED.src), page = COALESCE(EXCLUDED.page, cw_sessions.page)`)
      .bind(sel.shop, sid, t, t, step, phone, b.name ? String(b.name).slice(0, 80) : null, /^\d{6}$/.test(b.pincode || '') ? b.pincode : null,
        b.city ? String(b.city).slice(0, 60) : null, cart, value, b.src ? String(b.src).slice(0, 200) : null, b.page ? String(b.page).slice(0, 200) : null).run();
    return sj({ ok: true });
  }

  if (name === 'restore') {
    const sid = String(url.searchParams.get('sid') || '').replace(/[^\w-]/g, '').slice(0, 64);
    const r = sid && !sel.demo ? await env.DB.prepare('SELECT phone, name, pincode, city, cart, order_name FROM cw_sessions WHERE shop = ? AND sid = ?').bind(sel.shop, sid).first() : null;
    if (!r || r.order_name) return sj({ ok: false });
    return sj({ ok: true, phone: r.phone, name: r.name, pincode: r.pincode, cart: JSON.parse(r.cart || '[]') });
  }

  if (name === 'quote') {
    const online = onlineReady(s, sel.set);
    const { items, soldOut } = await priceLines(sel, b.lines);
    return sj({ ok: true, items, soldOut, quote: quote(items, s, { state: b.state, online }), cfg: publicCfg(sel) });
  }

  if (name === 'otp') {
    const phone = cleanPhone(b.phone);
    if (!phone) return sj({ ok: false, error: 'Enter a valid 10-digit mobile number' });
    if (sel.demo) return sj({ ok: true, demo: true });
    if (!(s.cod_otp && waReady(s, sel.set))) return sj({ ok: false, skip: true });
    const t = now();
    const row = await env.DB.prepare('SELECT * FROM cw_otps WHERE shop = ? AND phone = ?').bind(sel.shop, phone).first();
    if (row && t - row.sent_at < 30) return sj({ ok: false, error: 'Wait a few seconds before asking for a new code', wait: 30 - (t - row.sent_at) });
    if (row && t - row.sent_at < 3600 && row.sends >= 5) return sj({ ok: false, skip: true });
    const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    try {
      await sendWaTemplate(sel, phone, s.wa_otp_template || 'codwing_otp', [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
      ]);
    } catch (e) { console.warn('cw otp', sel.shop, e.message); return sj({ ok: false, skip: true }); }
    const sends = row && t - row.sent_at < 3600 ? row.sends + 1 : 1;
    await env.DB.prepare(`INSERT INTO cw_otps (shop, phone, code_hash, sent_at, sends, tries, verified_at) VALUES (?, ?, ?, ?, ?, 0, NULL)
      ON CONFLICT (shop, phone) DO UPDATE SET code_hash = EXCLUDED.code_hash, sent_at = EXCLUDED.sent_at, sends = EXCLUDED.sends, tries = 0, verified_at = NULL`)
      .bind(sel.shop, phone, otpHash(ctx.secret, sel.shop, phone, code), t, sends).run();
    return sj({ ok: true });
  }

  if (name === 'order') {
    const buyer = cleanBuyer(b.buyer || {});
    if (buyer.error) return sj({ ok: false, error: buyer.error });
    const method = ['online', 'cod', 'partial'].includes(b.method) ? b.method : 'cod';
    const online = onlineReady(s, sel.set);
    const { items, soldOut } = await priceLines(sel, b.lines);
    if (!items.length) return sj({ ok: false, error: soldOut.length ? 'These items just sold out' : 'Your cart is empty' });
    const q = quote(items, s, { state: buyer.state, online });
    const c = charge(q, method);
    if (!c) return sj({ ok: false, error: method === 'cod' ? 'Cash on delivery is not available for this order' : 'Online payment is not available right now' });
    const sid = String(b.sid || '').replace(/[^\w-]/g, '').slice(0, 64);
    if (sel.demo) return sj({ ok: true, demo: true, method, ...(c.now ? { pay: { demo: true, amount: c.now } } : { order: { name: '#1001' } }) });

    if (method === 'cod' && s.cod_otp && waReady(s, sel.set)) {
      const row = await env.DB.prepare('SELECT * FROM cw_otps WHERE shop = ? AND phone = ?').bind(sel.shop, buyer.phone).first();
      const fresh = row && now() - row.sent_at < 600;
      if (fresh && !row.verified_at) {
        if (row.tries >= 5) return sj({ ok: false, error: 'Too many wrong codes. Ask for a new one.', otp: true });
        const good = String(b.otp || '').length === 4 && otpHash(ctx.secret, sel.shop, buyer.phone, String(b.otp)) === row.code_hash;
        if (!good) {
          await env.DB.prepare('UPDATE cw_otps SET tries = tries + 1 WHERE shop = ? AND phone = ?').bind(sel.shop, buyer.phone).run();
          return sj({ ok: false, error: b.otp ? 'That code is not right. Check WhatsApp and try again.' : 'Enter the code we sent on WhatsApp', otp: true });
        }
        await env.DB.prepare('UPDATE cw_otps SET verified_at = ? WHERE shop = ? AND phone = ?').bind(now(), sel.shop, buyer.phone).run();
      } else if (!fresh && !b.otp_skipped) {
        return sj({ ok: false, error: 'Enter the code we sent on WhatsApp', otp: true, resend: true });
      }
    }

    const payload = { items, buyer, method, c, src: b.src || '' };
    const t = now();
    if (method === 'cod') {
      const input = orderInput({ ...payload, payment: null });
      if (b.otp_skipped) input.tags.push('otp-not-verified');
      try {
        const o = await createOrder(sel, input, buyer);
        await env.DB.prepare('INSERT INTO cw_orders (shop, sid, method, status, total, paid, payload, order_id, order_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)')
          .bind(sel.shop, sid, method, 'placed', c.total, JSON.stringify(payload), o.id, o.name, t, t).run();
        await markSession(env, sel.shop, sid, { step: 7, order_name: o.name });
        return sj({ ok: true, order: { name: o.name, url: o.statusPageUrl } });
      } catch (e) {
        console.error('cw order', sel.shop, e.message);
        return sj({ ok: false, error: 'We could not place the order. Please try again.' });
      }
    }
    const ro = await rzp(sel, '/orders', { amount: c.now, currency: 'INR', receipt: 'cw' + t, notes: { shop: sel.shop, phone: buyer.phone } }).catch((e) => ({ error: e.message }));
    if (ro.error) { console.error('cw rzp', sel.shop, ro.error); return sj({ ok: false, error: 'Online payment is not available right now. Try cash on delivery.' }); }
    await env.DB.prepare('INSERT INTO cw_orders (shop, sid, method, status, total, paid, rzp_order, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)')
      .bind(sel.shop, sid, method, 'awaiting_payment', c.total, ro.id, JSON.stringify(payload), t, t).run();
    return sj({ ok: true, pay: { key: s.razorpay_key_id, order_id: ro.id, amount: c.now, name: sel.name, prefill: { name: (buyer.first + ' ' + buyer.last).trim(), contact: '+91' + buyer.phone, email: buyer.email || undefined } } });
  }

  if (name === 'paid') {
    if (sel.demo) return sj({ ok: true, order: { name: '#1002' } });
    const oid = String(b.razorpay_order_id || ''), pid = String(b.razorpay_payment_id || '');
    if (!rzpSignatureOk(oid, pid, b.razorpay_signature, sel.secrets.razorpay_key_secret)) return sj({ ok: false, error: 'Payment could not be verified' }, 400);
    const row = await env.DB.prepare('SELECT * FROM cw_orders WHERE shop = ? AND rzp_order = ?').bind(sel.shop, oid).first();
    if (!row) return sj({ ok: false, error: 'Order not found' }, 404);
    if (row.order_name) return sj({ ok: true, order: { name: row.order_name } });
    const p = JSON.parse(row.payload);
    try {
      const o = await createOrder(sel, orderInput({ ...p, payment: pid }), p.buyer);
      await env.DB.prepare('UPDATE cw_orders SET status = ?, paid = ?, rzp_payment = ?, order_id = ?, order_name = ?, updated_at = ? WHERE id = ?')
        .bind('placed', p.c.now, pid, o.id, o.name, now(), row.id).run();
      await markSession(env, sel.shop, row.sid, { step: 7, order_name: o.name });
      return sj({ ok: true, order: { name: o.name, url: o.statusPageUrl } });
    } catch (e) {
      await env.DB.prepare('UPDATE cw_orders SET status = ?, paid = ?, rzp_payment = ?, error = ?, updated_at = ? WHERE id = ?')
        .bind('paid_no_order', p.c.now, pid, String(e.message).slice(0, 500), now(), row.id).run();
      console.error('cw paid order', sel.shop, e.message);
      return sj({ ok: true, order: { name: '' }, note: 'Payment received. Your order is being confirmed.' });
    }
  }
  return sj({ ok: false, error: 'not found' }, 404);
}
