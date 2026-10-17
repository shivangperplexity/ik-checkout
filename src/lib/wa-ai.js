// src/lib/wa-ai.js — the WhatsApp assistant: answers a customer's plain-text message on the store number.
//
// Every inbound message already lands in processInbound (lib/wa-g4w.js). Button taps and known words (yes / cancel /
// re-attempt / return / address replies) are handled by their own flows; anything else used to be dropped. Now it
// goes to a language model (Groq's free tier by default; any provider in PROVIDERS) with:
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

/* Where the model runs. Groq, Cerebras, OpenRouter and Gemini have free tiers and speak the OpenAI chat format;
   Anthropic is the paid option. The model name is editable in the dashboard because free model lists change. */
export const PROVIDERS = {
  groq: { label: 'Groq (free tier, recommended)', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys', free: true },
  cerebras: { label: 'Cerebras (free tier)', url: 'https://api.cerebras.ai/v1/chat/completions', model: 'llama-3.3-70b', keyUrl: 'https://cloud.cerebras.ai', free: true },
  openrouter: { label: 'OpenRouter (free models)', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'meta-llama/llama-3.3-70b-instruct:free', keyUrl: 'https://openrouter.ai/keys', free: true },
  gemini: { label: 'Google Gemini (free tier; prompts may be used for training)', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey', free: true },
  anthropic: { label: 'Anthropic Claude (paid)', url: 'https://api.anthropic.com/v1/messages', model: 'claude-haiku-5-5', keyUrl: 'https://console.anthropic.com', free: false },
};

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

export const aiCfg = (env) => {
  const a = env.SETTINGS?.ai || {};
  const provider = PROVIDERS[a.provider] ? a.provider : 'groq';
  const envKey = { groq: env.GROQ_API_KEY, cerebras: env.CEREBRAS_API_KEY, openrouter: env.OPENROUTER_API_KEY, gemini: env.GEMINI_API_KEY, anthropic: env.ANTHROPIC_API_KEY }[provider];
  return { ...a, provider, key: a.key || envKey || '', model: a.model && a.provider === provider ? a.model : PROVIDERS[provider].model };
};
export const aiOn = (env) => { const c = aiCfg(env); return !!(c.enabled && c.key); };

/** Ask Claude. Returns { text, handoff }. Throws on API trouble. */
/** Models this key can use, from the provider's own list (chat models only). */
export async function listModels(env) {
  const c = aiCfg(env), P = PROVIDERS[c.provider];
  if (!c.key) throw new Error('No API key saved yet');
  const url = P.url.replace(/\/(chat\/completions|messages)$/, '/models');
  const r = await fetch(url, { headers: c.provider === 'anthropic' ? { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' } : { Authorization: 'Bearer ' + c.key } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${P.label.split(' (')[0]} ${r.status}: ` + (j.error?.message || j.message || 'could not list models'));
  const rows = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
  return rows.filter((m) => m && m.active !== false).map((m) => String(m.id || m.name || '').replace(/^models\//, ''))
    .filter((id) => id && !/whisper|tts|orpheus|guard|safeguard|embed|vision-only|transcri|speech|audio|image|moderation|rerank/i.test(id))
    .filter((id) => c.provider !== 'openrouter' || /:free$/.test(id));
}

/** Best model from a list for this job: a capable general chat model, larger first. */
export function pickModel(ids, provider = 'groq') {
  const rank = [/llama-3\.3-70b/i, /gpt-oss-120b/i, /llama-4.*maverick/i, /qwen.*(3[0-9]b|32b|27b|72b)/i, /llama-4.*scout/i, /gemini-[0-9.]+-flash(?!-lite)/i, /haiku/i, /mistral-(small|medium)/i, /gpt-oss-20b/i, /70b/i, /llama/i];
  for (const re of rank) { const hit = ids.find((id) => re.test(id)); if (hit) return hit; }
  return ids[0] || PROVIDERS[provider]?.model || '';
}

const MODEL_GONE = /model.*(does not exist|not found|not exist|decommission|deprecat|no access|do not have access|unsupported|invalid model)|model_not_found|unknown model/i;

async function callModel(c, P, system, merged) {
  let r, j, out;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
  try {
    if (c.provider === 'anthropic') {
      r = await fetch(P.url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: c.model, max_tokens: 350, temperature: 0.3, system, messages: merged }) });
      j = await r.json().catch(() => ({}));
      out = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    } else {
      r = await fetch(P.url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key, ...(c.provider === 'openrouter' ? { 'HTTP-Referer': 'https://www.inkkulture.in', 'X-Title': 'Ink Kulture WhatsApp' } : {}) },
        body: JSON.stringify({ model: c.model, max_tokens: 600, temperature: 0.3, messages: [{ role: 'system', content: system }, ...merged] }) });
      j = await r.json().catch(() => ({}));
      out = j.choices?.[0]?.message?.content || '';
      if (j.usage) j.usage = { input_tokens: j.usage.prompt_tokens, output_tokens: j.usage.completion_tokens };
    }
  } finally { clearTimeout(timer); }
  return { r, j, out };
}

export async function aiAnswer(env, { phone, text, thread = [] }) {
  const c = aiCfg(env);
  const orders = phone ? await customerOrders(env, phone).catch(() => '') : '';
  const msgs = [...thread.filter((m) => m.content), { role: 'user', content: String(text).slice(0, 1500) }];
  /* the API wants alternating roles: merge neighbours of the same role */
  const merged = [];
  for (const m of msgs) { const last = merged[merged.length - 1]; if (last && last.role === m.role) last.content += '\n' + m.content; else merged.push({ ...m }); }
  if (merged[0].role !== 'user') merged.shift();
  const P = PROVIDERS[c.provider], system = SYSTEM(c.knowledge || DEFAULT_KNOWLEDGE, orders);
  let { r, j, out } = await callModel(c, P, system, merged);
  /* the model was retired or this key cannot use it: pick one from the key's own model list, remember it, try again */
  let switched = '';
  if (!r.ok && (r.status === 404 || r.status === 400 || r.status === 403) && MODEL_GONE.test(j.error?.message || j.message || '')) {
    try {
      const ids = await listModels(env);
      const next = pickModel(ids.filter((id) => id !== c.model), c.provider);
      if (next) {
        switched = next;
        ({ r, j, out } = await callModel({ ...c, model: next }, P, system, merged));
        if (r.ok && env.DB) { const { putSetting, getSettings } = await import('./settings.js'); const s = await getSettings(env, true); await putSetting(env, 'ai', { ...s.ai, model: next }); }
      }
    } catch (e) { console.error('ai model switch', e.message); }
  }
  if (!r.ok) throw new Error(`${P.label.split(' (')[0]} ${r.status}${r.status === 429 ? ' (free limit reached for now)' : ''}: ` + (j.error?.message || j.message || JSON.stringify(j).slice(0, 200)));
  out = String(out || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();
  const handoff = /\[HANDOFF\]/.test(out);
  out = out.replace(/\s*\[HANDOFF\]\s*/g, ' ').replace(/\s+$/, '').trim();
  if (!out) out = 'Thanks for your message. A team member will reply here shortly.';
  return { text: out, handoff, usage: j.usage || null, model: switched || c.model, switched };
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
  const res = await sendText(env, '91' + phone, a.text);
  await logMsg(env, { direction: 'out', phone, trigger: 'ai', template: a.handoff ? 'handoff' : 'answer', status: !res.ok ? 'failed' : a.handoff ? 'handoff' : 'accepted', wamid: res.id || '', error: res.ok ? '' : `${res.via}${env.REPLY_ROUTE?.phoneId ? ' ' + env.REPLY_ROUTE.phoneId : ''}: ${res.error}`, preview: a.text });
  if (!res.ok) return 'failed';
  if (a.handoff && env.SETTINGS?.wa?.admin_phone) {
    try { await sendText(env, '91' + String(env.SETTINGS.wa.admin_phone).replace(/\D/g, '').slice(-10), `Customer +91 ${phone} needs a reply (assistant handed off).\nThey wrote: "${t.slice(0, 300)}"\nAssistant said: "${a.text.slice(0, 300)}"`); } catch { /* best effort */ }
  }
  return a.handoff ? 'handoff' : 'replied';
}
