import { sha512hex, safeEqual } from './util.js';

export function payuAction(env) {
  return env.PAYU_ENV === 'test' ? 'https://test.payu.in/_payment' : 'https://secure.payu.in/_payment';
}

// key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT
export async function requestHash(env, p) {
  const s = [env.PAYU_KEY, p.txnid, p.amount, p.productinfo, p.firstname, p.email, p.udf1 || '', p.udf2 || '', p.udf3 || '', p.udf4 || '', p.udf5 || '', '', '', '', '', '', env.PAYU_SALT].join('|');
  return sha512hex(s);
}

// [additional_charges|]SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
export async function responseHash(env, r) {
  const parts = [env.PAYU_SALT, r.status, '', '', '', '', '', r.udf5 || '', r.udf4 || '', r.udf3 || '', r.udf2 || '', r.udf1 || '', r.email, r.firstname, r.productinfo, r.amount, r.txnid, env.PAYU_KEY];
  if (r.additionalCharges) parts.unshift(r.additionalCharges);
  return sha512hex(parts.join('|'));
}

export async function verifyResponse(env, form) {
  const r = Object.fromEntries(form.entries());
  const expected = await responseHash(env, { ...r, additionalCharges: r.additionalCharges || r.additional_charges });
  return safeEqual(expected, String(r.hash || '').toLowerCase()) ? r : null;
}

export async function buildPayuForm(env, { txnid, amount, productinfo, firstname, email, phone, surl, furl, udf1 }) {
  const f = { key: env.PAYU_KEY, txnid, amount, productinfo, firstname, email, phone, surl, furl, udf1: udf1 || '' };
  f.hash = await requestHash(env, f);
  return { action: payuAction(env), fields: f };
}

/** UPI intent via PayU server-to-server. Returns { uri } (a upi://pay?... deeplink) or throws. */
export async function upiIntent(env, f, ip, ua) {
  const body = new URLSearchParams({ ...f, pg: 'UPI', bankcode: 'INTENT', txn_s2s_flow: '4', s2s_client_ip: ip || '0.0.0.0', s2s_device_info: (ua || 'Mozilla/5.0').slice(0, 250) });
  const res = await fetch(payuAction(env), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, redirect: 'manual' });
  const j = await res.json().catch(() => null);
  const data = j?.result?.intentURIData;
  if (!data) throw new Error('payu upi intent failed: ' + res.status + ' ' + JSON.stringify(j || {}).slice(0, 300));
  return { uri: 'upi://pay?' + String(data).replace(/^upi:\/\/pay\?/, '') };
}

/** Server-side status lookup (verify_payment). Returns { status, amount } or null. */
export async function verifyPayment(env, txnid) {
  const command = 'verify_payment';
  const hash = await sha512hex([env.PAYU_KEY, command, txnid, env.PAYU_SALT].join('|'));
  const url = env.PAYU_ENV === 'test' ? 'https://test.payu.in/merchant/postservice.php?form=2' : 'https://info.payu.in/merchant/postservice.php?form=2';
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key: env.PAYU_KEY, command, var1: txnid, hash }) });
  const j = await res.json().catch(() => null);
  const t = j?.transaction_details?.[txnid];
  if (!t || t.status === 'Not Found') return null;
  return { status: String(t.status || '').toLowerCase(), amount: String(t.amt ?? t.amount ?? '') };
}
