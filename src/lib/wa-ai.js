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

const SYSTEM = (knowledge, orders, note = '') => `You are the WhatsApp assistant for Ink Kulture, an Indian semi-permanent tattoo brand. You reply to customers on the store's WhatsApp number.

Rules:
- Be warm, short and plain: WhatsApp style, 1 to 4 short sentences, no headings, no markdown, no emojis unless the customer uses them. Reply in the language the customer wrote in (English, Hindi, or Hinglish in Latin script).
- Answer only from the STORE KNOWLEDGE and the CUSTOMER'S ORDERS below. If the answer is not there, say you are not sure and that the team will reply, and end your message with the exact token [HANDOFF].
- Never invent prices, delivery dates, discounts, refunds or policies. Never promise a refund, replacement, cancellation or a specific date: say the team will confirm and end with [HANDOFF].
- For a complaint, a damaged or wrong item, a refund or payment problem, anything angry, or a request to talk to a person: acknowledge briefly, say a team member will reply here, and end with [HANDOFF].
- For "where is my order" use the CUSTOMER'S ORDERS: name the order, its status and the expected date if one is given, where the parcel was last scanned if that is given, and the tracking link if there is one. If there are no orders for this number, say you cannot see an order on this number and ask for the order number, then end with [HANDOFF].
- To confirm or cancel a COD order the customer can reply YES or CANCEL; after a failed delivery they can reply RE-ATTEMPT or RETURN. Mention these only when relevant.
- Do not discuss anything unrelated to Ink Kulture.

STORE KNOWLEDGE:
${knowledge}

CUSTOMER'S ORDERS (newest first; this is live data from the store):
${orders || 'None found for this phone number.'}${note ? '\n\nNOTE: ' + note : ''}`;

const day = (t) => t ? new Date(Number(t) * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
const ACTIVE = ['pickup_pending', 'pickup_failed', 'transit', 'ofd', 'ndr'];

/** Latest courier scans for one AWB, newest first: "16 Oct 14:20 · In Transit - Reached hub · Bhiwandi". Never throws. */
async function liveScans(env, awb, n = 3) {
  try {
    const { sr } = await import('./shiprocket.js');
    const { summarize } = await import('./sr-scan.js');
    const sum = summarize(await Promise.race([sr(env, 'GET', `courier/track/awb/${encodeURIComponent(awb)}`), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 6000))]));
    return { scans: sum.scans.slice(0, n).map((x) => `${x.at.slice(5, 16).replace(/^(\d\d)-(\d\d)/, (m, mo, d) => `${d}/${mo}`)} · ${x.text}${x.location ? ' · ' + x.location : ''}`), edd: sum.edd, current: sum.current };
  } catch { return null; }
}

function orderLine(r, live) {
  let items = ''; try { items = JSON.parse(r.contents_json || '[]').map((c) => `${c.title || c.sku || 'item'} x${c.quantity || 1}`).join(', ').slice(0, 160); } catch { items = ''; }
  let state;
  if (r.status === 'cancelled') state = 'cancelled';
  else if (r.awb && r.stage && STAGES.includes(r.stage)) {
    const edd = (live && live.edd) || r.edd;
    state = `shipped with ${r.courier || 'our courier'}, AWB ${r.awb}: ${STAGE_LABEL[r.stage] || r.stage}`
      + (r.stage === 'delivered' && r.delivered_at ? ` on ${day(r.delivered_at)}` : '')
      + (edd && ['transit', 'ofd', 'ndr'].includes(r.stage) ? `, expected ${edd}` : '')
      + (r.stage === 'ndr' ? (r.ndr_choice ? ` (customer chose ${r.ndr_choice}${r.ndr_date ? ' on ' + r.ndr_date : ''})` : ' (delivery attempt failed; customer can reply RE-ATTEMPT or RETURN)') : '')
      + (r.stage === 'pickup_pending' || r.stage === 'pickup_failed' ? ' (packed and waiting for the courier to collect it)' : '')
      + `, tracking https://shiprocket.co/tracking/${r.awb}`
      + (live && live.scans.length ? `. Latest courier scans: ${live.scans.join(' | ')}` : '');
  } else if (r.shipped_at) state = `shipped${r.tracking ? ' (' + r.tracking + ')' : ''}`;
  else if (r.method === 'cod' && !r.confirmed_at) state = 'placed, COD not yet confirmed by the customer (they can reply YES to confirm); not shipped yet';
  else state = 'confirmed, being packed, not shipped yet (dispatch within 1 to 2 working days)';
  return `- Order ${r.order_name} placed ${day(r.created_at)}, ${r.method === 'cod' ? 'Cash on Delivery' : 'prepaid'}, Rs ${Math.round(Number(r.total_paise || 0) / 100)}${items ? ', items: ' + items : ''}. Status: ${state}.`;
}

