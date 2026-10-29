/**
 * Barter collab checkout (ik-checkout.vercel.app/collab): creators we collab with pick up to 4 tattoos for free in
 * exchange for 1 reel + 1 Instagram story with commercial rights.
 *   - catalogue: the Creator Collab Catalogue, only designs with 10+ in stock, never full sleeves
 *   - WhatsApp code login, then name / Instagram / email / address; delivery date like any customer; the date they
 *     will post the reel: 4 to 10 days after delivery (6 by default)
 *   - no payment: a ₹0 Shopify draft order (tags barter-collab, barter-pending) with an ID like IKC-1042 that they
 *     DM us on Instagram; we approve in the dashboard (More -> Barter collabs), which turns it into a real order that
 *     goes to "To ship", or reject (the draft is deleted)
 * Table barter_orders.
 */
import { gql } from './shopify.orig.js';
import { json, cleanPhone, stateCode } from './util.js';
import { makeToken, readToken } from './creators.js';

const now = () => Math.floor(Date.now() / 1000);
export const COLLECTION = 'creator-collab-ik26x';
export const MAX_ITEMS = 4, MIN_STOCK = 10, POST_MIN = 4, POST_DEF = 6, POST_MAX = 10;
export const TERMS = [
  'I will post 1 reel and 1 Instagram story featuring the Ink Kulture tattoos, tagging @inkkulture.in.',
  'Ink Kulture may reuse the reel and story (commercial rights) on its own pages and in ads.',
  'I will post the reel on the date I pick below (4 to 10 days after delivery).',
  'My order is sent only after I DM the order ID to @inkkulture.in on Instagram and it is approved.',
];
export const refOf = (id) => 'IKC-' + (1000 + Number(id));

/** Pure: may a creator have this product? */
export function eligible(p) {
  if (/\bsleeve\b/i.test(p.title || '') || (p.collections || []).some((c) => /sleeve/i.test(c))) return false;
  return (p.stock ?? 0) >= MIN_STOCK && p.available !== false;
}
/** Pure: the posting window, as 'YYYY-MM-DD' strings, from the delivery date. */
export function postWindow(deliveryIso) {
  const base = deliveryIso && /^\d{4}-\d{2}-\d{2}$/.test(deliveryIso) ? Date.parse(deliveryIso + 'T12:00:00+05:30') : Date.now() + 7 * 86400000;
  const d = (n) => new Date(base + n * 86400000 + 19800000).toISOString().slice(0, 10);
  return { min: d(POST_MIN), def: d(POST_DEF), max: d(POST_MAX) };
}

/* ---------------- catalogue (cached 15 min) ---------------- */
let memCat = null;
export async function catalogue(env) {
  if (memCat && memCat.at > now() - 900) return memCat.items;
  const items = [];
  let after = null;
  for (let page = 0; page < 3; page++) {
    const d = await gql(env, `query($h:String!,$a:String){ collectionByHandle(handle:$h){ products(first:100, after:$a, sortKey:COLLECTION_DEFAULT){ pageInfo{hasNextPage endCursor}
      nodes{ id title handle status productType featuredImage{ url } collections(first:10){ nodes{ handle } }
        variants(first:5){ nodes{ id title availableForSale inventoryQuantity price } } } } } }`, { h: COLLECTION, a: after });
    const c = d.collectionByHandle;
    if (!c) break;
    for (const p of c.products.nodes) {
      if (p.status !== 'ACTIVE') continue;
      for (const v of p.variants.nodes) {
        const it = { id: v.id.split('/').pop(), product: p.title, title: p.title.replace(/\s*Tattoo$/i, '') + (v.title && v.title !== 'Default Title' ? ' · ' + v.title : ''), size: v.title !== 'Default Title' ? v.title : '', image: p.featuredImage?.url || '', handle: p.handle, stock: Number(v.inventoryQuantity) || 0, available: v.availableForSale, price: Number(v.price) || 0, collections: p.collections.nodes.map((x) => x.handle) };
        if (eligible({ ...it, title: p.title })) items.push(it);
      }
    }
    if (!c.products.pageInfo.hasNextPage) break;
    after = c.products.pageInfo.endCursor;
  }
  memCat = { at: now(), items };
  return items;
}

