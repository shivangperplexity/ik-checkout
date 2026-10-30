import { corsHeaders, allowedOrigins, json, cleanPhone, stateCode } from './util.js';
import { isCollab, COLLAB_TAG } from './collab.js';
import { cameFromAd } from './attribution.js';
import { loadLines, createDraft, completeDraft, addTags, removeTags, cancelOrder, createPartialOrder } from './shopify.js';
import { decide, quoteFlag, reasonText } from './partial-cod.js';
import { priceCart, quoteBoth, rupees } from './pricing.js';
import { sendOtp, checkOtp, otpOn, otpStatus, otpDelivery } from './cod-otp.js';
import { buildPayuForm, verifyResponse, upiIntent, verifyPayment } from './payu.js';
import { sendPurchase, metaCfg, recordCapi, purchasePayload } from './meta.js';
import { sendText, verifySignature, parseReplies, parseStatuses, fireTrigger, logMsg, dedupeInbound } from './whatsapp.js';
import { withSettings, codOn, codMode } from './settings.js';
import { handleLogin, handleRpc, handleLabel, handleTrack, markSessionOrdered, afterOrderRisk, runAutomations } from './admin.js';
import { shippingEstimate } from './shipping.js';
import { quoteRef, friendOffer, creditBalance, forOrder, onPaid, normCode } from './referral.js';

const now = () => Math.floor(Date.now() / 1000);
const rand = () => Math.random().toString(36).slice(2, 8);

function clientOk(req, env) {
  return allowedOrigins(env).includes(req.headers.get('Origin') || '');
}

async function rateLimit(env, ip, max) {
  if (!env.DB) return true;
  const hr = Math.floor(Date.now() / 3600000);
  const r = await env.DB.prepare('INSERT INTO rl (ip,hr,n) VALUES (?,?,1) ON CONFLICT(ip,hr) DO UPDATE SET n=rl.n+1 RETURNING n').bind(ip, hr).first();
  return (r?.n || 1) <= max;
}

function cartLines(body) {
  const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 30).filter((l) => /^\d+$/.test(String(l.variant_id)));
  if (!lines.length) throw new Error('empty cart');
  return lines;
}

function applyUpsells(env, raw, lines) {
  const ups = env.SETTINGS?.upsells || [];
  lines.forEach((l, i) => {
    if (!raw[i].upsell) return;
    const u = ups.find((x) => x.enabled && String(x.variantId) === String(raw[i].variant_id));
    if (u) { l.upsellPct = u.pct || 0; l.isUpsell = true; }
  });
}

/** The shopper's attribution when a checkout request carries it (Build 046+), else undefined */
const attrsIn = (b) => (b && b.attribution && typeof b.attribution === 'object' ? b.attribution : undefined);

async function handleQuote(req, env) {
  const body = await req.json();
  const raw = cartLines(body);
  const lines = await loadLines(env, raw);
  applyUpsells(env, raw, lines);
  /* Refer and earn: a friend's code (attribution.ref, from ?ref= on the store) takes ₹100 off the online-payment price */
  const q = env.DB ? await quoteRef(env, quoteBoth(lines, {}), attrsIn(body)).catch(() => quoteBoth(lines, {})) : quoteBoth(lines, {});
  const inCart = new Set(raw.map((l) => String(l.variant_id)));
  const upsells = (env.SETTINGS?.upsells || []).filter((u) => u.enabled && !inCart.has(String(u.variantId)) && q.cod.subtotal >= (u.minCart || 0) * 100)
    .map((u) => ({ variantId: u.variantId, title: u.title, image: u.image, price: Math.round(u.price * 100), pct: u.pct, headline: u.headline }));
  return json({ ok: true, lines: lines.map((l) => ({ title: l.title, qty: l.qty, unit: l.unit, upsell: !!l.isUpsell })), upsells, upi_logos: env.SETTINGS?.upi_logos || {}, partial: codOn(env, attrsIn(body)) ? quoteFlag(env) : { mode: 'off' }, cod_on: codOn(env, attrsIn(body)), px: metaPx(env), mystery: { on: false } /* Build 043 still asks: keeps its old mystery-gift lines hidden */, otp: otpOn(env), ...q });
}

/** Partial COD: does this address / number pay the advance first? The checkout asks once the delivery details are in. */
async function handleCodCheck(req, env) {
  const b = await req.json().catch(() => ({}));
  const total = Math.max(0, Math.round(Number(b.total) || 0));
  if (!codOn(env, attrsIn(b))) return json({ ok: true, partial: false, mode: 'off', cod_off: true });
  const d = await decide(env, { phone: String(b.phone || ''), pincode: String(b.pincode || ''), address1: String(b.address1 || '').slice(0, 200), address2: String(b.address2 || '').slice(0, 200) }, total);
  return json({ ok: true, partial: d.partial, mode: d.mode, advance: d.advance, balance: d.balance, hint: d.hint });
}

async function handleLead(req, env) {
  if (!env.DB) return json({ ok: true, db: !!env.DB });
  const b = await req.json();
  const phone = cleanPhone(b.phone);
  if (!phone) return json({ ok: false }, 400);
  const t = now();
  await env.DB.prepare(
    `INSERT INTO leads (phone,name,pincode,cart_json,utm_json,fbp,fbc,step,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'open',?,?)
     ON CONFLICT(phone) DO UPDATE SET name=excluded.name,pincode=excluded.pincode,cart_json=excluded.cart_json,utm_json=excluded.utm_json,
     fbp=excluded.fbp,fbc=excluded.fbc,step=excluded.step,status=CASE WHEN leads.status='ordered' AND ?<leads.updated_at+86400 THEN 'ordered' ELSE 'open' END,updated_at=excluded.updated_at`,
  )
    .bind(phone, String(b.name || '').slice(0, 80), String(b.pincode || '').slice(0, 6), JSON.stringify(b.lines || []).slice(0, 4000), JSON.stringify(b.utm || {}).slice(0, 1500), b.fbp || null, b.fbc || null, String(b.step || '').slice(0, 20), t, t, t)
    .run();
  return json({ ok: true, db: !!env.DB });
}

