/**
 * COD -> prepaid: the "pay online, get X% off" offer before the parcel ships.
 *
 *   Offer      sent the moment a COD customer confirms their delivery address on WhatsApp (offerAfterAddress, from
 *              lib/wa-address.js): a free in-chat message with a "Pay ₹… now" button (they have just written, so the
 *              24 h window is open), else the cod_prepaid_offer_v2 template. The offer is open for `minutes` (30 by
 *              default) and closes earlier the moment the parcel is booked with Shiprocket. The old env mode
 *              (COD_CONVERT_HOURS) still runs on the cron (offerPrepaidConversion).
 *   Pay page   https://www.inkkulture.in/pages/pay?k=<orderId>-<sig> (a Shopify page whose script calls /api/convert),
 *              falling back to /api/wa/pay here. UPI apps by intent (one tap on a phone) or PayU's hosted page.
 *   Money in   PayU's surl (/api/wa/paid) or the page's status poll (verify_payment) -> completeConversion(), once.
 *   Shopify    the paid amount is matched exactly: the discount goes onto a line through an order edit, then the
 *              order is marked paid, tagged prepaid + cod-converted-prepaid, and a note records the PayU txn.
 *              Anything Shopify refuses still marks it paid and tags prepaid-needs-attention.
 *   Shiprocket not booked yet: it books as Prepaid (codDue = 0). Booked but not picked up (a race): the booking is
 *              cancelled so it re-books as Prepaid with a new label. Already picked up: tagged for attention and the
 *              reconciliation audit flags the COD amount until it is converted in Shiprocket.
 */
import { gql, addTags, removeTags } from './shopify.js';
import { buildPayuForm, verifyResponse, upiIntent, verifyPayment } from './payu.js';
import { withSettings } from './settings.js';
import { logMsg, fireTrigger, sendText } from './whatsapp.js';
import { verifyPay, signPay, payLink, linkShapeOk } from './wa-token.js';
import { page, esc } from './wa-g4w.js';

