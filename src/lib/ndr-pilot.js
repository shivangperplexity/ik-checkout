/**
 * NDR autopilot: every failed delivery is handled on WhatsApp end to end, with nobody from the team in the loop.
 *
 * 1. Reading replies. While a parcel is in a failed-delivery episode, anything the customer writes (English, Hindi,
 *    Hinglish, any wording) is read here before the general assistant: "kal bhej do", "saturday ke baad",
 *    "call 98xxxxxxxx", a new address, "nobody came, I was home", "cancel kar do". A language model reads it when one is
 *    set up (Settings > WhatsApp assistant); a rule-based reader covers the rest and works without one. The result is
 *    acted on straight away: Shiprocket re-attempt (with the day / new address / other number / "call first" note), or
 *    the cancel path below.
 * 2. One save before a cancel. The first "cancel" / "don't want it" gets one honest reply that answers the reason
 *    (cash not ready -> pick a day; late -> it is already in your city; changed mind -> it is packed in your name and
 *    fades in ~2 weeks, no long commitment) with an easy YES. A second "cancel" is honoured at once: return to us,
 *    order tagged customer-refused.
 * 3. Follow-ups (cron, daytime IST only): a nudge with the design photo when the customer has not answered after
 *    `nudge_h` hours; when the rules book a re-attempt on their own, a "delivery booked again <day>, amount to pay"
 *    message that asks them to tap "Yes, I'll receive it" (a small commitment makes people far likelier to be there);
 *    before the courier's last allowed attempt, the final-attempt message says plainly that the parcel goes back and
 *    the order is cancelled if it fails again.
 * Nothing here invents offers, threats or dates: every line is true for that order.
 */
import { sendText, logMsg, fireTrigger, viaG4w } from './whatsapp.js';
import { customerNdr, ndrLink, ndrKey } from './wa-ndr.js';
import { ndrCfg, classifyNdr } from './ndr-rules.js';
import { codDue, cfg as partialCfg } from './partial-cod.js';

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
const WINDOW = 23 * 3600;   // free text reaches the customer only within 24 h of their last message

/* ---------------- dates (IST) ---------------- */