const ORDER_SQL = `SELECT o.order_id, o.order_name, o.phone, o.status, o.method, o.total_paise, o.confirmed_at, o.shipped_at, o.tracking, o.created_at, o.contents_json, o.converted_at, o.advance_paise,
    s.awb, s.courier, s.stage, s.edd, s.delivered_at, s.status AS ship_status, s.ndr_choice, s.ndr_date
    FROM orders o LEFT JOIN shipments s ON s.order_id = o.order_id AND COALESCE(s.status,'')<>'cancelled'`;

/** Orders Shopify has for this phone when this database has none (placed outside the IK checkout). */
async function shopifyOrders(env, phone) {
  try {
    const { gql } = await import('./shopify.orig.js');
    const d = await gql(env, `query($q:String){ customers(first:1, query:$q){ nodes{ orders(first:3, reverse:true){ nodes{ name createdAt cancelledAt displayFulfillmentStatus displayFinancialStatus
      totalPriceSet{shopMoney{amount}} fulfillments(first:2){ status trackingInfo{ number company url } } } } } } }`, { q: `phone:+91${phone}` });
    const os = d.customers?.nodes?.[0]?.orders?.nodes || [];
    return os.map((o) => { const f = (o.fulfillments || []).find((x) => x.status === 'SUCCESS'); const t = f?.trackingInfo?.[0];
      return `- Order ${o.name} placed ${day(Date.parse(o.createdAt) / 1000)}, Rs ${Math.round(Number(o.totalPriceSet?.shopMoney?.amount || 0))}, ${String(o.displayFinancialStatus || '').toLowerCase().replace(/_/g, ' ')}. Status: ${o.cancelledAt ? 'cancelled' : f ? `shipped${t ? ` with ${t.company || 'courier'}, tracking ${t.number}${t.url ? ' ' + t.url : ''}` : ''}` : 'not shipped yet'}.`; }).join('\n');
  } catch { return ''; }
}

/**
 * Everything the assistant may say about this customer's orders, newest first: this database (180 days), live courier
 * scans for parcels on the way, an order number they quote (only when it is theirs), else Shopify by phone.
 */
