/**
 * "Hi, I just placed order #1758. Please keep me updated." is the text the checkout's thank-you screen pre-fills
 * behind "Get updates on WhatsApp". It gets a fixed, instant reply instead of the AI:
 *   COD not confirmed yet -> ask them to tap Yes on the confirmation message (or reply YES here)
 *   COD confirmed / part-paid / prepaid -> thank you, all updates come here
 * Anything else (cancelled, not found, another number) falls through to the normal handling.
 */
import { logMsg, sendText } from './whatsapp.js';

const PLACED = /\bplaced\s+(?:an?\s+|my\s+)?order\b|keep me updated/i;
const rs = (p) => '₹' + Math.round(Number(p || 0) / 100).toLocaleString('en-IN');

export function placedReply(o) {
  const n0 = String(o.first_name || '').trim().split(/\s+/)[0], name = n0 ? n0[0].toUpperCase() + n0.slice(1).toLowerCase() : '';
  const hi = name ? `Thanks ${name}!` : 'Thanks!';
  if (o.status === 'cancelled') return '';
  if (o.method === 'cod' && !o.converted_at && !(Number(o.advance_paise) > 0)) {
    if (o.confirmed_at) return `${hi} Order ${o.order_name} is confirmed. You'll get every update right here on WhatsApp: when it ships, the tracking link, and the day it's out for delivery.`;
    return `${hi} Order ${o.order_name} is placed as Cash on Delivery (${rs(o.total_paise)}).\n\nPlease confirm it: tap "Yes" on the order confirmation message we sent you here, or simply reply YES to this message. We pack and ship only confirmed orders.\n\nAfter that, every update comes right here on WhatsApp.`;
  }
  if (Number(o.advance_paise) > 0 && !o.converted_at) return `${hi} Your advance for order ${o.order_name} is received, so it's confirmed. Pay ${rs(Number(o.total_paise) - Number(o.advance_paise))} when it arrives. You'll get every update right here on WhatsApp.`;
  return `Thank you for placing order ${o.order_name}${name ? ', ' + name : ''}! You'll receive all updates right here on WhatsApp: when it ships, the tracking link, and the day it's out for delivery.`;
}

/** true when handled. */
export async function handlePlaced(env, phone, text) {
  if (!PLACED.test(String(text || ''))) return false;
  const num = (String(text).match(/#\s?(\d{3,6})\b/) || [])[1];
  const o = num
    ? await env.DB.prepare('SELECT * FROM orders WHERE order_name=? AND phone=?').bind('#' + num, phone).first()
    : await env.DB.prepare("SELECT * FROM orders WHERE phone=? AND order_name IS NOT NULL AND status NOT IN ('pending_payment','failed','completing') AND created_at>? ORDER BY created_at DESC LIMIT 1").bind(phone, Math.floor(Date.now() / 1000) - 2 * 86400).first();
  if (!o) return false;
  const reply = placedReply(o);
  if (!reply) return false;
  const res = await sendText(env, '91' + phone, reply);
  await logMsg(env, { direction: 'out', phone, trigger: 'ai', template: 'order-placed', status: res.ok ? 'sent' : 'failed', orderName: o.order_name, wamid: res.id || '', error: res.error || '', preview: reply });
  return !!res.ok;
}