const istNow = (ms = Date.now()) => new Date(ms + 19800000);
/** YYYY-MM-DD in IST, `plus` days from today */
export const istDate = (plus = 0, ms = Date.now()) => { const d = istNow(ms); d.setUTCDate(d.getUTCDate() + plus); return d.toISOString().slice(0, 10); };
const wdOf = (iso) => new Date(iso + 'T06:00:00Z').getUTCDay();
const addDays = (iso, n) => { const d = new Date(iso + 'T06:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const nice = (iso) => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(iso + 'T06:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
export const whenText = (iso) => (iso ? 'on ' + nice(iso) : 'on the next working day');
/** Messages go out 9 am to 9 pm IST */
export const daytime = (t = now()) => { const h = istNow(t * 1000).getUTCHours(); return h >= 9 && h < 21; };

const MAX_AHEAD = 7;        // the courier holds a parcel about a week
const WD = [
  [/\b(sunday|ravivar|raviwar|itvar|itwar|etwar)\b/, 0], [/\b(monday|somvar|somwar)\b/, 1], [/\b(tuesday|tues|mangalvar|mangalwar|mangal)\b/, 2],
  [/\b(wednesday|wed|budhvar|budhwar|budh)\b/, 3], [/\b(thursday|thurs|guruvar|guruwar|brihaspativar|veervar)\b/, 4],
  [/\b(friday|fri|shukravar|shukrawar|shukra)\b/, 5], [/\b(saturday|sat|shanivar|shaniwar|shani)\b/, 6],
];
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A day named in the message, as YYYY-MM-DD (IST), never today or earlier, at most a week ahead, Sunday moved to
 * Monday. { date, clamped, sunday } or null.
 */
export function parseDay(text, ms = Date.now()) {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  const today = istDate(0, ms);
  let d = '';
  if (/\b(day after tomorrow|parso|parson|parsoo)\b/.test(t)) d = addDays(today, 2);
  else if (/\b(tomorrow|tmrw|tmr|tommorow|tomorow|tommorrow|kal|kl)\b/.test(t) && !/\b(yesterday|tha|thi|the|aaya|aya|aayi|aai|came|gaya|gayi)\b/.test(t)) d = addDays(today, 1);
  if (!d) {
    for (const [re, wd] of WD) if (re.test(t)) { const diff = (wd - wdOf(today) + 7) % 7 || 7; d = addDays(today, diff); break; }
  }
  if (!d) {
    const y = Number(today.slice(0, 4));
    let m = /\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/.exec(t) || null;
    let dd = 0, mm = 0;
    if (m) { dd = +m[1]; mm = MON.indexOf(m[2]) + 1; }
    else if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(t))) { dd = +m[2]; mm = MON.indexOf(m[1]) + 1; }
    else if ((m = /(?<![\d₹.])(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?(?![\d])/.exec(t))) { dd = +m[1]; mm = +m[2]; }
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      let iso = `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      if (iso < today) iso = `${y + 1}-${iso.slice(5)}`;
      d = iso;
    }
  }
  if (!d || d <= today) return null;
  let clamped = false, sunday = false;
  const max = addDays(today, MAX_AHEAD);
  if (d > max) { d = max; clamped = true; }
  if (wdOf(d) === 0) { d = addDays(d, 1); sunday = true; if (d > addDays(today, MAX_AHEAD + 1)) d = addDays(d, -2); }
  return { date: d, clamped, sunday };
}

/* ---------------- reading a reply ---------------- */

const RET = /\b((?:cancel|cancle|cancelled|return|returned|wapas|waapas|vapas)(?:\s+(?:kar|kr|bhej|le|karwa)\w*(?:\s+(?:do|de|dena|dijiye|lo|diya))?)?|send (it )?back|don'?t want|do not want|dont need|don'?t need|not interested|no need|nahi chahiye|nhi chahiye|nahi chaiye|nhi chaiye|nahin chahiye|mat bhej|mat bhejo|mat bhejna|refund|nahi lena|nhi lena|nahi leni|nhi leni|band karo|rehne do|rahne do)\b/i;
const YES = /\b(yes|yess|yeah|yep|haan|han|ha|haa|ji|ok|okay|okk|sure|deliver|delivery|bhej|bhejo|bhejdo|bhej do|send|receive|recieve|le lunga|le lungi|lunga|lungi|le lenge|chahiye|want it|available|reattempt|re-attempt|re attempt|again|dobara|phir se|fir se|kar do|kardo|aa jao|aajao|aana|aaiye|come)\b/i;
const FAKE = /(no ?one came|nobody came|nobody called|no one called|no ?body (came|called)|didn'?t (come|call|came)|did not (come|call)|never (came|called)|not came|no call|koi (nahi|nhi|nai) aaya|koi aaya hi nahi|aaya hi nahi|aya hi nahi|call (nahi|nhi|nai) (aaya|aya|kiya)|phone (nahi|nhi|nai) (aaya|aya|kiya)|i was (at )?home|was at home|ghar (pe|par|me|mein) (hi )?(tha|thi|the)|fake)/i;
const ADDR_OK = /\baddress\b.{0,25}\b(correct|sahi|same|right|theek|thik|wahi|ok|okay)\b/i;
const ADDR_KW = /\b(house|flat|h\.?\s?no|plot|road|rd|nagar|colony|sector|near|opp|opposite|behind|floor|building|bldg|apartment|apt|apts|society|soc|gali|lane|street|chowk|mohalla|ward|village|vill|post|tower|wing|block|landmark|marg|residency|enclave|vihar|bagh|puram|layout|cross|main|area|city|district|dist)\b/gi;

const phonesIn = (text) => [...String(text || '').matchAll(/(?:\+?91[\s-]*|\b0)?([6-9](?:[\s-]?\d){9})(?!\d)/g)].map((m) => m[1].replace(/\D/g, ''));

/** A new delivery address written in the message ('' when there is none). */
export function parseAddress(text) {
  let t = String(text || '').trim();
  if (t.length < 20 || ADDR_OK.test(t)) return '';
  const noPhones = t.replace(/(?:\+?91[\s-]*|\b0)?[6-9](?:[\s-]?\d){9}(?!\d)/g, ' ');
  const pin = /\b[1-9]\d{5}\b/.test(noPhones);
  const kw = (noPhones.match(ADDR_KW) || []).length;
  if (!(pin || (kw >= 2 && /\d/.test(noPhones)))) return '';
  t = noPhones.replace(/^\s*(?:my\s+)?(?:new\s+)?(?:address|addr|pata|mera\s+(?:naya\s+)?(?:address|pata))\s*(?:is|hai|:|-)?\s*/i, '').replace(/\s+/g, ' ').replace(/^[\s,:-]+|[\s,:-]+$/g, '');
  return t.slice(0, 200);
}
/** Shiprocket takes two address lines */
export function splitAddr(a) {
  a = String(a || '').trim();
  if (a.length <= 100) return [a, ''];
  const cut = a.lastIndexOf(',', 100);
  const i = cut > 30 ? cut : 100;
  return [a.slice(0, i).trim(), a.slice(i).replace(/^[\s,]+/, '').slice(0, 100).trim()];
}

function objectionOf(t) {
  if (/(cash|paise|paisa|money|amount|payment|pay nahi|no money|salary|upi)/i.test(t)) return 'cash';
  if (/(mistake|galti|someone else|kisi aur|maine order nahi|didn'?t order|did not order|not ordered|never ordered|wrong order|not mine)/i.test(t)) return 'wrong_order';
  if (/(late|der|delay|too long|bahut time|itna time|took so long|waited)/i.test(t)) return 'late';
  if (/(price|expensive|mehenga|mehnga|costly|cheaper|sasta)/i.test(t)) return 'price';
  return 'changed_mind';
}

/**
 * Rule-based reading of a reply. intent: deliver | return | unclear. Pure, so it is tested without a model.
 * { intent, date, clamped, sunday, phone, address, fake, objection }
 */
export function parseReply(text, { ownPhone = '', ms = Date.now() } = {}) {
  const t = String(text || '');
  const day = parseDay(t, ms);
  const phone = phonesIn(t).find((p) => p !== String(ownPhone)) || '';
  const address = parseAddress(t);
  const fake = FAKE.test(t);
  /* "don't cancel" / "cancel mat karna" is the opposite of a cancel */
  const NEG = /\b(don'?t|do not|dont|mat|na|never)\s+(cancel|cancle|return)\w*|\b(cancel|cancle|return)\w*\s+(mat|nahi|nhi|na|mt)\b/gi;
  const neg = NEG.test(t), t2 = t.replace(NEG, ' ');
  const ret = RET.test(t2), yes = YES.test(t2.replace(new RegExp(RET.source, 'gi'), ' ')) || neg;
  const detail = !!(day || phone || address || fake);
  const intent = ret ? (yes || detail ? 'unclear' : 'return') : yes || detail ? 'deliver' : 'unclear';
  return { intent, date: day?.date || '', clamped: !!day?.clamped, sunday: !!day?.sunday, phone, address, fake, objection: ret ? objectionOf(t2) : '' };
}

/** The model's reading, checked against the message so nothing it adds (a number, an address, a day) is invented. */
async function aiRead(env, ctx, text) {
  let W;
  try { W = await import('./wa-ai.js'); } catch { return null; }
  if (!W.aiOn(env)) return null;
  const c = W.aiCfg(env), P = W.PROVIDERS[c.provider];
  const today = istDate(0);
  const system = `You read one WhatsApp reply from a customer of Ink Kulture (India) whose parcel could not be delivered.
Today is ${today} (${new Date(today + 'T06:00:00Z').toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' })}). The courier's reason: "${String(ctx.ndr_reason || 'unknown').slice(0, 120)}". The customer's own phone: ${ctx.phone}.
Answer with ONLY one JSON object and nothing else:
{"intent":"deliver|return|question|other","date":"","phone":"","address":"","courier_no_show":false,"objection":""}
intent: deliver = they want the parcel (yes, a day, a time, a new address, another number, or they say the courier never came / never called); return = they clearly want to cancel or do not want it; question = they ask something; other = anything else.
date: YYYY-MM-DD only if they name a day (kal = tomorrow, parso = day after tomorrow, Hindi or English weekday names). Otherwise "".
phone: a 10-digit number written in the message for the courier to call, else "". address: the new delivery address exactly as written, else "". Never invent either.
courier_no_show: true if they say nobody came, nobody called, or they were at home.
objection (only for return): cash | changed_mind | late | price | wrong_order | other.`;
  try {
    const { r, out } = await W.callModel(c, P, system, [{ role: 'user', content: String(text).slice(0, 800) }]);
    if (!r.ok) return null;
    const m = /\{[\s\S]*\}/.exec(String(out || '').replace(/<think>[\s\S]*?<\/think>/g, ''));
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

/** Rules first, the model when the wording is unclear or carries details; the model's extras are verified. */
export async function readReply(env, ctx, text, ms = Date.now()) {
  const rx = parseReply(text, { ownPhone: ctx.phone, ms });
  const plain = String(text || '').trim();
  if (rx.intent !== 'unclear' && !rx.address && plain.length < 40) return { ...rx, by: 'rules' };
  const ai = await aiRead(env, ctx, plain);
  if (!ai) return { ...rx, by: 'rules' };
  const digits = plain.replace(/\D/g, '');
  const aPhone = String(ai.phone || '').replace(/\D/g, '').slice(-10);
  const okPhone = /^[6-9]\d{9}$/.test(aPhone) && digits.includes(aPhone) && aPhone !== String(ctx.phone) ? aPhone : '';
  const words = String(ai.address || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const okAddr = words.length >= 2 && words.filter((w) => plain.toLowerCase().includes(w)).length / words.length >= 0.7 ? String(ai.address).slice(0, 200) : '';
  let day = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(ai.date || '')) day = parseDay(`${Number(ai.date.slice(8))} ${MON[Number(ai.date.slice(5, 7)) - 1]}`, ms);
  const intent = ['deliver', 'return', 'question', 'other'].includes(ai.intent) ? ai.intent : rx.intent;
  return {
    intent, by: 'ai',
    date: rx.date || day?.date || '', clamped: rx.date ? rx.clamped : !!day?.clamped, sunday: rx.date ? rx.sunday : !!day?.sunday,
    phone: rx.phone || okPhone, address: rx.address || okAddr, fake: rx.fake || ai.courier_no_show === true,
    objection: intent === 'return' ? (['cash', 'changed_mind', 'late', 'price', 'wrong_order'].includes(ai.objection) ? ai.objection : rx.objection || objectionOf(plain)) : '',
  };
}

/* ---------------- the order in a failed-delivery episode ---------------- */

const CTX_SQL = `SELECT s.awb, s.order_id, s.order_name, s.stage, s.ndr_reason, s.ndr_choice, s.ndr_choice_at, s.ndr_by, s.ndr_date, s.ndr_asked_at,
    s.ndr_save_at, s.ndr_commit_at, s.ndr_fake, s.created_at AS booked_at, o.phone, o.first_name, o.method, o.total_paise, o.advance_paise, o.converted_at,
    o.status AS order_status, o.contents_json
  FROM shipments s JOIN orders o ON o.order_id = s.order_id`;

/** The parcel this phone (or order) has in a failed-delivery episode right now, with its latest NDR row; or null. */
export async function ndrContext(env, { phone = '', orderId = '' }) {
  const rows = (await env.DB.prepare(`${CTX_SQL} WHERE ${orderId ? 's.order_id=?' : 'o.phone=?'} AND LENGTH(s.awb) > 0
      AND COALESCE(s.status,'')<>'cancelled' AND COALESCE(s.stage,'') NOT IN ('delivered','rto','lost','cancelled') AND COALESCE(o.status,'')<>'cancelled'
      AND s.created_at>? ORDER BY s.created_at DESC LIMIT 3`).bind(String(orderId || phone), now() - 30 * DAY).all()).results;
  for (const r of rows) {
    const n = await env.DB.prepare('SELECT * FROM ndr_auto WHERE awb=? ORDER BY first_seen DESC LIMIT 1').bind(String(r.awb)).first();
    const recent = n && Number(n.first_seen) > now() - 5 * DAY;
    if (r.stage === 'ndr' || recent || Number(r.ndr_asked_at || 0) > now() - 4 * DAY) return { ...r, ndr: n || null };
  }
  return null;
}

const rupees = (paise) => '₹' + Math.round(Number(paise || 0) / 100);
const dueOf = (r) => codDue({ method: r.method, converted_at: r.converted_at, status: r.order_status, total_paise: r.total_paise, advance_paise: r.advance_paise });
export const amountText = (r) => { const d = dueOf(r); return d ? rupees(d) : '₹0 (already paid)'; };
function itemsOf(r, n = 2) {
  try {
    const t = JSON.parse(r.contents_json || '[]').map((c) => String(c.title || '').replace(/\s*[-|(].*$/, '').trim()).filter(Boolean);
    if (!t.length) return 'your tattoos';
    return t.slice(0, n).join(' + ') + (t.length > n ? ` + ${t.length - n} more` : '');
  } catch { return 'your tattoos'; }
}
/** The courier's next try is its last one */
const lastTry = (cfg, attempt) => Number(attempt || 0) > 0 && Number(attempt) + 1 >= cfg.max_attempts;

/* ---------------- sending ---------------- */

async function lastIn(env, phone) {
  const r = await env.DB.prepare("SELECT ts FROM messages WHERE phone=? AND direction='in' ORDER BY ts DESC LIMIT 1").bind(String(phone)).first().catch(() => null);
  return Number(r?.ts || 0);
}

/** Free text inside the 24 h window; on the Meta number with reply buttons ({id,title} max 3), else as typed instructions. */
async function inChat(env, phone, text, buttons = []) {
  if (buttons.length && !viaG4w(env) && env.REPLY_ROUTE?.via !== 'g4w' && env.WA_PHONE_ID && env.WA_TOKEN) {
    try {
      const res = await fetch(`https://graph.facebook.com/v21.0/${env.REPLY_ROUTE?.phoneId || env.WA_PHONE_ID}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WA_TOKEN}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '91' + phone, type: 'interactive',
          interactive: { type: 'button', body: { text: text.slice(0, 1024) }, footer: { text: 'Ink Kulture' }, action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) } } }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.messages?.[0]?.id) return { ok: true, id: j.messages[0].id, shown: text + '\n[' + buttons.map((b) => b.title).join('] [') + ']' };
    } catch { /* plain text below */ }
  }
  const r = await sendText(env, '91' + phone, text);
  return { ...r, shown: text };
}