async function handlePincode(pin) {
  if (!/^\d{6}$/.test(pin)) return json({ ok: false }, 400);
  const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { cf: { cacheTtl: 86400, cacheEverything: true } });
  const d = await res.json().catch(() => null);
  const po = d?.[0]?.Status === 'Success' ? d[0].PostOffice?.[0] : null;
  if (!po) return json({ ok: false });
  return json({ ok: true, city: po.District, state: po.State });
}

function validateBuyer(b) {
  const phone = cleanPhone(b.phone);
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const pincode = String(b.pincode || '').trim();
  const address1 = String(b.address1 || '').trim();
  const city = String(b.city || '').trim();
  const state = String(b.state || '').trim();
  const email = String(b.email || '').trim();
  const err = !phone ? 'Enter a valid 10-digit mobile number'
    : name.length < 2 ? 'Enter your name'
    : !/^\d{6}$/.test(pincode) ? 'Enter a valid 6-digit PIN code'
    : address1.length < 5 ? 'Enter your full address'
    : !city ? 'Enter your city'
    : !stateCode(state) ? 'Select your state'
    : email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? 'Email looks wrong'
    : null;
  if (err) throw Object.assign(new Error(err), { user: true });
  /* Build 036 theme sends first_name / last_name (Shopify's field set) as well as the joined name. */
  let firstName = String(b.first_name || '').trim(), lastName = String(b.last_name || '').trim();
  if (!firstName) { const [f, ...rest] = name.split(' '); firstName = f; lastName = rest.join(' '); }
  return { phone, firstName, lastName, pincode, address1, address2: String(b.address2 || '').trim().slice(0, 120), city, state, email: email || null,
    edd: String(b.edd || '').trim().slice(0, 40), newsOptIn: !!b.news };
}