export async function customerOrders(env, phone, text = '') {
  const rows = (await env.DB.prepare(`${ORDER_SQL} WHERE o.phone=? AND o.created_at>? AND o.status NOT IN ('pending_payment','failed','completing') ORDER BY o.created_at DESC LIMIT 5`).bind(String(phone), now() - 180 * 86400).all()).results;
  const lines = [];
  let lookups = 0;
  for (const r of rows) {
    const live = r.awb && ACTIVE.includes(r.stage) && lookups < 2 ? (lookups++, await liveScans(env, r.awb)) : null;
    lines.push(orderLine(r, live));
    /* a COD order not booked yet can still be paid online with the prepaid discount: give the assistant the link */
    if (r.method === 'cod' && !r.converted_at && !(Number(r.advance_paise) > 0) && !r.awb && !r.shipped_at && r.status === 'placed') {
      try { const { storePayLink, discountPct } = await import('./wa-convert.js'); const l = await storePayLink(env, r.order_id); if (l) lines.push(`  If the customer wants to pay online instead of cash: they can pay for ${r.order_name} at ${l} and get ${discountPct(env)}% off (only until it ships).`); } catch { /* no link */ }
    }
  }
  /* an order number in the message that is not in the list above */
  const asked = [...String(text).matchAll(/#?\b(\d{4,5})\b/g)].map((m) => '#' + m[1]).filter((n) => !rows.some((r) => r.order_name === n)).slice(0, 2);
  for (const name of asked) {
    const o = await env.DB.prepare(`${ORDER_SQL} WHERE o.order_name=?`).bind(name).first().catch(() => null);
    if (!o) continue;
    if (String(o.phone) === String(phone)) lines.push(orderLine(o, o.awb && ACTIVE.includes(o.stage) ? await liveScans(env, o.awb) : null));
    else lines.push(`- Order ${name} exists but is registered to a different phone number. For privacy do not share anything about it: ask the customer to message from the number used on that order, and end with [HANDOFF].`);
  }
  if (!lines.length) { const sh = await shopifyOrders(env, phone); if (sh) lines.push(sh); }
  return lines.join('\n');
}

const routeOf = (wamid) => { const m = /^in:(g4w|meta)(?::(.+))?$/.exec(String(wamid || '')); return m ? { via: m[1], phoneId: m[2] || '' } : null; };
const PLAIN_IN = "direction='in' AND trigger='reply' AND COALESCE(template,'')=''";

/**
 * The conversation with one phone, split in two: history (oldest first, up to and including our last answer) and the
 * plain-text messages that came in after it and still need an answer.
 */
async function conversation(env, phone) {
  const rows = (await env.DB.prepare(`SELECT id, direction, trigger, template, status, preview, ts, wamid FROM messages WHERE phone=? AND ts>? AND preview<>'' ORDER BY id DESC LIMIT 16`).bind(String(phone), now() - 3 * 86400).all()).results.reverse();
  const isAnswer = (r) => r.direction === 'out' && /^(ai|agent)$/.test(r.trigger) && !/^(failed|capped|queued|expired)$/.test(r.status || '');
  let cut = -1; rows.forEach((r, i) => { if (isAnswer(r)) cut = i; });
  const pending = rows.slice(cut + 1).filter((r) => r.direction === 'in' && r.trigger === 'reply' && !r.template);
  const history = rows.slice(0, cut + 1).filter((r) => (r.direction === 'in' && r.trigger === 'reply') || isAnswer(r)).map((r) => ({ role: r.direction === 'in' ? 'user' : 'assistant', content: String(r.preview).slice(0, 600) }));
  const lastIn = [...rows].reverse().find((r) => r.direction === 'in');
  return { history, pending, route: routeOf(lastIn?.wamid) };
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

export async function callModel(c, P, system, merged) {
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

export async function aiAnswer(env, { phone, text, thread = [], note = '' }) {
  const c = aiCfg(env);
  const orders = phone ? await customerOrders(env, phone, text).catch(() => '') : '';
  const msgs = [...thread.filter((m) => m.content), { role: 'user', content: String(text).slice(0, 1500) }];
  /* the API wants alternating roles: merge neighbours of the same role */
  const merged = [];
  for (const m of msgs) { const last = merged[merged.length - 1]; if (last && last.role === m.role) last.content += '\n' + m.content; else merged.push({ ...m }); }
  if (merged[0].role !== 'user') merged.shift();
  const P = PROVIDERS[c.provider], system = SYSTEM(c.knowledge || DEFAULT_KNOWLEDGE, orders, note);
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
  if (!r.ok) { const e = new Error(`${P.label.split(' (')[0]} ${r.status}${r.status === 429 ? ' (free limit reached for now)' : ''}: ` + (j.error?.message || j.message || JSON.stringify(j).slice(0, 200))); e.status = r.status; throw e; }
  out = String(out || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim();
  const handoff = /\[HANDOFF\]/.test(out);
  out = out.replace(/\s*\[HANDOFF\]\s*/g, ' ').replace(/\s+$/, '').trim();
  if (!out) out = 'Thanks for your message. A team member will reply here shortly.';
  return { text: out, handoff, usage: j.usage || null, model: switched || c.model, switched };
}

/* ---------------- rate limits, queue, answering ---------------- */

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const limits = (env) => { const a = env.SETTINGS?.ai || {}; return { rpm: Math.max(1, Number(a.rpm) || 20), rpd: Math.max(1, Number(a.rpd) || 800) }; };
const WINDOW = 23 * 3600;   // free text is only delivered within 24h of the customer's last message; keep an hour spare

/** Model calls left right now: { minute, day } (counts every answer attempt that reached the model). */
export async function budget(env) {
  const q = (since) => env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction='out' AND trigger='ai' AND status NOT IN ('queued','capped','expired','merged') AND ts>?`).bind(now() - since).first();
  const [m, d] = await Promise.all([q(60), q(86400)]);
  const L = limits(env);
  return { minute: L.rpm - (Number(m?.n) || 0), day: L.rpd - (Number(d?.n) || 0), ...L };
}

/** Put this phone in line for an answer (one entry per phone; the answer covers all its unanswered messages). */
export async function enqueue(env, phone, route, why = '') {
  await env.DB.prepare(`INSERT INTO ai_queue (phone, via, phone_id, queued_at, tries, note) VALUES (?,?,?,?,0,?)
    ON CONFLICT (phone) DO UPDATE SET via=COALESCE(EXCLUDED.via, ai_queue.via), phone_id=COALESCE(EXCLUDED.phone_id, ai_queue.phone_id), note=EXCLUDED.note`)
    .bind(String(phone), route?.via || null, route?.phoneId || null, now(), String(why).slice(0, 200)).run();
}

const withRoute = (env, route) => route ? Object.assign(Object.create(null), env, { REPLY_ROUTE: route }) : env;

/**
 * Answer everything this phone has said since our last answer, in one message. Returns
 * 'replied' | 'handoff' | 'nothing' | 'expired' | 'capped' | 'limited' | 'failed'.
 * A reply that Meta refuses as "re-engagement" (131047) is retried once through the other channel.
 */
export async function answerPhone(env0, phone, { route = null } = {}) {
  /* a person is handling this chat in the dashboard (Chats tab): stay quiet */
  try { const { aiPaused } = await import('./inbox.js'); if (await aiPaused(env0, phone)) return 'paused'; } catch { /* table not there yet: answer */ }
  const conv = await conversation(env0, phone);
  if (!conv.pending.length) return 'nothing';
  const last = conv.pending[conv.pending.length - 1];
  if (last.ts < now() - WINDOW) { await logMsg(env0, { direction: 'out', phone, trigger: 'ai', status: 'expired', error: 'more than 23 hours since the customer wrote: WhatsApp will not deliver free text', preview: '' }); return 'expired'; }
  const n = Number((await env0.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE phone=? AND trigger='ai' AND direction='out' AND status NOT IN ('queued','expired','merged') AND ts>?").bind(String(phone), now() - 86400).first())?.n) || 0;
  if (n >= AI_DAILY_CAP) { await logMsg(env0, { direction: 'out', phone, trigger: 'ai', status: 'capped', preview: '' }); return 'capped'; }
  const b = await budget(env0);
  if (b.minute <= 0 || b.day <= 0) return 'limited';
  const r0 = route || conv.route;
  const env = withRoute(env0, r0);
  const text = conv.pending.map((m) => m.preview).join('\n');
  const waited = now() - conv.pending[0].ts;
  const note = waited > 30 * 60 ? `The customer wrote ${waited > 7200 ? Math.round(waited / 3600) + ' hours' : Math.round(waited / 60) + ' minutes'} ago and is only being answered now: begin with a short apology for the late reply.` : '';
  let a;
  try { a = await aiAnswer(env, { phone, text, thread: conv.history, note }); }
  catch (e) {
    if (e.status === 429) return 'limited';
    await logMsg(env, { direction: 'out', phone, trigger: 'ai', status: 'failed', error: String(e.message || e), preview: '' });
    return 'failed';
  }
  let res = await sendText(env, '91' + phone, a.text);
  let used = r0;
  if (!res.ok && /131047|re-engagement/i.test(res.error || '')) {
    /* the customer wrote to the other channel: try it once */
    const alt = (r0?.via || (env0.SETTINGS?.wa?.transport === 'g4w' ? 'g4w' : 'meta')) === 'g4w' ? { via: 'meta', phoneId: '' } : (env0.G4W_API_KEY && env0.G4W_SECURE_KEY ? { via: 'g4w', phoneId: '' } : null);
    if (alt) { const r2 = await sendText(withRoute(env0, alt), '91' + phone, a.text); if (r2.ok) { res = r2; used = alt; } }
  }
  await logMsg(env, { direction: 'out', phone, trigger: 'ai', template: a.handoff ? 'handoff' : 'answer', status: !res.ok ? 'failed' : a.handoff ? 'handoff' : 'accepted', wamid: res.id || '', error: res.ok ? '' : `${res.via}${used?.phoneId ? ' ' + used.phoneId : ''}: ${res.error}`, preview: a.text });
  if (!res.ok) return 'failed';
  if (a.handoff) {
    try { const { openHandoff } = await import('./inbox.js'); await openHandoff(env0, phone, text.slice(0, 200)); } catch (e) { console.error('handoff', e.message); }
  }
  if (a.handoff && env0.SETTINGS?.wa?.admin_phone) {
    const link = env0.WORKER_URL ? `\nReply here: ${String(env0.WORKER_URL).replace(/\/$/, '')}/admin#chat=${phone}` : '';
    try { await sendText(env0, '91' + String(env0.SETTINGS.wa.admin_phone).replace(/\D/g, '').slice(-10), `Customer +91 ${phone} needs a reply (assistant handed off).\nThey wrote: "${text.slice(0, 300)}"\nAssistant said: "${a.text.slice(0, 300)}"${link}`); } catch { /* best effort */ }
  }
  return a.handoff ? 'handoff' : 'replied';
}

/**
 * A live inbound plain-text message. Waits a moment so a burst of messages ("hi" / "where is my order" / "#1571") gets
 * one answer: if a newer message from the same phone arrives meanwhile, that one answers for all of them.
 * Over the rate limit, the phone is queued and answered by the next drain (cron / dashboard).
 */
export async function aiReply(env, phone, text, { msgId = 0, waitMs = env.AI_WAIT_MS ?? 3500 } = {}) {
  if (!aiOn(env)) return 'off';
  if (String(text || '').trim().length < 2) return 'off';
  if (waitMs) await sleep(waitMs);
  if (msgId) {
    const newer = await env.DB.prepare(`SELECT id FROM messages WHERE phone=? AND ${PLAIN_IN} AND id>? LIMIT 1`).bind(String(phone), msgId).first().catch(() => null);
    if (newer) return 'merged';
  }
  const r = await answerPhone(env, phone, { route: env.REPLY_ROUTE || null });
  if (r === 'limited') { await enqueue(env, phone, env.REPLY_ROUTE || null, 'rate limit'); return 'queued'; }
  return r;
}

/** Answer queued phones, spaced to stay under the per-minute limit. Returns { done, remaining, results }. */
export async function drainQueue(env, { max = 6, gapMs = 2500 } = {}) {
  if (!aiOn(env)) return { done: 0, remaining: 0, results: [], off: true };
  await env.DB.prepare('DELETE FROM ai_queue WHERE queued_at<?').bind(now() - 2 * 86400).run().catch(() => {});
  const rows = (await env.DB.prepare('SELECT * FROM ai_queue ORDER BY queued_at LIMIT ?').bind(max).all()).results;
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const q = rows[i];
    if (i) await sleep(gapMs);
    const route = q.via ? { via: q.via, phoneId: q.phone_id || '' } : null;
    const r = await answerPhone(env, q.phone, { route });
    if (r === 'limited') { results.push({ phone: q.phone, result: r }); break; }
    if (r === 'failed' && Number(q.tries || 0) < 2) await env.DB.prepare('UPDATE ai_queue SET tries=tries+1 WHERE phone=?').bind(q.phone).run();
    else await env.DB.prepare('DELETE FROM ai_queue WHERE phone=?').bind(q.phone).run();
    results.push({ phone: q.phone, result: r });
  }
  const remaining = Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_queue').first())?.n) || 0;
  return { done: results.filter((x) => /replied|handoff/.test(x.result)).length, remaining, results };
}

/** Customers whose latest plain-text message (last 7 days) has no answer yet; in_window = can still get free text. */
export async function backlog(env) {
  const plain = (a) => `${a}.direction='in' AND ${a}.trigger='reply' AND COALESCE(${a}.template,'')=''`;
  const answered = `SELECT MAX(o.ts) FROM messages o WHERE o.phone=m.phone AND o.direction='out' AND o.trigger IN ('ai','agent') AND o.status NOT IN ('failed','capped','queued','expired')`;
  const rows = (await env.DB.prepare(`SELECT m.phone, MAX(m.ts) AS last_ts, COUNT(*) AS n,
      (SELECT x.preview FROM messages x WHERE x.phone=m.phone AND ${plain('x')} ORDER BY x.id DESC LIMIT 1) AS last_text
      FROM messages m WHERE ${plain('m')} AND m.ts>? AND m.ts > COALESCE((${answered}), 0)
      GROUP BY m.phone ORDER BY MAX(m.ts) DESC LIMIT 100`).bind(now() - 7 * 86400).all()).results;
  const queued = new Set((await env.DB.prepare('SELECT phone FROM ai_queue').all()).results.map((r) => String(r.phone)));
  const names = {};
  if (rows.length) for (const r of (await env.DB.prepare(`SELECT phone, first_name, last_name FROM orders WHERE phone IN (${rows.map(() => '?').join(',')}) ORDER BY created_at`).bind(...rows.map((r) => String(r.phone))).all()).results) names[r.phone] = `${r.first_name || ''} ${r.last_name || ''}`.trim();
  return rows.map((r) => ({ phone: String(r.phone), name: names[r.phone] || '', last_ts: Number(r.last_ts), count: Number(r.n), last_text: String(r.last_text || '').slice(0, 200), in_window: Number(r.last_ts) > now() - WINDOW, queued: queued.has(String(r.phone)) }));
}