/** Reply in the chat and log it as the assistant's answer (so the general assistant does not answer it again). */
async function say(env, ctx, text, kind, buttons = [], trigger = 'ai') {
  const r = await inChat(env, ctx.phone, text, buttons);
  await logMsg(env, { direction: 'out', phone: ctx.phone, trigger, template: kind, status: r.ok ? 'accepted' : 'failed', wamid: r.id || '', orderName: ctx.order_name, error: r.ok ? '' : r.error || '', preview: r.shown || text });
  return r;
}

const yesNo = (orderId) => [{ id: `NDR_YES:${orderId}`, title: 'Yes, deliver it' }, { id: `NDR_NO:${orderId}`, title: 'No, cancel order' }];

/* ---------------- acting ---------------- */

/**
 * Deliver again: book the re-attempt (day / new address / other number / "courier never came") unless one is already
 * booked for this failed attempt and nothing changed, then confirm in the chat. Never throws.
 */
export async function deliverAgain(env, ctx, { date = '', address = '', phone = '', fake = false, sunday = false, clamped = false, via = 'reply' } = {}) {
  const cfg = ndrCfg(env);
  const since = Number(ctx.ndr?.first_seen || ctx.ndr_asked_at || 0) - 3600;
  const booked = ctx.ndr_choice === 'reattempt' && Number(ctx.ndr_choice_at || 0) >= since;
  const change = (date && date !== ctx.ndr_date) || address || phone || (fake && !Number(ctx.ndr_fake));
  let status = 'committed', day = date || (booked ? ctx.ndr_date || '' : '');
  if (!booked || change) {
    const [a1, a2] = splitAddr(address);
    const note = fake ? 'Customer says nobody came and nobody called. Please call the customer before going and deliver.' : 'Please call the customer before going.';
    try {
      const r = await customerNdr(env, { orderId: ctx.order_id, what: 'reattempt', date, address1: a1, address2: a2, altPhone: phone, via: 'pilot-' + via, note, force: true });
      if (r.status === 'no-shipment') return say(env, ctx, `Order ${ctx.order_name} is not waiting with the courier any more. Reply here if you need help.`, 'ndr').then(() => ({ status: 'no-shipment' }));
      status = 'booked';
    } catch (e) {
      await logMsg(env, { direction: 'out', phone: ctx.phone, trigger: 'ndr-pilot', template: 'reattempt', status: 'failed', orderName: ctx.order_name, error: String(e.message || e) });
      status = booked ? 'committed' : 'pending';
      if (!booked) day = '';
    }
  }
  await env.DB.prepare(`UPDATE shipments SET ndr_commit_at=?${fake ? ', ndr_fake=COALESCE(ndr_fake,0)+1' : ''} WHERE order_id=?`).bind(now(), String(ctx.order_id)).run().catch(() => {});
  if (fake && ctx.ndr) await env.DB.prepare('UPDATE ndr_auto SET pilot_note=? WHERE awb=? AND k=?').bind('customer says the courier never came / called', ctx.awb, ctx.ndr.k).run().catch(() => {});
  const due = dueOf(ctx), name = ctx.first_name ? ' ' + ctx.first_name : '';
  const last = lastTry(cfg, ctx.ndr?.attempt);
  const lines = [];
  if (fake) lines.push("Really sorry about that. We've reported it to the courier and asked them to call you before coming.");
  if (status === 'committed') lines.push(`Thank you${name}! Delivery of order ${ctx.order_name} is booked ${whenText(day)}.`);
  else if (status === 'booked') lines.push(`Done${name}! We've asked the courier to deliver order ${ctx.order_name} again ${whenText(day)}${address ? ' to your new address' : ''}${phone ? `, and to call ${phone}` : ''}.`);
  else lines.push(`Thanks${name}! We're arranging another delivery of order ${ctx.order_name} and will confirm the day here.`);
  if (sunday) lines.push("Couriers don't deliver on Sundays, so it's booked for Monday.");
  if (clamped) lines.push('The courier can hold a parcel for about a week, so that is the latest day we could book.');
  lines.push(due ? `Please keep ${rupees(due)} ready.` : 'It is already paid, nothing to pay at the door.');
  lines.push(last ? 'This is the last attempt the courier allows, so please make sure someone is there to receive it.' : 'Please keep your phone on, the delivery partner calls before coming.');
  await say(env, ctx, lines.join(' '), 'ndr-deliver');
  return { status, date: day };
}

