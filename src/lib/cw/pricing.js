/**
 * CodWing checkout prices, all in paise. Pure: the server quotes with real Shopify variant prices, the storefront
 * only shows what this returns.
 *   online   cart total minus the seller's prepaid discount (Razorpay connected only)
 *   cod      cart total plus the seller's COD fee; off above cod_max
 *   partial  replaces COD when an advance is set (and, if states are listed, only for those states):
 *            the advance is paid online now, the rest is collected on delivery
 */
import { stateCode } from '../util.js';

export const STEPS = ['visit', 'cart', 'checkout', 'phone', 'address', 'payment', 'order'];
export const stepNo = (name) => STEPS.indexOf(name) + 1; /* 0 = unknown */

export function onlineReady(s, secretsSet) {
  return s.gateway === 'razorpay' && !!s.razorpay_key_id && !!secretsSet.razorpay_key_secret;
}

export function waReady(s, secretsSet) {
  return !!(s.wa_phone_id && secretsSet.wa_token);
}

/** lines: [{ price (paise, per unit), quantity }]; s: seller settings; opts: { state, online } */
export function quote(lines, s, { state = '', online = false } = {}) {
  const subtotal = lines.reduce((t, l) => t + Math.max(0, Math.round(l.price)) * Math.max(0, Math.round(l.quantity)), 0);
  const out = { subtotal, online: null, cod: null, partial: null };
  if (!subtotal) return out;
  if (online) {
    const off = Math.min(Math.max(0, (s.prepaid_discount || 0) * 100), subtotal);
    out.online = { total: subtotal - off, discount: off };
  }
  const fee = Math.max(0, (s.cod_fee || 0) * 100);
  const codTotal = subtotal + fee;
  const codAllowed = s.cod_on !== false && (!s.cod_max || codTotal <= s.cod_max * 100);
  if (codAllowed) {
    const states = String(s.partial_states || '').split(',').filter(Boolean);
    const code = stateCode(state) || String(state).toUpperCase();
    const adv = Math.min((s.partial_advance || 0) * 100, codTotal);
    if (online && adv > 0 && (!states.length || (state && states.includes(code)))) {
      out.partial = { total: codTotal, advance: adv, rest: codTotal - adv, fee };
    } else {
      out.cod = { total: codTotal, fee };
    }
  }
  return out;
}

/** The amount to charge now and the Shopify order total for a method; null if that method is not offered. */
export function charge(q, method) {
  if (method === 'online' && q.online) return { now: q.online.total, total: q.online.total, discount: q.online.discount, fee: 0 };
  if (method === 'cod' && q.cod) return { now: 0, total: q.cod.total, discount: 0, fee: q.cod.fee };
  if (method === 'partial' && q.partial) return { now: q.partial.advance, total: q.partial.total, discount: 0, fee: q.partial.fee };
  return null;
}

/** WhatsApp follow-up text for an abandoned checkout (the seller sends it from their own WhatsApp). */
export function followUpText({ name, items, store, link }) {
  const first = String(name || '').trim().split(/\s+/)[0];
  const what = (items || []).slice(0, 2).map((i) => i.t).filter(Boolean).join(' and ') || 'your items';
  const more = (items || []).length > 2 ? ` and ${(items.length - 2)} more` : '';
  return `Hi${first ? ' ' + first : ''}! You left ${what}${more} in your cart at ${store}. Your cart is saved, complete your order here: ${link}`;
}