async function handleOrder(req, env, ctx) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
  if (!(await rateLimit(env, ip, 20))) return json({ ok: false, error: 'Too many attempts, please try again later' }, 429);
  const b = await req.json();
  const method = b.method === 'prepaid' ? 'prepaid' : 'cod';
  const wantPartial = b.method === 'partial';
  const idem = String(b.idem || '').slice(0, 64);
  if (!idem) return json({ ok: false, error: 'bad request' }, 400);

  const prior = env.DB && (await env.DB.prepare('SELECT * FROM orders WHERE idem=?').bind(idem).first());
  if (prior && prior.status !== 'failed') return json(await replayResponse(env, prior));
  /* Cash on delivery switched off in Settings > Checkout: older checkout builds still show the COD tile, so refuse here too. */
  if ((method === 'cod' || wantPartial) && !codOn(env, b.attribution || {})) return json({ ok: false, cod_off: true, error: codMode(env) === 'off' ? 'Cash on delivery is not available right now. Please pay by UPI or card.' : 'Cash on delivery is not available for this order. Please pay by UPI or card.' });

  let buyer;
  try { buyer = validateBuyer(b.buyer || {}); } catch (e) { return json({ ok: false, error: e.message }, 400); }
  /* neither ShipPrime nor Shiprocket delivers to this PIN: don't take the order (a failed courier lookup never blocks) */
  try {
    const { deliveryEstimate } = await import('./edd.js');
    const e = await deliveryEstimate(env, { pin: buyer.pincode, cod: b.method === 'cod' });
    if (e.ok && e.serviceable === false) return json({ ok: false, error: `Sorry, we can't deliver to PIN code ${buyer.pincode} yet. Please use another address.`, unserviceable: true }, 400);
  } catch (e) { console.error('serviceability', e.message); }

  const raw = cartLines(b);
  const lines = await loadLines(env, raw);
  applyUpsells(env, raw, lines);
  const price = priceCart(lines, method, {});
  /* Partial COD: the server decides again with the real total; a stale checkout gets told to switch. */
  let partial = null;
  if (method === 'cod') {
    const d = await decide(env, buyer, price.total);
    if (wantPartial && d.mode === 'off') return json({ ok: false, error: 'Please choose your payment method again.' }, 409);
    /* A checkout that cannot take the advance (older theme, no b.pc) keeps placing full COD orders. */
    if (!wantPartial && d.partial && b.pc) return json({ ok: false, partial_required: true, advance: d.advance, balance: d.balance, hint: d.hint, error: `For this address: pay ₹${d.advance / 100} now, rest after delivery.` });
    if (wantPartial) {
      if (price.total <= d.advance) return json({ ok: false, error: 'Please pay online for this order.' }, 409);
      partial = { advance: d.advance, reasons: d.reasons.length ? d.reasons : ['chosen'] };
    }
  }
  /* COD with a WhatsApp OTP (Build 044+): the order is created only with the right code, and counts as confirmed.
     Without a code (older theme, or the code could not be sent) the old flow runs: WhatsApp confirmation after. */
  let otpOk = false;
  if (method === 'cod' && !partial && b.otp != null && String(b.otp) !== '') {
    const v = await checkOtp(env, buyer.phone, String(b.otp));
    if (!v.ok) return json({ ok: false, otp_invalid: true, expired: !!v.expired, error: v.error });
    otpOk = true;
  }
  const txnid = `IK${Date.now().toString(36)}${rand()}`.toUpperCase();
  const eventId = `ik_${txnid}`;
  const a = b.attribution || {};
  /* Refer and earn (online payment only): the friend's ₹100 off and the buyer's own store credit */
  let refBits = null;
  if (method === 'prepaid' && env.DB) {
    try {
      refBits = await forOrder(env, { idem, phone: buyer.phone, total: price.total, attribution: a });
      if (refBits.ref || refBits.credit) { price.ref = refBits.ref; price.credit = refBits.credit; price.total = refBits.total; }
    } catch (e) { console.error('referral', e.message); refBits = null; }
  }
  const attributes = [
    { key: 'Checkout', value: 'Ink Kulture custom' },
    { key: 'Payment choice', value: partial ? `Partial COD (₹${partial.advance / 100} online + rest on delivery)` : method === 'cod' ? 'COD' : 'Prepaid' },
    ...(method === 'prepaid' || partial ? [{ key: 'PayU txn id', value: txnid }] : []),
    ...(partial ? [{ key: 'Advance paid online', value: '₹' + partial.advance / 100 }, { key: 'Collect on delivery', value: '₹' + (price.total - partial.advance) / 100 }, { key: 'Partial COD reason', value: partial.reasons.map(reasonText).join('; ').slice(0, 200) }] : []),
    ...(otpOk ? [{ key: 'COD verified', value: 'WhatsApp OTP at checkout' }] : []),
    ...(price.ref ? [{ key: refBits.offer.kind === 'creator' ? 'Creator code' : refBits.offer.kind === 'voucher' ? 'Creator voucher' : 'Referral code', value: `${refBits.offer.code} (₹${price.ref / 100} off)` }] : []),
    ...(!price.ref && a.ref ? [{ key: 'Code', value: String(a.ref).slice(0, 20) }] : []),
    ...(price.credit ? [{ key: 'Store credit used', value: '₹' + price.credit / 100 }] : []),
    ...(buyer.edd ? [{ key: 'Promised delivery', value: buyer.edd }] : []),
    ...(a.sid ? [{ key: 'Session', value: String(a.sid).slice(0, 40) }] : []),
    ...['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'landing'].filter((k) => a[k]).map((k) => ({ key: k, value: String(a[k]).slice(0, 250) })),
  ];
  const tags = ['ik-checkout', method, ...(partial ? ['partial-cod'] : otpOk ? ['cod-confirmed', 'cod-otp-verified'] : method === 'cod' ? ['cod-unconfirmed'] : []), ...(isCollab(a.landing) ? [COLLAB_TAG] : []), ...(cameFromAd(a) ? ['from-ad'] : []), ...(price.ref ? [refBits.offer.kind === 'creator' ? 'creator-code' : refBits.offer.kind === 'voucher' ? 'creator-voucher' : 'referral'] : []), ...(price.credit ? ['store-credit'] : [])];
  /* creator program: every order through a creator's code (COD too) is followed to delivery (lib/creators.js) */
  if (a.ref && env.DB) { try { const { noteOrder } = await import('./creators.js'); await noteOrder(env, { idem, code: a.ref, phone: buyer.phone, method: partial ? 'partial' : method, total: price.total, discount: refBits?.offer?.kind === 'creator' ? price.ref || 0 : 0 }); } catch (e) { console.error('creator order', e.message); } }
  const draft = await createDraft(env, { lines, price, method, buyer, tags, attributes });
  if (Math.abs(draft.total - price.total) > 100) {
    console.error('total mismatch', { ours: price.total, shopify: draft.total, draft: draft.id });
    return json({ ok: false, error: 'Price changed, please reload your cart' }, 409);
  }

  const contents = lines.map((l) => ({ id: l.variantId.split('/').pop(), quantity: l.qty, item_price: Number(rupees(l.unit)) }));
  const row = {
    sid: String(a.sid || '').slice(0, 40), idem, txnid, eventId, draftId: draft.id, method, total: draft.total, buyer, a, contents,
    ip: (req.headers.get('x-forwarded-for') || '').split(',')[0].trim().slice(0, 64) || null, ua: String(req.headers.get('User-Agent') || '').slice(0, 400) || null,
    otp: otpOk, sourceUrl: String(a.landing || env.STORE_URL), advance: partial ? partial.advance : null, partialReason: partial ? partial.reasons.join(',').slice(0, 200) : null,
  };

  if (partial) {
    /* Only the advance goes through PayU now; the Shopify order is created when PayU confirms it (completePaid). */
    await saveOrder(env, row, null, 'pending_payment');
    const payu = await buildPayuForm(env, {
      txnid, amount: rupees(partial.advance), productinfo: `Ink Kulture ${draft.name} advance`.slice(0, 100), firstname: buyer.firstName.slice(0, 60),
      email: buyer.email || `orders+${buyer.phone}@inkkulture.in`, phone: buyer.phone,
      surl: `${env.WORKER_URL}/api/payu/return`, furl: `${env.WORKER_URL}/api/payu/return`, udf1: draft.id.split('/').pop(),
    });
    let upi = null;
    if (b.upi) { try { upi = await upiIntent(env, payu.fields, ip === 'unknown' ? '' : ip, req.headers.get('User-Agent')); } catch (e) { console.error('upi intent', e); } }
    return json({ ok: true, method: 'partial', payu, upi, txnid, advance: partial.advance, balance: draft.total - partial.advance });
  }

  if (method === 'prepaid') {
    await saveOrder(env, row, null, 'pending_payment');
    const payu = await buildPayuForm(env, {
      txnid, amount: rupees(draft.total), productinfo: `Ink Kulture ${draft.name}`.slice(0, 100), firstname: buyer.firstName.slice(0, 60),
      email: buyer.email || `orders+${buyer.phone}@inkkulture.in`, phone: buyer.phone,
      surl: `${env.WORKER_URL}/api/payu/return`, furl: `${env.WORKER_URL}/api/payu/return`, udf1: draft.id.split('/').pop(),
    });
    let upi = null;
    if (b.upi) {
      try {
        const f = payu.fields;
        upi = await upiIntent(env, f, ip === 'unknown' ? '' : ip, req.headers.get('User-Agent'));
      } catch (e) { console.error('upi intent', e); }
    }
    return json({ ok: true, method, payu, upi, txnid });
  }

  const order = await completeDraft(env, draft.id, true);
  await saveOrder(env, row, order, 'placed');
  if (otpOk) await env.DB.prepare('UPDATE orders SET confirmed_at=?, otp_at=? WHERE idem=?').bind(now(), now(), idem).run();
  ctx.waitUntil(afterCod(env, req, row, order));
  return json({ ok: true, method, orderName: order.name, statusUrl: order.statusPageUrl, eventId, value: Number(rupees(draft.total)), otp_verified: otpOk });
}