/** The one reply before a cancel: answers their reason, true for this order. */
export function saveText(env, ctx, objection) {
  const due = dueOf(ctx), items = itemsOf(ctx);
  const pc = partialCfg(env);
  const lever = due && pc.mode === 'risky' && pc.history ? ' (Good to know: when a Cash on Delivery parcel is sent back, later orders on this number need a small online advance.)' : '';
  const body = {
    cash: `No problem if the cash isn't ready right now. We can deliver it on any day this week that suits you: just reply with the day (for example "Saturday")${due ? ` and keep ${rupees(due)} ready then` : ''}.`,
    late: `Sorry it took longer than it should have. Your parcel is already in your city, so it can reach you on the next working day.`,
    price: `Your designs (${items}) are already packed and in your city${due ? `, ${rupees(due)} at the door and they're yours` : ' and already paid for'}.`,
    wrong_order: `If you didn't place this order, reply CANCEL again and we'll stop it right away. If you did want it, reply YES and we'll deliver it on the next working day.`,
    changed_mind: `Your designs (${items}) are already packed with your name on them and waiting in your city. They're semi-permanent and fade away on their own in about 2 weeks, so there's no long commitment.`,
  }[objection] || '';
  const ask = objection === 'wrong_order' ? '' : ' Reply YES and we\'ll deliver it on the next working day. If you still want to cancel, reply CANCEL once more and we\'ll stop it, no questions asked.';
  return `Before we cancel order ${ctx.order_name}: ${body || `your designs (${items}) are already packed and waiting in your city.`}${ask}${lever}`;
}

