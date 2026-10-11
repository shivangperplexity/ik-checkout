/**
 * COD -> prepaid conversion.
 *   GET  /api/wa/pay?o=<orderId>&s=<sig>   the link inside the cod_to_prepaid template
 *   POST /api/wa/paid                      PayU's surl/furl for these payments only (never /api/payu/return)
 *
 * The customer pays the order total minus COD_CONVERT_DISCOUNT percent of the product subtotal (never off
 * shipping or the COD fee). On success the same percentage goes onto every line item through a Shopify
 * order edit, so the order's own total matches what was paid, then the order is marked paid and retagged.
 * If Shopify's edited total would not match the payment, or the edit is refused, the order is still marked
 * paid (so no courier ever collects cash from someone who already paid) and tagged prepaid-needs-attention.
 */
import { gql, addTags, removeTags } from './shopify.js';
import { buildPayuForm, verifyResponse } from './payu.js';
import { withSettings } from './settings.js';
import { logMsg, fireTrigger } from './whatsapp.js';
import { verifyPay, payLink, linkShapeOk } from './wa-token.js';
import { page, esc } from './wa-g4w.js';

const now = () => Math.floor(Date.now() / 1000);
const rupees = (paise) => (Math.round(Number(paise) || 0) / 100).toFixed(2);
const paise = (amt) => Math.round(Number(amt || 0) * 100);
export const discountPct = (env) => Math.min(50, Math.max(1, Number(env.COD_CONVERT_DISCOUNT || 10)));

async function liveOrder(env, orderId) {
  const d = await gql(env, `query($id:ID!){ order(id:$id){ id name note cancelledAt displayFinancialStatus currentTotalPriceSet{shopMoney{amount}} totalOutstandingSet{shopMoney{amount}} lineItems(first:50){nodes{ quantity currentQuantity originalUnitPriceSet{shopMoney{amount}} }} } }`, { id: `gid://shopify/Order/${orderId}` });
  return d.order;
}

/**
 * What this order costs if they pay now. The discount is pct of the product subtotal at list price, which is
 * what a per-line percentage discount takes off on Shopify's side, so the two agree.
 */
export async function quoteConversion(env, row) {
  const pct = discountPct(env);
  const o = await liveOrder(env, row.order_id);
  if (!o) return { missing: true };
  const li = o.lineItems?.nodes || [];
  const subtotal = li.reduce((s, l) => s + paise(l.originalUnitPriceSet.shopMoney.amount) * Number(l.currentQuantity ?? l.quantity ?? 0), 0);
  const total = paise(o.totalOutstandingSet?.shopMoney?.amount ?? o.currentTotalPriceSet?.shopMoney?.amount) || Number(row.total_paise) || 0;
  const discount = Math.round((subtotal * pct) / 100);
  return { pct, total, discount, payable: Math.max(100, total - discount), cancelled: !!o.cancelledAt, financial: String(o.displayFinancialStatus || ''), note: o.note || '' };
}

/* ---------------- the pay page ---------------- */