async function saveOrder(env, r, order, status) {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO orders (idem,txnid,event_id,draft_id,order_id,order_gid,order_name,status_url,method,total_paise,phone,email,first_name,last_name,city,state_code,pincode,fbp,fbc,source_url,contents_json,status,created_at,advance_paise,partial_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(idem) DO UPDATE SET txnid=excluded.txnid,event_id=excluded.event_id,draft_id=excluded.draft_id,order_id=excluded.order_id,order_gid=excluded.order_gid,order_name=excluded.order_name,status_url=excluded.status_url,total_paise=excluded.total_paise,status=excluded.status,advance_paise=excluded.advance_paise,partial_reason=excluded.partial_reason`,
  )
    .bind(r.idem, r.txnid, r.eventId, r.draftId, order?.legacyResourceId || null, order?.id || null, order?.name || null, order?.statusPageUrl || null, r.method, r.total, r.buyer.phone, r.buyer.email, r.buyer.firstName, r.buyer.lastName, r.buyer.city, stateCode(r.buyer.state), r.buyer.pincode, r.a.fbp || null, r.a.fbc || null, r.sourceUrl, JSON.stringify(r.contents), status, now(), r.advance || null, r.partialReason || null)
    .run();
  await env.DB.prepare("UPDATE leads SET status='ordered', updated_at=? WHERE phone=?").bind(now(), r.buyer.phone).run();
  if (r.sid) await env.DB.prepare('UPDATE orders SET sid=? WHERE idem=?').bind(r.sid, r.idem).run();
  /* the shopper's own IP / browser, for the Meta server event (the PayU return may come from PayU's servers) */
  if (r.ua || r.ip) await env.DB.prepare('UPDATE orders SET client_ip=?, client_ua=? WHERE idem=?').bind(r.ip || null, r.ua || null, r.idem).run();
}

/** Pixel ID for the browser Purchase in IK checkout (same dataset as the server event, so Meta de-duplicates). */
const metaPx = (env) => { const c = metaCfg(env); return c.browser ? c.pixelId : ''; };

async function replayResponse(env, p) {
  if (Number(p.advance_paise) > 0) return p.status === 'placed' ? { ok: true, method: 'partial', orderName: p.order_name, statusUrl: p.status_url, eventId: p.event_id, value: p.total_paise / 100, advance: Number(p.advance_paise), balance: p.total_paise - p.advance_paise } : { ok: false, error: 'This payment attempt is already in progress. Please reload and try again.' };
  if (p.method === 'cod') return { ok: true, method: 'cod', orderName: p.order_name, statusUrl: p.status_url, eventId: p.event_id, value: p.total_paise / 100 };
  return { ok: false, error: 'This payment attempt is already in progress. Please reload and try again.' };
}

async function purchaseEvent(env, row, orderName, ip, ua) {
  const res = await sendPurchase(env, purchasePayload(row, orderName, ip, ua));
  await recordCapi(env, row.eventId || row.event_id, res);
  if (!res.ok && !res.skipped) console.error('capi rejected', orderName, res.status, res.error);
  return res;
}

async function afterCod(env, req, row, order) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;
  const ua = req.headers.get('User-Agent');
  const results = await Promise.allSettled([
    purchaseEvent(env, row, order.name, ip, ua),
    row.otp ? Promise.resolve({ skipped: 'otp verified' }) : fireTrigger(env, 'cod_confirm', { to: row.buyer.phone, vars: { name: row.buyer.firstName, order: order.name, total: rupees(row.total) }, orderId: order.legacyResourceId, orderName: order.name }),
    markSessionOrdered(env, row.sid, order.name),
  ]);
  results.forEach((r, i) => r.status === 'rejected' && console.error(['capi', 'whatsapp', 'session'][i], r.reason));
  await afterOrderRisk(env, { ...row, txnid: row.txnid }, order);
}

/** Shared by the PayU return and the status poll. `row` is the orders row; returns { ok, order_name, status_url } or { ok:false, why }. */
/* A partial-COD order is done once it is 'placed' (the courier still collects the rest); a prepaid one once 'paid'. */
const isPartial = (row) => Number(row.advance_paise) > 0;
const isDone = (row) => row.status === 'paid' || (isPartial(row) && ['placed', 'cancelled'].includes(row.status) && !!row.order_id);
/** What PayU must have collected for this row: the advance for partial COD, the whole total for prepaid. */
const payable = (row) => (isPartial(row) ? Number(row.advance_paise) : Number(row.total_paise));
const partialBits = (row) => (isPartial(row) ? { partial: true, advance: Number(row.advance_paise), balance: Number(row.total_paise) - Number(row.advance_paise) } : {});

async function completePaid(env, ctx, req, row) {
  if (isDone(row)) return { ok: true, order_name: row.order_name, status_url: row.status_url };
  /* claim atomically so duplicate callbacks (browser, PayU server, poll) can't complete the draft twice */
  const claim = await env.DB.prepare("UPDATE orders SET status='completing' WHERE txnid=? AND status IN ('pending_payment','failed') RETURNING txnid").bind(row.txnid).first();
  if (!claim) {
    for (let i = 0; i < 8; i++) {
      await new Promise((res) => setTimeout(res, 800));
      const cur = await env.DB.prepare('SELECT * FROM orders WHERE txnid=?').bind(row.txnid).first();
      if (cur && isDone(cur)) return { ok: true, order_name: cur.order_name, status_url: cur.status_url };
    }
    return { ok: false, why: 'review' };
  }
  if (isPartial(row)) return completePartial(env, ctx, req, row);
  try {
    const order = await completeDraft(env, row.draft_id, false);
    await env.DB.prepare("UPDATE orders SET status='paid', order_id=?, order_gid=?, order_name=?, status_url=? WHERE txnid=?").bind(order.legacyResourceId, order.id, order.name, order.statusPageUrl, row.txnid).run();
    await onPaid(env, { idem: row.idem, order_id: order.legacyResourceId, order_name: order.name }).catch((e) => console.error('referral paid', e.message));
    ctx.waitUntil(purchaseEvent(env, row, order.name, (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null, req.headers.get('User-Agent')).catch((e) => console.error('capi', e)));
    ctx.waitUntil(Promise.all([
      markSessionOrdered(env, row.sid, order.name),
      fireTrigger(env, 'prepaid_paid', { to: row.phone, vars: { name: row.first_name, order: order.name, total: rupees(row.total_paise) }, orderName: order.name }),
      afterOrderRisk(env, row, order),
    ]).catch((e) => console.error('post-paid', e)));
    return { ok: true, order_name: order.name, status_url: order.statusPageUrl };
  } catch (e) {
    console.error('PAID BUT ORDER NOT COMPLETED', row.txnid, row.draft_id, e);
    await env.DB.prepare("UPDATE orders SET status='paid_needs_attention' WHERE txnid=?").bind(row.txnid).run();
    return { ok: false, why: 'review' };
  }
}

/** Partial COD after PayU confirmed the advance: Shopify order as PARTIALLY_PAID, IK row 'placed' + confirmed. */
async function completePartial(env, ctx, req, row) {
  let order, problem = '';
  try { order = await createPartialOrder(env, { draftId: row.draft_id, advancePaise: Number(row.advance_paise), txnid: row.txnid }); }
  catch (e) {
    /* never lose a paid order: fall back to the normal COD completion and flag it for a manual payment entry */
    problem = String(e.message || e).slice(0, 300);
    console.error('PARTIAL COD: orderCreate failed, completing the draft as COD instead', row.txnid, problem);
    try {
      order = await completeDraft(env, row.draft_id, true);
      await addTags(env, order.id, ['partial-cod', 'advance-paid-' + Math.round(Number(row.advance_paise) / 100), 'needs-payment-entry']).catch(() => {});
    } catch (e2) {
      console.error('PAID ADVANCE BUT ORDER NOT COMPLETED', row.txnid, row.draft_id, e2);
      await env.DB.prepare("UPDATE orders SET status='paid_needs_attention' WHERE txnid=?").bind(row.txnid).run();
      return { ok: false, why: 'review' };
    }
  }
  const t = now();
  await env.DB.prepare("UPDATE orders SET status='placed', confirmed_at=?, order_id=?, order_gid=?, order_name=?, status_url=?, total_paise=COALESCE(?, total_paise), partial_reason=CASE WHEN ?<>'' THEN COALESCE(partial_reason,'') || ' | shopify: ' || ? ELSE partial_reason END WHERE txnid=?")
    .bind(t, String(order.legacyResourceId), order.id, order.name, order.statusPageUrl, order.total || null, problem, problem, row.txnid).run();
  const fresh = { ...row, status: 'placed', confirmed_at: t, order_id: String(order.legacyResourceId), order_name: order.name, total_paise: order.total || row.total_paise };
  const balance = Number(fresh.total_paise) - Number(row.advance_paise);
  ctx.waitUntil(purchaseEvent(env, fresh, order.name, (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null, req.headers.get('User-Agent')).catch((e) => console.error('capi', e)));
  ctx.waitUntil(Promise.all([
    markSessionOrdered(env, row.sid, order.name),
    fireTrigger(env, 'partial_paid', { to: row.phone, vars: { name: row.first_name, order: order.name, total: rupees(row.advance_paise), balance: rupees(balance) }, orderId: String(order.legacyResourceId), orderName: order.name }),
    afterOrderRisk(env, fresh, order),
  ]).catch((e) => console.error('post-partial', e)));
  return { ok: true, order_name: order.name, status_url: order.statusPageUrl };
}

async function handlePayuReturn(req, env, ctx) {
  const wantJson = new URL(req.url).searchParams.get('json') === '1'; /* in-page (PayU Bolt) flow */
  const form = await req.formData();
  const r = await verifyResponse(env, form);
  const fail = (why) => (wantJson ? json({ ok: false, why }) : Response.redirect(`${env.STORE_URL}/?ik_pay=${why}`, 303));
  if (!r) return fail('failed');
  const row = env.DB && (await env.DB.prepare('SELECT * FROM orders WHERE txnid=?').bind(r.txnid).first());
  if (!row) return fail('failed');
  const ok = (st) => (wantJson
    ? json({ ok: true, orderName: st.order_name, eventId: row.event_id, value: row.total_paise / 100, statusUrl: st.status_url || '', ...partialBits(row) })
    : Response.redirect(`${env.STORE_URL}/?ik_paid=1&o=${encodeURIComponent(st.order_name)}&e=${encodeURIComponent(row.event_id)}&v=${row.total_paise / 100}&u=${encodeURIComponent(st.status_url || '')}${isPartial(row) ? `&pa=${row.advance_paise}&pb=${row.total_paise - row.advance_paise}` : ''}`, 303));
  if (isDone(row)) return ok(row);
  if (r.status !== 'success' || r.amount !== rupees(payable(row))) {
    await env.DB.prepare("UPDATE orders SET status='failed' WHERE txnid=? AND status='pending_payment'").bind(r.txnid).run();
    return fail('failed');
  }
  const done = await completePaid(env, ctx, req, row);
  return done.ok ? ok(done) : fail(done.why);
}

/** Polled by the popup while the shopper pays in their UPI app. Trusts only PayU's own verify_payment answer. */
async function handlePayuStatus(req, env, ctx) {
  const b = await req.json().catch(() => ({}));
  const txnid = String(b.txnid || '').slice(0, 40);
  const row = txnid && env.DB && (await env.DB.prepare('SELECT * FROM orders WHERE txnid=?').bind(txnid).first());
  if (!row || (row.method !== 'prepaid' && !isPartial(row))) return json({ ok: false, state: 'failed' });
  const reply = (st) => json({ ok: true, state: 'paid', orderName: st.order_name, eventId: row.event_id, value: row.total_paise / 100, statusUrl: st.status_url || '', ...partialBits(row) });
  if (isDone(row)) return reply(row);
  const v = await verifyPayment(env, txnid).catch(() => null);
  if (!v || !['success', 'failure', 'failed', 'bounced', 'usercancelled', 'dropped'].includes(v.status)) return json({ ok: true, state: 'pending' });
  if (v.status !== 'success' || v.amount !== rupees(payable(row))) {
    await env.DB.prepare("UPDATE orders SET status='failed' WHERE txnid=? AND status='pending_payment'").bind(txnid).run();
    return json({ ok: true, state: 'failed' });
  }
  const done = await completePaid(env, ctx, req, row);
  return done.ok ? reply(done) : json({ ok: true, state: 'review' });
}

async function handleWa(req, env, ctx) {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    return url.searchParams.get('hub.verify_token') === env.WA_VERIFY_TOKEN ? new Response(url.searchParams.get('hub.challenge')) : new Response('forbidden', { status: 403 });
  }
  const raw = await req.text();
  if (!(await verifySignature(env, req, raw))) return new Response('bad signature', { status: 401 });
  const payload0 = JSON.parse(raw);
  ctx.waitUntil(
    (async () => {
      /* Meta can deliver one message twice: act on each inbound message id once. */
      const payload = await dedupeInbound(env, payload0);
      const replies = parseReplies(payload);
      for (const st of parseStatuses(payload)) {
        const row = await env.DB.prepare('UPDATE messages SET status=?, error=CASE WHEN ?<>\'\' THEN ? ELSE error END WHERE wamid=? RETURNING trigger, template').bind(st.status, st.error, st.error, st.id).first().catch(() => null);
        /* back-off after Meta's "Rate limit hit"; a delivered template ends it (lib/wa-gate.js) */
        try {
          const G = await import('./wa-gate.js');
          if (st.status === 'failed' && G.RATE_LIMIT.test(st.error)) await G.pushback(env);
          else if ((st.status === 'delivered' || st.status === 'read') && row && row.template && !['ai', 'agent', 'reply'].includes(row.trigger)) await G.clear(env);
        } catch (e) { console.error('wa gate', e.message); }
        await otpStatus(env, st.id, st.status).catch((e) => console.error('otp status', e.message));
      }
      /* Typed replies ("yes", "cancel", STOP) and buttons whose payload was lost go through the same safe rules as
         Go4WhatsUp: whole-message match only, applied to the order we last asked that number about. */
      const others = [];
      for (const e of payload.entry || []) for (const c of e.changes || []) for (const m of c.value?.messages || []) {
        const p = m.button?.payload || m.interactive?.button_reply?.id || '';
        if (/^(CONFIRM|CANCEL|ADDR_OK|ADDR_EDIT|NDR_YES|NDR_NO):/.test(p)) continue;
        const text = m.button?.text || m.interactive?.button_reply?.title || m.text?.body || '';
        const from = String(m.from || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
        if (text && /^\d{10}$/.test(from)) others.push({ from, text: String(text).slice(0, 300), via: 'meta', phoneId: String(c.value?.metadata?.phone_number_id || '') });
      }
      if (others.length) { const { processInbound } = await import('./wa-g4w.js'); await processInbound(env, others); }
      /* [Yes, deliver it] / [No, cancel order] on the refused-delivery question (lib/ndr-ask.js) */
      { const na = await import('./ndr-ask.js'); for (const b of na.parseNdrButtons(payload)) await na.answerRefused(env, b.from, b.orderId, b.yes, 'button'); }
      /* "Address is correct" / "Edit address" taps on the post-confirm address check. */
      const addr = await import('./wa-address.js');
      for (const rep of addr.parseAddrReplies(payload)) await addr.handleAddressReply(env, rep);
      const { applyAction } = await import('./wa-g4w.js');
      for (const rep of replies) {
        const row = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(rep.orderId).first();
        if (!row || row.method !== 'cod' || rep.from !== '91' + row.phone) continue;
        let result;
        try { result = await applyAction(env, row, rep.action); } catch (e) {
          await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'reply', template: rep.action, status: 'failed', orderName: row.order_name, error: String(e.message || e) });
          await sendText(env, rep.from, `We could not update order ${row.order_name} automatically. Our team will message you shortly.`);
          continue;
        }
        await env.DB.prepare('DELETE FROM wa_pending WHERE order_id=?').bind(String(rep.orderId)).run();
        await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'reply', template: rep.action, status: result, orderName: row.order_name });
        if (result === 'confirmed') { await sendText(env, rep.from, `Thanks ${row.first_name}! Order ${row.order_name} is confirmed. We'll pack and ship it soon.`); await addr.sendAddressCheck(env, row); }
        else if (result === 'cancelled') await sendText(env, rep.from, `Order ${row.order_name} has been cancelled. You can order again anytime at inkkulture.in`);
        else if (result === 'already-confirmed') await sendText(env, rep.from, `Order ${row.order_name} is already confirmed. We'll ship it soon.`);
        else if (result === 'already-cancelled') await sendText(env, rep.from, `Order ${row.order_name} was already cancelled.`);
      }
    })().catch((e) => console.error('wa', e)),
  );
  return new Response('ok');
}