const now = () => Math.floor(Date.now() / 1000);
const rupees = (paise) => (Math.round(Number(paise) || 0) / 100).toFixed(2);
const inr = (paise) => '₹' + (Math.round(Number(paise) || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const paise = (amt) => Math.round(Number(amt || 0) * 100);
/* 31900 -> "319", 31950 -> "319.50" (the template already prints the ₹) */
const whole = (p) => (Math.round(p) % 100 ? (Math.round(p) / 100).toFixed(2) : String(Math.round(p) / 100));

/* ---------------- settings ---------------- */

import { CONVERT_DEFAULTS, convertCfg } from './convert-cfg.js';
import { codDue } from './partial-cod.js';
export { CONVERT_DEFAULTS, convertCfg };
export const discountPct = (env) => convertCfg(env).pct;

/* ---------------- links ---------------- */

/** k = "<orderId>-<sig>" (fits a WhatsApp dynamic URL button). */
export async function payKey(env, orderId) { const s = await signPay(env, orderId); return s ? `${orderId}-${s}` : ''; }
export async function parseKey(env, k) {
  const m = /^(\d{1,25})-([a-f0-9]{12})$/.exec(String(k || ''));
  if (!m || !linkShapeOk(m[1], m[2]) || !(await verifyPay(env, m[1], m[2]))) return null;
  return m[1];
}
/** The branded pay page on the store; /api/wa/pay here when the store URL is not set. */
export async function storePayLink(env, orderId) {
  const k = await payKey(env, orderId);
  if (!k) return '';
  const store = String(env.STORE_URL || '').replace(/\/$/, '');
  return store ? `${store}/pages/pay?k=${k}` : (await payLink(env, orderId));
}

/* ---------------- quote ---------------- */

async function liveOrder(env, orderId) {
  const d = await gql(env, `query($id:ID!){ order(id:$id){ id name note cancelledAt displayFinancialStatus displayFulfillmentStatus
    currentTotalPriceSet{shopMoney{amount}} totalOutstandingSet{shopMoney{amount}} currentSubtotalPriceSet{shopMoney{amount}}
    lineItems(first:50){nodes{ id title quantity currentQuantity variantTitle image{url} originalUnitPriceSet{shopMoney{amount}} discountedUnitPriceAfterAllDiscountsSet{shopMoney{amount}} }} } }`, { id: `gid://shopify/Order/${orderId}` });
  return d.order;
}

/**
 * What the order costs if paid online now: pct off what the products cost after the Buy-1-Get-1 and any other
 * discount (never off shipping), so "20% off" is 20% of what they would have paid in cash for the tattoos.
 */
export async function quoteConversion(env, row, pct = discountPct(env)) {
  const o = await liveOrder(env, row.order_id);
  if (!o) return { missing: true };
  const total = paise(o.totalOutstandingSet?.shopMoney?.amount ?? o.currentTotalPriceSet?.shopMoney?.amount) || Number(row.total_paise) || 0;
  const products = paise(o.currentSubtotalPriceSet?.shopMoney?.amount) || total;
  /* whole rupees: "₹80 off, pay ₹319" reads better than ₹79.80; Shopify gets the exact same amount */
  const discount = Math.round((Math.min(products, total) * pct) / 10000) * 100;
  const items = (o.lineItems?.nodes || []).filter((l) => Number(l.currentQuantity ?? l.quantity) > 0).map((l) => ({
    title: l.title, qty: Number(l.currentQuantity ?? l.quantity), size: l.variantTitle && l.variantTitle !== 'Default Title' ? l.variantTitle : '', image: l.image?.url || '',
    free: paise(l.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount) === 0 }));
  return { pct, total, products, discount, payable: Math.max(100, total - discount), items, cancelled: !!o.cancelledAt,
    financial: String(o.displayFinancialStatus || ''), fulfilled: !!o.displayFulfillmentStatus && o.displayFulfillmentStatus !== 'UNFULFILLED', note: o.note || '' };
}

/** A live Shiprocket booking for this order (AWB assigned, not cancelled), or null. */
async function liveBooking(env, orderId) {
  return env.DB.prepare("SELECT awb, stage, courier FROM shipments WHERE order_id=? AND LENGTH(COALESCE(awb,'')) > 0 AND COALESCE(status,'')<>'cancelled'").bind(String(orderId)).first();
}

/**
 * Where this order's offer stands: open | paid | expired | booked | cancelled | not_cod (plus the row).
 * The window runs from the offer until `hours` later; a link opened without an offer (e.g. sent from Chats) is open
 * until the parcel is booked.
 */
export async function offerState(env, orderId) {
  const row = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(String(orderId)).first();
  if (!row) return { state: 'missing' };
  if (row.converted_at || (row.method !== 'cod' && row.status === 'paid')) return { state: 'paid', row };
  if (row.method !== 'cod' || Number(row.advance_paise) > 0) return { state: 'not_cod', row };
  if (row.status === 'cancelled') return { state: 'cancelled', row };
  if (row.shipped_at || (await liveBooking(env, orderId))) return { state: 'booked', row };
  const exp = Number(row.convert_expires_at) || 0;
  if (exp && now() > exp) return { state: 'expired', row };
  return { state: 'open', row, expires_at: exp || null };
}

/* ---------------- the store pay page API: POST /api/convert {k, op} ---------------- */

export async function handleConvertApi(req, env0, ctx) {
  const b = await req.json().catch(() => ({}));
  const env = await withSettings(env0);
  const orderId = await parseKey(env, b.k);
  if (!orderId) return { ok: false, state: 'invalid', error: 'This link is not valid. Please use the link from your WhatsApp message.' };
  const st = await offerState(env, orderId);
  const row = st.row;
  const base = row ? { order: row.order_name, name: row.first_name || '' } : {};
  if (b.op === 'status') return { ok: true, ...base, ...(await pollStatus(env, ctx, row, String(b.txnid || ''))) };
  if (st.state !== 'open') return { ok: true, ...base, state: st.state };
  const pct = row.convert_pct && Number(row.convert_offer_at) ? Number(row.convert_pct) : discountPct(env);
  let q;
  try { q = await quoteConversion(env, row, pct); } catch (e) { console.error('convert quote', e.message); return { ok: false, ...base, state: 'error', error: 'We could not load your order right now. Please try again in a minute.' }; }
  if (q.missing || q.cancelled) return { ok: true, ...base, state: 'cancelled' };
  if (q.fulfilled) return { ok: true, ...base, state: 'booked' };
  if (/^paid|refunded/i.test(q.financial)) return { ok: true, ...base, state: 'paid' };
  const info = { ok: true, ...base, state: 'open', pct: q.pct, total: q.total, discount: q.discount, payable: q.payable, items: q.items, expires_at: st.expires_at };
  if (b.op !== 'start') return info;

  /* start a payment: the quoted amount is fixed on the row, so the return / poll can check it exactly */
  const txnid = `IKC${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  await env.DB.prepare('UPDATE orders SET convert_txnid=?, convert_pct=?, convert_payable_paise=?, convert_started_at=? WHERE order_id=? AND converted_at IS NULL').bind(txnid, q.pct, q.payable, now(), orderId).run();
  const payu = await buildPayuForm(env, {
    txnid, amount: rupees(q.payable), productinfo: `Ink Kulture ${row.order_name}`.slice(0, 100),
    firstname: String(row.first_name || 'Customer').slice(0, 60), email: row.email || `orders+${row.phone}@inkkulture.in`, phone: row.phone,
    surl: `${env.WORKER_URL}/api/wa/paid`, furl: `${env.WORKER_URL}/api/wa/paid`, udf1: orderId,
  });
  await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'convert', template: b.upi ? 'upi' : 'payu', status: 'started', orderName: row.order_name, preview: `pay ${inr(q.payable)} (${q.pct}% off)` });
  if (b.upi) {
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    try { const u = await upiIntent(env, payu.fields, ip, req.headers.get('User-Agent')); return { ...info, txnid, upi: u.uri }; }
    catch (e) { console.error('convert upi intent', e.message); /* fall through to PayU's page */ }
  }
  return { ...info, txnid, payu };
}

/** The page polls while the customer is in their UPI app. Trusts only PayU's verify_payment. */
async function pollStatus(env, ctx, row, txnid) {
  if (!row) return { state: 'missing' };
  if (row.converted_at) return { state: 'paid', paid: Number(row.paid_paise) || null };
  if (!/^IKC[A-Z0-9]{6,}$/.test(txnid)) return { state: 'pending' };
  const v = await verifyPayment(env, txnid).catch(() => null);
  if (!v || !['success', 'failure', 'failed', 'bounced', 'usercancelled', 'dropped'].includes(v.status)) return { state: 'pending' };
  if (v.status !== 'success') return { state: 'failed' };
  const r = await completeConversion(env, ctx, row, { txnid, amountPaise: paise(v.amount) });
  return { state: r.ok ? 'paid' : 'review', paid: paise(v.amount) };
}

/* ---------------- the old pay page here (fallback, and links already sent) ---------------- */

export async function handlePay(req, env0) {
  const url = new URL(req.url);
  const orderId = String(url.searchParams.get('o') || '');
  const sig = String(url.searchParams.get('s') || '');
  if (!linkShapeOk(orderId, sig) || !(await verifyPay(env0, orderId, sig))) return page('Link not valid', 'Please use the link from your WhatsApp message.');
  const env = await withSettings(env0);
  /* the branded page on the store does the same, with UPI app buttons */
  const store = String(env.STORE_URL || '').replace(/\/$/, '');
  if (store && url.searchParams.get('here') !== '1') return Response.redirect(`${store}/pages/pay?k=${orderId}-${sig}`, 302);
  const st = await offerState(env, orderId);
  const row = st.row;
  if (!row) return page('Order not found', 'We could not find that order.');
  const name = esc(row.order_name);
  if (st.state === 'paid') return page(`Order ${name}`, 'Already paid. Thank you! We will ship it soon.');
  if (st.state === 'cancelled') return page(`Order ${name}`, 'This order was cancelled.');
  if (st.state === 'booked') return page(`Order ${name}`, 'Your order is already packed and handed to the courier, so it stays Cash on Delivery. Thank you!');
  if (st.state === 'expired') return page(`Order ${name}`, 'This offer has ended. Your Cash on Delivery order is on its way as planned.');
  if (st.state !== 'open') return page(`Order ${name}`, 'This order cannot be paid online.');
  const pct = row.convert_pct && Number(row.convert_offer_at) ? Number(row.convert_pct) : discountPct(env);
  let q;
  try { q = await quoteConversion(env, row, pct); } catch (e) { console.error('quote', e.message); return page(`Order ${name}`, 'We could not load this order right now. Please try again in a minute.'); }
  if (q.missing || q.cancelled) return page(`Order ${name}`, 'This order was cancelled.');
  if (/^paid|partially_refunded|refunded/i.test(q.financial)) return page(`Order ${name}`, 'Already paid. Thank you!');
  const txnid = `IKC${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  await env.DB.prepare('UPDATE orders SET convert_txnid=?, convert_pct=?, convert_payable_paise=?, convert_started_at=? WHERE order_id=? AND converted_at IS NULL').bind(txnid, q.pct, q.payable, now(), orderId).run();
  const payu = await buildPayuForm(env, {
    txnid, amount: rupees(q.payable), productinfo: `Ink Kulture ${row.order_name}`.slice(0, 100),
    firstname: String(row.first_name || 'Customer').slice(0, 60), email: row.email || `orders+${row.phone}@inkkulture.in`, phone: row.phone,
    surl: `${env.WORKER_URL}/api/wa/paid`, furl: `${env.WORKER_URL}/api/wa/paid`, udf1: orderId,
  });
  const fields = Object.entries(payu.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const giftLine = (env.SETTINGS?.mystery?.on !== false) ? ' Plus a FREE mystery tattoo in your parcel.' : '';
  return page(`Pay for order ${name}`, `${q.pct}% off for paying online.${giftLine} Prepaid orders are packed and shipped first.`,
    `<div class="was">₹${rupees(q.total)}</div><div class="amt">₹${rupees(q.payable)}</div><p>UPI, cards, netbanking · secured by PayU</p>
     <form id="f" method="POST" action="${esc(payu.action)}">${fields}<button class="y" type="submit">Pay ₹${rupees(q.payable)}</button></form>`);
}

/* ---------------- Shopify: discount exactly what was paid, then mark paid ---------------- */

function userErr(d, key) {
  const e = d?.[key]?.userErrors;
  if (e && e.length) throw new Error(`${key}: ${e.map((x) => x.message).join('; ')}`);
}

/**
 * Bring the order's outstanding balance down to exactly what was paid, through an order edit. Tries, in order:
 * the whole discount as a fixed amount on one single-quantity line, the same split per unit on a multi-quantity line,
 * then the percentage on every line. Each try is a fresh edit that is only committed when Shopify's own new
 * outstanding equals the payment (within ₹1); an uncommitted edit expires on its own and changes nothing.
 */
export async function discountOrder(env, orderId, { pct, paidPaise, note }) {
  const tries = [];
  const begin = async () => {
    const b = await gql(env, `mutation($id:ID!){ orderEditBegin(id:$id){ calculatedOrder{ id totalOutstandingSet{shopMoney{amount}} lineItems(first:50){ nodes{ id quantity discountedUnitPriceSet{shopMoney{amount}} } } } userErrors{ field message } } }`, { id: `gid://shopify/Order/${orderId}` });
    userErr(b, 'orderEditBegin');
    return b.orderEditBegin.calculatedOrder;
  };
  const add = async (calcId, li, d) => {
    const r = await gql(env, `mutation($id:ID!,$li:ID!,$d:OrderEditAppliedDiscountInput!){ orderEditAddLineItemDiscount(id:$id, lineItemId:$li, discount:$d){ calculatedOrder{ id totalOutstandingSet{shopMoney{amount}} } userErrors{ field message } } }`, { id: calcId, li, d });
    userErr(r, 'orderEditAddLineItemDiscount');
    return paise(r.orderEditAddLineItemDiscount.calculatedOrder?.totalOutstandingSet?.shopMoney?.amount);
  };
  const commit = async (calcId) => {
    const c = await gql(env, `mutation($id:ID!,$n:String){ orderEditCommit(id:$id, notifyCustomer:false, staffNote:$n){ order{ id } userErrors{ field message } } }`, { id: calcId, n: note });
    userErr(c, 'orderEditCommit');
  };
  let calc = await begin();
  const start = paise(calc.totalOutstandingSet?.shopMoney?.amount);
  const want = start - paidPaise;                       /* the discount Shopify has to show */
  if (Math.abs(want) <= 100) return { edited: false, note: 'already matches' };
  if (want < 0) throw new Error(`paid ₹${rupees(paidPaise)} is more than the ₹${rupees(start)} outstanding`);
  const lines = calc.lineItems.nodes.filter((l) => l.quantity > 0).map((l) => ({ ...l, unit: paise(l.discountedUnitPriceSet?.shopMoney?.amount) }));
  const money = (p) => ({ amount: rupees(p), currencyCode: 'INR' });
  const plans = [];
  const single = lines.filter((l) => l.quantity === 1 && l.unit >= want).sort((a, b) => b.unit - a.unit)[0];
  if (single) plans.push([{ li: single.id, d: { description: `Prepaid ${pct}% off`, fixedValue: money(want) } }]);
  const multi = lines.filter((l) => l.quantity > 1 && want % l.quantity === 0 && l.unit >= want / l.quantity).sort((a, b) => b.unit - a.unit)[0];
  if (multi) plans.push([{ li: multi.id, d: { description: `Prepaid ${pct}% off`, fixedValue: money(want / multi.quantity) } }]);
  if (multi || single) plans.push([{ li: (single || multi).id, d: { description: `Prepaid ${pct}% off`, fixedValue: money(want) } }]);
  plans.push(lines.map((l) => ({ li: l.id, d: { description: `Prepaid ${pct}% off`, percentValue: pct } })));
  for (let i = 0; i < plans.length; i++) {
    if (i) calc = await begin();
    let out = null;
    try { for (const s of plans[i]) out = await add(calc.id, s.li, s.d); } catch (e) { tries.push(String(e.message || e)); continue; }
    if (out !== null && Math.abs(out - paidPaise) <= 100) { await commit(calc.id); return { edited: true, plan: i }; }
    tries.push(`plan ${i + 1}: ₹${rupees(out)} outstanding`);
  }
  throw new Error(`could not make Shopify's total match the ₹${rupees(paidPaise)} paid (${tries.join('; ').slice(0, 200)})`);
}

async function markPaid(env, orderId) {
  const d = await gql(env, `mutation($input:OrderMarkAsPaidInput!){ orderMarkAsPaid(input:$input){ order{ id displayFinancialStatus } userErrors{ field message } } }`, { input: { id: `gid://shopify/Order/${orderId}` } });
  userErr(d, 'orderMarkAsPaid');
  return d.orderMarkAsPaid.order?.displayFinancialStatus || '';
}

async function appendNote(env, orderId, oldNote, line) {
  const note = [oldNote, line].filter(Boolean).join('\n').slice(0, 5000);
  const d = await gql(env, `mutation($input:OrderInput!){ orderUpdate(input:$input){ order{ id } userErrors{ field message } } }`, { input: { id: `gid://shopify/Order/${orderId}`, note } });
  userErr(d, 'orderUpdate');
}

/** After the money lands: discount (if Shopify agrees), mark paid, retag, note. Never throws. */
export async function markPrepaid(env, row, { pct, paidPaise, txnid, line: given, tags = [] }) {
  const orderId = String(row.order_id);
  const gid = `gid://shopify/Order/${orderId}`;
  const line = given || `COD converted to prepaid via WhatsApp: paid ₹${rupees(paidPaise)} online (${pct}% prepaid discount), PayU txn ${txnid}.`;
  let problem = '';
  try { await discountOrder(env, orderId, { pct, paidPaise, note: line }); } catch (e) { problem = String(e.message || e); }
  try { await markPaid(env, orderId); } catch (e) { problem = (problem ? problem + ' | ' : '') + String(e.message || e); }
  await removeTags(env, gid, ['cod-unconfirmed', 'cod']).catch(() => {});
  await addTags(env, gid, ['prepaid', 'cod-converted-prepaid', ...tags, ...(problem ? ['prepaid-needs-attention'] : [])]).catch(() => {});
  try {
    const cur = await liveOrder(env, orderId);
    await appendNote(env, orderId, cur?.note || '', line + (problem ? ` NEEDS ATTENTION: ${problem}` : ''));
  } catch (e) { problem = problem || String(e.message || e); }
  return { problem };
}

/**
 * The money is in (PayU return or poll): claim once, then Shopify, then Shiprocket, then tell the customer.
 * Returns { ok, already? }.
 */
export async function completeConversion(env, ctx, row, { txnid, amountPaise }) {
  const orderId = String(row.order_id);
  const claim = await env.DB.prepare('UPDATE orders SET converted_at=?, paid_paise=? WHERE order_id=? AND converted_at IS NULL RETURNING order_id').bind(now(), amountPaise, orderId).first();
  if (!claim) return { ok: true, already: true };
  await env.DB.prepare("UPDATE orders SET status='paid', confirmed_at=COALESCE(confirmed_at,?) WHERE order_id=?").bind(now(), orderId).run();
  const job = (async () => {
    const pct = Number(row.convert_pct) || discountPct(env);
    const expected = Number(row.convert_payable_paise) || 0;
    const issues = [];
    if (expected && Math.abs(expected - amountPaise) > 100) issues.push(`paid ₹${rupees(amountPaise)} but the offer was ₹${rupees(expected)}`);
    const { mysteryCfg, MYSTERY_TAG, MYSTERY_NOTE } = await import('./mystery.js');
    const gift = mysteryCfg(env).on;
    const { problem } = await markPrepaid(env, row, { pct, paidPaise: amountPaise, txnid, tags: gift ? [MYSTERY_TAG] : [],
      line: gift ? `COD converted to prepaid via WhatsApp: paid ₹${rupees(amountPaise)} online (${pct}% prepaid discount), PayU txn ${txnid}. ${MYSTERY_NOTE}` : undefined });
    if (problem) issues.push(problem);
    /* Shiprocket: a parcel booked as COD in the meantime is re-booked as prepaid (new label), or flagged if it left */
    const ship = await reconcileShipment(env, row).catch((e) => ({ state: 'error', note: String(e.message || e) }));
    if (ship.state === 'picked' || ship.state === 'error') issues.push(`Shiprocket: ${ship.note}`);
    if (issues.length) await addTags(env, `gid://shopify/Order/${orderId}`, ['prepaid-needs-attention']).catch(() => {});
    await env.DB.prepare('DELETE FROM wa_pending WHERE order_id=?').bind(orderId).run().catch(() => {});
    await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'convert', template: `${pct}% ₹${rupees(amountPaise)}`, status: issues.length ? 'needs_attention' : 'converted', orderName: row.order_name, error: issues.join(' | ').slice(0, 300), preview: `Paid ${inr(amountPaise)} online (${pct}% off), PayU ${txnid}${ship.state === 'rebook' ? '. COD booking cancelled: book it again (prepaid) and print the new label' : ''}` });
    await fireTrigger(env, 'prepaid_paid', { to: row.phone, vars: { name: row.first_name, order: row.order_name, total: rupees(amountPaise) }, orderName: row.order_name });
  })().catch((e) => console.error('convert', e));
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return { ok: true };
}

/**
 * Dashboard "Mark as prepaid": the customer paid some other way (UPI to you, bank transfer …), so nothing is to be
 * collected on delivery. amountPaise = what they paid now (default: the whole COD balance). Paying less than the
 * balance is taken as a discount: Shopify's total is brought down to match, like the pay-online offer.
 * Same reconciliation as a pay-online conversion: Shopify paid + tagged + noted, a COD booking not picked up yet is
 * cancelled for a prepaid re-book, one already with the courier is flagged. Returns { ok, shopify, shiprocket, notified }.
 */
export async function manualPrepaid(env, orderId, { amountPaise, ref = '', notify = false } = {}) {
  const id = String(orderId);
  const row = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(id).first();
  if (!row) throw new Error('Order not found');
  if (row.status === 'cancelled') throw new Error('This order is cancelled');
  if (row.method !== 'cod') throw new Error('This order is already prepaid');
  if (row.converted_at) throw new Error('Already marked prepaid');
  const ship = await env.DB.prepare('SELECT stage, status FROM shipments WHERE order_id=?').bind(id).first();
  if (ship && ship.status !== 'cancelled' && ship.stage === 'delivered') throw new Error('Already delivered: the courier collected the cash');
  const due = codDue(row);
  if (due <= 0) throw new Error('Nothing left to collect on this order');
  const amt = amountPaise == null || amountPaise === '' ? due : Math.round(Number(amountPaise));
  if (!Number.isFinite(amt) || amt < 100) throw new Error('Enter the amount the customer paid');
  if (amt > due + 100) throw new Error(`₹${rupees(amt)} is more than the ₹${rupees(due)} still due`);
  const off = Math.max(0, due - amt), pct = off > 100 ? Math.round((off * 100) / due) : 0;
  const cleanRef = String(ref || '').replace(/[^\w .:/#@-]/g, '').trim().slice(0, 60);
  const txn = 'manual' + (cleanRef ? ':' + cleanRef : '');
  const t = now();
  const claim = await env.DB.prepare('UPDATE orders SET converted_at=?, paid_paise=?, convert_txnid=?, convert_pct=? WHERE order_id=? AND converted_at IS NULL RETURNING order_id')
    .bind(t, amt + (Number(row.advance_paise) || 0), txn, pct, id).first();
  if (!claim) throw new Error('Already marked prepaid');
  await env.DB.prepare("UPDATE orders SET status='paid', confirmed_at=COALESCE(confirmed_at,?) WHERE order_id=?").bind(t, id).run();
  const line = `Marked prepaid from the dashboard: customer paid ₹${rupees(amt)}${cleanRef ? ` (ref ${cleanRef})` : ''}${off > 100 ? `, ₹${rupees(off)} less than the COD balance (taken as a discount)` : ''}. Nothing to collect on delivery.`;
  const { mysteryCfg, MYSTERY_TAG, MYSTERY_NOTE } = await import('./mystery.js');
  const gift = mysteryCfg(env).on;
  const { problem } = await markPrepaid(env, row, { pct, paidPaise: amt, txnid: txn, line: gift ? line + ' ' + MYSTERY_NOTE : line, tags: ['marked-prepaid', ...(gift ? [MYSTERY_TAG] : [])] });
  const sr = await reconcileShipment(env, row).catch((e) => ({ state: 'error', note: String(e.message || e) }));
  if (sr.state === 'picked' || sr.state === 'error') await addTags(env, `gid://shopify/Order/${id}`, ['prepaid-needs-attention']).catch(() => {});
  await env.DB.prepare('DELETE FROM wa_pending WHERE order_id=?').bind(id).run().catch(() => {});
  let notified = false;
  if (notify && row.phone) {
    const r = await fireTrigger(env, 'prepaid_paid', { to: row.phone, vars: { name: row.first_name, order: row.order_name, total: rupees(amt) }, orderName: row.order_name }).catch(() => ({}));
    notified = !!r?.ok;
  }
  return { ok: true, paid: amt / 100, discount: off / 100, shopify: problem || 'ok', shiprocket: sr.state, shiprocket_note: sr.note || '', notified };
}

/** After a conversion: make sure no courier will collect cash. */
export async function reconcileShipment(env, row) {
  const rec = await liveBooking(env, row.order_id);
  if (!rec) return { state: 'none' };                 /* books as prepaid later */
  const { stopShipment } = await import('./ship-cancel.js');
  const r = await stopShipment(env, row.order_id, 'Customer paid online: re-book as prepaid');
  if (r.state === 'cancelled') { await addTags(env, `gid://shopify/Order/${row.order_id}`, ['relabel-prepaid']).catch(() => {}); return { state: 'rebook' }; }
  if (r.state === 'picked') return { state: 'picked', note: `already with the courier as COD (AWB ${rec.awb}): convert it to prepaid in Shiprocket (Delhivery / Ecom Express, before out for delivery) or refund` };
  return { state: 'error', note: r.note || 'could not cancel the COD booking' };
}

/* ---------------- PayU return (surl / furl) ---------------- */

export async function handlePaid(req, env0, ctx) {
  const env = await withSettings(env0);
  const form = await req.formData().catch(() => null);
  const r = form && (await verifyResponse(env, form));
  const store = String(env.STORE_URL || 'https://www.inkkulture.in').replace(/\/$/, '');
  const shop = `<a class="btn y" href="${esc(store)}">Back to Ink Kulture</a>`;
  const back = (q, row) => {
    /* back to the branded page when we know the order: it shows the result itself */
    if (row && store && env.STORE_URL) return null;
    return q === 'paid'
      ? page('Payment received', `Thank you${row?.first_name ? ', ' + esc(row.first_name) : ''}! Order ${esc(row?.order_name || '')} is now prepaid. We'll pack it and ship it first.`, shop)
      : page('Payment didn’t go through', 'No money was taken, or it will be refunded automatically by your bank. Your Cash on Delivery order is still active.', shop);
  };
  const toStore = async (row, q) => { const k = await payKey(env, row.order_id); return Response.redirect(`${store}/pages/pay?k=${k}&r=${q}`, 303); };
  if (!r) return back('failed') || page('Payment didn’t go through', 'Your Cash on Delivery order is still active.', shop);

  const orderId = String(r.udf1 || '');
  const row = /^\d{1,25}$/.test(orderId) && (await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(orderId).first());
  if (!row) return page('Payment didn’t go through', 'Your Cash on Delivery order is still active.', shop);
  const reply = async (q) => back(q, row) || toStore(row, q);
  if (row.converted_at) return reply('paid');
  /* Any conversion txnid we issued for this order counts (a customer may open the link twice and pay in
     the first tab). PayU's response hash already covers txnid, amount and udf1 = this order. */
  const ours = r.txnid === row.convert_txnid || /^IKC[A-Z0-9]{6,}$/.test(String(r.txnid || ''));
  if (String(r.status).toLowerCase() !== 'success' || !ours) {
    await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'convert', template: 'payu', status: 'failed', orderName: row.order_name, error: `status=${r.status} txnid=${r.txnid}` });
    return reply('failed');
  }
  await completeConversion(env, ctx, row, { txnid: r.txnid, amountPaise: paise(r.amount) });
  return reply('paid');
}

/* ---------------- the offer ---------------- */

/** "30 minutes", "1 hour", "90 minutes", "2 hours" */
export const validity = (min) => (min % 60 === 0 ? `${min / 60} hour${min === 60 ? '' : 's'}` : `${min} minutes`);

/** Free in-chat message with a "Pay ₹… now" button (only inside the 24 h window, Cloud API). */
async function sendCta(env, row, q, link, minutes) {
  const body = `Hi ${row.first_name || 'there'}! Pay for order ${row.order_name} online now and get ${q.pct}% off: ${inr(q.payable)} instead of ${inr(q.total)} cash on delivery.\n\n${env.SETTINGS?.mystery?.on !== false ? '\n\n🎁 Plus a FREE mystery tattoo in your parcel when you pay online.' : ''}\n\nThis offer is valid for the next ${validity(minutes)} only. Prepaid orders are packed and shipped first.`;
  const res = await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_ID}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WA_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '91' + row.phone, type: 'interactive',
      interactive: { type: 'cta_url', body: { text: body }, footer: { text: 'Ink Kulture · secured by PayU' }, action: { name: 'cta_url', parameters: { display_text: `Pay ${inr(q.payable)} now`.slice(0, 20), url: link } } } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error?.message || 'HTTP ' + res.status);
  await logMsg(env, { direction: 'out', phone: row.phone, trigger: 'cod_to_prepaid', template: 'in-chat pay button', status: 'sent', wamid: j.messages?.[0]?.id || '', orderName: row.order_name, preview: body });
  return { ok: true };
}

