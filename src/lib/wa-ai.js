// src/lib/wa-ai.js — the WhatsApp assistant: answers a customer's plain-text message on the store number.
//
// Every inbound message already lands in processInbound (lib/wa-g4w.js). Button taps and known words (yes / cancel /
// re-attempt / return / address replies) are handled by their own flows; anything else used to be dropped. Now it
// goes to Claude with:
//   * the store knowledge written in Settings (what the tattoos are, how to apply, how long they last, delivery,
//     COD, Buy 1 Get 1, returns...),
//   * that customer's own orders from this database (status, confirmed?, shipped?, courier, AWB, where the parcel is,
//     expected date) so "where is my order" gets a real answer,
//   * the last few messages exchanged with that number, for continuity.
// The reply goes back as a free-text WhatsApp message (allowed: the customer wrote first, which opens the 24h window).
//
// Guard rails: it only talks about Ink Kulture and the customer's own orders, never promises refunds, discounts or
// dates it was not given, and ends with [HANDOFF] when a person should take over (complaints, refunds, anything it
// cannot see). A handoff is logged so the WhatsApp tab shows it, and the customer is told the team will reply.
// At most AI_DAILY_CAP replies per phone per day. Off until an API key is saved and the switch is on.

import { sendText, logMsg } from './whatsapp.js';
import { STAGES, LABEL as STAGE_LABEL } from './ship-status.js';

const now = () => Math.floor(Date.now() / 1000);
const AI_DAILY_CAP = 25;
const API = 'https://api.anthropic.com/v1/messages';

export const DEFAULT_KNOWLEDGE = `Ink Kulture sells semi-permanent tattoos (temporary tattoo transfers) in India, at inkkulture.in.
- The tattoo is a transfer sheet: clean and dry the skin, place the tattoo face down, press a wet cloth on the backing paper for about 30 seconds, then peel the paper off slowly. Let it dry for a few minutes. Full instructions come with every order.
- It lasts up to 2 weeks depending on placement, skin type and how much it is rubbed or washed. Avoid oil, scrubbing and soap directly on it to make it last longer. To remove early, rub gently with baby oil or coconut oil, or exfoliate.
- It is waterproof once dry: showering and swimming are fine. Pat dry, do not rub.
- The ink is skin-safe. Patch-test on a small area first if your skin is sensitive. Not for broken or irritated skin.
- Sizes: small designs 5.5 x 5.5 cm (from Rs 399), forearm designs 8 x 13 cm (from Rs 499), arm bands, and large pieces 11 x 18 cm and up (Rs 699 to 1199).
- Offer: Buy 1 Get 1 Free on every design. The lower-priced one in each pair is free automatically at checkout, no code needed.
- Shipping: free above Rs 499, otherwise a small charge. Orders are dispatched within 1 to 2 working days from Navi Mumbai and usually deliver in 3 to 7 working days across India, up to 10 for remote pin codes.
- Payment: UPI, cards and Cash on Delivery. COD orders are confirmed on WhatsApp first; unconfirmed COD orders are not shipped.
- Tracking: the customer gets the courier and tracking link on WhatsApp when the parcel is picked up.
- Returns: as these are hygiene products they cannot be returned once opened. A damaged or wrong item is replaced; the customer should send a photo on this number within 48 hours of delivery.
- Support hours: 10 am to 7 pm IST, Monday to Saturday. Outside these hours a person replies the next working day.`;

const SYSTEM = (knowledge, orders) => `You are the WhatsApp assistant for Ink Kulture, an Indian semi-permanent tattoo brand. You reply to customers on the store's WhatsApp number.

Rules:
- Be warm, short and plain: WhatsApp style, 1 to 4 short sentences, no headings, no markdown, no emojis unless the customer uses them. Reply in the language the customer wrote in (English, Hindi, or Hinglish in Latin script).
- Answer only from the STORE KNOWLEDGE and the CUSTOMER'S ORDERS below. If the answer is not there, say you are not sure and that the team will reply, and end your message with the exact token [HANDOFF].
- Never invent prices, delivery dates, discounts, refunds or policies. Never promise a refund, replacement, cancellation or a specific date: say the team will confirm and end with [HANDOFF].
- For a complaint, a damaged or wrong item, a refund or payment problem, anything angry, or a request to talk to a person: acknowledge briefly, say a team member will reply here, and end with [HANDOFF].
- For "where is my order" use the CUSTOMER'S ORDERS: name the order, its status and the expected date if one is given, and the tracking link if there is one. If there are no orders for this number, say you cannot see an order on this number and ask for the order number, then end with [HANDOFF].
- To confirm or cancel a COD order the customer can reply YES or CANCEL; after a failed delivery they can reply RE-ATTEMPT or RETURN. Mention these only when relevant.
- Do not discuss anything unrelated to Ink Kulture.

STORE KNOWLEDGE:
${knowledge}

CUSTOMER'S ORDERS (newest first; this is live data from the store):
${orders || 'None found for this phone number.'}`;