async function handleAdminLeads(req, env) {
  if (!env.ADMIN_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
  const since = now() - 3 * 86400;
  const { results } = await env.DB.prepare("SELECT phone,name,pincode,cart_json,utm_json,step,updated_at FROM leads WHERE status='open' AND updated_at>? ORDER BY updated_at DESC LIMIT 500").bind(since).all();
  return json({ count: results.length, leads: results });
}

export async function handle(req, env0, ctx) {
  const url = new URL(req.url);
  let env = env0;
  if (env0.DB && url.pathname !== '/api/health') { try { env = await withSettings(env0); } catch (e) { console.error('settings', e); } }
  const path = url.pathname;
  const cors = corsHeaders(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    if (path === '/api/payu/return' && req.method === 'POST') {
      const pr = await handlePayuReturn(req, env, ctx);
      if (url.searchParams.get('json') === '1') Object.entries(cors).forEach(([k, v]) => pr.headers.set(k, v));
      return pr;
    }
    if (path === '/api/wa/webhook') return await handleWa(req, env, ctx);
    /* creator program: apply, WhatsApp-code login and the creator's dashboard (lib/creators.js); /c/CODE counts a link open */
    /* Instagram comment -> DM: Meta webhook and the login callback (lib/ig-dm.js) */
    if (path === '/api/ig/webhook' || path === '/api/ig/callback') { const { handleIg } = await import('./ig-dm.js'); return await handleIg(req, env, ctx); }
    /* old temp endpoints: clear their stored blobs */
    if (path === '/api/tmp/put' || path === '/api/tmp/get') { await env.DB.prepare("DELETE FROM settings WHERE k LIKE 'tmp:%'").run(); return new Response('{"ok":false}', { status: 410 }); }
    if (path.startsWith('/api/barter/')) { const { handleBarter } = await import('./barter.js'); const r = await handleBarter(req, env); Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v)); return r; }   /* /collab on Vercel and inkkulture.in/pages/collab */
    if (path.startsWith('/api/refer/')) { const { handleRefer } = await import('./refer-me.js'); return await handleRefer(req, env); }
    if (path.startsWith('/api/creator/')) {
      if (path === '/api/creator/go') { const { click } = await import('./creators.js'); return await click(env, url.searchParams.get('code'), req); }
      const { handleCreator } = await import('./creators.js'); return await handleCreator(req, env);
    }
    /* ShipPrime status webhook (Bearer secret from Settings, Shipping carriers): lib/shipprime.js */
    if (path === '/api/shipprime/webhook' && req.method === 'POST') { const { handleSpWebhook } = await import('./shipprime.js'); return await handleSpWebhook(req, env); }
    if (path === '/api/admin/leads') return await handleAdminLeads(req, env);
    if (path === '/api/admin/login' && req.method === 'POST') return await handleLogin(req, env);
    if (path === '/api/admin/rpc' && req.method === 'POST') return await handleRpc(req, env);
    if (path === '/api/admin/label' && req.method === 'POST') return await handleLabel(req, env);
    if (path === '/api/health') return json({ ok: true, db: !!env.DB });
    /* Partial COD mode as the checkout sees it (no customer data): handy to check the switch from any browser. */
    if (path === '/api/partial' && req.method === 'GET') { const { cfg } = await import('./partial-cod.js'); const c = cfg(env); return json({ ok: true, mode: c.mode, advance: c.advance }); }
    if (path === '/api/cron') {
      if (!env.CRON_SECRET || req.headers.get('Authorization') !== `Bearer ${env.CRON_SECRET}`) return json({ error: 'unauthorized' }, 401);
      return json({ ok: true, ...(await runCron(env)) });
    }

    if (path.startsWith('/api/')) {
      if (!clientOk(req, env)) return json({ ok: false, error: 'forbidden' }, 403);
      let res;
      if (path === '/api/quote' && req.method === 'POST') res = await handleQuote(req, env);
      else if (path === '/api/lead' && req.method === 'POST') res = await handleLead(req, env);
      else if (path === '/api/track' && req.method === 'POST') res = await handleTrack(req, env);
      else if (path === '/api/order' && req.method === 'POST') res = await handleOrder(req, env, ctx);
      else if (path === '/api/cod-check' && req.method === 'POST') res = await handleCodCheck(req, env);
      else if (path === '/api/otp/send' && req.method === 'POST') {
        const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
        if (!(await rateLimit(env, 'otp:' + ip, 30))) res = json({ ok: false, error: 'Too many attempts, please try again later' }, 429);
        else {
          const b = await req.json().catch(() => ({}));
          res = !codOn(env, attrsIn(b)) ? json({ ok: false, cod_off: true, error: 'Cash on delivery is not available for this order. Please pay by UPI or card.' }) : json(await sendOtp(env, cleanPhone(b.phone), { log: (m) => logMsg(env, m) })); }
      }
      else if (path === '/api/otp/status' && req.method === 'POST') {
        const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
        if (!(await rateLimit(env, 'otps:' + ip, 600))) res = json({ ok: false, error: 'Too many attempts' }, 429);
        else { const b = await req.json().catch(() => ({})); res = json(await otpDelivery(env, cleanPhone(b.phone))); }
      }
      else if (path === '/api/payu/status' && req.method === 'POST') res = await handlePayuStatus(req, env, ctx);
      /* Refer and earn: once the number is typed, the checkout asks whether the friend's code applies (first order
         only) and how much store credit this number has; both only on online payment. */
      else if (path === '/api/ref/me' && req.method === 'POST') {
        if (!(await rateLimit(env, 'ref:' + ((req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'x'), 120))) res = json({ ok: false }, 429);
        else {
          const b = await req.json().catch(() => ({}));
          const phone = cleanPhone(b.phone), code = normCode(b.ref);
          const [o, credit] = await Promise.all([code ? friendOffer(env, code, phone) : null, phone ? creditBalance(env, phone) : 0]);
          res = json({ ok: true, ref: o?.ok ? o.amount : 0, ref_ok: !!o?.ok, name: o?.name || '', note: code && o && !o.ok ? o.why : '', credit });
        }
      }
      else if (path.startsWith('/api/pincode/')) res = await handlePincode(path.split('/').pop());
      else if (path === '/api/shipping' && req.method === 'GET') res = await shippingEstimate(req, env);
      /* the pay-online page on the store (inkkulture.in/pages/pay): order details, start a payment, poll it */
      else if (path === '/api/convert' && req.method === 'POST') {
        const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
        if (!(await rateLimit(env, 'cv:' + ip, 120))) res = json({ ok: false, error: 'Too many attempts, please try again later' }, 429);
        else { const { handleConvertApi } = await import('./wa-convert.js'); res = json(await handleConvertApi(req, env, ctx)); }
      }
      /* storefront: track page, tickets, delivery date, floating assistant (lib/site.js) */
      else if (path.startsWith('/api/site/')) { const { handleSite } = await import('./site.js'); res = await handleSite(req, env); }
      else res = json({ error: 'not found' }, 404);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }
    return new Response('Not found', { status: 404 });
  } catch (e) {
    console.error('unhandled', path, e);
    return json({ ok: false, error: 'Something went wrong. Please try again.' }, 500, cors);
  }
}

