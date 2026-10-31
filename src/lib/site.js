/**
 * The storefront's own corner, called from inkkulture.in (theme snippet ik-site, Build 051+):
 *   GET  /api/site/config            WhatsApp number, Instagram, how-to-apply video and steps
 *   GET  /api/site/edd?pin=          delivery date for a PIN, or (no pin) for the visitor's IP location
 *   POST /api/site/otp {phone}       WhatsApp code, only for numbers that have ordered
 *   POST /api/site/verify {phone,code} -> { token } (90 days)
 *   GET  /api/site/orders            (Bearer) orders with live tracking, tickets
 *   POST /api/site/ticket            (Bearer) { order, topic, message }: lands in the dashboard Chats tab, the
 *                                    customer gets a WhatsApp receipt; replies from Chats reach them on WhatsApp
 *   POST /api/site/chat {messages}   the floating assistant (same knowledge as the WhatsApp assistant)
 */
import { json, cleanPhone } from './util.js';
import { makeToken, readToken } from './creators.js';
import { cancellable, CANCEL_REASONS, FAQS } from './self-cancel.js';

const now = () => Math.floor(Date.now() / 1000);
export const IG_URL = 'https://www.instagram.com/inkkulture.in/';
const day = (t) => new Date(Number(t) * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/* ---------------- tracking for customers ---------------- */

/** Pure: what the customer sees for one order. */
export function customerStatus(o) {
  const stage = o.stage || '';
  if (o.status === 'cancelled') return { key: 'cancelled', text: 'Cancelled', step: -1 };
  if (stage === 'delivered') return { key: 'delivered', text: 'Delivered' + (o.delivered_at ? ' on ' + day(o.delivered_at) : ''), step: 5 };
  if (stage === 'rto' || o.rto) return { key: 'returned', text: 'Returned to us', step: -1 };
  if (stage === 'lost') return { key: 'issue', text: 'Delayed with the courier, our team is on it', step: 3 };
  if (stage === 'ofd') return { key: 'ofd', text: 'Out for delivery today', step: 4 };
  if (stage === 'ndr') return { key: 'ndr', text: 'Delivery attempt missed, the courier will try again', step: 4 };
  if (stage === 'transit') return { key: 'transit', text: 'On the way', step: 3 };
  if (o.awb) return { key: 'packed', text: 'Packed, handing over to the courier', step: 2 };
  if (o.method === 'cod' && !o.confirmed_at) return { key: 'confirm', text: 'Placed, please confirm on WhatsApp', step: 0 };
  return { key: 'confirmed', text: 'Confirmed, packing (ships in 1-2 working days)', step: 1 };
}
export const STEPS = ['Placed', 'Confirmed', 'Packed', 'On the way', 'Out for delivery', 'Delivered'];

async function liveTrack(env, o) {
  try {
    const { trackRaw } = await import('./shiprocket.js');
    const { summarize } = await import('./sr-scan.js');
    const s = summarize(await Promise.race([trackRaw(env, o.awb, o), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 6000))]));
    return { stage: s.stage, edd: s.edd, scans: s.scans.slice(0, 8).map((x) => ({ at: x.at, text: x.text, place: x.location })) };
  } catch { return null; }
}

