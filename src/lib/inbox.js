/**
 * WhatsApp chat inbox for the dashboard ("Chats" tab).
 *
 * A chat needs a person when the assistant handed off ([HANDOFF] in lib/wa-ai.js), when the team took it over, or
 * when a plain message has no answer yet. While a chat is with the team the assistant stays quiet on it
 * (ai_paused_until), so the customer does not get two voices; "Done" hands it back to the assistant.
 *
 * Replies go out as free text through the same route the customer last wrote on (Meta only delivers free text
 * within 24 h of the customer's last message, and only from the number they wrote to).
 */
import { logMsg, sendText } from './whatsapp.js';

const now = () => Math.floor(Date.now() / 1000);
export const PAUSE = 24 * 3600;           /* assistant stays quiet this long after a handoff / a team reply */
const WINDOW = 24 * 3600;
const PLAIN_IN = "direction='in' AND trigger='reply' AND COALESCE(template,'')=''";
const routeOf = (wamid) => { const m = /^in:(g4w|meta)(?::(.+))?$/.exec(String(wamid || '')); return m ? { via: m[1], phoneId: m[2] || '' } : null; };
const clean = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/** Open (or keep open) a chat for the team. why: 'handoff' | 'takeover' | text. */
export async function openHandoff(env, phone, why = 'handoff') {
  const t = now();
  await env.DB.prepare(`INSERT INTO wa_handoff (phone, state, reason, opened_at, ai_paused_until) VALUES (?,?,?,?,?)
    ON CONFLICT (phone) DO UPDATE SET state='open', reason=EXCLUDED.reason, opened_at=CASE WHEN wa_handoff.state='open' THEN wa_handoff.opened_at ELSE EXCLUDED.opened_at END, resolved_at=NULL, ai_paused_until=EXCLUDED.ai_paused_until`)
    .bind(clean(phone), 'open', String(why).slice(0, 300), t, t + PAUSE).run();
}

/** Is the assistant paused for this phone (a person is handling it)? */
export async function aiPaused(env, phone) {
  const r = await env.DB.prepare('SELECT state, ai_paused_until FROM wa_handoff WHERE phone=?').bind(clean(phone)).first().catch(() => null);
  return !!r && r.state === 'open' && Number(r.ai_paused_until) > now();
}

export async function resolveHandoff(env, phone) {
  await env.DB.prepare("UPDATE wa_handoff SET state='resolved', resolved_at=?, ai_paused_until=NULL WHERE phone=?").bind(now(), clean(phone)).run();
}

/** Chats for the list: open handoffs, unanswered messages, or everything recent. */
export async function inboxList(env, { filter = 'needs', q = '' } = {}) {
  const t = now();
  const rows = (await env.DB.prepare(`SELECT m.phone, MAX(m.ts) AS last_ts, MAX(CASE WHEN m.direction='in' THEN m.ts END) AS last_in,
      MAX(CASE WHEN m.direction='out' AND m.trigger IN ('ai','agent') AND COALESCE(m.status,'') NOT IN ('failed','capped','queued','expired') THEN m.ts END) AS last_answer,
      MAX(CASE WHEN m.direction='out' AND m.trigger IN ('ai','agent') AND COALESCE(m.status,'') NOT IN ('failed','capped','queued','expired') THEN m.id END) AS last_answer_id
    FROM messages m WHERE m.ts>? AND LENGTH(m.phone) >= 10 GROUP BY m.phone ORDER BY MAX(m.ts) DESC LIMIT 400`).bind(t - 30 * 86400).all()).results;
  const ho = Object.fromEntries((await env.DB.prepare('SELECT * FROM wa_handoff').all()).results.map((r) => [String(r.phone), r]));
  const plainIn = Object.fromEntries((await env.DB.prepare(`SELECT phone, MAX(ts) AS ts, MAX(id) AS id FROM messages WHERE ${PLAIN_IN} AND ts>? GROUP BY phone`).bind(t - 30 * 86400).all()).results.map((r) => [String(r.phone), { ts: Number(r.ts), id: Number(r.id) }]));
  let list = rows.map((r) => {
    const h = ho[String(r.phone)];
    const pl = plainIn[String(r.phone)] || { ts: 0, id: 0 };
    const lastPlain = pl.ts;
    const unanswered = pl.id > (Number(r.last_answer_id) || 0);
    const open = h?.state === 'open';
    return { phone: String(r.phone), last_ts: Number(r.last_ts), last_in: Number(r.last_in) || null, in_window: Number(r.last_in) > t - WINDOW, handoff: open ? (h.reason || 'handoff') : '',
      unanswered, unread: unanswered && pl.id > (Number(h?.seen_id) || 0), ai_paused: open && Number(h.ai_paused_until) > t, opened_at: open ? Number(h.opened_at) : null };
  });
  if (filter === 'needs') list = list.filter((x) => x.handoff || (x.unanswered && x.last_in > t - 7 * 86400));
  else if (filter === 'handoff') list = list.filter((x) => x.handoff);
  else list = list.filter((x) => x.last_in);   /* 'all': conversations where the customer wrote at least once */
  const phones = list.map((x) => x.phone).slice(0, 150);
  const names = {}, last = {};
  if (phones.length) {
    for (const r of (await env.DB.prepare(`SELECT phone, first_name, last_name, order_name FROM orders WHERE phone IN (${phones.map(() => '?').join(',')}) AND order_name IS NOT NULL ORDER BY created_at`).bind(...phones).all()).results) names[r.phone] = { name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), order: r.order_name };
    for (const r of (await env.DB.prepare(`SELECT phone, direction, trigger, template, preview, ts FROM messages WHERE id IN (SELECT MAX(id) FROM messages WHERE phone IN (${phones.map(() => '?').join(',')}) AND LENGTH(COALESCE(preview,'')) > 0 GROUP BY phone)`).bind(...phones).all()).results) last[r.phone] = r;
  }
  list = list.slice(0, 150).map((x) => ({ ...x, name: names[x.phone]?.name || '', order: names[x.phone]?.order || '', preview: String(last[x.phone]?.preview || '').slice(0, 120), preview_dir: last[x.phone]?.direction || '', preview_by: last[x.phone]?.trigger || '' }));
  if (q) { const s = String(q).toLowerCase().replace(/^\+?91/, ''); list = list.filter((x) => `${x.phone} ${x.name} ${x.order}`.toLowerCase().includes(s)); }
  /* chats with the team first, then unanswered, newest first */
  list.sort((a, b) => (b.handoff ? 1 : 0) - (a.handoff ? 1 : 0) || (b.unanswered ? 1 : 0) - (a.unanswered ? 1 : 0) || b.last_ts - a.last_ts);
  return list;
}