export async function handlePay(req, env0) {
  const url = new URL(req.url);
  const orderId = String(url.searchParams.get('o') || '');
  const sig = String(url.searchParams.get('s') || '');
  if (!linkShapeOk(orderId, sig) || !(await verifyPay(env0, orderId, sig))) return page('Link not valid', 'Please use the link from your WhatsApp message.');
  const env = await withSettings(env0);
  const row = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(orderId).first();
  if (!row || row.method !== 'cod') return page('Order not found', 'We could not find that order.');
  const name = esc(row.order_name);
  if (row.converted_at || row.status === 'paid') return page(`Order ${name}`, 'Already paid. Thank you! We will ship it soon.');
  if (row.status === 'cancelled') return page(`Order ${name}`, 'This order was cancelled.');

  let q;
  try { q = await quoteConversion(env, row); } catch (e) { console.error('quote', e.message); return page(`Order ${name}`, 'We could not load this order right now. Please try again in a minute.'); }
  if (q.missing || q.cancelled) return page(`Order ${name}`, 'This order was cancelled.');
  if (/^paid|partially_refunded|refunded/i.test(q.financial)) return page(`Order ${name}`, 'Already paid. Thank you!');

  const txnid = `IKC${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  await env.DB.prepare('UPDATE orders SET convert_txnid=? WHERE order_id=? AND converted_at IS NULL').bind(txnid, orderId).run();
  const payu = await buildPayuForm(env, {
    txnid, amount: rupees(q.payable), productinfo: `Ink Kulture ${row.order_name}`.slice(0, 100),
    firstname: String(row.first_name || 'Customer').slice(0, 60), email: row.email || `orders+${row.phone}@inkkulture.in`, phone: row.phone,
    surl: `${env.WORKER_URL}/api/wa/paid`, furl: `${env.WORKER_URL}/api/wa/paid`, udf1: orderId,
  });
  const fields = Object.entries(payu.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return page(`Pay for order ${name}`, `${q.pct}% off for paying online. Prepaid orders are packed and shipped first.`,
    `<div class="was">₹${rupees(q.total)}</div><div class="amt">₹${rupees(q.payable)}</div><p>UPI, cards, netbanking · secured by PayU</p>
     <form id="f" method="POST" action="${esc(payu.action)}">${fields}<button class="y" type="submit">Pay ₹${rupees(q.payable)}</button></form>`);
}

/* ---------------- Shopify: discount, then mark paid ---------------- */

function userErr(d, key) {
  const e = d?.[key]?.userErrors;
  if (e && e.length) throw new Error(`${key}: ${e.map((x) => x.message).join('; ')}`);
}

/**
 * Take pct off every line item and commit only if the edited outstanding balance equals what was paid
 * (within ₹2 for Shopify's per-line rounding). Returns { edited: true } or throws with the reason.
 */
export async function discountOrder(env, orderId, { pct, paidPaise, note }) {
  const begin = await gql(env, `mutation($id:ID!){ orderEditBegin(id:$id){ calculatedOrder{ id lineItems(first:50){ nodes{ id quantity } } } userErrors{ field message } } }`, { id: `gid://shopify/Order/${orderId}` });
  userErr(begin, 'orderEditBegin');
  const calc = begin.orderEditBegin.calculatedOrder;
  let outstanding = null;
  for (const li of calc.lineItems.nodes.filter((l) => l.quantity > 0)) {
    const d = await gql(env, `mutation($id:ID!,$li:ID!,$d:OrderEditAppliedDiscountInput!){ orderEditAddLineItemDiscount(id:$id, lineItemId:$li, discount:$d){ calculatedOrder{ id totalOutstandingSet{shopMoney{amount}} } userErrors{ field message } } }`,
      { id: calc.id, li: li.id, d: { description: `Prepaid ${pct}% off`, percentValue: pct } });
    userErr(d, 'orderEditAddLineItemDiscount');
    outstanding = paise(d.orderEditAddLineItemDiscount.calculatedOrder?.totalOutstandingSet?.shopMoney?.amount);
  }
  /* Not committing leaves the staged edit to expire on its own: the order is untouched. */
  if (outstanding === null || Math.abs(outstanding - paidPaise) > 200) throw new Error(`edited total ₹${rupees(outstanding)} would not match the ₹${rupees(paidPaise)} paid`);
  const commit = await gql(env, `mutation($id:ID!,$n:String){ orderEditCommit(id:$id, notifyCustomer:false, staffNote:$n){ order{ id totalOutstandingSet{shopMoney{amount}} } userErrors{ field message } } }`, { id: calc.id, n: note });
  userErr(commit, 'orderEditCommit');
  return { edited: true };
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

/** After the money lands: discount (if Shopify agrees), mark paid, retag. Never throws. */
export async function markPrepaid(env, row, { pct, paidPaise, txnid }) {
  const orderId = String(row.order_id);
  const gid = `gid://shopify/Order/${orderId}`;
  const line = `COD converted to prepaid via WhatsApp: paid ₹${rupees(paidPaise)} online (${pct}% prepaid discount), PayU txn ${txnid}.`;
  let problem = '';
  try { await discountOrder(env, orderId, { pct, paidPaise, note: line }); } catch (e) { problem = String(e.message || e); }
  try { await markPaid(env, orderId); } catch (e) { problem = (problem ? problem + ' | ' : '') + String(e.message || e); }
  await removeTags(env, gid, ['cod-unconfirmed', 'cod']).catch(() => {});
  await addTags(env, gid, ['prepaid', 'cod-converted-prepaid', ...(problem ? ['prepaid-needs-attention'] : [])]).catch(() => {});
  try {
    const cur = await liveOrder(env, orderId);
    await appendNote(env, orderId, cur?.note || '', line + (problem ? ` NEEDS ATTENTION: ${problem}` : ''));
  } catch (e) { problem = problem || String(e.message || e); }
  return { problem };
}

/* ---------------- PayU return ---------------- */

export async function handlePaid(req, env0, ctx) {
  const env = await withSettings(env0);
  const form = await req.formData().catch(() => null);
  const r = form && (await verifyResponse(env, form));
  const shop = `<a class="btn y" href="${esc(env.STORE_URL || 'https://www.inkkulture.in')}">Back to Ink Kulture</a>`;
  const back = (q, row) => (q === 'paid'
    ? page('Payment received', `Thank you${row?.first_name ? ', ' + esc(row.first_name) : ''}! Order ${esc(row?.order_name || '')} is now prepaid. We'll pack it and ship it first.`, shop)
    : page('Payment didn’t go through', 'No money was taken, or it will be refunded automatically by your bank. Your Cash on Delivery order is still active.', shop));
  if (!r) return back('failed');

  const orderId = String(r.udf1 || '');
  const row = /^\d{1,25}$/.test(orderId) && (await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(orderId).first());
  if (!row) return back('failed');
  if (row.converted_at) return back('paid', row);
  /* Any conversion txnid we issued for this order counts (a customer may open the link twice and pay in
     the first tab). PayU's response hash already covers txnid, amount and udf1 = this order. */
  const ours = r.txnid === row.convert_txnid || /^IKC[A-Z0-9]{6,}$/.test(String(r.txnid || ''));
  if (String(r.status).toLowerCase() !== 'success' || !ours) {
    await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'convert', template: 'payu', status: 'failed', orderName: row.order_name, error: `status=${r.status} txnid=${r.txnid}` });
    return back('failed');
  }

  const paidPaise = paise(r.amount);
  /* Claim first so a duplicate callback cannot discount the order twice. */
  const claim = await env.DB.prepare('UPDATE orders SET converted_at=?, paid_paise=? WHERE order_id=? AND converted_at IS NULL RETURNING order_id').bind(now(), paidPaise, orderId).first();
  if (!claim) return back('paid', row);
  await env.DB.prepare("UPDATE orders SET status='paid', confirmed_at=COALESCE(confirmed_at,?) WHERE order_id=?").bind(now(), orderId).run();

  ctx.waitUntil((async () => {
    const pct = discountPct(env);
    const { problem } = await markPrepaid(env, row, { pct, paidPaise, txnid: r.txnid });
    if (problem) console.error('CONVERTED BUT SHOPIFY NEEDS ATTENTION', orderId, problem);
    await env.DB.prepare('DELETE FROM wa_pending WHERE order_id=?').bind(orderId).run();
    await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'convert', template: `${pct}% ₹${rupees(paidPaise)}`, status: problem ? 'needs_attention' : 'converted', orderName: row.order_name, error: problem });
    await fireTrigger(env, 'prepaid_paid', { to: row.phone, vars: { name: row.first_name, order: row.order_name, total: rupees(paidPaise) }, orderName: row.order_name });
  })().catch((e) => console.error('convert', e)));
  return back('paid', row);
}