export async function customerOrders(env, phone) {
  const rows = (await env.DB.prepare(`SELECT o.order_id, o.order_name, o.status, o.method, o.total_paise, o.confirmed_at, o.created_at, o.contents_json, o.pincode, o.city,
      s.awb, s.courier, s.stage, s.edd, s.delivered_at, s.rto, s.provider, s.picked_at
    FROM orders o LEFT JOIN shipments s ON s.order_id = o.order_id AND COALESCE(s.status,'')<>'cancelled'
    WHERE o.phone=? AND o.order_id IS NOT NULL AND o.status NOT IN ('pending_payment','failed','completing') ORDER BY o.created_at DESC LIMIT 10`).bind(phone).all()).results;
  const { trackUrlOf } = await import('./shipprime.js');
  const { orderDetail } = await import('./shopify.orig.js');
  const top = rows.slice(0, 4);
  const [details, lives] = await Promise.all([
    Promise.all(top.map((o) => Promise.race([orderDetail(env, o.order_id), new Promise((ok) => setTimeout(() => ok(null), 5000))]).catch(() => null))),
    Promise.all(top.map((o) => (o.awb && !['delivered', 'rto'].includes(o.stage) && o.status !== 'cancelled' ? liveTrack(env, o) : null))),
  ]);
  return rows.map((o, i) => {
    const live = lives[i] || null;
    const st = customerStatus({ ...o, stage: live?.stage || o.stage });
    let items = [];
    const d = details[i];
    if (d) items = (d.lineItems?.nodes || []).map((l) => ({ title: l.title, qty: l.quantity, image: l.image?.url || '' }));
    else { try { items = JSON.parse(o.contents_json || '[]').map((c) => ({ title: c.title || c.sku || 'Tattoo', qty: c.quantity || 1, image: '' })); } catch { items = []; } }
    let edd = String(live?.edd || o.edd || '');
    if (/^\d{4}-\d{2}-\d{2}/.test(edd)) edd = new Date(edd.slice(0, 10) + 'T12:00:00+05:30').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
    return {
      name: o.order_name, date: Number(o.created_at), total: Math.round(Number(o.total_paise) / 100), pay: o.method === 'cod' ? 'Cash on delivery' : 'Paid online',
      status: st.text, key: st.key, step: st.step, edd: edd && !['delivered', 'returned', 'cancelled'].includes(st.key) ? edd : '',
      awb: o.awb || '', track_url: o.awb ? trackUrlOf(o) : '', scans: live?.scans || [], items,
      can_cancel: cancellable({ ...o, stage: live?.stage || o.stage }),
      cancel_by: o.method === 'cod' ? 'code' : 'request',
    };
  });
}

/* ---------------- tickets ---------------- */

export const TOPICS = ['Where is my order', 'Wrong or missing design', 'Tattoo did not come out well', 'Change address or phone', 'Cancel my order', 'Payment or refund', 'Something else'];

export async function createTicket(env, phone, b) {
  const topic = TOPICS.includes(b.topic) ? b.topic : 'Something else';
  const message = String(b.message || '').trim().slice(0, 1500);
  if (message.length < 5) throw new Error('Please write a little about the problem');
  const order = String(b.order || '').replace(/[^#\w-]/g, '').slice(0, 20);
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE phone=? AND status='open' AND created_at>?").bind(phone, now() - 86400).first();
  if (Number(open?.n) >= 3) throw new Error('You already have open requests. We will reply on WhatsApp soon.');
  const t = now();
  const r = await env.DB.prepare("INSERT INTO tickets (phone, order_name, topic, message, status, created_at) VALUES (?,?,?,?,'open',?) RETURNING id").bind(phone, order, topic, message, t).first();
  const ref = 'T' + r.id;
  const { logMsg, fireTrigger } = await import('./whatsapp.js');
  /* into the Chats tab as the customer's message (trigger 'ticket': not a WhatsApp message, so it doesn't open the 24 h window) */
  await logMsg(env, { direction: 'in', phone, trigger: 'ticket', template: '', status: 'received', orderName: order, preview: `🎫 Support request ${ref}${order ? ' · order ' + order : ''} · ${topic}\n${message}` });
  const { openHandoff } = await import('./inbox.js');
  await openHandoff(env, phone, `Ticket ${ref}: ${topic}`);
  const name = (await env.DB.prepare('SELECT first_name FROM orders WHERE phone=? AND first_name IS NOT NULL ORDER BY created_at DESC LIMIT 1').bind(phone).first())?.first_name || 'there';
  const told = await fireTrigger(env, 'support_reply', { to: phone, vars: { name: String(name).split(/\s+/)[0], ticket: ref, reply: `We have received your request about "${topic}" and will reply here soon.` }, orderName: order }).catch((e) => ({ ok: false, error: e.message }));
  return { ok: true, ticket: ref, whatsapp: !!told?.ok };
}

export async function ticketsOf(env, phone) {
  const rows = (await env.DB.prepare('SELECT id, order_name, topic, message, status, created_at, replied_at FROM tickets WHERE phone=? ORDER BY id DESC LIMIT 10').bind(phone).all()).results;
  return rows.map((r) => ({ ref: 'T' + r.id, order: r.order_name || '', topic: r.topic, message: r.message, status: r.status === 'open' ? (r.replied_at ? 'Replied on WhatsApp' : 'Open') : 'Closed', date: Number(r.created_at) }));
}

/* ---------------- floating assistant ---------------- */

const WEB_NOTE = 'This chat is the help box on the inkkulture.in website, not WhatsApp. The visitor is anonymous, so you cannot see their orders: for order status tell them to tap "Track order" (inkkulture.in/pages/track) and log in with their WhatsApp number. Never tell them to reply YES, CANCEL, RE-ATTEMPT or RETURN here. Keep answers short. If they need a person, say they can message us on WhatsApp and end with [HANDOFF].';

/** Keep the website chat for later (questions people ask = FAQ, product and content ideas). */
async function logChat(env, b, role, text, handoff = false, city = '') {
  const session = String(b.session || '').replace(/[^\w-]/g, '').slice(0, 40) || 'anon';
  await env.DB.prepare('INSERT INTO site_chats (session, role, text, handoff, page, city, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(session, role, String(text || '').slice(0, 2000), !!handoff, String(b.page || '').slice(0, 200), String(city || '').slice(0, 60), now()).run().catch((e) => console.error('site chat log', e.message));
}

export async function siteChat(env, b, city = '') {
  const { aiOn, aiAnswer } = await import('./wa-ai.js');
  const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-10).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 800) })).filter((m) => m.content);
  const last = msgs.filter((m) => m.role === 'user').pop();
  if (!last) return { ok: false, error: 'Type a question' };
  await logChat(env, b, 'user', last.content, false, city);
  let out;
  if (!aiOn(env)) out = { ok: true, text: 'Our assistant is resting right now. Message us on WhatsApp and the team will reply.', handoff: true };
  else {
    const thread = msgs.slice(0, msgs.lastIndexOf(last));
    try { const a = await aiAnswer(env, { phone: '', text: last.content, thread, note: WEB_NOTE }); out = { ok: true, text: a.text, handoff: !!a.handoff }; }
    catch (e) { out = { ok: true, text: 'Sorry, I could not answer that right now. Message us on WhatsApp and the team will help.', handoff: true }; }
  }
  await logChat(env, b, 'assistant', out.text, out.handoff, city);
  return out;
}