export async function inboxCount(env) {
  const list = await inboxList(env, { filter: 'needs' });
  return { needs: list.length, unread: list.filter((x) => x.unread).length, handoff: list.filter((x) => x.handoff).length };
}

/** One chat: messages, the customer's orders with shipment state, and the handoff row. Marks it seen. */
export async function inboxThread(env, phone) {
  const p = clean(phone);
  if (p.length !== 10) throw new Error('Phone number needed');
  const msgs = (await env.DB.prepare('SELECT id, ts, direction, trigger, template, status, order_name, error, preview FROM messages WHERE phone=? AND ts>? ORDER BY id DESC LIMIT 200').bind(p, now() - 90 * 86400).all()).results.reverse();
  const orders = (await env.DB.prepare(`SELECT o.order_id, o.order_name, o.status, o.method, o.total_paise, o.advance_paise, o.converted_at, o.confirmed_at, o.shipped_at, o.packed_at, o.tracking, o.created_at, o.first_name, o.last_name, o.city, o.pincode, o.status_url,
      s.awb, s.courier, s.stage, s.sr_status, s.edd, s.delivered_at, s.ndr_choice, s.ndr_date, s.ndr_by, s.ndr_reason
    FROM orders o LEFT JOIN shipments s ON s.order_id = o.order_id AND COALESCE(s.status,'')<>'cancelled'
    WHERE o.phone=? AND o.order_id IS NOT NULL AND o.status NOT IN ('pending_payment','failed','completing') ORDER BY o.created_at DESC LIMIT 6`).bind(p).all()).results;
  /* items and the address come from Shopify, for the newest three orders */
  const { orderDetail } = await import('./shopify.js');
  const detail = await Promise.all(orders.slice(0, 3).map((o) => Promise.race([orderDetail(env, o.order_id), new Promise((ok) => setTimeout(() => ok(null), 5000))]).catch(() => null)));
  /* a COD order that can still be paid online: the pay-online link for a quick reply */
  const { storePayLink, discountPct } = await import('./wa-convert.js');
  const payLinks = await Promise.all(orders.map((o) => (o.method === 'cod' && !o.converted_at && !(Number(o.advance_paise) > 0) && !o.awb && !o.shipped_at && o.status !== 'cancelled' ? storePayLink(env, o.order_id) : '')));
  const out = orders.map((o, i) => {
    const d = detail[i];
    const total = Number(o.total_paise) / 100, adv = Number(o.advance_paise) / 100 || 0;
    return { id: String(o.order_id), name: o.order_name, created_at: Number(o.created_at), status: o.status, total,
      pay: o.converted_at ? 'Paid online (converted)' : adv ? `Part COD: ₹${adv} paid, ₹${total - adv} on delivery` : o.method === 'cod' ? 'Cash on delivery' : 'Paid online',
      confirmed: o.method !== 'cod' || !!o.confirmed_at, packed: !!o.packed_at, shipped: !!(o.shipped_at || o.awb),
      awb: o.awb || '', courier: o.courier || '', stage: o.stage || '', sr_status: o.sr_status || '', edd: o.edd || '', delivered_at: Number(o.delivered_at) || null,
      ndr: o.stage === 'ndr' ? { reason: o.ndr_reason || '', choice: o.ndr_choice || '', date: o.ndr_date || '', by: o.ndr_by || '' } : null,
      pay_link: payLinks[i] || '', pay_pct: payLinks[i] ? discountPct(env) : 0,
      track: o.awb ? `https://shiprocket.co/tracking/${o.awb}` : (o.tracking && /^https?:/.test(o.tracking) ? o.tracking : ''), status_url: o.status_url || '',
      items: d ? (d.lineItems?.nodes || []).map((l) => ({ title: l.title, qty: l.quantity, size: l.variantTitle || '', image: l.image?.url || '' })) : null,
      address: d?.shippingAddress ? [d.shippingAddress.address1, d.shippingAddress.address2, d.shippingAddress.city, d.shippingAddress.province, d.shippingAddress.zip].filter(Boolean).join(', ') : '',
      name_on_order: d?.shippingAddress?.name || `${o.first_name || ''} ${o.last_name || ''}`.trim() };
  });
  const h = await env.DB.prepare('SELECT * FROM wa_handoff WHERE phone=?').bind(p).first();
  const seenId = msgs.length ? Number(msgs[msgs.length - 1].id) : 0;
  await env.DB.prepare('INSERT INTO wa_handoff (phone, state, seen_at, seen_id) VALUES (?,?,?,?) ON CONFLICT (phone) DO UPDATE SET seen_at=EXCLUDED.seen_at, seen_id=GREATEST(COALESCE(wa_handoff.seen_id,0), EXCLUDED.seen_id)').bind(p, h?.state || 'none', now(), seenId).run();
  const lastIn = [...msgs].reverse().find((m) => m.direction === 'in');
  return { phone: p, messages: msgs, orders: out, handoff: h && h.state === 'open' ? { reason: h.reason || '', opened_at: Number(h.opened_at), ai_paused_until: Number(h.ai_paused_until) || null } : null,
    last_in: lastIn ? Number(lastIn.ts) : null, in_window: !!lastIn && Number(lastIn.ts) > now() - WINDOW };
}