/** The customer's recent orders with shipping state, as plain lines for the prompt. */
export async function customerOrders(env, phone) {
  const rows = (await env.DB.prepare(`SELECT o.order_id, o.order_name, o.status, o.method, o.total_paise, o.confirmed_at, o.shipped_at, o.tracking, o.created_at, o.contents_json,
      s.awb, s.courier, s.stage, s.edd, s.status AS ship_status, s.ndr_choice
      FROM orders o LEFT JOIN shipments s ON s.order_id = o.order_id AND COALESCE(s.status,'')<>'cancelled'
      WHERE o.phone=? AND o.created_at>? AND o.status NOT IN ('pending_payment','failed','completing') ORDER BY o.created_at DESC LIMIT 4`).bind(String(phone), now() - 60 * 86400).all()).results;
  const day = (t) => t ? new Date(Number(t) * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
  return rows.map((r) => {
    let items = ''; try { items = JSON.parse(r.contents_json || '[]').map((c) => `${c.title || c.sku || 'item'} x${c.quantity || 1}`).join(', ').slice(0, 160); } catch { items = ''; }
    let state;
    if (r.status === 'cancelled') state = 'cancelled';
    else if (r.awb && r.stage && STAGES.includes(r.stage)) state = `shipped with ${r.courier || 'our courier'}, AWB ${r.awb}: ${STAGE_LABEL[r.stage] || r.stage}${r.edd && ['transit', 'ofd', 'ndr'].includes(r.stage) ? `, expected ${r.edd}` : ''}${r.stage === 'ndr' ? (r.ndr_choice ? ` (customer chose ${r.ndr_choice})` : ' (delivery attempt failed; customer can reply RE-ATTEMPT or RETURN)') : ''}, tracking https://shiprocket.co/tracking/${r.awb}`;
    else if (r.shipped_at) state = `shipped${r.tracking ? ' (' + r.tracking + ')' : ''}`;
    else if (r.method === 'cod' && !r.confirmed_at) state = 'placed, COD not yet confirmed by the customer (they can reply YES to confirm); not shipped yet';
    else state = 'confirmed, being packed, not shipped yet (dispatch within 1 to 2 working days)';
    return `- Order ${r.order_name} placed ${day(r.created_at)}, ${r.method === 'cod' ? 'Cash on Delivery' : 'prepaid'}, Rs ${Math.round(Number(r.total_paise || 0) / 100)}${items ? ', items: ' + items : ''}. Status: ${state}.`;
  }).join('\n');
}

/** The last few messages with this number (both directions), oldest first, for continuity. */
async function recentThread(env, phone, limit = 8) {
  const rows = (await env.DB.prepare(`SELECT direction, trigger, preview, ts FROM messages WHERE phone=? AND preview<>'' AND ts>? ORDER BY ts DESC LIMIT ${limit}`).bind(String(phone), now() - 3 * 86400).all()).results;
  return rows.reverse().filter((r) => r.direction === 'in' ? /^(reply|ai)$/.test(r.trigger) : r.trigger === 'ai').map((r) => ({ role: r.direction === 'in' ? 'user' : 'assistant', content: String(r.preview).slice(0, 600) }));
}

export const aiCfg = (env) => ({ ...(env.SETTINGS?.ai || {}), key: env.SETTINGS?.ai?.key || env.ANTHROPIC_API_KEY || '' });
export const aiOn = (env) => { const c = aiCfg(env); return !!(c.enabled && c.key); };

/** Ask Claude. Returns { text, handoff }. Throws on API trouble. */
export async function aiAnswer(env, { phone, text, thread = [] }) {
  const c = aiCfg(env);
  const orders = phone ? await customerOrders(env, phone).catch(() => '') : '';
  const msgs = [...thread.filter((m) => m.content), { role: 'user', content: String(text).slice(0, 1500) }];
  /* the API wants alternating roles: merge neighbours of the same role */
  const merged = [];
  for (const m of msgs) { const last = merged[merged.length - 1]; if (last && last.role === m.role) last.content += '\n' + m.content; else merged.push({ ...m }); }
  if (merged[0].role !== 'user') merged.shift();
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: c.model || 'claude-haiku-5-5', max_tokens: 350, temperature: 0.3, system: SYSTEM(c.knowledge || DEFAULT_KNOWLEDGE, orders), messages: merged }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Claude API ' + r.status + ': ' + (j.error?.message || JSON.stringify(j).slice(0, 200)));
  let out = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const handoff = /\[HANDOFF\]/.test(out);
  out = out.replace(/\s*\[HANDOFF\]\s*/g, ' ').replace(/\s+$/, '').trim();
  if (!out) out = 'Thanks for your message. A team member will reply here shortly.';
  return { text: out, handoff, usage: j.usage || null };
}

/** Handle one inbound plain-text message. Returns 'replied' | 'handoff' | 'off' | 'capped' | 'failed'. */
export async function aiReply(env, phone, text) {
  if (!aiOn(env)) return 'off';
  const t = String(text || '').trim();
  if (!t || t.length < 2) return 'off';
  const n = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE phone=? AND trigger='ai' AND direction='out' AND ts>?").bind(String(phone), now() - 86400).first())?.n) || 0;
  if (n >= AI_DAILY_CAP) { await logMsg(env, { direction: 'out', phone, trigger: 'ai', status: 'capped', preview: '' }); return 'capped'; }
  let a;
  try { a = await aiAnswer(env, { phone, text: t, thread: await recentThread(env, phone).catch(() => []) }); }
  catch (e) {
    await logMsg(env, { direction: 'out', phone, trigger: 'ai', status: 'failed', error: String(e.message || e), preview: '' });
    return 'failed';
  }
  await sendText(env, '91' + phone, a.text);
  await logMsg(env, { direction: 'out', phone, trigger: 'ai', template: a.handoff ? 'handoff' : 'answer', status: a.handoff ? 'handoff' : 'sent', preview: a.text });
  if (a.handoff && env.SETTINGS?.wa?.admin_phone) {
    try { await sendText(env, '91' + String(env.SETTINGS.wa.admin_phone).replace(/\D/g, '').slice(-10), `Customer +91 ${phone} needs a reply (assistant handed off).\nThey wrote: "${t.slice(0, 300)}"\nAssistant said: "${a.text.slice(0, 300)}"`); } catch { /* best effort */ }
  }
  return a.handoff ? 'handoff' : 'replied';
}