/* ---------------- the cron offer ---------------- */

/**
 * Offer prepaid conversion on COD orders nobody confirmed. Off unless COD_CONVERT_HOURS is set; runs before
 * the auto-cancel sweep so the discount gets a chance first. One offer per order, 25 per run.
 */
export async function offerPrepaidConversion(env0) {
  const hours = Number(env0.COD_CONVERT_HOURS || 0);
  if (!hours || !env0.DB) return { offered: 0, skipped: 'off' };
  const env = await withSettings(env0);
  const { results } = await env.DB.prepare(
    `SELECT * FROM orders WHERE method='cod' AND status='placed' AND confirmed_at IS NULL AND converted_at IS NULL
       AND convert_offer_at IS NULL AND order_id IS NOT NULL AND created_at<? AND created_at>? ORDER BY created_at LIMIT 25`,
  ).bind(now() - hours * 3600, now() - 5 * 86400).all();
  let n = 0;
  for (const row of results) {
    try {
      await env.DB.prepare('UPDATE orders SET convert_offer_at=? WHERE order_id=?').bind(now(), row.order_id).run();
      const q = await quoteConversion(env, row);
      if (q.missing || q.cancelled || /^paid/i.test(q.financial)) continue;
      const r = await fireTrigger(env, 'cod_to_prepaid', {
        to: row.phone, orderId: row.order_id, orderName: row.order_name,
        vars: { name: row.first_name, order: row.order_name, total: rupees(q.total), newtotal: rupees(q.payable), pct: String(q.pct), pay: await payLink(env, row.order_id) },
      });
      if (r.ok) n++;
    } catch (e) {
      console.error('convertOffer', row.order_id, e.message);
    }
  }
  return { offered: n };
}