export async function runCron(env0, via = 'vercel') {
  const env = await withSettings(env0);
  /* who ran it last and when: the dashboard's "tick" skips while a recent run exists, Settings shows it */
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('cron_at', ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v").bind(String(now())).run().catch(() => {});
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('cron_via', ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v").bind(JSON.stringify(via)).run().catch(() => {});
  /* TEMP one-off: re-create IKC-1021 (Shopify refused the gmail.con email) */
  try { const f = await env.DB.prepare("SELECT 1 AS x FROM settings WHERE k='barter_fix21'").first(); if (!f) { await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('barter_fix21', '1') ON CONFLICT (k) DO NOTHING").run(); const B = await import('./barter.js'); console.log('DIAG fix21 ' + JSON.stringify(await B.makeDraft(env, 21))); } } catch (e) { console.log('DIAG fix21 err ' + e.message); }
  const cutoff = now() - 24 * 3600;
  const { results } = await env.DB.prepare("SELECT order_id FROM orders WHERE method='cod' AND status='placed' AND confirmed_at IS NULL AND flagged_at IS NULL AND created_at<?").bind(cutoff).all();
  for (const r of results) {
    await addTags(env, `gid://shopify/Order/${r.order_id}`, ['cod-unconfirmed-24h']);
    await env.DB.prepare('UPDATE orders SET flagged_at=? WHERE order_id=?').bind(now(), r.order_id).run();
  }
  await env.DB.prepare('DELETE FROM leads WHERE updated_at<?').bind(now() - 30 * 86400).run();
  await env.DB.prepare('DELETE FROM rl WHERE hr<?').bind(Math.floor(Date.now() / 3600000) - 24).run();
  const auto = await runAutomations(env);
  return { flagged: results.length, ...auto };
}