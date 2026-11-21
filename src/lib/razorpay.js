/**
 * Razorpay for the IK checkout (Nov 2026: replaces PayU for new payments).
 * Keys: Settings > Payments (pay.rzp_key_id / pay.rzp_key_secret); pay.gateway = 'razorpay' turns it on.
 * Our own txnid stays the order's key: it is sent as the Razorpay order `receipt`, so any Razorpay order can be
 * traced back to the IK row, and verifyRzp(txnid) finds the payment by receipt (status poll + sweep).
 */
import { rupees } from './pricing.js';

const API = 'https://api.razorpay.com/v1';
let noS2sUntil = 0; /* S2S UPI intent not enabled on the account: stop asking for an hour (saves ~300 ms per order) */
const pay = (env) => env.SETTINGS?.pay || {};
export const rzpKeyId = (env) => String(pay(env).rzp_key_id || env.RAZORPAY_KEY_ID || '').trim();
const rzpSecret = (env) => String(pay(env).rzp_key_secret || env.RAZORPAY_KEY_SECRET || '').trim();
export const rzpReady = (env) => !!(rzpKeyId(env) && rzpSecret(env));
/** Razorpay takes new payments when it is switched on and both keys are saved. */
export const rzpOn = (env) => pay(env).gateway === 'razorpay' && rzpReady(env);

export async function rzp(env, method, path, body) {
  const auth = btoa(rzpKeyId(env) + ':' + rzpSecret(env));
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('Razorpay: ' + (j?.error?.description || 'HTTP ' + r.status)); e.status = r.status; throw e; }
  return j;
}

/** Razorpay order for `paise`; returns what the browser needs to open Razorpay Checkout. */
export async function rzpCheckout(env, { txnid, paise, desc, buyer, draftId, method, upi, ip, ua, referer }) {
  const o = await rzp(env, 'POST', '/orders', { amount: Math.round(paise), currency: 'INR', receipt: String(txnid).slice(0, 40), payment_capture: 1,
    notes: { txnid: String(txnid), draft: String(draftId || ''), phone: String(buyer.phone || '') } });
  /* UPI intent (S2S): a upi://pay link for the app button the shopper tapped; the theme's goUpi opens it and polls
     /api/payu/status. Needs S2S UPI enabled on the Razorpay account; if Razorpay refuses, the Razorpay window is used. */
  let intent = null;
  if (upi && Date.now() > noS2sUntil) {
    try {
      const p = await rzp(env, 'POST', '/payments/create/upi', { amount: o.amount, currency: 'INR', order_id: o.id, method: 'upi',
        email: buyer.email || `orders+${String(buyer.phone || '').slice(-10)}@inkkulture.in`, contact: '+91' + String(buyer.phone || '').slice(-10),
        ip: ip || '0.0.0.0', referer: referer || 'https://www.inkkulture.in/', user_agent: String(ua || 'Mozilla/5.0').slice(0, 250),
        description: String(desc || '').slice(0, 250), notes: { txnid: String(txnid) }, upi: { flow: 'intent' } });
      const link = String(p.link || p.intent_url || p?.next?.find?.((x) => /intent|upi/.test(x.action))?.url || '');
      if (/^upi:\/\/pay\?/i.test(link)) intent = { uri: link, payment_id: p.razorpay_payment_id || p.id || '' };
      else console.error('rzp intent: no link', JSON.stringify(p).slice(0, 300));
    } catch (e) { if (e.status === 404 || e.status === 400 && /not (found|enabled|permitted)/i.test(e.message)) noS2sUntil = Date.now() + 3600e3; console.error('rzp intent', e.message); }
  }
  const pm = { upi: 'upi', upiid: 'upi', card: 'card', nb: 'netbanking' }[method] || '';
  return { rzp: { key: rzpKeyId(env), order_id: o.id, amount: o.amount, currency: 'INR', name: 'Ink Kulture', description: String(desc || '').slice(0, 250),
    prefill: { name: String(buyer.firstName || '').slice(0, 60), contact: '+91' + String(buyer.phone || '').slice(-10), email: buyer.email || '' },
    notes: { txnid: String(txnid) } }, upi: intent };
}

async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function rzpSignatureOk(env, orderId, paymentId, signature) {
  if (!orderId || !paymentId || !signature) return false;
  const want = await hmacHex(rzpSecret(env), `${orderId}|${paymentId}`);
  return want.length === String(signature).length && want === String(signature);
}

/** Same shape as payu.verifyPayment: { status: 'success'|'failed'|'pending', amount: '349.00', mode, payment_id, order_id } or null. */
export async function verifyRzpOrder(env, orderId) {
  const [o, ps] = await Promise.all([rzp(env, 'GET', `/orders/${encodeURIComponent(orderId)}`), rzp(env, 'GET', `/orders/${encodeURIComponent(orderId)}/payments`)]);
  const list = ps?.items || [];
  let p = list.find((x) => x.status === 'captured');
  if (!p) {
    const auth = list.find((x) => x.status === 'authorized');
    if (auth) { try { p = await rzp(env, 'POST', `/payments/${auth.id}/capture`, { amount: auth.amount, currency: 'INR' }); } catch (e) { console.error('rzp capture', auth.id, e.message); } }
  }
  if (p && p.status === 'captured') return { status: 'success', amount: rupees(p.amount), mode: String(p.method || ''), payment_id: p.id, order_id: o.id, receipt: o.receipt };
  /* not paid (yet): a failed attempt can still be retried in the same Razorpay window, so never "failed" here */
  return { status: 'pending', amount: rupees(o.amount), mode: '', payment_id: '', order_id: o.id, receipt: o.receipt };
}

/** By our txnid (the Razorpay receipt). null when Razorpay has no order for it. */
export async function verifyRzp(env, txnid) {
  if (!rzpReady(env)) return null;
  const j = await rzp(env, 'GET', `/orders?receipt=${encodeURIComponent(txnid)}&count=5`);
  const items = (j?.items || []).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  let last = null;
  for (const o of items) { const v = await verifyRzpOrder(env, o.id); if (v.status === 'success') return v; last = last || v; }
  return last;
}