/** First "cancel": one save message. A second one (within 3 days) is honoured: return to us, tagged customer-refused. Never throws. */
export async function refuseOrSave(env, ctx, { objection = '', via = 'reply' } = {}) {
  const cfg = ndrCfg(env);
  if (cfg.pilot.save && !(Number(ctx.ndr_save_at || 0) > now() - 3 * DAY)) {
    await env.DB.prepare('UPDATE shipments SET ndr_save_at=? WHERE order_id=?').bind(now(), String(ctx.order_id)).run();
    await say(env, ctx, saveText(env, ctx, objection || 'changed_mind'), 'ndr-save', yesNo(ctx.order_id));
    return { status: 'save' };
  }
  try {
    const r = await customerNdr(env, { orderId: ctx.order_id, what: 'return', via: 'pilot-' + via, force: true });
    if (r.status === 'no-shipment') { await say(env, ctx, `Order ${ctx.order_name} is not waiting with the courier any more. Reply here if you need help.`, 'ndr'); return { status: 'no-shipment' }; }
  } catch (e) {
    await logMsg(env, { direction: 'out', phone: ctx.phone, trigger: 'ndr-pilot', template: 'return', status: 'failed', orderName: ctx.order_name, error: String(e.message || e) });
    if (ctx.ndr) await env.DB.prepare('UPDATE ndr_auto SET pilot_note=? WHERE awb=? AND k=?').bind('customer asked to cancel; return request failed: ' + String(e.message || e).slice(0, 120), ctx.awb, ctx.ndr.k).run().catch(() => {});
  }
  try { const { addTags } = await import('./shopify.js'); await addTags(env, `gid://shopify/Order/${ctx.order_id}`, ['customer-refused']); } catch { /* tag is best effort */ }
  await say(env, ctx, `Okay, order ${ctx.order_name} is cancelled and the parcel is coming back to us. Nothing to pay. If you change your mind, you can order again anytime at inkkulture.in`, 'ndr-return');
  return { status: 'returned' };
}