/* ---------------- config ---------------- */

export async function siteConfig(env) {
  const A = await import('./apply-guide.js');
  const { waNumber } = await import('./creators.js');
  const video = A.applyVideo(env);
  const steps = A.APPLY_TEXT.split('\n').filter((l) => /^\d\./.test(l)).map((l) => l.replace(/^\d\.\s*/, ''));
  return { ok: true, wa: waNumber(env), instagram: IG_URL, apply: { video, ytid: A.ytId(video), steps, note: 'Semi-permanent: lasts 1-2 weeks depending on your skin type, may last fewer days on sensitive skin.' }, topics: TOPICS, steps: STEPS, cancel_reasons: CANCEL_REASONS, faqs: FAQS };
}

/** A representative PIN for a city name (India Post directory), cached in edd_cache for 30 days. '' when unknown. */
export async function cityPin(env, city) {
  const c = String(city || '').trim();
  if (!c) return '';
  const key = 'city:' + c.toLowerCase();
  const row = await env.DB.prepare('SELECT body, at FROM edd_cache WHERE k=?').bind(key).first().catch(() => null);
  if (row && Number(row.at) > now() - 30 * 86400) return String(row.body || '');
  let pin = '';
  try {
    const r = await (await Promise.race([fetch(`https://api.postalpincode.in/postoffice/${encodeURIComponent(c)}`), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 4000))])).json();
    const list = r?.[0]?.PostOffice || [];
    const head = list.find((p) => /head office/i.test(p.BranchType || '') && new RegExp(c, 'i').test(p.District || p.Name)) || list.find((p) => new RegExp(c, 'i').test(p.District || '')) || list[0];
    pin = /^\d{6}$/.test(String(head?.Pincode || '')) ? String(head.Pincode) : '';
  } catch { pin = ''; }
  await env.DB.prepare('INSERT INTO edd_cache (k, body, at) VALUES (?,?,?) ON CONFLICT (k) DO UPDATE SET body=EXCLUDED.body, at=EXCLUDED.at').bind(key, pin, now()).run().catch(() => {});
  return pin;
}

