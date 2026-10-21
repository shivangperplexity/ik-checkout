/**
 * "Do you still want it?" after the courier says the delivery was refused / cancelled at the door.
 *
 * Instead of the generic delivery-failed message, the customer gets one question with two buttons:
 *   [Yes, deliver it]  -> re-attempt (Shiprocket NDR action), "we'll deliver again" reply
 *   [No, cancel order] -> return to us (RTO), order tagged customer-refused, "cancelled" reply
 * Inside the 24 h window it is a free interactive message; otherwise the ndr_refused template (two quick replies).
 * A typed "yes" / "no" / "cancel" from that number within 48 h of the question counts too (Go4WhatsUp loses the
 * button payload, and some customers just type). Every answer is logged and shows on the NDR card like a link choice.
 */
import { logMsg, sendText, fireTrigger, viaG4w } from './whatsapp.js';
import { customerNdr } from './wa-ndr.js';
import { addTags } from './shopify.js';

const now = () => Math.floor(Date.now() / 1000);
const ASK_WINDOW = 48 * 3600;

export const REFUSED_TEMPLATE = {
  name: 'ndr_refused_check', language: 'en', category: 'UTILITY',
  components: [
    { type: 'BODY', text: 'Hi {{1}}, the courier says the delivery of your Ink Kulture order {{2}} was refused or cancelled at the door. Do you still want it?\n\nTap below and we will arrange it.',
      example: { body_text: [['Riya', '#1627']] } },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes, deliver it' }, { type: 'QUICK_REPLY', text: 'No, cancel order' }] },
  ],
};

async function sendButtons(env, phone, orderId, text) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_ID}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WA_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '91' + phone, type: 'interactive',
      interactive: { type: 'button', body: { text }, footer: { text: 'Ink Kulture' }, action: { buttons: [
        { type: 'reply', reply: { id: `NDR_YES:${orderId}`, title: 'Yes, deliver it' } },
        { type: 'reply', reply: { id: `NDR_NO:${orderId}`, title: 'No, cancel order' } },
      ] } } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error?.message || 'HTTP ' + res.status);
  return j.messages?.[0]?.id || '';
}

/** Ask once per failed attempt. r = { order_id, order_name, phone, first_name }. Returns { ok } or { ok:false, error }. */
export async function askRefused(env, r) {
  const t = now();
  const text = `Hi ${r.first_name || 'there'}, the courier says the delivery of your order ${r.order_name} was refused or cancelled at the door. Do you still want it?\n\nTap below and we will arrange it.`;
  const lastIn = await env.DB.prepare("SELECT ts FROM messages WHERE phone=? AND direction='in' ORDER BY id DESC LIMIT 1").bind(String(r.phone)).first();
  let ok = false, err = '';
  if (lastIn && Number(lastIn.ts) > t - 23 * 3600 && !viaG4w(env) && env.WA_PHONE_ID && env.WA_TOKEN) {
    try {
      const wamid = await sendButtons(env, r.phone, r.order_id, text);
      await logMsg(env, { direction: 'out', phone: r.phone, trigger: 'ndr_refused', template: 'in-chat buttons', status: 'sent', wamid, orderName: r.order_name, preview: text + '\n[Yes, deliver it] [No, cancel order]' });
      ok = true;
    } catch (e) { err = String(e.message || e); }
  }
  if (!ok) {
    const res = await fireTrigger(env, 'ndr_refused', { to: r.phone, vars: { name: r.first_name || 'there', order: r.order_name }, orderId: String(r.order_id), orderName: r.order_name });
    ok = !!res.ok; err = res.error || res.skipped || err;
  }
  if (ok) await env.DB.prepare('UPDATE shipments SET ndr_asked_at=? WHERE order_id=?').bind(t, String(r.order_id)).run();
  return ok ? { ok: true } : { ok: false, error: err };
}

/** The order this number was asked about in the last 48 h and has not answered since, or null. */
export async function pendingAsk(env, phone) {
  return env.DB.prepare(`SELECT s.order_id, s.order_name, s.ndr_asked_at, s.ndr_choice_at, o.phone, o.first_name, o.total_paise, o.advance_paise, o.method, o.converted_at
    FROM shipments s JOIN orders o ON o.order_id = s.order_id
    WHERE o.phone=? AND s.ndr_asked_at>? AND COALESCE(s.ndr_choice_at,0) < s.ndr_asked_at AND COALESCE(s.status,'')<>'cancelled'
    ORDER BY s.ndr_asked_at DESC LIMIT 1`).bind(String(phone), now() - ASK_WINDOW).first();
}

/** yes = deliver again, no = cancel (return to us). via: 'button' | 'reply'. Replies to the customer. Never throws. */
export async function answerRefused(env, phone, orderId, yes, via = 'button') {
  const row = await env.DB.prepare('SELECT o.order_id, o.order_name, o.first_name, o.method, o.total_paise, o.advance_paise, o.converted_at FROM orders o WHERE o.order_id=? AND o.phone=?').bind(String(orderId), String(phone)).first();
  if (!row) return false;
  try {
    const r = await customerNdr(env, { orderId: row.order_id, what: yes ? 'reattempt' : 'return', via: 'refused-' + via });
    if (r.status === 'no-shipment') { await sendText(env, '91' + phone, `Order ${row.order_name} is not waiting with the courier any more. Reply here if you need help.`); return true; }
    if (yes) {
      const cod = row.method === 'cod' && !row.converted_at;
      const due = Math.round((Number(row.total_paise) - (Number(row.advance_paise) || 0)) / 100);
      await sendText(env, '91' + phone, `Great, thank you ${row.first_name || ''}! We've asked the courier to deliver order ${row.order_name} again on the next working day. Please keep your phone reachable${cod ? ` and ₹${due} ready for the delivery` : ''}.`);
    } else {
      await addTags(env, `gid://shopify/Order/${row.order_id}`, ['customer-refused']).catch(() => {});
      await sendText(env, '91' + phone, `Okay, order ${row.order_name} is cancelled and the parcel is coming back to us. Nothing to pay. You can order again anytime at inkkulture.in`);
    }
    return true;
  } catch (e) {
    await logMsg(env, { direction: 'in', phone, trigger: 'ndr-refused', template: yes ? 'YES' : 'NO', status: 'failed', orderName: row.order_name, error: String(e.message || e) });
    await sendText(env, '91' + phone, `We could not reach the courier just now for order ${row.order_name}. Our team will arrange it shortly.`);
    return true;
  }
}

/** Button taps from Meta's webhook: NDR_YES:<orderId> / NDR_NO:<orderId>. */
export function parseNdrButtons(payload) {
  const out = [];
  for (const e of payload.entry || []) for (const c of e.changes || []) for (const m of c.value?.messages || []) {
    const p = m.button?.payload || m.interactive?.button_reply?.id || '';
    const x = /^NDR_(YES|NO):(\d{1,25})$/.exec(p);
    if (x) out.push({ yes: x[1] === 'YES', orderId: x[2], from: String(m.from || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '') });
  }
  return out;
}