/** A question or anything else while the parcel is in NDR: answered, and steered back to a delivery. */
async function answerOther(env, ctx, text) {
  const link = await ndrLink(env, ctx.order_id).catch(() => '');
  const due = dueOf(ctx);
  const booked = ctx.ndr_choice === 'reattempt' && Number(ctx.ndr_choice_at || 0) >= Number(ctx.ndr?.first_seen || 0) - 3600;
  const state = booked ? `A new delivery attempt is already booked ${whenText(ctx.ndr_date)}.` : `The last delivery attempt failed (courier's reason: ${ctx.ndr_reason || 'not given'}) and the parcel is waiting with the courier.`;
  let W = null;
  try { W = await import('./wa-ai.js'); } catch { /* no assistant */ }
  if (W && W.aiOn(env)) {
    const note = `This customer's order ${ctx.order_name} is in a failed-delivery situation. ${state} Amount to pay at delivery: ${due ? rupees(due) : 'nothing, it is prepaid'}.
Goal: get the parcel delivered. Answer their message briefly and kindly from the store knowledge, then ${booked ? 'remind them of the booked day and ask them to keep their phone on' : 'ask them to reply YES for delivery on the next working day, or to tell you a day, a new address or another number for the courier'}${link ? `; they can also use ${link}` : ''}.
Never threaten, never invent offers, discounts or dates. Do not say a team member will reply and do not use [HANDOFF]: you handle this chat. If they want to cancel, tell them to reply CANCEL.`;
    try {
      const a = await W.aiAnswer(env, { phone: ctx.phone, text, note });
      await say(env, ctx, a.text.replace(/a team member will[^.]*\.?/gi, '').trim() || a.text, 'ndr-answer');
      return;
    } catch (e) { console.error('ndr ai', e.message); }
  }
  const msg = booked
    ? `Order ${ctx.order_name}: ${state} ${due ? `Please keep ${rupees(due)} ready and your phone on.` : 'Please keep your phone on.'} Reply with a different day, address or number if you need to change it.`
    : `Order ${ctx.order_name} could not be delivered last time and is waiting with the courier. Reply YES and we'll deliver it on the next working day, or tell us a day, a new address or another number to call.${link ? ' You can also choose here: ' + link : ''}`;
  await say(env, ctx, msg, 'ndr-answer');
}

/**
 * Every inbound message from a phone with a parcel in a failed-delivery episode lands here first (lib/wa-g4w.js
 * processInbound). `action` is the whole-message keyword (CONFIRM / CANCEL / REATTEMPT / RETURN) when there is one.
 * Returns true when handled.
 */
export async function handleNdrMessage(env, phone, text, action = null) {
  const cfg = ndrCfg(env);
  if (cfg.mode === 'off' || !cfg.pilot.on || action === 'STOP' || action === 'START') return false;
  const ctx = await ndrContext(env, { phone }).catch(() => null);
  if (!ctx) return false;
  /* a person took over this chat in the dashboard: leave it to them */
  try { const { aiPaused } = await import('./inbox.js'); if (await aiPaused(env, phone)) return false; } catch { /* no inbox table */ }
  /* a plain "yes" / "cancel" that answers a newer COD-confirmation question for another order is not about this parcel */
  if (action === 'CONFIRM' || action === 'CANCEL') {
    const p = await env.DB.prepare('SELECT p.sent_at, o.confirmed_at, o.status FROM wa_pending p JOIN orders o ON o.order_id = p.order_id WHERE p.phone=? AND p.order_id<>?').bind(String(phone), String(ctx.order_id)).first().catch(() => null);
    const started = Math.max(Number(ctx.ndr?.first_seen || 0), Number(ctx.ndr_asked_at || 0), Number(ctx.ndr_save_at || 0));
    if (p && !p.confirmed_at && p.status === 'placed' && Number(p.sent_at) > started) return false;
  }
  let rd;
  if (action === 'REATTEMPT' || action === 'CONFIRM') rd = { intent: 'deliver' };
  else if (action === 'RETURN' || action === 'CANCEL') rd = { intent: 'return', objection: '' };
  else rd = await readReply(env, ctx, text);
  if (rd.intent === 'deliver') await deliverAgain(env, ctx, { ...rd, via: rd.by === 'ai' ? 'ai' : 'reply' });
  else if (rd.intent === 'return') await refuseOrSave(env, ctx, { objection: rd.objection, via: rd.by === 'ai' ? 'ai' : 'reply' });
  else await answerOther(env, ctx, text);
  return true;
}

/* ---------------- follow-ups on the cron ---------------- */

const SWEEP_SQL = `SELECT n.awb, n.k, n.attempt, n.category, n.first_seen, n.action, n.action_at, n.nudged_at, n.told_at, n.pilot_note,
    s.order_id, s.order_name, s.stage, s.ndr_choice, s.ndr_choice_at, s.ndr_by, s.ndr_date, s.ndr_commit_at,
    o.phone, o.first_name, o.method, o.total_paise, o.advance_paise, o.converted_at, o.status AS order_status, o.contents_json
  FROM ndr_auto n JOIN shipments s ON s.awb = n.awb JOIN orders o ON o.order_id = s.order_id`;
const ENDED = (r) => ['delivered', 'rto', 'lost', 'cancelled'].includes(String(r.stage || '')) || r.order_status === 'cancelled';

/**
 * Is this trigger's template approved in WhatsApp Manager? Checked before sending so a template still in review is
 * held quietly (no "failed" line in the message log every hour). Unknown (Go4WhatsUp, no WABA id): let the send try.
 */
async function templateReady(env, key) {
  if (viaG4w(env) || !env.WA_WABA_ID) return { ok: true };
  try {
    const { triggerConfig } = await import('./settings.js');
    const { metaTemplate } = await import('./whatsapp.js');
    const name = triggerConfig(env, key).name;
    const t = await metaTemplate(env, name);
    return t && t.status === 'APPROVED' ? { ok: true } : { ok: false, error: `template "${name}" not found or not approved (status ${t ? t.status : 'MISSING'})` };
  } catch { return { ok: true }; }
}

/**
 * Templates this app needs that are not in WhatsApp Manager yet are submitted by the server itself (no dashboard
 * login needed): the three NDR ones and the 30-minute pay-online offer. At most every 6 hours.
 */