/** One order: quote, open the window, send (in-chat when we can, else the template). */
export async function sendOffer(env, row, c = convertCfg(env)) {
  const t = now();
  await env.DB.prepare('UPDATE orders SET convert_offer_at=?, convert_expires_at=?, convert_pct=? WHERE order_id=?').bind(t, t + c.minutes * 60, c.pct, row.order_id).run();
  const q = await quoteConversion(env, row, c.pct);
  if (q.missing || q.cancelled || q.fulfilled || /^paid/i.test(q.financial)) return { skipped: true };
  const link = await storePayLink(env, row.order_id);
  const lastIn = await env.DB.prepare("SELECT ts FROM messages WHERE phone=? AND direction='in' ORDER BY id DESC LIMIT 1").bind(String(row.phone)).first();
  const { viaG4w } = await import('./whatsapp.js');
  if (lastIn && Number(lastIn.ts) > t - 23 * 3600 && !viaG4w(env) && env.WA_PHONE_ID && env.WA_TOKEN) {
    try { return await sendCta(env, { ...row, convert_pct: c.pct }, q, link, c.minutes); } catch (e) { console.error('convert cta', e.message); /* template below */ }
  }
  return fireTrigger(env, 'cod_to_prepaid', {
    to: row.phone, orderId: row.order_id, orderName: row.order_name,
    vars: { name: row.first_name, order: row.order_name, total: whole(q.total), newtotal: whole(q.payable), pct: String(q.pct), mins: String(c.minutes), hours: String(Math.round((c.minutes / 60) * 10) / 10), pay: link, paykey: await payKey(env, row.order_id) },
  });
}