/* ---------------- router ---------------- */

export async function handleSite(req, env) {
  const url = new URL(req.url), path = url.pathname;
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'x';
  const limit = async (k, max) => {
    const r = await env.DB.prepare('INSERT INTO rl (ip, hr, n) VALUES (?,?,1) ON CONFLICT (ip, hr) DO UPDATE SET n=rl.n+1 RETURNING n').bind(k, Math.floor(Date.now() / 3600000)).first().catch(() => null);
    return !r || Number(r.n) <= max;
  };
  const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  try {
    if (path === '/api/site/config') return json(await siteConfig(env), 200, { 'Cache-Control': 'public, max-age=600' });
    if (path === '/api/site/edd') {
      const { deliveryEstimate, ipPlace } = await import('./edd.js');
      let pin = String(url.searchParams.get('pin') || ''), city = '', byIp = false;
      if (!/^\d{6}$/.test(pin)) { const p = ipPlace(req); pin = p.pin; city = p.city; byIp = true; }
      /* mobile networks often give a city but no PIN: use that city's main post office PIN (cached a month) */
      if (!pin && city) pin = await cityPin(env, city);
      if (!pin) return json({ ok: true, by_ip: true, city, edd: '', generic: '3-6 days' });
      if (!(await limit('edd:' + ip, 120))) return json({ ok: false, error: 'Too many checks, try again later' }, 429);
      const e = await deliveryEstimate(env, { pin });
      if (!city) { try { const r = await (await fetch(`https://api.postalpincode.in/pincode/${pin}`)).json(); city = r?.[0]?.PostOffice?.[0]?.District || ''; } catch { /* no city then */ } }
      return json({ ok: !!e.ok, by_ip: byIp, pin, city, edd: e.edd || '', date: e.date || '', serviceable: e.serviceable !== false, generic: e.edd ? '' : '3-6 days' });
    }
    if (path === '/api/site/otp' && req.method === 'POST') {
      const phone = cleanPhone(b.phone);
      if (!phone) return json({ ok: false, error: 'Enter your 10-digit WhatsApp number' });
      if (!(await limit('sotp:' + ip, 15))) return json({ ok: false, error: 'Too many tries, please try again later' }, 429);
      const has = await env.DB.prepare("SELECT 1 AS x FROM orders WHERE phone=? AND order_id IS NOT NULL LIMIT 1").bind(phone).first();
      if (!has) return json({ ok: false, error: 'No order found on this number. Use the number you ordered with.' });
      const { sendOtp } = await import('./cod-otp.js');
      const r = await sendOtp(env, phone);
      return json(r.ok ? { ok: true } : { ok: false, error: r.fallback ? 'Could not send the WhatsApp code right now. Please try again in a few minutes.' : r.error, wait: r.wait });
    }
    if (path === '/api/site/verify' && req.method === 'POST') {
      const phone = cleanPhone(b.phone);
      if (!(await limit('sver:' + ip, 40))) return json({ ok: false, error: 'Too many tries, please try again later' }, 429);
      const { checkOtp } = await import('./cod-otp.js');
      const v = await checkOtp(env, phone, String(b.code || ''));
      if (!v.ok) return json({ ok: false, error: v.error });
      return json({ ok: true, token: await makeToken(env, phone, 90 * 86400, 'site') });
    }
    /* admin view: "<key>.<10-digit number>" typed in the track page's number box (key set in the dashboard) */
    if (path === '/api/site/admin' && req.method === 'POST') {
      if (!(await limit('sadm:' + ip, 8))) return json({ ok: false, error: 'Too many tries, please try again later' }, 429);
      const phone = cleanPhone(b.phone);
      const row = await env.DB.prepare("SELECT v FROM settings WHERE k='site_admin_key'").first().catch(() => null);
      const { hmacSha256hex, safeEqual } = await import('./util.js');
      const want = row ? String(row.v) : '';
      const got = await hmacSha256hex(env.ADMIN_SECRET || env.CRON_SECRET || 'ik', 'sitekey:' + String(b.key || ''));
      if (!want || !phone || !safeEqual(want, got)) return json({ ok: false, error: 'Enter your 10-digit WhatsApp number' });
      console.log('site admin view', JSON.stringify({ phone: phone.slice(0, 2) + 'xxxxxx' + phone.slice(-2), ip: ip.slice(0, 7) }));
      return json({ ok: true, admin: true, token: await makeToken(env, phone, 2 * 3600, 'site') });
    }
    if (path === '/api/site/chat' && req.method === 'POST') {
      if (!(await limit('chat:' + ip, 40))) return json({ ok: true, text: 'You have asked a lot of questions in a short time. Message us on WhatsApp and the team will help.', handoff: true });
      const { ipPlace } = await import('./edd.js');
      return json(await siteChat(env, b, ipPlace(req).city));
    }
    /* the link in every WhatsApp order message: logs in to that order's number without a code */
    if (path === '/api/site/link' && req.method === 'POST') {
      if (!(await limit('slink:' + ip, 40))) return json({ ok: false, error: 'Too many tries, please try again later' }, 429);
      const { readTrackKey } = await import('./self-cancel.js');
      const id = await readTrackKey(env, b.k);
      const row = id ? await env.DB.prepare('SELECT phone, order_name FROM orders WHERE order_id=?').bind(id).first() : null;
      if (!row?.phone) return json({ ok: false, error: 'This link has expired. Log in with your WhatsApp number.' });
      return json({ ok: true, order: row.order_name, token: await makeToken(env, row.phone, 30 * 86400, 'site') });
    }
    /* below: logged in */
    const phone = await readToken(env, String(req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), 'site');
    if (!phone) return json({ ok: false, auth: true, error: 'Please log in again' }, 401);
    if (path === '/api/site/orders') {
      const [orders, tickets] = await Promise.all([customerOrders(env, phone), ticketsOf(env, phone)]);
      return json({ ok: true, phone: phone.slice(0, 2) + 'xxxxxx' + phone.slice(-2), orders, tickets });
    }
    if (path === '/api/site/cancel/code' && req.method === 'POST') {
      if (!(await limit('scc:' + phone, 6))) return json({ ok: false, fallback: true, error: 'Too many codes asked. Raise a cancellation request instead.' }, 429);
      const { cancelCode } = await import('./self-cancel.js');
      return json(await cancelCode(env, phone, b.order));
    }
    if (path === '/api/site/cancel/state') { const { otpDelivery } = await import('./cod-otp.js'); return json(await otpDelivery(env, phone)); }
    if (path === '/api/site/cancel' && req.method === 'POST') {
      if (!(await limit('scx:' + phone, 12))) return json({ ok: false, error: 'Too many tries, please try again later' }, 429);
      const { cancelWithCode } = await import('./self-cancel.js');
      return json(await cancelWithCode(env, phone, b.order, b.code, b.reason));
    }
    if (path === '/api/site/cancel/request' && req.method === 'POST') {
      if (!(await limit('scr:' + phone, 4))) return json({ ok: false, error: 'Too many requests, please try again later' }, 429);
      const { cancelRequest } = await import('./self-cancel.js');
      return json(await cancelRequest(env, phone, b.order, b.reason));
    }
    if (path === '/api/site/ticket' && req.method === 'POST') {
      if (!(await limit('tk:' + phone, 6))) return json({ ok: false, error: 'Too many requests, please try again later' }, 429);
      return json(await createTicket(env, phone, b));
    }
    return json({ ok: false, error: 'not found' }, 404);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e).slice(0, 200) }, 400);
  }
}

/* WhatsApp template for ticket receipts and replies (submitted once by lib/cod-warning.js ensureTemplates) */
export const SUPPORT_TEMPLATE = 'ik_support_reply_v1';
export function supportTemplates() {
  return [{ name: SUPPORT_TEMPLATE, language: 'en', category: 'UTILITY', components: [
    { type: 'BODY', text: 'Hi {{1}}, this is Ink Kulture support about your request {{2}}:\n\n{{3}}\n\nYou can reply to this message if you need anything else.',
      example: { body_text: [['Riya', 'T12', 'Your parcel is with the courier and will reach you by Friday.']] } },
  ] }];
}