/* ---------------- order ---------------- */
async function placeBarter(env, phone, b) {
  const items = (Array.isArray(b.items) ? b.items : []).map((x) => ({ id: String(x.id || '').replace(/\D/g, ''), qty: Math.max(1, Math.min(MAX_ITEMS, parseInt(x.qty, 10) || 1)) })).filter((x) => x.id);
  const count = items.reduce((a, x) => a + x.qty, 0);
  if (!count) throw new Error('Pick at least one tattoo');
  if (count > MAX_ITEMS) throw new Error(`You can pick up to ${MAX_ITEMS} tattoos`);
  const cat = await catalogue(env);
  const lines = items.map((x) => { const c = cat.find((y) => y.id === x.id); if (!c) throw new Error('One of the designs is no longer available, please pick another'); return { ...c, qty: x.qty }; });
  const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const ig = String(b.instagram || '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?].*$/, '').toLowerCase();
  const email = String(b.email || '').trim().slice(0, 120);
  const a = { address1: String(b.address1 || '').trim().slice(0, 120), address2: String(b.address2 || '').trim().slice(0, 120), city: String(b.city || '').trim().slice(0, 60), state: String(b.state || '').trim(), pincode: String(b.pincode || '').trim() };
  const err = name.length < 2 ? 'Enter your name' : !/^[a-z0-9._]{1,30}$/.test(ig) ? 'Enter your Instagram username' : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? 'Enter a valid email'
    : !/^\d{6}$/.test(a.pincode) ? 'Enter a valid 6-digit PIN code' : a.address1.length < 5 ? 'Enter your full address' : !a.city ? 'Enter your city' : !stateCode(a.state) ? 'Select your state'
    : !b.agree ? 'Please accept the collab terms' : '';
  if (err) throw new Error(err);
  /* one live collab per number and per Instagram account */
  const dup = await env.DB.prepare("SELECT id, status FROM barter_orders WHERE (phone=? OR instagram=?) AND status IN ('pending','approved') AND created_at>? LIMIT 1").bind(phone, ig, now() - 45 * 86400).first();
  if (dup) throw new Error(dup.status === 'pending' ? `You already have a collab order waiting: ${refOf(dup.id)}. DM that ID to @inkkulture.in on Instagram.` : 'You already have a collab order with us. Message us on Instagram for another one.');
  const { deliveryEstimate } = await import('./edd.js');
  const e = await deliveryEstimate(env, { pin: a.pincode });
  if (e.ok && e.serviceable === false) throw new Error(`Sorry, we can't deliver to PIN code ${a.pincode} yet.`);
  const w = postWindow(e.date || '');
  const post = String(b.post_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(post) || post < w.min || post > w.max) throw new Error(`Pick a posting date between ${w.min} and ${w.max}`);

  const r = await env.DB.prepare(`INSERT INTO barter_orders (phone, name, email, instagram, items_json, address_json, edd, post_date, status, created_at) VALUES (?,?,?,?,?,?,?,?, 'pending', ?) RETURNING id`)
    .bind(phone, name, email, ig, JSON.stringify(lines.map((l) => ({ id: l.id, title: l.title, qty: l.qty, image: l.image, price: l.price }))), JSON.stringify(a), e.date || '', post, now()).first();
  const ref = refOf(r.id);
  const [firstName, ...rest] = name.split(' ');
  const addr = { firstName, lastName: rest.join(' '), address1: a.address1, address2: a.address2, city: a.city, provinceCode: stateCode(a.state), zip: a.pincode, countryCode: 'IN', phone: '+91' + phone };
  const value = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const input = {
    lineItems: lines.map((l) => ({ variantId: `gid://shopify/ProductVariant/${l.id}`, quantity: l.qty })),
    shippingAddress: addr, billingAddress: addr, phone: '+91' + phone, email, tags: ['barter-collab', 'barter-pending', 'ik-checkout'],
    customAttributes: [{ key: 'Collab ID', value: ref }, { key: 'Instagram', value: '@' + ig }, { key: 'Reel posting date', value: post }, { key: 'Deliverables', value: '1 reel + 1 IG story, commercial rights' }, { key: 'Terms accepted', value: new Date().toISOString() }],
    note: `Barter collab ${ref} · @${ig} · reel by ${post}`,
    appliedDiscount: { title: 'Creator collab', description: 'Barter collab: 1 reel + 1 story', value: value, valueType: 'FIXED_AMOUNT' },
    shippingLine: { title: 'Free shipping', price: '0' },
  };
  const d = await gql(env, `mutation($input:DraftOrderInput!){ draftOrderCreate(input:$input){ draftOrder{ id name } userErrors{ field message } } }`, { input });
  const ue = d.draftOrderCreate.userErrors;
  if (ue?.length) { await env.DB.prepare("UPDATE barter_orders SET status='failed', note=? WHERE id=?").bind(ue.map((x) => x.message).join('; ').slice(0, 300), r.id).run(); throw new Error('Could not create the order, please try again'); }
  await env.DB.prepare('UPDATE barter_orders SET draft_id=?, draft_name=? WHERE id=?').bind(d.draftOrderCreate.draftOrder.id, d.draftOrderCreate.draftOrder.name, r.id).run();
  return { ok: true, ref, edd: e.edd || '', post_date: post, instagram: ig };
}

/* ---------------- dashboard ---------------- */
export async function barterList(env) {
  const rows = (await env.DB.prepare('SELECT * FROM barter_orders ORDER BY id DESC LIMIT 200').all()).results;
  return { ok: true, rows: rows.map((r) => ({ id: r.id, ref: refOf(r.id), phone: r.phone, name: r.name, email: r.email, instagram: r.instagram, items: JSON.parse(r.items_json || '[]'), address: JSON.parse(r.address_json || '{}'), edd: r.edd, post_date: r.post_date, status: r.status, order_name: r.order_name || '', created_at: Number(r.created_at), decided_at: Number(r.decided_at) || null, note: r.note || '' })) };
}
export async function barterDecide(env, id, approve) {
  const r = await env.DB.prepare('SELECT * FROM barter_orders WHERE id=?').bind(Number(id)).first();
  if (!r) throw new Error('Not found');
  if (r.status !== 'pending') throw new Error('Already ' + r.status);
  if (!approve) {
    if (r.draft_id) await gql(env, `mutation($id:ID!){ draftOrderDelete(input:{id:$id}){ userErrors{ message } } }`, { id: r.draft_id }).catch((e) => console.error('draft delete', e.message));
    await env.DB.prepare("UPDATE barter_orders SET status='rejected', decided_at=? WHERE id=?").bind(now(), r.id).run();
    return { ok: true, status: 'rejected' };
  }
  const { completeDraft, removeTags } = await import('./shopify.orig.js');
  const order = await completeDraft(env, r.draft_id, false);
  await removeTags(env, order.id, ['barter-pending']).catch(() => {});
  const a = JSON.parse(r.address_json || '{}');
  const [first, ...rest] = String(r.name || '').split(' ');
  /* into "To ship" like any prepaid order (₹0) */
  await env.DB.prepare(`INSERT INTO orders (idem, order_id, order_gid, order_name, status_url, method, total_paise, phone, email, first_name, last_name, city, state_code, pincode, source_url, contents_json, status, created_at, confirmed_at)
      VALUES (?,?,?,?,?,'prepaid',0,?,?,?,?,?,?,?,?,?, 'placed', ?, ?) ON CONFLICT (idem) DO NOTHING`)
    .bind('barter-' + r.id, String(order.legacyResourceId), order.id, order.name, order.statusPageUrl || '', r.phone, r.email, first, rest.join(' '), a.city || '', stateCode(a.state), a.pincode || '', `https://www.inkkulture.in/collections/${COLLECTION}?barter=${refOf(r.id)}`, JSON.stringify(JSON.parse(r.items_json || '[]').map((x) => ({ id: x.id, quantity: x.qty, item_price: 0, title: x.title }))), now(), now()).run();
  await env.DB.prepare("UPDATE barter_orders SET status='approved', decided_at=?, order_id=?, order_name=? WHERE id=?").bind(now(), String(order.legacyResourceId), order.name, r.id).run();
  return { ok: true, status: 'approved', order: order.name };
}

/* ---------------- router: /api/barter/* ---------------- */
export async function handleBarter(req, env) {
  const url = new URL(req.url), path = url.pathname;
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'x';
  const limit = async (k, max) => { const r = await env.DB.prepare('INSERT INTO rl (ip, hr, n) VALUES (?,?,1) ON CONFLICT (ip, hr) DO UPDATE SET n=rl.n+1 RETURNING n').bind(k, Math.floor(Date.now() / 3600000)).first().catch(() => null); return !r || Number(r.n) <= max; };
  const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  try {
    if (path === '/api/barter/catalogue') return json({ ok: true, max: MAX_ITEMS, terms: TERMS, items: (await catalogue(env)).map(({ collections, stock, ...x }) => x) });
    if (path === '/api/barter/edd') {
      const pin = String(url.searchParams.get('pin') || '');
      if (!/^\d{6}$/.test(pin)) return json({ ok: false, error: 'Enter a valid PIN code' });
      if (!(await limit('bedd:' + ip, 60))) return json({ ok: false, error: 'Too many checks' }, 429);
      const { deliveryEstimate } = await import('./edd.js');
      const [e, place] = await Promise.all([deliveryEstimate(env, { pin }), fetch(`https://api.postalpincode.in/pincode/${pin}`).then((r) => r.json()).catch(() => null)]);
      const po = place?.[0]?.Status === 'Success' ? place[0].PostOffice?.[0] : null;
      return json({ ok: true, serviceable: e.serviceable !== false, edd: e.edd || '', date: e.date || '', window: postWindow(e.date || ''), city: po?.District || '', state: po?.State || '' });
    }
    if (path === '/api/barter/otp' && req.method === 'POST') {
      const phone = cleanPhone(b.phone);
      if (!phone) return json({ ok: false, error: 'Enter your 10-digit WhatsApp number' });
      if (!(await limit('botp:' + ip, 15))) return json({ ok: false, error: 'Too many tries, please try again later' }, 429);
      const { sendOtp } = await import('./cod-otp.js');
      const r = await sendOtp(env, phone);
      return json(r.ok ? { ok: true } : { ok: false, error: r.fallback ? 'Could not send the WhatsApp code right now. Please try again in a few minutes.' : r.error, wait: r.wait });
    }
    if (path === '/api/barter/verify' && req.method === 'POST') {
      const phone = cleanPhone(b.phone);
      if (!(await limit('bver:' + ip, 40))) return json({ ok: false, error: 'Too many tries, please try again later' }, 429);
      const { checkOtp } = await import('./cod-otp.js');
      const v = await checkOtp(env, phone, String(b.code || ''));
      if (!v.ok) return json({ ok: false, error: v.error });
      return json({ ok: true, token: await makeToken(env, phone, 6 * 3600, 'barter') });
    }
    const phone = await readToken(env, String(req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), 'barter');
    if (!phone) return json({ ok: false, auth: true, error: 'Please verify your WhatsApp number again' }, 401);
    if (path === '/api/barter/order' && req.method === 'POST') {
      if (!(await limit('bord:' + phone, 6))) return json({ ok: false, error: 'Too many tries, please try again later' }, 429);
      return json(await placeBarter(env, phone, b));
    }
    return json({ ok: false, error: 'not found' }, 404);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e).slice(0, 200) }, 400);
  }
}