/** A reply typed in the dashboard. Keeps the chat with the team (assistant paused) unless done is set. */
export async function inboxSend(env, phone, text, { done = false } = {}) {
  const p = clean(phone), body = String(text || '').trim().slice(0, 3000);
  if (p.length !== 10) throw new Error('Phone number needed');
  if (!body) throw new Error('Type a message');
  const lastIn = await env.DB.prepare("SELECT ts, wamid FROM messages WHERE phone=? AND direction='in' ORDER BY id DESC LIMIT 1").bind(p).first();
  if (!lastIn || Number(lastIn.ts) < now() - WINDOW) throw new Error('More than 24 hours since this customer last wrote, so WhatsApp will not deliver a typed message. Call them, or wait for them to message again.');
  const route = routeOf(lastIn.wamid);
  const e2 = route ? Object.assign(Object.create(null), env, { REPLY_ROUTE: route }) : env;
  const res = await sendText(e2, '91' + p, body);
  await logMsg(e2, { direction: 'out', phone: p, trigger: 'agent', template: '', status: res.ok ? 'accepted' : 'failed', wamid: res.id || '', error: res.ok ? '' : `${res.via}: ${res.error}`, preview: body });
  if (!res.ok) throw new Error('WhatsApp did not accept it: ' + (res.error || 'unknown error'));
  if (done) await resolveHandoff(env, p);
  else {
    const t = now();
    await env.DB.prepare(`INSERT INTO wa_handoff (phone, state, reason, opened_at, replied_at, ai_paused_until, seen_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (phone) DO UPDATE SET state='open', replied_at=EXCLUDED.replied_at, ai_paused_until=EXCLUDED.ai_paused_until, seen_at=EXCLUDED.seen_at, resolved_at=NULL, opened_at=COALESCE(wa_handoff.opened_at, EXCLUDED.opened_at), reason=COALESCE(wa_handoff.reason, EXCLUDED.reason)`)
      .bind(p, 'open', 'team replied', t, t, t + PAUSE, t).run();
  }
  return { ok: true, id: res.id || '' };
}
