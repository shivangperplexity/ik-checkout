import { hmacSha256hex, safeEqual } from './util.js';

/* Short signed tokens so a link in a WhatsApp message can only act on its own order.
   Keyed on WA_LINK_SECRET, falling back to secrets that already exist in the project env. */
const secret = (env) => env.WA_LINK_SECRET || env.ADMIN_TOKEN || env.CRON_SECRET || '';

async function sign(env, prefix, orderId) {
  const s = secret(env);
  if (!s) return null;
  return (await hmacSha256hex(s, prefix + String(orderId))).slice(0, 12);
}

export const signOrder = (env, orderId) => sign(env, 'wa:', orderId);
/* Pay links use a different prefix so a confirm link can never be replayed as a payment link, or back. */
export const signPay = (env, orderId) => sign(env, 'pay:', orderId);

export async function verifyOrder(env, orderId, sig) {
  const want = await signOrder(env, orderId);
  return !!want && safeEqual(want, String(sig || ''));
}
export async function verifyPay(env, orderId, sig) {
  const want = await signPay(env, orderId);
  return !!want && safeEqual(want, String(sig || ''));
}

/** Accepts only what a real link can carry: a numeric Shopify order id and exactly 12 hex chars. */
export const linkShapeOk = (orderId, sig) => /^\d{1,25}$/.test(String(orderId || '')) && /^[a-f0-9]{12}$/.test(String(sig || ''));

const base = (env) => String(env.WORKER_URL || '').replace(/\/$/, '');

/** The one-tap confirm / cancel link that goes into the cod_order_confirm template body. */
export async function confirmLink(env, orderId) {
  const sig = await signOrder(env, orderId);
  if (!sig || !base(env)) return '';
  return `${base(env)}/api/wa/act?o=${orderId}&s=${sig}`;
}

/** The prepaid-conversion link that goes into the cod_to_prepaid template body. */
export async function payLink(env, orderId) {
  const sig = await signPay(env, orderId);
  if (!sig || !base(env)) return '';
  return `${base(env)}/api/wa/pay?o=${orderId}&s=${sig}`;
}

/* Address-edit links get their own prefix too: a confirm or pay link can never open the address form, or back. */
export const signAddr = (env, orderId) => sign(env, 'addr:', orderId);
export async function verifyAddr(env, orderId, sig) {
  const want = await signAddr(env, orderId);
  return !!want && safeEqual(want, String(sig || ''));
}
/** The "Edit address" link sent after a customer confirms a COD order. */
export async function addrLink(env, orderId) {
  const sig = await signAddr(env, orderId);
  if (!sig || !base(env)) return '';
  return `${base(env)}/api/wa/addr?o=${orderId}&s=${sig}`;
}