/**
 * Right after the customer confirms (or corrects) their delivery address: offer pay-online for `minutes`, once per
 * order. Skips orders that are not plain COD, already paid / offered, cancelled or booked. Never throws.
 */
export async function offerAfterAddress(env, orderId) {
  try {
    const c = convertCfg(env);
    if (c.mode !== 'on') return { skipped: 'off' };
    const st = await offerState(env, orderId);
    if (st.state !== 'open' || st.row.convert_offer_at || st.row.status !== 'placed') return { skipped: st.state === 'open' ? 'already offered' : st.state };
    /* claim it first: a double tap on "Address is correct" sends one offer */
    const claim = await env.DB.prepare('UPDATE orders SET convert_offer_at=? WHERE order_id=? AND convert_offer_at IS NULL RETURNING order_id').bind(now(), String(orderId)).first();
    if (!claim) return { skipped: 'already offered' };
    return await sendOffer(env, st.row, c);
  } catch (e) {
    console.error('offerAfterAddress', orderId, e.message);
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * The cron (old env mode only): COD orders placed `delay_min` ago (and less than a day), not partial COD, not paid, not booked, never
 * offered. The legacy env mode keeps its old rule (unconfirmed only). 25 per run.
 */
export async function offerPrepaidConversion(env0) {
  if (!env0.DB) return { offered: 0 };
  const env = await withSettings(env0);
  const c = convertCfg(env);
  if (c.mode === 'off') return { offered: 0, skipped: 'off' };
  /* dashboard mode: the offer goes out when the address is confirmed (offerAfterAddress), not on a timer */
  if (c.mode === 'on') return { offered: 0, skipped: 'sent on address confirmation' };
  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT o.* FROM orders o LEFT JOIN shipments s ON s.order_id=o.order_id AND LENGTH(COALESCE(s.awb,'')) > 0 AND COALESCE(s.status,'')<>'cancelled'
     WHERE s.order_id IS NULL AND o.method='cod' AND o.status='placed' AND o.converted_at IS NULL AND COALESCE(o.advance_paise,0)=0
       AND o.convert_offer_at IS NULL AND o.order_id IS NOT NULL AND o.shipped_at IS NULL AND o.created_at<? AND o.created_at>?
       ${c.mode === 'legacy' ? 'AND o.confirmed_at IS NULL' : ''}
     ORDER BY o.created_at LIMIT 25`,
  ).bind(t - c.delay_min * 60, t - (c.mode === 'legacy' ? 5 : 1) * 86400).all();
  let n = 0;
  for (const row of results) {
    try { const r = await sendOffer(env, row, c); if (r?.ok) n++; }
    catch (e) { console.error('convertOffer', row.order_id, e.message); }
  }
  return { offered: n };
}

/* ---------------- the WhatsApp template (created from the dashboard, approved by Meta) ---------------- */

export const OFFER_TEMPLATE = {
  name: 'cod_prepaid_offer_v2', language: 'en', category: 'MARKETING', parameter_format: 'NAMED',
  components: [
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Hi {{name}}, your Ink Kulture order {{order}} is getting ready to ship.\n\nPay online now and get {{pct}}% off: pay ₹{{newtotal}} instead of ₹{{total}} cash on delivery.\n\nThis offer is valid for the next {{mins}} minutes only. Prepaid orders are packed and shipped first.',
      example: { body_text_named_params: [{ param_name: 'name', example: 'Riya' }, { param_name: 'order', example: '#1627' }, { param_name: 'pct', example: '20' }, { param_name: 'newtotal', example: '319' }, { param_name: 'total', example: '399' }, { param_name: 'mins', example: '30' }] } },
    { type: 'FOOTER', text: 'Reply STOP to stop offers' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay online', url: 'https://www.inkkulture.in/pages/pay?k={{1}}', example: ['https://www.inkkulture.in/pages/pay?k=18951817658603-0123456789ab'] }] },
  ],
};

/** Dashboard numbers: offers sent, paid, money in, discount given, last 30 days. */
export async function convertStats(env, days = 30) {
  const since = now() - days * 86400;
  const r = (await env.DB.prepare(`SELECT COUNT(*) AS offered, SUM(CASE WHEN converted_at IS NOT NULL THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN converted_at IS NOT NULL THEN COALESCE(paid_paise,0) ELSE 0 END) AS paid_paise,
      SUM(CASE WHEN converted_at IS NOT NULL THEN GREATEST(COALESCE(total_paise,0) - COALESCE(paid_paise,0), 0) ELSE 0 END) AS discount_paise,
      SUM(CASE WHEN converted_at IS NULL AND convert_started_at IS NOT NULL THEN 1 ELSE 0 END) AS tried
    FROM orders WHERE convert_offer_at>?`).bind(since).first()) || {};
  const n = (x) => Number(x) || 0;
  const open = (await env.DB.prepare(`SELECT order_id, order_name, convert_expires_at FROM orders WHERE convert_offer_at IS NOT NULL AND converted_at IS NULL AND convert_expires_at>? AND status='placed' ORDER BY convert_expires_at`).bind(now()).all()).results;
  return { days, offered: n(r.offered), paid: n(r.paid), rate: n(r.offered) ? Math.round((n(r.paid) * 1000) / n(r.offered)) / 10 : 0, revenue: n(r.paid_paise) / 100, discount: n(r.discount_paise) / 100, tried: n(r.tried), open: open.length };
}