export async function submitMissingTemplates(env) {
  const t = now();
  const last = await env.DB.prepare("SELECT v FROM settings WHERE k='tpl_autosubmit_at'").first().catch(() => null);
  if (Number(String(last?.v || '0').replace(/"/g, '')) > t - 6 * 3600) return { skipped: 'submitted recently' };
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('tpl_autosubmit_at', ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v").bind(String(t)).run();
  const out = {};
  try {
    const { action } = await import('./admin.js');
    const r = await action('ndr_pilot_templates')(env, {});
    out.ndr = (r.created || []).map((x) => `${x.name}: ${x.status}${x.error ? ' (' + x.error + ')' : ''}`);
    const { metaTemplate, clearMetaCache } = await import('./whatsapp.js');
    clearMetaCache();
    if (!(await metaTemplate(env, 'review_request_v1').catch(() => undefined))) {
      const rv = await action('review_template')(env, {});
      out.review = (rv.created || []).map((x) => `${x.name}: ${x.status}${x.error ? ' (' + x.error + ')' : ''}`);
    }
    if (!(await metaTemplate(env, 'apply_guide_v1').catch(() => undefined))) {
      const { applyVideo } = await import('./apply-guide.js');
      const { withSettings } = await import('./settings.js');
      if (applyVideo(await withSettings(env))) { const ag = await action('apply_guide')(env, { submit: true }); out.apply = (ag.created || []).map((x) => `${x.name}: ${x.status}${x.error ? ' (' + x.error + ')' : ''}`); }
    }
    if (!(await metaTemplate(env, 'cod_prepaid_offer_v2').catch(() => undefined))) {
      const c = await action('convert_template')(env, {});
      out.offer = (c.created || []).map((x) => `${x.name}: ${x.status}${x.error ? ' (' + x.error + ')' : ''}`);
    }
  } catch (e) { out.error = String(e.message || e).slice(0, 200); }
  console.log('templates auto-submitted', JSON.stringify(out));
  return out;
}

async function nudge(env, r) {
  const items = itemsOf(r);
  if (await lastIn(env, r.phone) > now() - WINDOW) {
    const link = await ndrLink(env, r.order_id).catch(() => '');
    const text = `Hi ${r.first_name || 'there'}, your Ink Kulture order ${r.order_name} (${items}) is packed and waiting with the courier. The last delivery attempt didn't go through.\n\nTap below and we'll send it again on the next working day, or reply with a day, a new address or another number to call.${link ? '\n' + link : ''}`;
    const res = await say(env, r, text, 'ndr-nudge', [{ id: `NDR_YES:${r.order_id}`, title: 'Deliver it to me' }], 'ndr-pilot');
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
  const ready = await templateReady(env, 'ndr_nudge');
  if (!ready.ok) return ready;
  return fireTrigger(env, 'ndr_nudge', { to: r.phone, vars: { name: r.first_name || 'there', order: r.order_name, items, ndrkey: await ndrKey(env, r.order_id) }, orderId: String(r.order_id), orderName: r.order_name });
}

async function tell(env, r, last) {
  const when = whenText(r.ndr_date), amount = amountText(r);
  if (await lastIn(env, r.phone) > now() - WINDOW) {
    const text = last
      ? `Hi ${r.first_name || 'there'}, the courier is making the final delivery attempt for order ${r.order_name} ${when}. If it can't be delivered this time, the parcel goes back and the order will be cancelled. Amount to pay at delivery: ${amount}. Tap below to confirm you'll be there.`
      : `Hi ${r.first_name || 'there'}, we've asked the courier to deliver order ${r.order_name} again ${when}. Amount to pay at delivery: ${amount}. Please keep your phone on, the delivery partner calls before coming. Tap below to confirm you'll be there.`;
    const res = await say(env, r, text, last ? 'ndr-last' : 'ndr-booked', [{ id: `NDR_YES:${r.order_id}`, title: "Yes, I'll receive it" }], 'ndr-pilot');
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }
  const ready = await templateReady(env, last ? 'ndr_last_attempt' : 'ndr_rescheduled');
  if (!ready.ok) return ready;
  return fireTrigger(env, last ? 'ndr_last_attempt' : 'ndr_rescheduled', { to: r.phone, vars: { name: r.first_name || 'there', order: r.order_name, when, amount, ndrkey: await ndrKey(env, r.order_id) }, orderId: String(r.order_id), orderName: r.order_name });
}

/** Nudges and re-attempt announcements. Runs after the NDR rules on every cron; only 9 am to 9 pm IST (quiet = on). */
export async function pilotSweep(env, cfg = ndrCfg(env)) {
  const t = now();
  const out = { nudged: 0, told: 0, failed: 0 };
  if (!cfg.pilot.on) return { ...out, skipped: 'off' };
  if (cfg.pilot.quiet && !daytime(t)) return { ...out, quiet: true };
  /* (templates are checked below even when nothing is due) */
  const mark = (r, col, note = '') => env.DB.prepare(`UPDATE ndr_auto SET ${col}=?, pilot_note=? WHERE awb=? AND k=?`).bind(t, note || null, r.awb, r.k).run();
  /* sends that failed only because the template was not approved yet are tried again (hourly) */
  const RETRY_SQL = "LIKE '%not found or not approved%'";
  /* a template still waiting for Meta's approval: try again in an hour instead of giving up */
  const WAIT = /not found or not approved|status PENDING|status IN_REVIEW/i;
  const waiting = (r) => { const m = /^template pending @(\d+)/.exec(String(r.pilot_note || '')); return m && t - Number(m[1]) < 3600; };
  const hold = (r, res) => env.DB.prepare('UPDATE ndr_auto SET pilot_note=? WHERE awb=? AND k=?').bind(`template pending @${t}: ${String(res.error || '').slice(0, 100)}`, r.awb, r.k).run();

  /* 1. no answer yet after nudge_h hours: a second message, with the design photo */
  const quiet = (await env.DB.prepare(`${SWEEP_SQL} WHERE n.first_seen>? AND n.first_seen<? AND (n.nudged_at IS NULL OR n.pilot_note ${RETRY_SQL}) AND n.action IS NULL ORDER BY n.first_seen LIMIT 10`)
    .bind(t - 3 * DAY, t - cfg.pilot.nudge_h * 3600).all()).results;
  for (const r of quiet) {
    if (ENDED(r) || r.stage !== 'ndr') { await mark(r, 'nudged_at', 'no nudge: parcel moved on'); continue; }
    if (Number(r.ndr_choice_at || 0) >= Number(r.first_seen) - 3600 || Number(r.ndr_commit_at || 0) >= Number(r.first_seen) - 3600) { await mark(r, 'nudged_at'); continue; }
    if (waiting(r)) continue;
    const res = await nudge(env, r).catch((e) => ({ ok: false, error: e.message }));
    if (!res.ok && WAIT.test(String(res.error || ''))) { await hold(r, res); out.pending = (out.pending || 0) + 1; continue; }
    await mark(r, 'nudged_at', res.ok ? '' : 'nudge failed: ' + String(res.error || res.skipped || '').slice(0, 120));
    if (res.ok) out.nudged++; else out.failed++;
  }

  /* 2. the rules booked a re-attempt on their own: tell the customer the day and ask them to commit */
  /* only fresh ones: a day-old "booked again" would be stale (the courier may already be on the way) */
  const booked = (await env.DB.prepare(`${SWEEP_SQL} WHERE n.action='reattempt' AND (n.told_at IS NULL OR n.pilot_note ${RETRY_SQL}) AND n.action_at>? ORDER BY n.action_at LIMIT 10`).bind(t - 14 * 3600).all()).results;
  for (const r of booked) {
    if (ENDED(r)) { await mark(r, 'told_at'); continue; }
    /* the customer chose something themselves since: they already know */
    if (r.ndr_by && r.ndr_by !== 'auto' && Number(r.ndr_choice_at || 0) > Number(r.action_at || 0)) { await mark(r, 'told_at'); continue; }
    if (waiting(r)) continue;
    const res = await tell(env, r, lastTry(cfg, r.attempt)).catch((e) => ({ ok: false, error: e.message }));
    if (!res.ok && WAIT.test(String(res.error || ''))) { await hold(r, res); out.pending = (out.pending || 0) + 1; continue; }
    await mark(r, 'told_at', res.ok ? '' : 'announcement failed: ' + String(res.error || res.skipped || '').slice(0, 120));
    if (res.ok) out.told++; else out.failed++;
  }
  /* templates Meta does not have yet are submitted ahead of need (checked at most every 6 h) */
  const sub = await submitMissingTemplates(env).catch((e) => ({ error: e.message }));
  if (!sub.skipped) out.templates = sub;
  return out;
}

/* ---------------- WhatsApp templates (outside the 24 h window) ---------------- */

/** The three templates, ready for Meta. base = this app's URL (the button opens /api/wa/ndr). */
export function pilotTemplates(base) {
  const b = String(base || '').replace(/\/$/, '');
  const url = { type: 'URL', url: `${b}/api/wa/ndr?k={{1}}`, example: [`${b}/api/wa/ndr?k=6123456789012.a1b2c3d4e5f6`] };
  return [
    { name: 'ndr_nudge_v1', language: 'en', category: 'UTILITY', allow_category_change: true,
      components: [
        { type: 'HEADER', format: 'IMAGE' },
        { type: 'BODY', text: 'Hi {{1}}, your Ink Kulture order {{2}} is packed and waiting with the courier: {{3}}.\n\nThe last delivery attempt did not go through. Tap below and we will send it to you again on the next working day, or pick a day and address that suit you.',
          example: { body_text: [['Riya', '#1627', 'Phoenix Wings + Koi Fish']] } },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Deliver it to me' }, { ...url, text: 'Pick a day or address' }] },
      ] },
    { name: 'ndr_rescheduled_v1', language: 'en', category: 'UTILITY', allow_category_change: true,
      components: [
        { type: 'BODY', text: 'Hi {{1}}, we have asked the courier to deliver your Ink Kulture order {{2}} again {{3}}.\n\nAmount to pay at delivery: {{4}}.\n\nPlease keep your phone reachable, the delivery partner will call before coming. Tap below to confirm you will be there to receive it.',
          example: { body_text: [['Riya', '#1627', 'on Fri, 24 Oct', '₹399']] } },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: "Yes, I'll receive it" }, { ...url, text: 'Change day or address' }] },
      ] },
    { name: 'ndr_last_attempt_v1', language: 'en', category: 'UTILITY', allow_category_change: true,
      components: [
        { type: 'BODY', text: 'Hi {{1}}, the courier is making the final delivery attempt for your Ink Kulture order {{2}} {{3}}.\n\nIf it cannot be delivered this time, the parcel goes back and the order will be cancelled. Amount to pay at delivery: {{4}}.\n\nTap below to confirm you will be available to receive it.',
          example: { body_text: [['Riya', '#1627', 'on Fri, 24 Oct', '₹399']] } },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: "Yes, I'll receive it" }, { ...url, text: 'Change day or address' }] },
      ] },
  ];
}
export const PILOT_TEMPLATE_NAMES = ['ndr_nudge_v1', 'ndr_rescheduled_v1', 'ndr_last_attempt_v1'];

export { classifyNdr };
