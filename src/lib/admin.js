import { json, hmacSha256hex, sha256hex, safeEqual, cleanPhone } from './util.js';
import { getSettings, putSetting, TRIGGERS, VAR_LABELS, triggerConfig } from './settings.js';
const convertCfgOf = (f) => { try { return { mode: f.SETTINGS?.convert?.mode === 'on' ? 'on' : 'off' }; } catch { return { mode: 'off' }; } };
async function withSettingsFresh(env) { return { ...env, SETTINGS: await getSettings(env, true) }; }
import { orderForShipping, packingItems, activeFulfilments, updateTracking, cancelFulfilmentsFor } from './shopify.js';
import { planShipment, bookShipment, publicRec, srPickups, ndrList, ndrAction, cancelShipment, refreshDocs, srConnected, srWallet } from './shiprocket.js';
import { packCfg, PACK_DEFAULTS, IN } from './packing.js';
import { pickOption } from './rates.js';
import { cfg as cfgShip, courierBlocked } from './shipping.js';
import { isCollab } from './collab.js';
import { labelPdf } from './labels.js';
import { stopShipment, sweepCancelled, syncCancelledOrders, syncFulfilledOrders } from './ship-cancel.js';
import { stageOf, LABEL as STAGE_LABEL, refreshShipment, refreshDue, requestPickup, manifestUrl } from './ship-status.js';
import { audit as shipAudit, listIssues as shipIssues, fix as shipFix, dismissIssue, KINDS as ISSUE_KINDS, FIX_LABEL } from './ship-audit.js';
import { orderDetail, shipOrder, searchProducts, addTags, removeTags, cancelOrder, gql } from './shopify.js';
const shopOrderShip = shipOrder;
import { fireTrigger, waGet, logMsg, viaG4w, metaFromDashboard, clearMetaCache, cartLink } from './whatsapp.js';
import * as g4w from './go4whatsup.js';
import { rupees } from './pricing.js';
import { metaCfg, pixelInfo, capiStats, resendDue, resendPurchases, META_DEFAULTS } from './meta.js';
import { codDue, cfg as partialCfg, decide as partialDecide, riskyPins, reasonText as partialReason, DEFAULTS as PARTIAL_DEFAULTS } from './partial-cod.js';

const now = () => Math.floor(Date.now() / 1000);
const digits = (x) => String(x || '').replace(/\D/g, '');
export const STEPS = ['cart', 'open', 'phone', 'pin', 'address', 'pay', 'submit', 'done'];
const STEP_LABEL = { cart: 'Cart (has items)', open: 'Opened checkout popup', phone: 'Entered phone number', pin: 'Entered PIN code', address: 'Filled address', pay: 'Chose payment method', submit: 'Tapped pay / place order', done: 'Order placed' };

/* ---------------- auth ---------------- */
const secretOf = (env) => env.ADMIN_SECRET || 'ik-admin|' + (env.DATABASE_URL || env.POSTGRES_URL || 'x');
const b64 = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
async function makeToken(env, email) {
  const p = b64(JSON.stringify({ e: email, x: now() + 14 * 86400 }));
  return p + '.' + (await hmacSha256hex(secretOf(env), p));
}
async function checkToken(env, req) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const [p, sig] = t.split('.');
  if (!p || !sig || !safeEqual(await hmacSha256hex(secretOf(env), p), sig)) return null;
  try { const o = JSON.parse(unb64(p)); return o.x > now() ? o : null; } catch { return null; }
}
async function hashPw(salt, pw) { return sha256hex(`${salt}|${pw}|${secretOf({})}`); }

export async function handleLogin(req, env) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const hr = Math.floor(Date.now() / 3600000);
  const r = await env.DB.prepare('INSERT INTO rl (ip,hr,n) VALUES (?,?,1) ON CONFLICT(ip,hr) DO UPDATE SET n=rl.n+1 RETURNING n').bind('login:' + ip, hr).first();
  if ((r?.n || 1) > 15) return json({ ok: false, error: 'Too many attempts. Try again in an hour.' }, 429);
  const b = await req.json().catch(() => ({}));
  const email = String(b.email || '').trim().toLowerCase();
  const pw = String(b.password || '');
  let admin = (await getSettings(env, true)).admin;
  if (!admin) { /* first run: seed the test login */
    const salt = Math.random().toString(36).slice(2);
    admin = { email: 'shivangperplexity@gmail.com', salt, hash: await hashPw(salt, 'TEST123') };
    await putSetting(env, 'admin', admin);
  }
  if (email !== admin.email || !safeEqual(await hashPw(admin.salt, pw), admin.hash)) return json({ ok: false, error: 'Wrong email or password' }, 401);
  return json({ ok: true, token: await makeToken(env, email), email });
}

/* ---------------- tracking from the storefront ---------------- */
export async function handleTrack(req, env) {
  if (!env.DB) return json({ ok: true });
  const b = await req.json().catch(() => ({}));
  const sid = String(b.sid || '').slice(0, 40);
  const type = String(b.type || '').slice(0, 20);
  if (!sid || !STEPS.concat(['left', 'fail', 'method', 'upi', 'ping']).includes(type)) return json({ ok: false }, 400);
  const t = now();
  const rank = STEPS.indexOf(type);
  const lines = Array.isArray(b.cart) ? b.cart.slice(0, 20).map((l) => ({ t: String(l.t || '').slice(0, 80), q: +l.q || 1, p: +l.p || 0 })) : null;
  const value = lines ? lines.reduce((s, l) => s + l.p * l.q, 0) : null;
  const utm = b.utm && typeof b.utm === 'object' ? JSON.stringify(b.utm).slice(0, 800) : null;
  const src = b.utm?.utm_source ? String(b.utm.utm_source).slice(0, 40) : b.utm?.fbclid ? 'facebook' : null;
  const phone = cleanPhone(b.phone);
  await env.DB.prepare(
    `INSERT INTO sessions (sid,phone,name,device,cart_json,cart_value,step,max_step,method,source,utm_json,page,first_seen,last_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(sid) DO UPDATE SET phone=COALESCE(excluded.phone,sessions.phone), name=COALESCE(NULLIF(excluded.name,''),sessions.name),
       cart_json=COALESCE(excluded.cart_json,sessions.cart_json), cart_value=COALESCE(?,sessions.cart_value),
       step=CASE WHEN ?>=0 THEN excluded.step ELSE sessions.step END, max_step=GREATEST(sessions.max_step,excluded.max_step),
       method=COALESCE(excluded.method,sessions.method), source=COALESCE(sessions.source,excluded.source), utm_json=COALESCE(sessions.utm_json,excluded.utm_json),
       page=COALESCE(excluded.page,sessions.page), last_seen=excluded.last_seen`,
  ).bind(sid, phone, String(b.name || '').slice(0, 60), String(b.device || '').slice(0, 10), lines ? JSON.stringify(lines) : null, value ?? 0, rank >= 0 ? type : null, Math.max(rank, 0), b.method ? String(b.method).slice(0, 10) : null, src, utm, b.page ? String(b.page).slice(0, 200) : null, t, t, value, rank)
    .run();
  if (type !== 'ping' && type !== 'cart') await env.DB.prepare('INSERT INTO events (sid,ts,type,data) VALUES (?,?,?,?)').bind(sid, t, type, JSON.stringify(b.data || {}).slice(0, 300)).run();
  if (type === 'done') await env.DB.prepare("UPDATE sessions SET ordered=1, max_step=7 WHERE sid=?").bind(sid).run();
  return json({ ok: true });
}
export async function markSessionOrdered(env, sid, orderName) {
  if (!sid || !env.DB) return;
  await env.DB.prepare('UPDATE sessions SET ordered=1, max_step=7, step=?, order_name=? WHERE sid=?').bind('done', orderName || '', sid).run();
}

/* ---------------- risk score ---------------- */
export function scoreOrder(o, all) {
  const f = [];
  const add = (w, why) => f.push({ w, why });
  const total = (o.total_paise || 0) / 100;
  const others = all.filter((x) => x.phone === o.phone && x.txnid !== o.txnid);
  const before = others.filter((x) => x.created_at < o.created_at);
  if (o.method === 'cod' && Number(o.advance_paise) > 0) {
    add(6, `Partial COD: ₹${Number(o.advance_paise) / 100} paid online, rest on delivery`);
    if (o.confirmed_at) add(-12, 'Advance paid (counts as confirmed)');
  } else if (o.method === 'cod') {
    add(18, 'Cash on delivery');
    if (total > 3000) add(20, 'High COD value (over Rs 3,000)'); else if (total > 1500) add(10, 'COD value over Rs 1,500');
    if (!o.email) add(4, 'No email given');
    if (!o.confirmed_at && o.created_at < now() - 86400) add(18, 'Not confirmed on WhatsApp after 24h');
    if (o.confirmed_at) add(-30, 'Confirmed on WhatsApp');
  } else add(-22, 'Prepaid (paid online)');
  const cancelled = others.filter((x) => x.status === 'cancelled').length;
  if (cancelled) add(Math.min(40, 25 * cancelled), `${cancelled} earlier cancelled order(s) from this number`);
  const good = before.filter((x) => ['paid', 'placed'].includes(x.status) && x.shipped_at).length;
  if (good) add(-12, 'Repeat customer with shipped orders');
  if (others.some((x) => Math.abs(x.created_at - o.created_at) < 86400)) add(20, 'Another order from this number within 24h');
  const pinMates = all.filter((x) => x.pincode === o.pincode && x.phone !== o.phone && Math.abs(x.created_at - o.created_at) < 86400);
  if (pinMates.length >= 3) add(14, `${pinMates.length} orders from different numbers to this PIN in 24h`);
  const nm = `${o.first_name || ''} ${o.last_name || ''}`.trim();
  if (/\d/.test(nm) || /^(.)\1+$/.test(nm.replace(/\s/g, '')) || (nm.length < 4)) add(14, 'Name looks fake or too short');
  if (/(\d)\1{5,}/.test(o.phone || '') || /1234567|9876543|0123456/.test(o.phone || '')) add(25, 'Phone number looks fake');
  const hr = new Date((o.created_at + 19800) * 1000).getUTCHours();
  if (hr >= 0 && hr < 5) add(6, 'Ordered between midnight and 5am');
  const score = Math.max(0, Math.min(100, 12 + f.reduce((s, x) => s + x.w, 0)));
  const level = score >= 65 ? 'high' : score >= 35 ? 'medium' : 'low';
  const advice = { high: 'Call or WhatsApp to verify before shipping. Consider asking for prepaid.', medium: 'Ship once the customer confirms on WhatsApp.', low: 'Safe to ship.' }[level];
  return { score, level, factors: f.filter((x) => x.w !== 0).sort((a, b) => b.w - a.w), advice };
}
async function recentOrders(env, days = 90) {
  return (await env.DB.prepare("SELECT * FROM orders WHERE created_at>? AND status NOT IN ('pending_payment','failed','completing') ORDER BY created_at DESC LIMIT 800").bind(now() - days * 86400).all()).results;
}
const num = (v) => Number(v) || 0;
/** Orders that have a live (not cancelled) Shiprocket AWB. They count as shipped even if the Shopify fulfilment step failed. */
async function bookedMap(env) {
  const rows = (await env.DB.prepare("SELECT order_id, awb, courier, fulfil_error, cancel_state, charge_paise FROM shipments WHERE awb IS NOT NULL AND awb<>'' AND COALESCE(status,'')<>'cancelled'").all()).results;
  return Object.fromEntries(rows.map((r) => [String(r.order_id), r]));
}
function orderOut(o, all) {
  const r = scoreOrder(o, all);
  return {
    id: o.order_id, name: o.order_name, txnid: o.txnid, method: o.method, status: o.status, total: num(o.total_paise) / 100, phone: o.phone, customer: `${o.first_name || ''} ${o.last_name || ''}`.trim(),
    city: o.city, pincode: o.pincode, state: o.state_code, created_at: num(o.created_at), confirmed_at: num(o.confirmed_at) || null, shipped_at: num(o.shipped_at) || null, packed_at: num(o.packed_at) || null, tracking: o.tracking || '',
    risk: r.score, level: r.level,
    advance: num(o.advance_paise) / 100, cod_due: codDue(o) / 100,
    /* pay-online offer: paid (converted, with what they paid), or open until convert_expires_at */
    converted: !!o.converted_at, paid_online: o.converted_at ? num(o.paid_paise) / 100 : 0, marked_prepaid: /^manual/.test(String(o.convert_txnid || '')),
    collab: isCollab(o.source_url),
    offer_until: !o.converted_at && num(o.convert_expires_at) > now() ? num(o.convert_expires_at) : null, offer_sent: num(o.convert_offer_at) || null,
  };
}

/** Called right after an order exists: tag Shopify if risky and ping the admin. */
export async function afterOrderRisk(env, row, order) {
  try {
    const all = await recentOrders(env, 90);
    const o = all.find((x) => x.txnid === row.txnid);
    if (!o) return;
    const r = scoreOrder(o, all);
    const gid = order.id || `gid://shopify/Order/${order.legacyResourceId}`;
    await addTags(env, gid, ['risk-' + r.level]);
    const total = rupees(row.total ?? row.total_paise);
    const tasks = [fireTrigger(env, 'admin_new_order', { to: env.WA_ADMIN_PHONE, vars: { order: order.name, total, method: row.method === 'cod' ? 'COD' : 'Prepaid', risk: `${r.score} (${r.level})` }, orderName: order.name })];
    if (r.score >= 65) tasks.push(fireTrigger(env, 'admin_high_risk', { to: env.WA_ADMIN_PHONE, vars: { order: order.name, risk: String(r.score), reasons: r.factors.filter((x) => x.w > 0).slice(0, 3).map((x) => x.why).join('; ') }, orderName: order.name }));
    await Promise.all(tasks);
  } catch (e) { console.error('risk', e); }
}

/* ---------------- RPC ---------------- */
async function runRates(env, { pin, cod, amount, weight_g }) {
  const { compareRates } = await import('./rates.js');
  const fresh = await withSettingsFresh(env);
  if (weight_g) fresh.SETTINGS = { ...fresh.SETTINGS, shipping: { ...fresh.SETTINGS.shipping, weight_g } };
  return { pin, cod, amount, ...(await compareRates(fresh, { pin, cod, amount })) };
}
const dayOut = (d) => (d ? d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '');
function ratesOut(r) {
  const tag = (o) => o && `${o.provider}|${o.courier}`;
  return {
    ok: true, pin: r.pin, cod: r.cod, policy: r.policy, tolerance_days: r.toleranceDays, connected: r.connected, errors: r.errors,
    pick: tag(r.pick), cheapest: tag(r.cheapest), fastest: tag(r.fastest),
    options: r.options.map((o) => ({ key: tag(o), provider: o.providerLabel, courier: o.courier, charge: o.charge, freight: o.freight, cod_fee: o.cod, edd: dayOut(o.eddDate), days: o.eddDate ? Math.max(1, Math.round((o.eddDate - Date.now()) / 86400000)) : null })),
    saving_vs_dearest: r.options.length > 1 ? Math.round((Math.max(...r.options.map((o) => o.charge ?? 0)) - (r.pick?.charge ?? 0)) * 100) / 100 : 0,
  };
}
async function shipCtx(env, id) {
  const row = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(String(id)).first();
  if (!row) throw new Error('Order not found');
  if (row.status === 'cancelled') throw new Error('This order is cancelled');
  const fresh = await withSettingsFresh(env);
  const order = await orderForShipping(env, row.order_id);
  if (!order) throw new Error('Order not found in Shopify');
  if (order.cancelled) throw new Error('This order is cancelled in Shopify');
  return { fresh, row, order };
}
/* envelope sizes are edited in inches in the dashboard and stored in cm */
function packUi(p) {
  const c = packCfg(p), r2 = (n) => Math.round(n * 100) / 100;
  return { a_l: r2(c.env_a[0] / IN), a_b: r2(c.env_a[1] / IN), cap_a: c.cap_a, b_l: r2(c.env_b[0] / IN), b_b: r2(c.env_b[1] / IN), cap_b: c.cap_b, pad_cm: c.pad_cm, base_h_cm: c.base_h_cm, step_h_cm: c.step_h_cm, roll_l: c.roll[0], roll_b: c.roll[1], roll_h: c.roll[2], env_weight_g: c.env_weight_g, tattoo_weight_g: c.tattoo_weight_g };
}
function packFromUi(u) {
  const n = (v, d, lo = 0.1, hi = 200) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : d; };
  const d = packUi({});
  return { env_a_l: n(u.a_l, d.a_l) * IN, env_a_b: n(u.a_b, d.a_b) * IN, cap_a: Math.round(n(u.cap_a, d.cap_a, 1, 50)), env_b_l: n(u.b_l, d.b_l) * IN, env_b_b: n(u.b_b, d.b_b) * IN, cap_b: Math.round(n(u.cap_b, d.cap_b, 1, 50)),
    pad_cm: n(u.pad_cm, d.pad_cm, 0, 20), base_h_cm: n(u.base_h_cm, d.base_h_cm), step_h_cm: n(u.step_h_cm, d.step_h_cm, 0, 20), roll_l: n(u.roll_l, d.roll_l), roll_b: n(u.roll_b, d.roll_b), roll_h: n(u.roll_h, d.roll_h), env_weight_g: n(u.env_weight_g, d.env_weight_g, 0, 500), tattoo_weight_g: n(u.tattoo_weight_g, d.tattoo_weight_g, 1, 1000) };
}
const mask = (v) => (v ? '••••••' + String(v).slice(-4) : '');
const IST = 19800;

async function liveData(env) {
  const t = now();
  const rows = (await env.DB.prepare('SELECT * FROM sessions WHERE last_seen>? ORDER BY last_seen DESC LIMIT 80').bind(t - 1800).all()).results;
  const mapped = rows.map((s) => ({
    sid: s.sid.slice(0, 8), phone: s.phone, name: s.name, device: s.device, step: s.step || 'cart', max_step: s.max_step, method: s.method, source: s.source || 'direct',
    cart: JSON.parse(s.cart_json || '[]'), value: num(s.cart_value), ordered: !!s.ordered, order: s.order_name, last_seen: num(s.last_seen), first_seen: num(s.first_seen), active: t - num(s.last_seen) < 90,
  }));
  /* When each phone was last nudged, so the Live tab can show it next to the Nudge button. */
  const phones = [...new Set(mapped.map((s) => s.phone).filter(Boolean))];
  if (phones.length) {
    const ls = (await env.DB.prepare(`SELECT phone, nudged_at FROM leads WHERE phone IN (${phones.map(() => '?').join(',')})`).bind(...phones).all()).results;
    const by = Object.fromEntries(ls.map((l) => [l.phone, num(l.nudged_at) || null]));
    mapped.forEach((s) => { s.nudged_at = s.phone ? by[s.phone] || null : null; });
  }
  return { now: t, active: mapped.filter((s) => s.active && !s.ordered).length, sessions: mapped };
}

async function analytics(env, days) {
  const since = now() - days * 86400;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).all().then((r) => r.results);
  const [funnel, left, daily, sources, devices, orders, msgs, leads] = await Promise.all([
    q('SELECT max_step, COUNT(*) n FROM sessions WHERE first_seen>? GROUP BY max_step', since),
    q('SELECT max_step, COUNT(*) n, COALESCE(SUM(cart_value),0) v FROM sessions WHERE first_seen>? AND ordered=0 GROUP BY max_step', since),
    q(`SELECT ((created_at+${IST})/86400) d, COUNT(*) n, SUM(total_paise) v, SUM(CASE WHEN method='cod' THEN 1 ELSE 0 END) cod FROM orders WHERE created_at>? AND status NOT IN ('pending_payment','failed','completing','cancelled') GROUP BY 1 ORDER BY 1`, since),
    q("SELECT COALESCE(source,'direct') s, COUNT(*) sessions, SUM(ordered) orders FROM sessions WHERE first_seen>? GROUP BY 1 ORDER BY 2 DESC LIMIT 8", since),
    q("SELECT COALESCE(NULLIF(device,''),'unknown') d, COUNT(*) sessions, SUM(ordered) orders FROM sessions WHERE first_seen>? GROUP BY 1", since),
    q("SELECT method, status, COUNT(*) n, SUM(total_paise) v FROM orders WHERE created_at>? AND status NOT IN ('pending_payment','failed','completing') GROUP BY 1,2", since),
    q('SELECT trigger, status, COUNT(*) n FROM messages WHERE ts>? AND direction=\'out\' GROUP BY 1,2', since),
    q("SELECT COUNT(*) n FROM leads WHERE status='open' AND updated_at>?", since),
  ]);
  const byStep = Array(8).fill(0);
  funnel.forEach((r) => { byStep[num(r.max_step)] = num(r.n); });
  const reached = byStep.map((_, i) => byStep.slice(i).reduce((s, x) => s + x, 0));
  const kept = orders.filter((o) => o.status !== 'cancelled');
  const rev = kept.reduce((s, o) => s + num(o.v), 0);
  const cnt = kept.reduce((s, o) => s + num(o.n), 0);
  return {
    days, funnel: STEPS.map((s, i) => ({ step: s, label: STEP_LABEL[s], n: reached[i] })),
    left: STEPS.map((s, i) => { const r = left.find((x) => num(x.max_step) === i); return { step: s, label: STEP_LABEL[s], n: r ? num(r.n) : 0, value: r ? num(r.v) / 100 : 0 }; }).filter((x) => x.step !== 'done'),
    daily: daily.map((r) => ({ day: new Date(num(r.d) * 86400000).toISOString().slice(0, 10), orders: num(r.n), revenue: num(r.v) / 100, cod: num(r.cod) })),
    sources, devices,
    kpi: {
      orders: cnt, revenue: rev / 100, aov: cnt ? rev / cnt / 100 : 0, cod: kept.filter((o) => o.method === 'cod').reduce((s, o) => s + num(o.n), 0), prepaid: kept.filter((o) => o.method !== 'cod').reduce((s, o) => s + num(o.n), 0),
      cancelled: orders.filter((o) => o.status === 'cancelled').reduce((s, o) => s + num(o.n), 0), sessions: reached[0], conv: reached[0] ? (cnt / reached[0]) * 100 : 0, open_leads: num(leads[0]?.n),
    },
    messages: msgs,
  };
}

/**
 * Mark a booked order fulfilled in Shopify (tracking = the Shiprocket AWB) and send the WhatsApp "shipped" message.
 * Never throws: returns '' when done, otherwise the reason (also saved on the shipment so the dashboard can show it).
 */
/**
 * Mark orders packed (or not). Only orders that are not shipped / cancelled. The Shopify order gets a "packed" tag
 * so the state is visible there too (best effort). Returns per-order results.
 */
export async function packOrders(env, ids, packed) {
  ids = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))].slice(0, 200);
  if (!ids.length) throw new Error('Select at least one order');
  const rows = (await env.DB.prepare(`SELECT order_id, order_name, status, shipped_at, packed_at FROM orders WHERE order_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results;
  const booked = await bookedMap(env).catch(() => ({}));
  const t = now(), results = [];
  for (const id of ids) {
    const o = rows.find((r) => String(r.order_id) === id);
    if (!o) { results.push({ id, name: id, ok: false, note: 'Order not found' }); continue; }
    if (o.status === 'cancelled') { results.push({ id, name: o.order_name, ok: false, note: 'Cancelled' }); continue; }
    if (booked[id] && booked[id].cancel_state === 'picked') { results.push({ id, name: o.order_name, ok: false, note: 'Already picked up by the courier' }); continue; }
    await env.DB.prepare('UPDATE orders SET packed_at=? WHERE order_id=?').bind(packed ? t : null, id).run();
    const gid = `gid://shopify/Order/${id}`;
    try { if (packed) await addTags(env, gid, ['packed']); else await removeTags(env, gid, ['packed']); } catch { /* tag is cosmetic */ }
    results.push({ id, name: o.order_name, ok: true, note: packed ? 'Packed' : 'Not packed' });
  }
  return results;
}

/** Cancel one order: Shiprocket pickup first (never after the courier has it), then the Shopify order. Throws with a plain reason. */
async function cancelOne(env, id) {
  const gid = `gid://shopify/Order/${id}`;
  const stop = await stopShipment(env, id, 'Cancelled from the dashboard');
  if (stop.state === 'picked') throw new Error('The courier has already picked this parcel up, so it cannot be cancelled here. Ask Shiprocket for RTO.');
  if (stop.state === 'error') throw new Error('The Shiprocket shipment could not be cancelled yet (' + stop.note + '). Nothing was changed; try again in a minute.');
  await cancelOrder(env, gid, 'Cancelled from Ink Kulture dashboard');
  await env.DB.prepare("UPDATE orders SET status='cancelled', packed_at=NULL WHERE order_id=?").bind(String(id)).run();
}

/** Live (not cancelled) shipment rows for these order ids. */
async function shipRecs(env, ids, max) {
  ids = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))].slice(0, max);
  if (!ids.length) throw new Error('Select at least one shipment');
  return (await env.DB.prepare(`SELECT * FROM shipments WHERE order_id IN (${ids.map(() => '?').join(',')}) AND awb IS NOT NULL AND awb<>'' AND COALESCE(status,'')<>'cancelled'`).bind(...ids).all()).results;
}

/** The WhatsApp tracking row follows the live AWB: a new AWB (rebook) restarts it, the same AWB leaves it alone. */
async function syncTrackRow(env, id, awb, courier) {
  const t = now();
  await env.DB.prepare(`INSERT INTO ship_track (order_id, awb, courier, url, status, sent, checked_at, done, updated_at) VALUES (?,?,?,?,NULL,'{}',0,FALSE,?)
    ON CONFLICT (order_id) DO UPDATE SET awb=excluded.awb, courier=excluded.courier, url=excluded.url, status=NULL, sent='{}', checked_at=0, done=FALSE, updated_at=excluded.updated_at
    WHERE ship_track.awb IS DISTINCT FROM excluded.awb OR ship_track.done = TRUE`).bind(String(id), String(awb), courier, `https://shiprocket.co/tracking/${awb}`, t).run().catch(() => {});
}

/**
 * Make Shopify show this order as shipped with the live Shiprocket AWB. Idempotent:
 *  - not fulfilled yet            -> fulfilmentCreate
 *  - fulfilled with the same AWB  -> nothing to do
 *  - fulfilled with another AWB   -> after a rebook: retarget the fulfilment's tracking to the new AWB (or undo + refulfil)
 * Returns '' on success or the reason it could not (kept on the shipment row; the cron retries).
 */
export async function fulfilBooked(env, id) {
  const rec = await env.DB.prepare('SELECT * FROM shipments WHERE order_id=?').bind(String(id)).first();
  if (!rec?.awb) return 'No Shiprocket AWB for this order yet';
  const courier = rec.courier || 'Shiprocket', awb = String(rec.awb), url = `https://shiprocket.co/tracking/${awb}`;
  let err = '';
  try { await ACTIONS.ship(env, { id, company: courier, number: awb, url, notify: false }); }
  catch (e) {
    err = String(e.message || e);
    if (/Nothing left to fulfil/.test(err)) {
      try {
        const f = await activeFulfilments(env, String(id));
        const same = f.list.find((x) => x.numbers.includes(awb)), other = f.list.find((x) => !x.numbers.includes(awb));
        if (!same && other) {                                    // rebooked: Shopify still carries the old AWB
          try { await updateTracking(env, other.id, { company: courier, number: awb, url }); }
          catch (e2) {
            if (!/Access denied/i.test(String(e2.message))) throw e2;
            await cancelFulfilmentsFor(env, String(id), other.numbers[0]);     // may need write_fulfillments; its own message explains
            await shipOrder(env, String(id), { company: courier, number: awb, url, notify: false });
          }
        }
        if (same || other || (f.status && f.status !== 'UNFULFILLED')) err = '';   // Shopify shows it shipped (with this AWB where it can)
      } catch (e3) { err = String(e3.message || e3); }
    }
  }
  if (!err) {
    await env.DB.prepare('UPDATE orders SET shipped_at=COALESCE(shipped_at, ?), tracking=? WHERE order_id=?').bind(now(), `${courier} ${awb}`, String(id)).run();
    await syncTrackRow(env, id, awb, courier);
  }
  await env.DB.prepare('UPDATE shipments SET fulfil_error=? WHERE order_id=?').bind(err ? err.slice(0, 400) : null, String(id)).run();
  return err;
}

const ACTIONS = {
  async live(env) { return liveData(env); },
  async analytics(env, b) { return analytics(env, Math.min(90, Math.max(1, +b.days || 7))); },
  async orders(env, b) {
    const [all, booked] = await Promise.all([recentOrders(env, 90), bookedMap(env).catch(() => ({}))]);
    /* orders cancelled in Shopify / by another COD app: catch them now (user-triggered loads only; the cron does the rest) */
    if (b.fresh) {
      try {
        const open = all.filter((o) => !o.shipped_at && !booked[String(o.order_id)] && o.status !== 'cancelled' && o.order_id).slice(0, 150).map((o) => String(o.order_id));
        const gone = new Set(await syncCancelledOrders(env, open));
        all.forEach((o) => { if (gone.has(String(o.order_id))) o.status = 'cancelled'; });
        /* ... and orders Shopify already shows as fulfilled (shipped another way): they leave "To ship" too */
        const shipped = new Set(await syncFulfilledOrders(env, open.filter((id) => !gone.has(id))));
        all.forEach((o) => { if (shipped.has(String(o.order_id))) { o.shipped_at = o.shipped_at || now(); o.tracking = o.tracking || 'Fulfilled in Shopify'; } });
      } catch (e) { console.error('orders cancel sync', e.message); }
    }
    let list = all.map((o) => {
      const x = orderOut(o, all), s = booked[String(o.order_id)];
      if (s) { x.booked = true; x.awb = s.awb; x.courier = s.courier; x.fulfil_error = s.fulfil_error || ''; }
      x.shipped = !!(x.shipped_at || x.booked);   // shipped_at is only set once Shopify is fulfilled; a booked AWB is shipped too
      return x;
    });
    /* chip counts on the Orders tab: confirmed (or prepaid) but not shipped, and COD still waiting for confirmation */
    const live = list.filter((o) => !o.shipped && o.status !== 'cancelled');
    const counts = { toship: live.filter((o) => o.method !== 'cod' || o.confirmed_at).length, unconfirmed: live.filter((o) => o.method === 'cod' && !o.confirmed_at).length, collab: list.filter((o) => o.collab && o.status !== 'cancelled').length };
    if (b.filter === 'collab') list = list.filter((o) => o.collab);
    if (b.filter === 'high') list = list.filter((o) => o.level === 'high');
    if (b.filter === 'toship') list = list.filter((o) => !o.shipped && o.status !== 'cancelled' && (o.method !== 'cod' || o.confirmed_at));
    if (b.filter === 'unshipped') list = list.filter((o) => !o.shipped && o.status !== 'cancelled').map((o) => ({ ...o, ready: o.method !== 'cod' || !!o.confirmed_at }));
    if (b.filter === 'unconfirmed') list = list.filter((o) => o.method === 'cod' && !o.confirmed_at && !o.shipped && o.status !== 'cancelled');
    let profit = null;
    if (b.filter === 'shipped') {
      list = list.filter((o) => o.shipped);
      /* expected profit per shipped order: revenue - items x product cost - CAC - the parcel's Shiprocket charge (assumes it is delivered) */
      const pf = (env.SETTINGS || await getSettings(env)).profit || { unit_cost: 40, cac: 80 };
      const unitCost = num(pf.unit_cost), cac = num(pf.cac);
      const sum = { n: 0, revenue: 0, units: 0, product: 0, cac: 0, shipping: 0, net: 0, known: 0, unknown: 0, collab: 0 };
      /* no Shiprocket charge on record (shipped another way): use the average of the known charges so the order still counts */
      const knownCharges = list.map((o) => booked[String(o.id)]).filter((s) => s && s.charge_paise != null && num(s.charge_paise) > 0).map((s) => num(s.charge_paise) / 100);
      const estShip = knownCharges.length ? Math.round(knownCharges.reduce((a, c) => a + c, 0) / knownCharges.length) : num(pf.ship_estimate) || 65;
      list.forEach((o) => {
        const row = all.find((x) => String(x.order_id) === String(o.id)) || {};
        let units = 0; try { units = JSON.parse(row.contents_json || '[]').reduce((s, c) => s + (Number(c.quantity) || 0), 0); } catch { units = 0; }
        if (!units) units = 1;
        const known = booked[String(o.id)] && booked[String(o.id)].charge_paise != null && num(booked[String(o.id)].charge_paise) > 0;
        const ship = known ? num(booked[String(o.id)].charge_paise) / 100 : estShip;
        const oCac = o.collab ? 0 : cac;   /* a barter collab came from a creator, not from paid ads */
        const product = units * unitCost, net = Math.round((o.total - product - oCac - ship) * 100) / 100;
        o.profit = { units, product, cac: oCac, shipping: ship, net, est: !known };
        sum.n++; sum.revenue += o.total; sum.units += units; sum.product += product; sum.cac += oCac; sum.shipping += ship; sum.net += net;
        if (known) sum.known++; else sum.unknown++;
        if (o.collab) sum.collab++;
      });
      profit = { ...sum, unit_cost: unitCost, cac_per_order: cac, ship_estimate: estShip, avg: sum.n ? Math.round(sum.net / sum.n) : 0 };
      Object.keys(profit).forEach((k) => { if (typeof profit[k] === 'number') profit[k] = Math.round(profit[k] * 100) / 100; });
    }
    if (b.filter === 'packed') list = list.filter((o) => o.packed_at && o.status !== 'cancelled');
    if (b.q) { const q = String(b.q).toLowerCase(); list = list.filter((o) => `${o.name} ${o.phone} ${o.customer} ${o.pincode}`.toLowerCase().includes(q)); }
    return { orders: list.slice(0, 200), profit, counts };
  },
  async order(env, b) {
    const all = await recentOrders(env, 365);
    const o = all.find((x) => String(x.order_id) === String(b.id));
    if (!o) throw new Error('Order not found');
    const r = scoreOrder(o, all);
    let shop = null;
    try { shop = await orderDetail(env, o.order_id); } catch (e) { shop = { error: String(e.message || e) }; }
    const msgs = (await env.DB.prepare('SELECT ts,direction,trigger,template,status,error FROM messages WHERE phone=? ORDER BY ts DESC LIMIT 15').bind(o.phone).all()).results;
    const sess = o.sid ? await env.DB.prepare('SELECT source,device,first_seen,page FROM sessions WHERE sid=?').bind(o.sid).first() : null;
    return { order: orderOut(o, all), risk: r, shop, messages: msgs, session: sess };
  },
  async pack(env, b) {
    const results = await packOrders(env, b.ids, b.packed !== false);
    /* auto-print: the labels of the orders just marked packed go to the packing Mac's printer (lib/print-agent.js) */
    let printing = 0;
    if (b.packed !== false && b.server_print !== false) { try { const { onPacked } = await import('./print-agent.js'); printing = await onPacked(env, results); } catch (e) { console.error('auto print', e.message); } }
    return { ok: true, results, printing };
  },
  /** Label printer: status, setting, setup command, recent jobs. */
  async printer_info(env) {
    const P = await import('./print-agent.js');
    const s = await P.printerState(env);
    const base = String(env.WORKER_URL || '').replace(/\/$/, '');
    return { ok: true, auto: s.auto, tune: await P.printTune(env), ready: !!(s.key || s.stationOn), online: s.online, seen: s.seen, station: s.stationOn ? s.station : null, command: s.key && base ? P.setupCommand(base, s.key) : '', jobs: await P.recentJobs(env) };
  },
  /** Make (or with fresh, replace) the agent key and return the setup command. */
  async printer_setup(env, b) {
    const P = await import('./print-agent.js');
    const base = String(env.WORKER_URL || '').replace(/\/$/, '');
    if (!/^https:\/\//.test(base)) throw new Error('WORKER_URL (this app\'s https address) is not set');
    const key = await P.printerKey(env, !!b.fresh);
    return { ok: true, command: P.setupCommand(base, key) };
  },
  async printer_auto(env, b) { const P = await import('./print-agent.js'); await P.setAuto(env, !!b.on); return { ok: true }; },
  /** Bluetooth print quality (darkness, speed, size, direction): the packing Mac picks it up within 10 minutes. */
  async printer_tune(env, b) { const P = await import('./print-agent.js'); return { ok: true, tune: await P.setTune(env, b || {}) }; },
  /** Send labels to the printer now (order drawer / Shipments bar / reprint). */
  async print_labels(env, b) {
    const P = await import('./print-agent.js');
    const s = await P.printerState(env);
    if (!s.key && !s.stationOn) throw new Error('Set up the label printer first (Settings, Label printer)');
    const n = await P.enqueuePrint(env, b.ids, 'manual');
    return { ok: true, queued: n, online: s.online || s.stationOn };
  },
  async printer_test(env) {
    const P = await import('./print-agent.js');
    const s = await P.printerState(env);
    if (!s.key && !s.stationOn) throw new Error('Set up the label printer first');
    await env.DB.prepare('INSERT INTO print_jobs (order_id, order_name, reason, created_at, tries) VALUES (?,?,?,?,0)').bind('', 'test', 'Test from the dashboard', now()).run();
    return { ok: true, online: s.online || s.stationOn };
  },
  /** Print station (a phone / computer with the Bluetooth printer): report the last label, check in, take the next one. */
  async print_station(env, b) {
    const P = await import('./print-agent.js');
    if (b.done) await P.jobDone(env, b.done, !!b.ok, b.msg);
    await P.stationBeat(env, String(b.name || 'Bluetooth printer'), !!b.off);
    if (b.off) return { ok: true, job: null };
    const job = await P.nextJob(env);
    if (!job) return { ok: true, job: null };
    return { ok: true, job: { id: job.id, order: job.order, pdf: Buffer.from(job.pdf).toString('base64') } };
  },
  /** Which Shopify app the dashboard token belongs to, and the scopes it really has (so a missing one can be named). */
  async shopify_scopes(env) {
    const d = await gql(env, '{ currentAppInstallation { app { title } accessScopes { handle } } shop { myshopifyDomain } }');
    const scopes = (d.currentAppInstallation?.accessScopes || []).map((x) => x.handle).sort();
    const need = ['write_fulfillments', 'write_merchant_managed_fulfillment_orders', 'write_orders', 'read_orders', 'write_draft_orders', 'read_products', 'write_products'];
    return { ok: true, app: d.currentAppInstallation?.app?.title || '', shop: d.shop?.myshopifyDomain || '', scopes, missing: need.filter((x) => !scopes.includes(x)) };
  },
  /* ---- WhatsApp assistant ---- */
  async save_ai(env, b) {
    const s = await getSettings(env, true);
    const a = { ...s.ai };
    if (b.enabled !== undefined) a.enabled = !!b.enabled;
    const { PROVIDERS, aiCfg } = await import('./wa-ai.js');
    if (b.provider !== undefined && PROVIDERS[b.provider]) { if (b.provider !== a.provider) { a.key = ''; a.model = ''; } a.provider = b.provider; }
    if (b.key !== undefined && !String(b.key).startsWith('••')) a.key = String(b.key).trim();
    if (b.model !== undefined) a.model = String(b.model).trim().slice(0, 100);
    if (b.knowledge !== undefined) a.knowledge = String(b.knowledge).slice(0, 12000);
    if (b.rpm !== undefined) a.rpm = Math.max(1, Math.min(100, Number(b.rpm) || 20));
    if (b.rpd !== undefined) a.rpd = Math.max(10, Math.min(20000, Number(b.rpd) || 800));
    if (a.enabled && !aiCfg({ ...env, SETTINGS: { ...s, ai: a } }).key) throw new Error('Paste the ' + PROVIDERS[a.provider || 'groq'].label.split(' (')[0] + ' API key first.');
    await putSetting(env, 'ai', a);
    return { ok: true };
  },
  /** Send one free-text WhatsApp message now and return the provider's own answer (diagnoses "sent but not received"). */
  async wa_text_test(env, b) {
    const to = digits(b.to).slice(-10);
    if (to.length !== 10) throw new Error('Enter a 10-digit number');
    const { sendText, viaG4w } = await import('./whatsapp.js');
    const fresh = await withSettingsFresh(env);
    const { withSettings } = await import('./settings.js');
    const e2 = await withSettings(fresh);
    const text = String(b.text || 'Test message from Ink Kulture').slice(0, 1000);
    const res = await sendText(e2, '91' + to, text);
    await logMsg(e2, { direction: 'out', phone: to, trigger: 'ai-test', status: res.ok ? 'accepted' : 'failed', wamid: res.id || '', error: res.ok ? '' : `${res.via}: ${res.error}`, preview: text });
    const lastIn = await env.DB.prepare("SELECT ts FROM messages WHERE phone=? AND direction='in' ORDER BY ts DESC LIMIT 1").bind(to).first().catch(() => null);
    return { ok: true, sent: res.ok, via: res.via || (viaG4w(e2) ? 'g4w' : 'meta'), id: res.id || '', error: res.error || '', last_in: Number(lastIn?.ts) || null };
  },
  /* ---- Chats tab (lib/inbox.js): chats the assistant handed off, unanswered messages, manual replies ---- */
  async inbox_list(env, b) { const { inboxList } = await import('./inbox.js'); return { ok: true, chats: await inboxList(env, { filter: ['needs', 'handoff', 'all'].includes(b.filter) ? b.filter : 'needs', q: String(b.q || '').slice(0, 60) }) }; },
  async inbox_count(env) { const { inboxCount } = await import('./inbox.js'); return { ok: true, ...(await inboxCount(env)) }; },
  async inbox_thread(env, b) { const { inboxThread } = await import('./inbox.js'); return { ok: true, ...(await inboxThread(await withSettingsFresh(env), b.phone)) }; },
  async inbox_send(env, b) {
    const { inboxSend } = await import('./inbox.js');
    const { withSettings } = await import('./settings.js');
    return inboxSend(await withSettings(await withSettingsFresh(env)), b.phone, b.text, { done: !!b.done });
  },
  /** done: hand the chat back to the assistant. takeover: keep the assistant quiet on it (24 h, renewed by each reply). */
  async inbox_state(env, b) {
    const { resolveHandoff, openHandoff } = await import('./inbox.js');
    if (b.state === 'done') await resolveHandoff(env, b.phone); else await openHandoff(env, b.phone, 'taken over by the team');
    return { ok: true };
  },
  /** Customers whose last plain-text message has no answer yet, with today's usage and limits. */
  async ai_backlog(env) {
    const { backlog, budget } = await import('./wa-ai.js');
    const fresh = await withSettingsFresh(env);
    return { ok: true, rows: await backlog(fresh), budget: await budget(fresh) };
  },
  /** Queue these phones for an answer (only those still inside WhatsApp's window are accepted). */
  async ai_enqueue(env, b) {
    const { enqueue, backlog } = await import('./wa-ai.js');
    const fresh = await withSettingsFresh(env);
    const ok = new Set((await backlog(fresh)).filter((r) => r.in_window).map((r) => r.phone));
    const phones = (Array.isArray(b.phones) ? b.phones : []).map((p) => digits(p).slice(-10)).filter((p) => ok.has(p)).slice(0, 100);
    for (const p of phones) await enqueue(fresh, p, null, 'backlog');
    return { ok: true, queued: phones.length };
  },
  /** Answer a few queued phones now (the dashboard calls this repeatedly, showing progress). */
  async ai_drain(env) {
    const { withSettings } = await import('./settings.js');
    const { drainQueue } = await import('./wa-ai.js');
    return { ok: true, ...(await drainQueue(await withSettings(await withSettingsFresh(env)), { max: 4, gapMs: 3000 })) };
  },
  /** The models the saved key can use, with the one the assistant would pick. */
  async ai_models(env) {
    const { listModels, pickModel, aiCfg } = await import('./wa-ai.js');
    const fresh = await withSettingsFresh(env);
    const ids = await listModels(fresh);
    return { ok: true, models: ids, current: aiCfg(fresh).model, suggested: pickModel(ids, aiCfg(fresh).provider) };
  },
  /** Try the assistant without sending anything: { text, phone? } -> its reply, with the order context it saw. */
  async ai_test(env, b) {
    const { aiAnswer, customerOrders, aiCfg } = await import('./wa-ai.js');
    const fresh = await withSettingsFresh(env);
    if (!aiCfg(fresh).key) throw new Error('No API key saved yet');
    const phone = digits(b.phone).slice(-10);
    const a = await aiAnswer(fresh, { phone, text: String(b.text || 'How long does it last?') });
    return { ok: true, reply: a.text, handoff: a.handoff, usage: a.usage, model: a.model, switched: a.switched, orders: phone ? await customerOrders(fresh, phone).catch(() => '') : '' };
  },
  async save_profit(env, b) {
    const unit_cost = Number(b.unit_cost), cac = Number(b.cac);
    if (!(unit_cost >= 0 && unit_cost < 100000) || !(cac >= 0 && cac < 100000)) throw new Error('Enter amounts in rupees');
    await putSetting(env, 'profit', { unit_cost, cac });
    return { ok: true };
  },
  /** Re-rank the main collections now (lib/ranking.js); also runs daily on the cron. */
  async rank_now(env) {
    const { rankAll } = await import('./ranking.js');
    return { ok: true, status: await rankAll(env, { force: true }) };
  },
  /** Meta tracking: real orders vs Purchases Meta accepted, the pixel they go to, and what Meta says about it. */
  async meta_status(env, b) {
    const fresh = await withSettingsFresh(env);
    const c = metaCfg(fresh);
    const days = Math.max(1, Math.min(60, Number(b.days) || 14));
    const [stats, info, envInfo, due] = await Promise.all([
      capiStats(fresh, days),
      pixelInfo(fresh, c.pixelId),
      env.META_PIXEL_ID && env.META_PIXEL_ID !== c.pixelId ? pixelInfo(fresh, env.META_PIXEL_ID) : null,
      resendDue(fresh, { anyTries: true }),
    ]);
    return { ok: true, pixel: c.pixelId, env_pixel: env.META_PIXEL_ID || '', test_code: c.testCode, env_test_ignored: !!env.META_TEST_EVENT_CODE, browser: c.browser, token: !!c.token,
      info, env_info: envInfo, resend_due: due.length, ...stats };
  },
  async save_meta(env, b) {
    const s = await getSettings(env, true);
    const m = { ...META_DEFAULTS, ...(s.meta || {}) };
    if (b.pixel_id !== undefined) {
      const id = String(b.pixel_id || '').replace(/\D/g, '');
      if (id && !/^\d{10,20}$/.test(id)) throw new Error('A Meta pixel / dataset ID is 15–16 digits');
      m.pixel_id = id;
    }
    if (b.test_code !== undefined) m.test_code = String(b.test_code || '').trim().slice(0, 40);
    if (b.browser !== undefined) m.browser = !!b.browser;
    await putSetting(env, 'meta', m);
    return { ok: true, meta: m };
  },
  /** Send purchases from the last 7 days that never reached the current pixel (rejected, or sent to another pixel). */
  async meta_resend(env) {
    return { ok: true, ...(await resendPurchases(await withSettingsFresh(env), { limit: 400, anyTries: true })) };
  },
  /** Partial COD settings (lib/partial-cod.js). */
  async save_partial(env, b) {
    const c = { ...PARTIAL_DEFAULTS };
    if (!['off', 'test', 'risky', 'all'].includes(b.mode)) throw new Error('Pick a mode');
    c.mode = b.mode;
    c.advance = Math.round(Number(b.advance));
    if (!(c.advance >= 1 && c.advance <= 2000)) throw new Error('Advance must be between ₹1 and ₹2,000');
    c.test_phones = String(b.test_phones || '').split(/[\s,;]+/).map((x) => x.replace(/\D/g, '').slice(-10)).filter((x) => /^[6-9]\d{9}$/.test(x)).join(', ');
    if (c.mode === 'test' && !c.test_phones) throw new Error('Add at least one test mobile number');
    for (const k of ['vague_address', 'rto_pin', 'history']) c[k] = !!b[k];
    c.high_value = Math.max(0, Math.round(Number(b.high_value) || 0));
    c.pins = String(b.pins || '').split(/[\s,;]+/).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 1 && x.length <= 6).join(', ');
    c.rto_rate = Math.max(1, Math.min(100, Math.round(Number(b.rto_rate) || 35)));
    c.rto_min = Math.max(1, Math.min(50, Math.round(Number(b.rto_min) || 2)));
    await putSetting(env, 'partial', c);
    return { ok: true, partial: c };
  },
  /** Try the rules on an address before switching them on: { phone, pincode, address1, address2, total (₹) }. */
  async partial_check(env, b) {
    const fresh = await withSettingsFresh(env);
    if (b.draft) fresh.SETTINGS = { ...fresh.SETTINGS, partial: { ...fresh.SETTINGS.partial, ...b.draft } };
    const total = Math.round((Number(b.total) || 499) * 100);
    const d = await partialDecide(fresh, { phone: cleanPhone(b.phone) || '', pincode: String(b.pincode || ''), address1: String(b.address1 || ''), address2: String(b.address2 || '') }, total);
    return { ok: true, ...d, advance: d.advance / 100, balance: d.balance / 100, reasons: d.reasons.map((r) => ({ key: r, text: partialReason(r) + (r.includes(':') ? ' (' + r.split(':').slice(1).join(':').replace(/_/g, ' ') + ')' : '') })) };
  },
  /** PIN codes with returns over the last 180 days, worst first, and whether the current threshold flags them. */
  async partial_pins(env) {
    const fresh = await withSettingsFresh(env);
    const c = partialCfg(fresh);
    const pins = await riskyPins(fresh, c);
    const stats = (await env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN COALESCE(advance_paise,0)>0 THEN 1 ELSE 0 END) AS p FROM orders WHERE method='cod' AND created_at>? AND status NOT IN ('pending_payment','failed','completing')").bind(now() - 30 * 86400).first()) || {};
    const pend = (await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE COALESCE(advance_paise,0)>0 AND status IN ('pending_payment','failed') AND created_at>?").bind(now() - 30 * 86400).first()) || {};
    return { ok: true, pins, rto_rate: c.rto_rate, rto_min: c.rto_min, last30: { cod: num(stats.n), partial: num(stats.p), dropped: num(pend.n) } };
  },
  /** Packing screen: what goes in each parcel (design image, size, SKU, quantity) and the envelope / roll it needs. */
  async pack_list(env, b) {
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean))].slice(0, 150);
    if (!ids.length) throw new Error('Select at least one order');
    const [items, rows, fresh, booked] = await Promise.all([packingItems(env, ids), env.DB.prepare(`SELECT order_id, method, packed_at, pincode, city, total_paise, advance_paise, converted_at, status FROM orders WHERE order_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all().then((r) => r.results), withSettingsFresh(env), bookedMap(env).catch(() => ({}))]);
    const cfg = packCfg(fresh.SETTINGS?.shipping?.pack);
    return { ok: true, orders: ids.map((id) => {
      const it = items[id], o = rows.find((r) => String(r.order_id) === id) || {};
      if (!it) return { id, missing: true };
      let parcel = ''; try { parcel = packOrder(it.items, cfg).label; } catch { parcel = ''; }
      const s = booked[id] || null;
      return { id, name: it.name, first_name: it.first_name, city: it.city || o.city || '', pincode: o.pincode || '', cod: codDue(o) > 0, advance: num(o.advance_paise) / 100, packed_at: num(o.packed_at) || null, parcel, awb: s ? s.awb : '', courier: s ? s.courier : '',
        items: it.items.map((x) => ({ title: x.title, qty: x.quantity, size: x.variantTitle, sku: x.sku, image: x.image })) };
    }) };
  },
  async confirm(env, b) {
    const gid = `gid://shopify/Order/${b.id}`;
    await removeTags(env, gid, ['cod-unconfirmed']); await addTags(env, gid, ['cod-confirmed', 'Address confirmed']);
    await env.DB.prepare('UPDATE orders SET confirmed_at=?, addr_tagged_at=? WHERE order_id=?').bind(now(), now(), String(b.id)).run();
    return { ok: true };
  },
  async cancel(env, b) { await cancelOne(await withSettingsFresh(env), b.id); return { ok: true }; },
  /** Shipments tab: cancel these orders (Shiprocket pickup first, then Shopify). Per-order results, nothing stops the batch. */
  async cancel_orders(env, b) {
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean))].slice(0, 100);
    if (!ids.length) throw new Error('Select at least one order');
    const fresh = await withSettingsFresh(env), results = [];
    for (const id of ids) {
      const o = await env.DB.prepare('SELECT order_name, status FROM orders WHERE order_id=?').bind(id).first();
      const name = o?.order_name || id;
      if (!o) { results.push({ id, name, ok: false, note: 'Order not found' }); continue; }
      if (o.status === 'cancelled') { results.push({ id, name, ok: false, note: 'Already cancelled' }); continue; }
      try { await cancelOne(fresh, id); results.push({ id, name, ok: true, note: 'Cancelled' }); }
      catch (e) { results.push({ id, name, ok: false, note: String(e.message || e).slice(0, 200) }); }
    }
    return { ok: true, results };
  },
  async ship(env, b) {
    const company = String(b.company || '').trim(), number = String(b.number || '').trim();
    if (!company || !number) throw new Error('Enter courier name and tracking number');
    const o = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(String(b.id)).first();
    if (!o) throw new Error('Order not found');
    try { await shopOrderShip(env, b.id, { company, number, url: String(b.url || '').trim(), notify: b.notify !== false }); }
    catch (e) {
      /* Shopify already shows it shipped with this very number (fulfilled by another app or by hand): just record it here */
      if (!/Nothing left to fulfil/.test(String(e.message))) throw e;
      const f = await activeFulfilments(env, String(b.id));
      if (!f.list.some((x) => x.numbers.includes(number))) throw e;
    }
    await env.DB.prepare('UPDATE orders SET shipped_at=?, tracking=? WHERE order_id=?').bind(now(), `${company} ${number}`, String(b.id)).run();
    const w = b.whatsapp === false ? { ok: false, skipped: 'silent' } : await fireTrigger(env, 'order_shipped', { to: o.phone, vars: { name: o.first_name, order: o.order_name, courier: company, tracking: number }, orderName: o.order_name });
    return { ok: true, whatsapp: w };
  },
  /**
   * What the WhatsApp retargeting brought in (days: 7 / 30 / 90):
   *   abandoned  checkout-reminder messages (trigger abandoned_cart) and the orders the same number placed within 72 h after
   *   convert    COD orders offered the pay-online discount (cod_to_prepaid) and how many paid online
   */
  async retarget_stats(env, b) {
    const days = [7, 30, 90].includes(Number(b?.days)) ? Number(b.days) : 30, since = now() - days * 86400, WIN = 72 * 3600;
    const sent = (await env.DB.prepare("SELECT phone, MIN(ts) AS ts, COUNT(*) AS n FROM messages WHERE trigger='abandoned_cart' AND direction='out' AND COALESCE(status,'') NOT IN ('failed','skipped') AND ts>? GROUP BY phone").bind(since).all()).results;
    const phones = sent.map((r) => r.phone);
    let recovered = [];
    if (phones.length) {
      const orders = (await env.DB.prepare(`SELECT order_name, phone, first_name, total_paise, method, status, created_at, advance_paise FROM orders WHERE phone IN (${phones.map(() => '?').join(',')}) AND created_at>? AND status NOT IN ('pending_payment','failed','completing')`).bind(...phones, since).all()).results;
      const first = Object.fromEntries(sent.map((r) => [r.phone, num(r.ts)]));
      const seen = new Set();
      recovered = orders.filter((o) => { const t = first[o.phone]; return t && num(o.created_at) > t && num(o.created_at) - t < WIN; })
        .sort((a, c) => num(c.created_at) - num(a.created_at))
        .filter((o) => { const k = o.phone; if (seen.has(k)) return false; seen.add(k); return true; })   // one recovery per person
        .map((o) => ({ name: o.order_name, customer: o.first_name || '', total: num(o.total_paise) / 100, method: num(o.advance_paise) > 0 ? 'partial' : o.method, cancelled: o.status === 'cancelled', hours: Math.max(0, Math.round((num(o.created_at) - first[o.phone]) / 3600)), at: num(o.created_at) }));
    }
    const kept = recovered.filter((o) => !o.cancelled);
    const conv = (await env.DB.prepare("SELECT COUNT(*) AS offered, SUM(CASE WHEN converted_at IS NOT NULL THEN 1 ELSE 0 END) AS paid, SUM(CASE WHEN converted_at IS NOT NULL THEN COALESCE(paid_paise,0) ELSE 0 END) AS paise FROM orders WHERE convert_offer_at>?").bind(since).first()) || {};
    return { ok: true, days,
      abandoned: { reminded: sent.length, recovered: kept.length, cancelled: recovered.length - kept.length, revenue: Math.round(kept.reduce((a, o) => a + o.total, 0)), rate: sent.length ? Math.round((kept.length * 1000) / sent.length) / 10 : 0, orders: recovered.slice(0, 30) },
      convert: { offered: num(conv.offered), paid: num(conv.paid), revenue: Math.round(num(conv.paise) / 100), rate: num(conv.offered) ? Math.round((num(conv.paid) * 1000) / num(conv.offered)) / 10 : 0 } };
  },
  async leads(env) {
    const rows = (await env.DB.prepare("SELECT phone,name,pincode,cart_json,utm_json,step,updated_at,nudged_at FROM leads WHERE status='open' AND updated_at>? ORDER BY updated_at DESC LIMIT 200").bind(now() - 7 * 86400).all()).results;
    return { leads: rows.map((l) => ({ ...l, cart: JSON.parse(l.cart_json || '[]').length, updated_at: num(l.updated_at), nudged_at: num(l.nudged_at) || null })) };
  },
  /* Manual nudge from the Abandoned or Live tab. Works even when automatic nudges are switched off. */
  async nudge(env, b) {
    const phone = cleanPhone(b.phone);
    if (!phone) throw new Error('No valid phone number');
    const l = await env.DB.prepare('SELECT * FROM leads WHERE phone=?').bind(phone).first();
    const sess = l ? null : await env.DB.prepare('SELECT name FROM sessions WHERE phone=? ORDER BY last_seen DESC LIMIT 1').bind(phone).first();
    const name = String((l?.name || sess?.name || '').split(' ')[0] || 'there');
    const done = await env.DB.prepare("SELECT order_name FROM orders WHERE phone=? AND created_at>? AND status NOT IN ('pending_payment','failed') ORDER BY created_at DESC LIMIT 1").bind(phone, now() - 6 * 3600).first();
    if (done && !b.anyway) throw new Error(`This customer already ordered (${done.order_name}) in the last 6 hours`);
    const r = await fireTrigger(env, 'abandoned_cart', { to: phone, vars: { name, items: 'your Ink Kulture cart', link: await cartLink(env, phone) }, force: true });
    if (r.skipped) throw new Error(r.skipped === 'nowa' ? 'WhatsApp is not connected yet' : r.skipped === 'optout' ? 'This customer replied STOP to WhatsApp offers' : r.skipped === 'nophone' ? 'No phone' : 'Not sent: ' + r.skipped);
    if (!r.ok) throw new Error('WhatsApp refused it: ' + (r.error || 'see the message log'));
    if (l) await env.DB.prepare('UPDATE leads SET nudged_at=? WHERE phone=?').bind(now(), phone).run();
    return { ok: true, template: r.template };
  },
  async messages(env) {
    return { messages: (await env.DB.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 150').all()).results };
  },
  async settings(env) {
    const cronAt = Number((await env.DB.prepare("SELECT v FROM settings WHERE k='cron_at'").first().catch(() => null))?.v) || 0, cronVia = String((await env.DB.prepare("SELECT v FROM settings WHERE k='cron_via'").first().catch(() => null))?.v || '').replace(/"/g, '');
    const s = await getSettings(env, true);
    const w = s.wa;
    return {
      cron_at: cronAt, cron_via: cronVia,
      profit: s.profit,
      partial: partialCfg({ SETTINGS: s }),
      rank: await (async () => { try { return JSON.parse((await env.DB.prepare("SELECT v FROM settings WHERE k='rank_status'").first())?.v || 'null'); } catch { return null; } })(),
      ai: await (async () => { const { PROVIDERS, aiCfg, DEFAULT_KNOWLEDGE } = await import('./wa-ai.js'); const c = aiCfg({ ...env, SETTINGS: s }); return { enabled: !!s.ai.enabled, provider: c.provider, key: mask(s.ai.key), has_key: !!c.key, model: c.model, rpm: Number(s.ai.rpm) || 20, rpd: Number(s.ai.rpd) || 800, knowledge: s.ai.knowledge || '', default_knowledge: DEFAULT_KNOWLEDGE, providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, model: v.model, keyUrl: v.keyUrl, free: v.free }])) }; })(),
      wa: { phone_id: w.phone_id, waba_id: w.waba_id, admin_phone: w.admin_phone, lang: w.lang, token: mask(w.token), app_secret: mask(w.app_secret), verify_token: w.verify_token, has_token: !!(w.token || env.WA_TOKEN), connected: !!((w.phone_id || env.WA_PHONE_ID) && (w.token || env.WA_TOKEN)) || viaG4w(env) },
      webhook: 'https://ik-checkout.vercel.app/api/wa/webhook',
      /* Go4WhatsUp (BSP) takes over sending as soon as G4W_API_KEY + G4W_SECURE_KEY are set in Vercel. */
      transport: viaG4w({ ...env, SETTINGS: s }) ? 'g4w' : 'meta',
      /* which Meta fields are still empty in the dashboard */
      meta_missing: [['phone_id', 'Phone number ID'], ['waba_id', 'WhatsApp Business Account ID'], ['token', 'Permanent access token'], ['app_secret', 'App secret']].filter(([k]) => !w[k]).map(([, l]) => l),
      g4w: { on: viaG4w({ ...env, SETTINGS: s }), webhook: env.G4W_WEBHOOK_SECRET ? `${String(env.WORKER_URL || 'https://ik-checkout.vercel.app').replace(/\/$/, '')}/api/wa/g4w?k=${env.G4W_WEBHOOK_SECRET}` : '',
        ids: Object.entries(s.g4w_ids || {}).map(([n, id]) => n + ' = ' + id).join('\n'),
        header_image: !!env.WA_HEADER_IMAGE, autocancel_hours: Number(env.COD_AUTOCANCEL_HOURS || 0), convert_hours: Number(env.COD_CONVERT_HOURS || 0), convert_pct: Number(env.COD_CONVERT_DISCOUNT || 10) },
      triggers: Object.entries(TRIGGERS).map(([key, t]) => ({ key, label: t.label, to: t.to, when: t.when, buttons: !!t.buttons, allVars: t.vars, ...triggerConfig({ ...env, SETTINGS: s }, key) })),
      var_labels: VAR_LABELS,
      upsells: s.upsells, upi_logos: s.upi_logos, email: s.admin?.email,
      shipping: { origin_pin: s.shipping.origin_pin, weight_g: s.shipping.weight_g, connected: !!(s.shipping.shiprocket_email && s.shipping.shiprocket_password),
        shiprocket_email: s.shipping.shiprocket_email, shiprocket_password: mask(s.shipping.shiprocket_password), shiprocket_ok: !!(s.shipping.shiprocket_email && s.shipping.shiprocket_password), shiprocket_couriers: s.shipping.shiprocket_couriers,
        policy: s.shipping.policy, tolerance_days: s.shipping.tolerance_days,
        sr_pickup: s.shipping.sr_pickup || '', sr_fallback_email: s.shipping.sr_fallback_email || '', pack: packUi(s.shipping.pack) },
    };
  },
  async save_shipping(env, b) {
    const s = await getSettings(env, true);
    const sh = { ...s.shipping };
    if (b.origin_pin !== undefined && /^\d{6}$/.test(String(b.origin_pin).trim())) sh.origin_pin = String(b.origin_pin).trim();
    if (b.weight_g !== undefined) sh.weight_g = Math.max(10, Math.min(5000, +b.weight_g || 50));
    if (b.shiprocket_email !== undefined) sh.shiprocket_email = String(b.shiprocket_email).trim().slice(0, 200);
    if (b.shiprocket_password && !String(b.shiprocket_password).startsWith('••')) sh.shiprocket_password = String(b.shiprocket_password).trim();
    if (b.shiprocket_block !== undefined) sh.shiprocket_block = String(b.shiprocket_block).replace(/[^\w |,&.-]/g, '').trim().slice(0, 200);
    for (const k of ['shiprocket_couriers']) {
      if (b[k] === undefined) continue;
      const v = String(b[k]).trim().slice(0, 200);
      try { if (v) new RegExp(v, 'i'); } catch { throw new Error('"' + v + '" is not a valid courier filter. Use names separated by |, like delhivery|xpressbees'); }
      sh[k] = v;
    }
    if (b.sr_pickup !== undefined) sh.sr_pickup = String(b.sr_pickup).trim().slice(0, 120);
    if (b.sr_fallback_email !== undefined) sh.sr_fallback_email = String(b.sr_fallback_email).trim().slice(0, 200);
    if (b.pack && typeof b.pack === 'object') sh.pack = packFromUi(b.pack);
    if (b.policy !== undefined) sh.policy = b.policy === 'fastest' ? 'fastest' : 'cheapest';
    if (b.tolerance_days !== undefined) sh.tolerance_days = Math.max(0, Math.min(10, Math.round(+b.tolerance_days || 0)));
    await putSetting(env, 'shipping', sh);
    return { ok: true };
  },
  async shipping_test(env, b) { // kept for older dashboards: same answer as the rate comparison
    return ACTIONS.shipping_rates(env, { pin: String(b.pin || '').trim() || '411001', cod: true });
  },
  /* Compare every connected carrier for one PIN. Read-only: nothing is booked. */
  async shipping_rates(env, b) {
    const pin = String(b.pin || '').trim();
    if (!/^\d{6}$/.test(pin)) throw new Error('Enter a 6-digit PIN code');
    return ratesOut(await runRates(env, { pin, cod: !!b.cod, amount: +b.amount || 499, weight_g: +b.weight_g || 0 }));
  },
  /* ---- Ship from the dashboard with Shiprocket (cheapest courier, automatic parcel size) ---- */
  /** Preview: parcel size, every Shiprocket courier with price + date, and the one that would be booked. Books nothing. */
  async ship_plan(env, b) {
    const { fresh, row, order } = await shipCtx(env, b.id);
    const existing = await env.DB.prepare('SELECT * FROM shipments WHERE order_id=?').bind(String(b.id)).first();
    if (!srConnected(fresh)) throw new Error('Shiprocket is not connected yet. Add the API user login in Settings, Shipping carriers.');
    const plan = await planShipment(fresh, order, row, { pickOption, allowNever: !!b.allow_never });
    return { ok: true, allow_never: !!b.allow_never, only_never: !!plan.onlyNever, pack: plan.pack, pin: plan.pin, cod: plan.cod, pick: plan.pick ? plan.pick.id : '', ready: !!fresh.SETTINGS.shipping.sr_pickup,
      shipment: publicRec(existing && existing.awb && existing.status !== 'cancelled' ? existing : null),
      options: plan.options.map((o) => ({ key: o.id, provider: 'Shiprocket', courier: o.courier, charge: o.charge, cod_fee: o.cod, edd: dayOut(o.eddDate), days: o.eddDate ? Math.max(1, Math.round((o.eddDate - Date.now()) / 86400000)) : null, excluded: o.excluded || '' })),
      fallback: plan.fallback || '', why: plan.why || '', excluded: plan.excluded || [], convert_on: convertCfgOf(fresh).mode === 'on' };
  },
  /** Book it: Shiprocket order -> AWB (cheapest courier) -> pickup -> label, then Shopify fulfilment + WhatsApp. */
  async ship_book(env, b) {
    const { fresh, row, order } = await shipCtx(env, b.id);
    fresh.SETTINGS.shipping = { ...fresh.SETTINGS.shipping, sr_fallback_email: fresh.SETTINGS.shipping.sr_fallback_email || fresh.SETTINGS.admin?.email || '' };
    const r = await bookShipment(fresh, order, row, { pickOption, allowNever: !!b.allow_never });
    /* the AWB exists in Shiprocket either way; Shopify is fulfilled now, or the reason is kept and the cron retries */
    const fulfil = r.already && row.shipped_at ? '' : await fulfilBooked(env, b.id);
    return { ok: true, shipment: r.shipment, already: !!r.already, fulfilment_error: fulfil, note: r.note || '' };
  },
  async sr_docs(env, b) {
    const rec = await env.DB.prepare('SELECT * FROM shipments WHERE order_id=?').bind(String(b.id)).first();
    if (!rec?.sr_shipment_id) throw new Error('This order was not booked from the dashboard');
    const d = await refreshDocs(await withSettingsFresh(env), rec);
    await env.DB.prepare('UPDATE shipments SET label_url=?, pickup=?, updated_at=? WHERE order_id=?').bind(d.label_url, d.pickup, now(), String(b.id)).run();
    return { ok: true, ...d };
  },
  async sr_cancel(env, b) {
    const r = await stopShipment(await withSettingsFresh(env), b.id, 'Shipment cancelled from the dashboard');
    if (r.state === 'none') throw new Error('No live shipment for this order');
    if (r.state === 'picked') throw new Error('The courier has already picked this parcel up, so it cannot be cancelled. Ask Shiprocket for RTO.');
    if (r.state === 'error') throw new Error(r.note);
    return { ok: true, note: r.note };
  },
  async sr_pickups(env) { return { ok: true, pickups: await srPickups(await withSettingsFresh(env)) }; },
  /**
   * Shipments tab. range: today | yesterday | 7d | 30d | all (by booking date, IST); stage: one of STAGES or 'all';
   * q: order / AWB / name / phone. Counts per stage are for the range; "attention" is across all dates.
   */
  async shipments(env, b) {
    const t = now(), DAY = 86400, today0 = Math.floor((t + 19800) / DAY) * DAY - 19800;
    const range = ['today', 'yesterday', '7d', '30d', 'all'].includes(b.range) ? b.range : 'all';
    const from = { today: today0, yesterday: today0 - DAY, '7d': today0 - 6 * DAY, '30d': today0 - 29 * DAY, all: 0 }[range];
    const to = range === 'yesterday' ? today0 : t + DAY;
    /* parcels never checked yet (new bookings, or just after an update): ask Shiprocket now, a few at a time */
    try {
      const fresh = (await env.DB.prepare(`SELECT * FROM shipments WHERE awb IS NOT NULL AND awb<>'' AND COALESCE(status,'')<>'cancelled' AND COALESCE(stage,'') NOT IN ('delivered','lost','cancelled') AND created_at > ?
          AND COALESCE(tracked_at,0) < (CASE WHEN COALESCE(stage,'pickup_pending') IN ('pickup_pending','pickup_failed','ofd','ndr') THEN ?::bigint ELSE ?::bigint END)
          ORDER BY COALESCE(tracked_at,0) LIMIT 24`).bind(t - 45 * DAY, t - 10 * 60, t - 30 * 60).all()).results;
      if (fresh.length) { const fe = await withSettingsFresh(env); let i = 0; await Promise.all(Array.from({ length: Math.min(4, fresh.length) }, async () => { while (i < fresh.length) { const r = fresh[i++]; await refreshShipment(fe, r).catch((e) => console.error('ship first check', r.order_id, e.message)); } })); }
    } catch (e) { console.error('ship first check', e); }
    const rows = (await env.DB.prepare(`SELECT s.*, t.status AS track_status, o.method, o.first_name, o.last_name, o.city, o.pincode, o.total_paise, o.phone, o.packed_at, o.contents_json, o.advance_paise, o.converted_at, o.status AS order_status
        FROM shipments s LEFT JOIN ship_track t ON t.order_id = s.order_id LEFT JOIN orders o ON o.order_id = s.order_id
        WHERE s.awb IS NOT NULL AND s.awb<>'' AND s.created_at > ? ORDER BY s.created_at DESC LIMIT 2000`).bind(t - 90 * DAY).all()).results;
    const all = rows.map((r) => {
      /* not checked yet: only trust an older reading if the parcel was clearly delivered / returned */
      const legacy = stageOf(r.track_status || '');
      const stage = r.status === 'cancelled' ? 'cancelled' : (r.stage || (['delivered', 'rto'].includes(legacy) ? legacy : 'pickup_pending'));
      return { ...publicRec(r), stage, stage_label: STAGE_LABEL[stage] || stage, sr_status: r.sr_status || '', edd: r.edd || '', ndr_choice: r.ndr_choice || '', ndr_date: r.ndr_date || '', total_paise: num(r.total_paise), contents_json: r.contents_json || '',
        cancel_state: r.cancel_state || '', cancel_note: r.cancel_note || '', customer: `${r.first_name || ''} ${r.last_name || ''}`.trim(), city: r.city || '', pincode: r.pincode || '',
        cod: codDue({ ...r, status: r.order_status }) > 0, cod_due: codDue({ ...r, status: r.order_status }) / 100, advance: num(r.advance_paise) / 100, total: num(r.total_paise) / 100,
        cod_mismatch: r.cod_paise != null && r.sr_total_paise != null && Math.abs(num(r.cod_paise) - num(r.sr_total_paise)) > 100 ? { ours: num(r.cod_paise) / 100, shiprocket: num(r.sr_total_paise) / 100 } : null, phone: r.phone || '', booked_at: num(r.created_at), tracked_at: num(r.tracked_at) || null, packed_at: num(r.packed_at) || null,
        picked_at: num(r.picked_at) || null, delivered_at: num(r.delivered_at) || null, verified_at: num(r.verified_at) || null,
        /* cash the courier collects on this parcel: what it was booked to collect (a later pay-online conversion does not change a parcel already out) */
        cod_amt: r.cod_paise != null ? num(r.cod_paise) / 100 : codDue({ ...r, status: r.order_status }) / 100 };
    });
    const inRange = all.filter((x) => x.booked_at >= from && x.booked_at < to);
    const counts = Object.fromEntries(Object.keys(STAGE_LABEL).map((k) => [k, 0]));
    inRange.forEach((x) => { counts[x.stage] = (counts[x.stage] || 0) + 1; });
    const toPack = (x) => (x.stage === 'pickup_pending' || x.stage === 'pickup_failed') && !x.packed_at;   // "To pack": booked, courier not here yet, not packed
    counts.to_pack = inRange.filter(toPack).length;
    const todayIso = new Date((today0 + 19800) * 1000).toISOString().slice(0, 10);
    const dueToday = (x) => ['transit', 'ofd', 'ndr'].includes(x.stage) && x.edd === todayIso;   // courier's own estimate says today
    counts.due_today = all.filter(dueToday).length;
    let list = b.stage === 'to_pack' ? inRange.filter(toPack).sort((a, c) => a.booked_at - c.booked_at) : b.stage === 'due_today' ? all.filter(dueToday) : b.stage && b.stage !== 'all' ? inRange.filter((x) => x.stage === b.stage) : inRange;
    if (b.q) { const q = String(b.q).toLowerCase().trim(); const q0 = q.replace(/\s+/g, ''); list = list.filter((x) => { const h = `${x.order_name} ${x.awb} ${x.customer} ${x.phone} ${x.pincode} ${x.courier}`.toLowerCase(); return h.includes(q) || h.replace(/\s+/g, '').includes(q0); }); }
    const live = all.filter((x) => x.stage !== 'cancelled');
    const liveR = inRange.filter((x) => x.stage !== 'cancelled'), rto = liveR.filter((x) => x.stage === 'rto');
    /* expected profit for the parcels in range (same assumptions as Orders > Shipped): total - items x product cost - CAC - courier charge */
    const pf = (await getSettings(env)).profit || { unit_cost: 40, cac: 80 };
    const units = (x) => { try { return Math.max(1, JSON.parse(x.contents_json || '[]').reduce((a, c) => a + (Number(c.quantity) || 0), 0)); } catch { return 1; } };
    const profit = liveR.reduce((a, x) => a + (x.total_paise / 100 - units(x) * num(pf.unit_cost) - num(pf.cac) - x.charge), 0);
    const profitDelivered = liveR.filter((x) => x.stage === 'delivered').reduce((a, x) => a + (x.total_paise / 100 - units(x) * num(pf.unit_cost) - num(pf.cac) - x.charge), 0);
    /* an RTO loses the CAC and the courier charge; a partial-COD advance stays with us and offsets it */
    const rtoLoss = rto.reduce((a, x) => a + num(pf.cac) + x.charge - (x.advance || 0), 0);
    /* COD cash: collected = delivered COD parcels (delivered in the range), to collect = COD parcels still on the way (any date) */
    const OPEN_STAGES = ['delivered', 'rto', 'lost', 'cancelled'];
    const sumCod = (xs) => Math.round(xs.reduce((a, x) => a + (x.cod_amt || 0), 0));
    const codDel = all.filter((x) => x.stage === 'delivered' && x.cod_amt > 0 && (x.delivered_at || x.booked_at) >= from && (x.delivered_at || x.booked_at) < to);
    const codOpen = all.filter((x) => !OPEN_STAGES.includes(x.stage) && x.cod_amt > 0);
    const codRto = inRange.filter((x) => x.stage === 'rto' && x.cod_amt > 0);
    let codUnshipped = { n: 0, amount: 0 };
    try {
      const shippedIds = new Set(all.filter((x) => x.stage !== 'cancelled').map((x) => String(x.order_id)));
      const ords = (await env.DB.prepare("SELECT order_id, method, status, total_paise, advance_paise, converted_at, shipped_at FROM orders WHERE method='cod' AND created_at > ?").bind(t - 30 * DAY).all()).results;
      const wait = ords.filter((o) => o.status !== 'cancelled' && !num(o.shipped_at) && !shippedIds.has(String(o.order_id)) && codDue(o) > 0);
      codUnshipped = { n: wait.length, amount: Math.round(wait.reduce((a, o) => a + codDue(o), 0) / 100) };
    } catch (e) { console.error('cod unshipped', e.message); }
    const cod = { collected: sumCod(codDel), collected_n: codDel.length, to_collect: sumCod(codOpen), to_collect_n: codOpen.length,
      out_for_delivery: sumCod(codOpen.filter((x) => x.stage === 'ofd')), rto: sumCod(codRto), rto_n: codRto.length, unshipped: codUnshipped.amount, unshipped_n: codUnshipped.n };
    const blockList = cfgShip({ ...env, SETTINGS: await getSettings(env) }).shiprocketBlock;
    let wallet = null, walletErr = '';
    try { wallet = await srWallet(await withSettingsFresh(env), !!b.fresh_wallet); } catch (e) { walletErr = String(e.message || e).slice(0, 120); }
    const pubList = list.slice(0, 500).map(({ contents_json, total_paise, ...x }) => x);
    return { ok: true, range, shipments: pubList, total: list.length, counts, all_in_range: inRange.length, wallet, wallet_error: walletErr,
      attention: {
        pickup_failed: live.filter((x) => x.stage === 'pickup_failed').length,
        pickup_late: live.filter((x) => x.stage === 'pickup_pending' && x.booked_at < t - DAY).length,
        pending_pickups: live.filter((x) => x.stage === 'pickup_pending' || x.stage === 'pickup_failed').length,
        to_pack: live.filter((x) => (x.stage === 'pickup_pending' || x.stage === 'pickup_failed') && !x.packed_at).sort((a, b) => a.booked_at - b.booked_at).map((x) => x.order_id),
        ndr: live.filter((x) => x.stage === 'ndr').length,
        unverified: live.filter((x) => (x.stage === 'pickup_pending' || x.stage === 'pickup_failed') && !x.verified_at).length,
        due_today: counts.due_today,
        cancelled_after_pickup: all.filter((x) => x.cancel_state === 'picked' && !['delivered', 'rto'].includes(x.stage)).length,
        /* booked with a courier on the never-use list (e.g. Blue Dart) and not picked up yet: cancel and re-book */
        blocked: live.filter((x) => (x.stage === 'pickup_pending' || x.stage === 'pickup_failed') && courierBlocked(x.courier, blockList)).length,
        blocked_name: String(blockList || '').split(/[|,]/)[0].trim(),
      },
      cod,
      today: { booked: all.filter((x) => x.booked_at >= today0).length, picked: all.filter((x) => x.picked_at && x.picked_at >= today0).length,
        delivered: all.filter((x) => x.delivered_at && x.delivered_at >= today0).length, pickup_pending: live.filter((x) => x.stage === 'pickup_pending').length,
        packed: all.filter((x) => x.packed_at && x.packed_at >= today0).length },
      stats: { booked: liveR.length, rto_pct: liveR.length ? Math.round(rto.length * 1000 / liveR.length) / 10 : 0,
        rto_cost: Math.round(rto.reduce((a, x) => a + x.charge, 0)), spend: Math.round(liveR.reduce((a, x) => a + x.charge, 0)),
        profit: Math.round(profit), profit_delivered: Math.round(profitDelivered), rto_loss: Math.round(rtoLoss), delivered: liveR.filter((x) => x.stage === 'delivered').length } };
  },
  /**
   * Verify a packed parcel by the barcode on its label. code: the scanned text (AWB, or the Shiprocket order id
   * "1571" / "1571-R1234"); expect: optional order id the parcel is supposed to be. Returns one of
   *   ok              the label is the live booking of a parcel waiting for pickup (marked verified)
   *   wrong           the label belongs to another order than the one expected
   *   cancelled       the label is from a cancelled booking: print the current label (current_awb) or it cannot ship
   *   order_cancelled the order itself is cancelled: do not ship it
   *   picked          Shiprocket already shows this parcel picked up / delivered
   *   unknown         no booking has this code
   */
  async verify_scan(env, b) {
    const raw = String(b.code || '').trim();
    if (!raw) throw new Error('Nothing scanned');
    const t = now(), digits = raw.replace(/\D/g, '');
    const pub = (r) => ({ order_id: String(r.order_id), order_name: r.order_name, awb: r.awb || '', courier: r.courier || '', stage: r.status === 'cancelled' ? 'cancelled' : (r.stage || 'pickup_pending'), verified_at: num(r.verified_at) || null, packed_at: num(r.packed_at) || null, customer: `${r.first_name || ''} ${r.last_name || ''}`.trim(), order_status: r.order_status || '' });
    const Q = `SELECT s.*, o.status AS order_status, o.first_name, o.last_name, o.packed_at FROM shipments s LEFT JOIN orders o ON o.order_id = s.order_id`;
    /* 1. by AWB (exact, then the digits only: some couriers print a prefix/suffix round it) */
    let recs = (await env.DB.prepare(`${Q} WHERE s.awb=? OR s.awb=? ORDER BY (COALESCE(s.status,'')<>'cancelled') DESC, s.created_at DESC`).bind(raw, digits || raw).all()).results;
    /* 2. by order number ("#1571", "1571", "1571-R0421" from the Shiprocket order barcode) */
    let byOrder = false;
    if (!recs.length) {
      const m = /^#?\s*(\d{3,6})(?:-R\d{3,5})?$/i.exec(raw);
      if (m) { recs = (await env.DB.prepare(`${Q} WHERE s.order_name=? OR s.order_name=? ORDER BY (COALESCE(s.status,'')<>'cancelled') DESC, s.created_at DESC`).bind('#' + m[1], m[1]).all()).results; byOrder = true; }
    }
    /* 3. an AWB from a booking that was cancelled and since rebooked (its row was replaced) */
    if (!recs.length) {
      const old = await env.DB.prepare('SELECT * FROM ship_old_awbs WHERE awb=? OR awb=?').bind(raw, digits || raw).first().catch(() => null);
      if (old) {
        const cur = await env.DB.prepare(`${Q} WHERE s.order_id=?`).bind(String(old.order_id)).first();
        const order = { order_id: String(old.order_id), order_name: old.order_name, awb: old.awb, courier: old.courier || '', stage: 'cancelled', customer: cur ? `${cur.first_name || ''} ${cur.last_name || ''}`.trim() : '' };
        if (cur && cur.order_status === 'cancelled') return { ok: true, state: 'order_cancelled', code: raw, order, note: `${old.order_name} is cancelled. Do not ship this parcel.` };
        const liveCur = cur && cur.awb && cur.status !== 'cancelled' ? pub(cur) : null;
        return { ok: true, state: 'cancelled', code: raw, order, current: liveCur,
          note: liveCur ? `Old label: this booking of ${old.order_name} was cancelled. The current AWB is ${liveCur.awb} (${liveCur.courier}). Print the new label and stick it on.` : `This booking of ${old.order_name} was cancelled and it has no live booking. Book it again from the Orders tab before shipping.` };
      }
      return { ok: true, state: 'unknown', code: raw, note: 'No booking has this code. Is it a Shiprocket label from this account?' };
    }
    const live = recs.find((r) => r.awb && r.status !== 'cancelled') || null;
    const hit = byOrder ? (live || recs[0]) : recs.find((r) => r.awb === raw || r.awb === digits) || recs[0];
    const order = pub(hit), exp = b.expect ? String(b.expect) : '';
    if (hit.order_status === 'cancelled') return { ok: true, state: 'order_cancelled', code: raw, order, note: `${hit.order_name} is cancelled. Do not ship this parcel.` };
    if (exp && exp !== String(hit.order_id)) {
      const e = await env.DB.prepare('SELECT order_name FROM orders WHERE order_id=?').bind(exp).first();
      return { ok: true, state: 'wrong', code: raw, order, expected: { order_id: exp, order_name: e?.order_name || exp }, note: `This label is ${hit.order_name}, not ${e?.order_name || 'the expected order'}.` };
    }
    if (hit.status === 'cancelled' || (byOrder && !live)) {
      const cur = live ? pub(live) : null;
      return { ok: true, state: 'cancelled', code: raw, order, current: cur,
        note: cur ? `Old label: this booking of ${hit.order_name} was cancelled. The current AWB is ${cur.awb} (${cur.courier}). Print the new label and stick it on.` : `This booking of ${hit.order_name} was cancelled and it has no live booking. Book it again from the Orders tab before shipping.` };
    }
    const stage = hit.stage || 'pickup_pending';
    if (!['pickup_pending', 'pickup_failed'].includes(stage)) return { ok: true, state: 'picked', code: raw, order, note: `${hit.order_name}: Shiprocket already shows this parcel as ${STAGE_LABEL[stage] || stage}.` };
    await env.DB.prepare('UPDATE shipments SET verified_at=? WHERE order_id=?').bind(t, String(hit.order_id)).run();
    order.verified_at = t;
    return { ok: true, state: 'ok', code: raw, order, note: `${hit.order_name} · ${order.customer} · ${hit.courier} ${hit.awb}. Ready for pickup.` };
  },
  /** Un-verify (scanned by mistake). */
  async verify_clear(env, b) { await env.DB.prepare('UPDATE shipments SET verified_at=NULL WHERE order_id=?').bind(String(b.id)).run(); return { ok: true }; },
  /** Every parcel still waiting for pickup (or pickup failed), any date: the ids the "Cancel all pending pickups" button works through. */
  async ship_pending_ids(env) {
    const rows = (await env.DB.prepare(`SELECT order_id FROM shipments WHERE awb IS NOT NULL AND awb<>'' AND COALESCE(status,'')<>'cancelled'
        AND COALESCE(stage,'pickup_pending') IN ('pickup_pending','pickup_failed') AND COALESCE(cancel_state,'')<>'picked' AND created_at > ? ORDER BY created_at`).bind(now() - 45 * 86400).all()).results;
    return { ok: true, ids: rows.map((r) => String(r.order_id)) };
  },
  /** Re-check these shipments with Shiprocket now (max 80). */
  async ship_refresh(env, b) {
    const recs = await shipRecs(env, b.ids, 80);
    const fresh = await withSettingsFresh(env);
    let i = 0, n = 0;
    await Promise.all(Array.from({ length: Math.min(4, recs.length) }, async () => { while (i < recs.length) { const r = recs[i++]; try { await refreshShipment(fresh, r); n++; } catch (e) { console.error('ship_refresh', r.order_id, e.message); } } }));
    return { ok: true, refreshed: n, asked: recs.length };
  },
  /** Ask the courier to come (again); optional date YYYY-MM-DD. */
  async ship_pickup(env, b) {
    const date = String(b.date || '').trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must look like 2026-10-20');
    const recs = (await shipRecs(env, b.ids, 100)).filter((r) => r.sr_shipment_id);
    if (!recs.length) throw new Error('Select shipments that are waiting for pickup');
    return { ok: true, results: await requestPickup(await withSettingsFresh(env), recs, date) };
  },
  /** Cancel shipments that are not picked up yet. The order goes back to "To ship"; it is not cancelled. */
  async ship_cancel(env, b) {
    const recs = await shipRecs(env, b.ids, 100), fresh = await withSettingsFresh(env), results = [];
    for (const r of recs) {
      const x = await stopShipment(fresh, r.order_id, 'Shipment cancelled from the dashboard');
      results.push({ id: r.order_id, name: r.order_name, ok: x.state === 'cancelled', note: x.state === 'picked' ? 'Already picked up, cannot cancel' : x.state === 'error' ? x.note : x.note || 'Cancelled' });
    }
    return { ok: true, results };
  },
  async ship_manifest(env, b) {
    const recs = (await shipRecs(env, b.ids, 200)).filter((r) => r.sr_shipment_id);
    return { ok: true, url: await manifestUrl(await withSettingsFresh(env), recs) };
  },
  /** Called by the dashboard every few minutes while it is open: runs the cron work if nobody did in the last 4 minutes. */
  async tick(env) {
    const last = Number((await env.DB.prepare("SELECT v FROM settings WHERE k='cron_at'").first())?.v) || 0, t = now();
    if (t - last < 240) return { ok: true, ran: false, last };
    const { runCron } = await import('./app.js');
    const r = await runCron(env, 'dashboard');
    return { ok: true, ran: true, last: t, result: r };
  },
  /* ---- Reconciliation: Shopify x Shiprocket x this dashboard. Lists every mismatch with a one-click fix. ---- */
  /** Open issues; with run=true the audit is run first (days: how far back, default 45). */
  async audit(env, b) {
    const fresh = await withSettingsFresh(env);
    const r = b.run ? await shipAudit(fresh, { days: Math.min(120, Math.max(1, +b.days || 45)) }) : { issues: await shipIssues(fresh) };
    const { issues, audited_at } = r.issues;
    const open = issues.filter((x) => !x.dismissed_at);
    return { ok: true, checked: r.checked || 0, audited_at, issues, open: open.length, shop: String(fresh.SHOP_DOMAIN || env.SHOP_DOMAIN || '').replace(/\.myshopify\.com.*$/, ''), by_kind: open.reduce((a, x) => ((a[x.kind] = (a[x.kind] || 0) + 1), a), {}),
      kinds: Object.fromEntries(Object.entries(ISSUE_KINDS).map(([k, v]) => [k, { sev: v.sev, title: v.title, why: v.why, fixes: v.fixes }])), fix_labels: FIX_LABEL };
  },
  /** Apply one fix to one order: { id, fix }. Returns what is left for that order. */
  async audit_fix(env, b) {
    if (b.fix === 'dismiss') { await dismissIssue(env, b.id, b.kind, !!b.undo); return { ok: true, note: b.undo ? 'Restored' : 'Dismissed', left: [] }; }
    return shipFix(await withSettingsFresh(env), { id: b.id, fix: b.fix }, { fulfilBooked });
  },
  async ndr_list(env) {
    const f = await withSettingsFresh(env);
    const list = await ndrList(f);
    const mine = Object.fromEntries((await env.DB.prepare("SELECT awb, order_name, ndr_choice, ndr_choice_at, ndr_date, ndr_by, ndr_attempt, ndr_asked_at FROM shipments WHERE awb IS NOT NULL AND LENGTH(awb) > 0").all()).results.map((r) => [r.awb, r]));
    /* Shiprocket keeps a parcel in its NDR list until the courier's next attempt, even after a re-attempt was asked for.
       Count it as handled when a choice was made after this failed attempt (same attempt number, or made after it was raised). */
    const handled = (x, m) => {
      if (!m || !m.ndr_choice || !m.ndr_choice_at) return false;
      const at = num(m.ndr_choice_at);
      if (now() - at > 4 * 86400) return false;
      if (x.attempts && m.ndr_attempt) return x.attempts <= num(m.ndr_attempt);
      const raised = Math.floor(Date.parse(String(x.date || '').replace(' ', 'T') + (/[zZ+]/.test(x.date) ? '' : '+05:30')) / 1000);
      return Number.isFinite(raised) ? at >= raised - 60 : true;
    };
    /* what the automatic rules will do with each (lib/ndr-rules.js), from the same state the cron uses */
    const { ndrCfg, planNdr, classifyNdr, CATEGORIES } = await import('./ndr-rules.js');
    const cfg = ndrCfg(f);
    const autoRows = list.length ? (await env.DB.prepare(`SELECT * FROM ndr_auto WHERE awb IN (${list.map(() => '?').join(',')})`).bind(...list.map((x) => x.awb)).all()).results : [];
    const pay = list.length ? Object.fromEntries((await env.DB.prepare(`SELECT s.awb, o.method, o.advance_paise, o.converted_at FROM shipments s JOIN orders o ON o.order_id=s.order_id WHERE s.awb IN (${list.map(() => '?').join(',')})`).bind(...list.map((x) => x.awb)).all()).results.map((r) => [r.awb, r.method !== 'cod' || num(r.advance_paise) > 0 || !!r.converted_at])) : {};
    return { ok: true, auto: cfg.mode, ndr: list.map((x) => { const m = mine[x.awb];
      const k = x.attempts ? 'a' + x.attempts : 'd' + String(x.date || '').slice(0, 10);
      const st = autoRows.find((r) => r.awb === x.awb && r.k === k);
      const plan = m ? planNdr(cfg, x, st || {}, m, !!pay[x.awb]) : null;
      const cat = classifyNdr(x.reason);
      return { ...x, order_name: m?.order_name || String(x.order || ''), done: handled(x, m), choice: m?.ndr_choice || '', choice_at: num(m?.ndr_choice_at) || null, choice_date: m?.ndr_date || '', choice_by: m?.ndr_by || '',
        category: cat, category_label: CATEGORIES[cat].label, paid: !!pay[x.awb],
        plan: plan ? { act: plan.act, why: plan.why, due: plan.due || null, then: plan.then || '' } : null, asked_at: num(m?.ndr_asked_at) || null, auto_action: st?.action || '', auto_error: st?.error || '' }; }) };
  },
  /** Pay-online offer (lib/wa-convert.js): settings, template status, results. */
  async convert_settings(env) {
    const { convertCfg, convertStats } = await import('./wa-convert.js');
    const f = await withSettingsFresh(env);
    const { withSettings } = await import('./settings.js');
    const e2 = await withSettings(f);
    const { metaTemplate } = await import('./whatsapp.js');
    const tpl = async (n) => { try { const t = await metaTemplate(e2, n); return t ? { name: n, status: t.status, category: t.category || '' } : { name: n, status: 'MISSING' }; } catch (e) { return { name: n, status: 'UNKNOWN', error: String(e.message || e).slice(0, 120) }; } };
    return { ok: true, cfg: convertCfg(f), stats: await convertStats(env), templates: [await tpl('cod_prepaid_offer_v2'), await tpl('cod_prepaid_offer')], trigger_on: triggerConfig(f, 'cod_to_prepaid').enabled, store: env.STORE_URL || '' };
  },
  async save_convert(env, b) {
    const { CONVERT_DEFAULTS } = await import('./wa-convert.js');
    const c = { ...CONVERT_DEFAULTS, mode: b.mode === 'on' ? 'on' : 'off', pct: Math.min(50, Math.max(1, Math.round(Number(b.pct) || 20))),
      minutes: Math.max(5, Math.min(72 * 60, Math.round(Number(b.minutes) || CONVERT_DEFAULTS.minutes))) };
    await putSetting(env, 'convert', c);
    return { ok: true, cfg: c };
  },
  /** Submit the cod_prepaid_offer template to Meta for approval. */
  async convert_template(env) {
    const { OFFER_TEMPLATE } = await import('./wa-convert.js');
    const r = await ACTIONS.wa_create_templates(env, { templates: [OFFER_TEMPLATE] });
    const { clearMetaCache } = await import('./whatsapp.js'); clearMetaCache();
    return { ok: true, ...r };
  },
  /** Send the offer for one order now (dashboard button), ignoring the delay; the window starts now. */
  async convert_send(env, b) {
    const { sendOffer, offerState, convertCfg } = await import('./wa-convert.js');
    const { withSettings } = await import('./settings.js');
    const e2 = await withSettings(await withSettingsFresh(env));
    const st = await offerState(e2, String(b.id));
    if (st.state !== 'open') throw new Error({ paid: 'Already paid online', booked: 'Already booked with the courier: it stays COD', cancelled: 'Order cancelled', not_cod: 'Not a COD order', expired: 'The offer window has ended', missing: 'Order not found' }[st.state] || st.state);
    const r = await sendOffer(e2, st.row, { ...convertCfg(e2), mode: 'on' });
    if (r?.skipped) throw new Error('Shopify says this order is paid, fulfilled or cancelled');
    if (r && r.ok === false) throw new Error(r.error || 'WhatsApp did not send it');
    return { ok: true };
  },
  /** "Mark as prepaid": the customer paid another way. amount in ₹ (blank = the whole COD balance), ref = UPI / bank ref. */
  async mark_prepaid(env, b) {
    const { manualPrepaid } = await import('./wa-convert.js');
    const { withSettings } = await import('./settings.js');
    const e2 = await withSettings(await withSettingsFresh(env));
    const amt = b.amount === undefined || b.amount === null || String(b.amount).trim() === '' ? null : Math.round(Number(b.amount) * 100);
    return manualPrepaid(e2, String(b.id), { amountPaise: amt, ref: b.ref, notify: !!b.notify });
  },
  /** Automatic NDR rules: settings, what they would do right now, and the last automatic actions. */
  async ndr_rules(env) {
    const { ndrCfg, CATEGORIES } = await import('./ndr-rules.js');
    const f = await withSettingsFresh(env);
    const log = (await env.DB.prepare('SELECT * FROM ndr_auto WHERE first_seen>? ORDER BY first_seen DESC LIMIT 60').bind(now() - 14 * 86400).all()).results;
    const stats = { total: log.length, reattempt: 0, return: 0, manual: 0, customer: 0 };
    log.forEach((r) => { if (r.action && stats[r.action] !== undefined) stats[r.action]++; });
    const sel = log.length ? (await env.DB.prepare(`SELECT awb, ndr_by, stage, delivered_at FROM shipments WHERE awb IN (${log.map(() => '?').join(',')})`).bind(...log.map((r) => r.awb)).all()).results : [];
    const by = Object.fromEntries(sel.map((r) => [r.awb, r]));
    log.forEach((r) => { const x = by[r.awb]; r.outcome = x?.delivered_at || x?.stage === 'delivered' ? 'delivered' : x?.stage === 'rto' ? 'rto' : x?.stage || ''; if (!r.action && x?.ndr_by === 'customer') stats.customer++; });
    stats.delivered = log.filter((r) => r.outcome === 'delivered').length;
    stats.rto = log.filter((r) => r.outcome === 'rto').length;
    let refusedTpl = { status: 'UNKNOWN' };
    try { const { withSettings } = await import('./settings.js'); const { metaTemplate } = await import('./whatsapp.js'); const t = await metaTemplate(await withSettings(f), 'ndr_refused_check'); refusedTpl = t ? { status: t.status } : { status: 'MISSING' }; } catch (e) { refusedTpl = { status: 'UNKNOWN', error: String(e.message || e).slice(0, 120) }; }
    /* autopilot: its templates, and what it did over the same 14 days */
    const { PILOT_TEMPLATE_NAMES } = await import('./ndr-pilot.js');
    const pilotTpls = [];
    try { const { withSettings } = await import('./settings.js'); const { metaTemplate } = await import('./whatsapp.js'); const e2 = await withSettings(f); for (const n of PILOT_TEMPLATE_NAMES) { const t = await metaTemplate(e2, n).catch(() => undefined); pilotTpls.push({ name: n, status: t === undefined ? 'UNKNOWN' : t ? t.status : 'MISSING', category: t?.category || '' }); } } catch { /* shown as unknown */ }
    const since = now() - 14 * 86400;
    const pc = async (sql, ...a) => num((await env.DB.prepare(sql).bind(...a).first().catch(() => null))?.n);
    stats.pilot = {
      nudged: await pc("SELECT COUNT(*) AS n FROM ndr_auto WHERE nudged_at>? AND COALESCE(pilot_note,'') NOT LIKE 'no nudge%' AND COALESCE(pilot_note,'') NOT LIKE 'nudge failed%'", since),
      told: await pc("SELECT COUNT(*) AS n FROM ndr_auto WHERE told_at>? AND COALESCE(pilot_note,'') NOT LIKE 'announcement failed%'", since),
      replies: await pc("SELECT COUNT(*) AS n FROM messages WHERE ts>? AND direction='out' AND template LIKE 'ndr-%' AND trigger='ai'", since),
      booked: await pc("SELECT COUNT(*) AS n FROM messages WHERE ts>? AND direction='in' AND trigger LIKE 'ndr-pilot-%' AND template='REATTEMPT'", since),
      saves: await pc("SELECT COUNT(*) AS n FROM shipments WHERE ndr_save_at>?", since),
      saved: await pc("SELECT COUNT(*) AS n FROM shipments WHERE ndr_save_at>? AND (stage='delivered' OR delivered_at IS NOT NULL)", since),
      committed: await pc("SELECT COUNT(*) AS n FROM shipments WHERE ndr_commit_at>?", since),
      fake: await pc("SELECT COUNT(*) AS n FROM shipments WHERE ndr_fake>0 AND ndr_commit_at>?", since),
    };
    return { ok: true, pilot_tpls: pilotTpls, ai_on: !!(f.SETTINGS?.ai?.enabled && (f.SETTINGS?.ai?.key || env.GROQ_API_KEY || env.CEREBRAS_API_KEY || env.OPENROUTER_API_KEY || env.GEMINI_API_KEY || env.ANTHROPIC_API_KEY)), cfg: ndrCfg(f), categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])), log, stats, ship_failed_on: triggerConfig(f, 'ship_failed').enabled, refused_on: triggerConfig(f, 'ndr_refused').enabled, refused_tpl: refusedTpl };
  },
  /** Submit ndr_refused_check ("Do you still want it?" with Yes / Cancel buttons) to Meta. */
  async ndr_template(env) {
    const { REFUSED_TEMPLATE } = await import('./ndr-ask.js');
    const r = await ACTIONS.wa_create_templates(env, { templates: [REFUSED_TEMPLATE] });
    const { clearMetaCache } = await import('./whatsapp.js'); clearMetaCache();
    return { ok: true, ...r };
  },
  /* ---------------- Reviews (lib/reviews.js) ---------------- */
  async reviews(env, b) {
    const R = await import('./reviews.js');
    const { photoSig } = await import('./review-page.js');
    const r = await R.adminList(env, b || {});
    const base = String(env.WORKER_URL || '').replace(/\/$/, '');
    for (const rv of r.reviews) rv.photos = rv.photos.map((id) => ({ id, thumb: `${base}/api/review/photo?id=${id}&s=t&k=${photoSig(env, id)}`, full: `${base}/api/review/photo?id=${id}&s=f&k=${photoSig(env, id)}` }));
    const { metaTemplate } = await import('./whatsapp.js');
    const { withSettings } = await import('./settings.js');
    const tpl = await metaTemplate(await withSettings(env), R.REVIEW_TEMPLATE).catch(() => undefined);
    r.template = tpl ? tpl.status : (env.WA_WABA_ID || (await withSettings(env)).WA_WABA_ID ? 'MISSING' : 'UNKNOWN');
    return r;
  },
  async review_set(env, b) { const R = await import('./reviews.js'); return R.adminSet(env, b); },
  async review_delete(env, b) { const R = await import('./reviews.js'); return R.adminDelete(env, b); },
  async review_cfg(env, b) { const R = await import('./reviews.js'); return { ok: true, cfg: await R.saveReviewCfg(env, b || {}) }; },
  /** Test: a real review link and the real WhatsApp message to any number (marked test, never on the website). */
  async review_test(env, b) {
    const R = await import('./reviews.js');
    const { withSettings } = await import('./settings.js');
    return R.adminTest(await withSettings(await withSettingsFresh(env)), b || {});
  },
  /** "Ask past customers": everyone delivered before the launch becomes due now (still one per customer, 10 am - 8 pm). */
  async review_backfill(env) {
    const R = await import('./reviews.js');
    const cfg = await R.saveReviewCfg(env, { backfill_at: Math.floor(Date.now() / 1000) });
    return { ok: true, cfg, due: await R.countDue(env, cfg) };
  },
  /** Scan Shopify + tracking now (dashboard "Refresh"), and send what is due if sending is on. */
  async review_scan(env, b) {
    const R = await import('./reviews.js');
    const { withSettings } = await import('./settings.js');
    const e2 = await withSettings(await withSettingsFresh(env));
    const out = { scan: await R.scanShopify(e2, { pages: Math.min(8, Number(b?.pages) || 4) }), track: await R.checkTracking(e2, { max: 30 }) };
    if (b?.send) out.send = await R.sendDue(e2);
    return { ok: true, ...out };
  },
  /** Submit the review request template to WhatsApp Manager (also done by the server on its own). */
  async review_template(env, b) {
    const R = await import('./reviews.js');
    const { withSettings } = await import('./settings.js');
    const { metaTemplate, clearMetaCache } = await import('./whatsapp.js');
    const base = String(env.WORKER_URL || '').replace(/\/$/, '');
    if (!/^https:\/\//.test(base)) throw new Error('WORKER_URL (this app\'s https address) is not set');
    const have = await metaTemplate(await withSettings(await withSettingsFresh(env)), R.REVIEW_TEMPLATE).catch(() => null);
    if (have && have.status !== 'REJECTED' && !b?.force) return { ok: true, created: [{ name: R.REVIEW_TEMPLATE, status: have.status }] };
    const r = await ACTIONS.wa_create_templates(env, { templates: [R.reviewTemplate(base)] });
    clearMetaCache();
    return { ok: true, ...r };
  },
  /** How-to-apply video on delivery (lib/apply-guide.js): status, set the video link, submit the template, send a test. */
  async apply_guide(env, b) {
    const A = await import('./apply-guide.js');
    const { withSettings, putSetting, getSettings } = await import('./settings.js');
    const { metaTemplate, clearMetaCache, fireTrigger } = await import('./whatsapp.js');
    const s = await getSettings(env, true);
    if (b.video !== undefined) {
      const v = String(b.video || '').trim();
      if (v && !/^https:\/\/\S+$/.test(v)) throw new Error('Paste a public https link to the video (.mp4)');
      if (v) {
        const r = await fetch(v, { method: 'HEAD', redirect: 'follow' }).catch(() => null);
        const type = r?.headers.get('content-type') || '', size = Number(r?.headers.get('content-length') || 0);
        if (!r || !r.ok) throw new Error('That link does not open (HTTP ' + (r ? r.status : 'error') + '). It must be a direct, public link to the .mp4 file');
        if (type && !/video\/mp4|application\/octet-stream|binary/.test(type)) throw new Error(`That link is a ${type.split(';')[0]} page, not an .mp4 file. Use a direct file link`);
        if (size > 16 * 1024 * 1024) throw new Error(`The video is ${(size / 1048576).toFixed(1)} MB; WhatsApp allows up to 16 MB`);
      }
      await putSetting(env, 'apply', { ...s.apply, video: v });
    }
    const e2 = await withSettings(await withSettingsFresh(env));
    const video = A.applyVideo(e2);
    let tpl = await metaTemplate(e2, A.APPLY_TEMPLATE).catch(() => null);
    let created = null;
    if (b.submit || (video && (!tpl || tpl.status === 'REJECTED') && b.video !== undefined)) {
      if (!video) throw new Error('Set the video first');
      const t = { ...A.applyTemplate(), sample_url: video };
      created = (await ACTIONS.wa_create_templates(env, { templates: [t] })).created;
      clearMetaCache();
      tpl = await metaTemplate(e2, A.APPLY_TEMPLATE).catch(() => null);
    }
    let test = null;
    if (b.test) {
      const to = cleanPhone(b.to) || cleanPhone(e2.WA_ADMIN_PHONE);
      if (!to) throw new Error('Enter a 10-digit number for the test');
      if (!video) throw new Error('Set the video first');
      test = await fireTrigger(e2, 'ship_delivered', { to, vars: { name: 'Test', order: '#TEST', video }, orderName: '#TEST', force: true });
    }
    return { ok: true, video, text: A.APPLY_TEXT, template: A.APPLY_TEMPLATE, status: tpl ? tpl.status : (created?.[0]?.status || 'NOT SUBMITTED'), created, test, on: triggerConfig(e2, 'ship_delivered').enabled };
  },
  /** Submit the NDR autopilot templates (nudge, booked again, final attempt) that are not in WhatsApp Manager yet. */
  async ndr_pilot_templates(env, b) {
    const { pilotTemplates, PILOT_TEMPLATE_NAMES } = await import('./ndr-pilot.js');
    const { withSettings } = await import('./settings.js');
    const { metaTemplate, clearMetaCache } = await import('./whatsapp.js');
    const base = String(env.WORKER_URL || '').replace(/\/$/, '');
    if (!/^https:\/\//.test(base)) throw new Error('WORKER_URL (this app\'s https address) is not set, so the template button has nowhere to point');
    const e2 = await withSettings(await withSettingsFresh(env));
    const want = [];
    for (const t of pilotTemplates(base)) { const have = await metaTemplate(e2, t.name).catch(() => null); if (!have || have.status === 'REJECTED' || b?.force) want.push(t); }
    if (!want.length) return { ok: true, created: PILOT_TEMPLATE_NAMES.map((n) => ({ name: n, status: 'EXISTS' })) };
    const r = await ACTIONS.wa_create_templates(env, { templates: want });
    clearMetaCache();
    return { ok: true, ...r };
  },
  async save_ndr(env, b) {
    const { ndrCfg } = await import('./ndr-rules.js');
    const c = ndrCfg({ SETTINGS: { ndr: b } });
    await putSetting(env, 'ndr', c);
    return { ok: true, cfg: c };
  },
  /** Run the NDR rules now (dry = only show what would happen). */
  async ndr_run(env, b) {
    const { autoNdr } = await import('./ndr-rules.js');
    const { withSettings } = await import('./settings.js');
    return { ok: true, result: await autoNdr(await withSettings(await withSettingsFresh(env)), { dry: !!b.dry }) };
  },
  /** action: 'reattempt' (optionally with a new date/phone) or 'return' (start RTO). */
  async ndr_do(env, b) {
    const action = b.action_type === 'return' ? 'return' : 're-attempt';
    const date = String(b.deferred_date || '').trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Date must look like 2026-10-20');
    const r = await ndrAction(await withSettingsFresh(env), { awb: String(b.awb || ''), action, phone: String(b.phone || '').replace(/\D/g, '').slice(-10), deferred_date: date, comments: String(b.comments || '').slice(0, 200) });
    /* remember it, so the NDR card shows "re-attempt requested" instead of asking again (Shiprocket lists it until the next attempt) */
    await env.DB.prepare('UPDATE shipments SET ndr_choice=?, ndr_choice_at=?, ndr_date=?, ndr_by=?, ndr_attempt=?, updated_at=? WHERE awb=?')
      .bind(action === 'return' ? 'return' : 'reattempt', now(), date || null, 'team', Number(b.attempts) || null, now(), String(b.awb || '')).run().catch(() => {});
    return { ok: true, response: r.message || r.status || 'sent' };
  },
  async save_wa(env, b) {
    const s = await getSettings(env, true);
    const w = { ...s.wa };
    for (const k of ['phone_id', 'waba_id', 'admin_phone', 'lang', 'verify_token']) if (b[k] !== undefined) w[k] = String(b[k]).trim().slice(0, 200);
    if (b.transport === 'meta' || b.transport === 'g4w') w.transport = b.transport;
    for (const k of ['token', 'app_secret']) if (b[k] && !String(b[k]).startsWith('••')) w[k] = String(b[k]).trim();
    if (!w.verify_token) w.verify_token = 'ik_' + Math.random().toString(36).slice(2, 12);
    await putSetting(env, 'wa', w);
    return { ok: true };
  },
  async save_triggers(env, b) {
    const t = {};
    const prev = (await getSettings(env, true)).templates || {};
    for (const [k, v] of Object.entries(b.triggers || {})) if (TRIGGERS[k]) {
      t[k] = { enabled: !!v.enabled, name: String(v.name || '').trim().slice(0, 100), lang: String(v.lang || 'en').slice(0, 10), vars: (v.vars || []).filter((x) => TRIGGERS[k].vars.includes(x)) };
      /* keep a saved rotation list (templates.<key>.variants) unless the dashboard sends a new one */
      const variants = Array.isArray(v.variants) ? v.variants : prev[k]?.variants;
      if (Array.isArray(variants)) t[k].variants = variants.map((x) => String(x).trim().slice(0, 100)).filter(Boolean).slice(0, 12);
    }
    await putSetting(env, 'templates', t);
    return { ok: true };
  },
  async wa_test(env) {
    if (viaG4w(env)) {
      /* Probe each Go4WhatsUp API separately: plans differ in which ones they allow. */
      g4w.clearTemplateCache();
      const cr = await g4w.credits(env).then((j) => ({ j })).catch((e) => ({ error: e.message }));
      const tl = await g4w.listTemplates(env).then((list) => ({ list })).catch((e) => ({ error: e.message }));
      const bal = cr.j?.message?.credits ?? cr.j?.message?.balance ?? cr.j?.credits ?? cr.j?.balance;
      const manual = env.SETTINGS?.g4w_ids || {};
      const list = tl.list || [];
      const names = new Set([...list.map((x) => String(x.templateName || x.name || '').toLowerCase()), ...Object.keys(manual)]);
      const wanted = new Set();
      for (const k of Object.keys(TRIGGERS)) { const c = triggerConfig(env, k); if (c.enabled) { wanted.add(c.name); (c.variants || []).forEach((n) => wanted.add(n)); } }
      const templates = [
        { name: 'API check: wallet credits (getOrgCredits)', language: cr.error || (bal !== undefined ? 'balance ' + bal : ''), status: cr.error ? 'BLOCKED' : 'WORKS' },
        { name: 'API check: list templates (getApproveTemplates)', language: tl.error || list.length + ' approved', status: tl.error ? 'BLOCKED' : 'WORKS' },
        ...list.map((x) => ({ name: x.templateName || x.name, language: x._id ? 'id ' + x._id : '', status: 'APPROVED' })),
        ...Object.entries(manual).filter(([n]) => !list.some((x) => String(x.templateName || x.name || '').toLowerCase() === n)).map(([n, id]) => ({ name: n, language: 'id ' + id + ' (typed in)', status: 'APPROVED' })),
        ...[...wanted].filter((n) => !names.has(String(n).toLowerCase())).map((n) => ({ name: n, language: 'needed by an active message', status: tl.error ? 'ID NEEDED' : 'NOT APPROVED YET' })),
      ];
      return { ok: true, name: 'Go4WhatsUp', number: '+91 99874 53483', quality: cr.error && tl.error ? 'API blocked by plan' : 'connected', templates };
    }
    if (!env.WA_PHONE_ID || !env.WA_TOKEN) throw new Error('Add Phone number ID and access token first');
    clearMetaCache();
    /* Plain-language checks of everything Meta needs before a message can go out. */
    const checks = [];
    const row = (name, ok, note) => checks.push({ name, language: note || '', status: ok ? 'WORKS' : 'BLOCKED' });
    let appId = '';
    try {
      const d = (await waGet(env, `debug_token?input_token=${encodeURIComponent(env.WA_TOKEN)}`)).data || {};
      appId = String(d.app_id || '');
      const scopes = d.granular_scopes || [];
      const has = (sc) => scopes.find((x) => x.scope === sc);
      const forWaba = (sc) => { const x = has(sc); return x && (!x.target_ids || !env.WA_WABA_ID || x.target_ids.includes(String(env.WA_WABA_ID))); };
      row('Token is valid', !!d.is_valid, d.expires_at ? 'expires ' + new Date(d.expires_at * 1000).toISOString().slice(0, 10) : 'never expires');
      row('Permission to SEND messages (whatsapp_business_messaging)', forWaba('whatsapp_business_messaging'), has('whatsapp_business_messaging') && !forWaba('whatsapp_business_messaging') ? 'granted, but not for this WhatsApp account: assign the account to the system user, then make a new token' : has('whatsapp_business_messaging') ? '' : 'missing: generate a new token and tick it');
      row('Permission to read templates (whatsapp_business_management)', forWaba('whatsapp_business_management'), has('whatsapp_business_management') ? '' : 'missing: generate a new token and tick it');
    } catch (e) { row('Token check', false, e.message); }
    let me = {};
    try { me = await waGet(env, `${env.WA_PHONE_ID}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status`); row('Phone number ID works', true, `${me.display_phone_number || ''} ${me.verified_name || ''} · ${me.platform_type || ''} ${me.status || ''}`.trim()); }
    catch (e) { row('Phone number ID works', false, e.message); }
    if (env.WA_WABA_ID) {
      try { const nums = (await waGet(env, `${env.WA_WABA_ID}/phone_numbers?fields=id,display_phone_number`)).data || []; row('Phone number belongs to this WhatsApp account', nums.some((n) => String(n.id) === String(env.WA_PHONE_ID)), nums.map((n) => n.display_phone_number + ' = ' + n.id).join(', ')); }
      catch (e) { row('Phone number belongs to this WhatsApp account', false, e.message); }
      /* One field at a time: some fields are only visible to a Business Solution Provider, and one refusal must not hide the rest. */
      const field = async (f) => { try { return (await waGet(env, `${env.WA_WABA_ID}?fields=${f}`))[f.split('{')[0]]; } catch (e) { return { error: e.message.slice(0, 120) }; } };
      const owner = await field('owner_business_info');
      const own = await field('ownership_type');
      const review = await field('account_review_status');
      const verif = await field('business_verification_status');
      const fund = await field('primary_funding_id');
      const obo = await field('on_behalf_of_business_info');
      row('Owner of this WhatsApp account', !owner?.error, owner?.error || `${owner?.name || '?'} (${owner?.id || ''})${own && !own.error ? ' · ' + own : ''}`);
      /* Meta fills on_behalf_of with the owner itself on accounts the business owns directly: that is not a partner. */
      const partner = obo && !obo.error && (obo.id || obo.name) && !(owner && !owner.error && ((obo.id && obo.id === owner.id) || (!obo.id && obo.name === owner.name))) && own !== 'SELF';
      row('Managed by a partner on your behalf', !partner, obo?.error ? 'cannot read: ' + obo.error : partner ? `yes: ${obo.name || obo.id}. Only that partner's app can send` : 'no (you own it)');
      row('Account review / verification', !(review && !review.error && review === 'REJECTED'), `review ${review?.error ? '?' : review || '?'} · business verification ${verif?.error ? '?' : verif || '?'}`);
      row('Payment method readable', !!fund && !fund.error, fund?.error ? 'hidden: ' + fund.error.slice(0, 60) + (partner ? ' (a partner such as AiSensy likely pays through its own credit line)' : ' (normal for your own account: check WhatsApp Manager → Payment settings has a card)') : fund ? 'funding id ' + fund : 'none set: add a card in WhatsApp Manager → Payment settings');
      try { const apps = (await waGet(env, `${env.WA_WABA_ID}/subscribed_apps`)).data || []; const ids = apps.map((a) => String(a.whatsapp_business_api_data?.id || a.id || '')); row('Your app is linked to the WhatsApp account', appId ? ids.includes(appId) : apps.length > 0, appId && !ids.includes(appId) ? 'press "Connect replies to this WhatsApp account"' : apps.map((a) => a.whatsapp_business_api_data?.name || '').filter(Boolean).join(', ')); }
      catch (e) { row('Your app is linked to the WhatsApp account', false, e.message); }
    } else row('WhatsApp Business Account ID saved', false, 'add it in card 1');
    let templates = [];
    if (env.WA_WABA_ID) {
      try { templates = (await waGet(env, `${env.WA_WABA_ID}/message_templates?fields=name,status,language,category&limit=100`)).data || []; } catch (e) { templates = [{ name: 'Could not list templates: ' + e.message, status: '' }]; }
    }
    return { ok: true, number: me.display_phone_number || '', name: me.verified_name || '', quality: me.quality_rating || '?', templates: [...checks, ...templates] };
  },
  /* template name -> Go4WhatsUp template _id, for plans where the listing API is blocked */
  async save_g4w_ids(env, b) {
    const ids = {};
    for (const line of String(b.text || '').split(/\n+/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*[=:,\s]\s*([A-Za-z0-9_-]{6,})\s*$/);
      if (m) ids[m[1].toLowerCase()] = m[2];
    }
    await putSetting(env, 'g4w_ids', ids);
    g4w.clearTemplateCache();
    return { ok: true, count: Object.keys(ids).length };
  },
  /* Dashboard "Try a template": send one template by name + ID to one number and show Go4WhatsUp's raw answer. */
  async wa_try_template(env, b) {
    if (!(env.G4W_API_KEY && env.G4W_SECURE_KEY)) throw new Error('Go4WhatsUp keys are not set in Vercel');
    const name = String(b.name || '').trim(), id = String(b.id || '').trim(), to = cleanPhone(b.to);
    if (!name) throw new Error('Enter the template name');
    if (!to) throw new Error('Enter a 10-digit number');
    /* variables: the ones the checkout uses for this template, else the reminder set */
    let vars = ['name', 'items', 'link'], media = true;
    for (const k of Object.keys(TRIGGERS)) { const c = triggerConfig(env, k); if (c.name === name || (c.variants || []).includes(name)) { vars = c.vars; media = !!TRIGGERS[k].media; } }
    const sample = { name: 'Shivang', order: '#TEST', items: 'God\u2019s Plan Script', total: '449.00', link: env.STORE_URL || 'https://www.inkkulture.in', confirm: env.STORE_URL, pay: env.STORE_URL, pct: '10', newtotal: '404.10', courier: 'Delhivery', tracking: 'TEST123' };
    const body = Object.fromEntries(vars.map((k) => [k, sample[k] ?? '-']));
    const image = media && !b.noimage ? (env.WA_HEADER_IMAGE || (await searchProducts(env, '').catch(() => [])).find((p) => p.image)?.image || '') : '';
    try {
      const r = b.plain
        ? await g4w.sendTemplatePlainRaw(env, { id: id || (await g4w.templateId(env, name)), to })
        : await g4w.sendTemplate(env, { name, id, to, body, fileUrl: image, raw: true });
      await logMsg(env, { phone: to, trigger: 'try', template: name, status: 'sent', preview: JSON.stringify(body).slice(0, 300) });
      return { sent: true, used_id: r.payload.templateId, api: r.api, vars: b.plain ? {} : body, image: b.plain ? '' : image, response: r.response };
    } catch (e) {
      await logMsg(env, { phone: to, trigger: 'try', template: name, status: 'failed', error: String(e.message || e) });
      return { sent: false, api: b.plain ? 'sendTemplate' : image ? 'sendAttachmentWithVariable' : 'sendTemplateWithVariable', used_id: id || '(looked up by name)', vars: b.plain ? {} : body, image: b.plain ? '' : image, error: String(e.message || e) };
    }
  },
  /* Point the WhatsApp account's webhooks at this app (POST /{waba}/subscribed_apps), so replies reach /api/wa/webhook. */
  /* ---- moving the number into an account the business owns ---- */
  async wa_accounts(env) {
    const { accessibleAccounts } = await import('./wa-migrate.js');
    return await accessibleAccounts(env);
  },
  /* Switch to a number in another WhatsApp account the business owns (the old number moved, or a new SIM).
     b.number: the number to use (optional, last 10 digits are matched). b.waba: account ID, if the token's account list misses it. */
  async wa_finish_migration(env, b = {}) {
    const { accessibleAccounts } = await import('./wa-migrate.js');
    const s = await getSettings(env, true);
    const w = { ...s.wa };
    const cur = String(w.waba_id || '');
    /* the account templates get copied from: the partner-run one, kept across repeated presses */
    const old = String(w.prev_waba || cur);
    const want = digits(b.number).slice(-10);
    const { accounts } = await accessibleAccounts(env);
    const extra = digits(b.waba);
    if (extra && !accounts.some((a) => a.id === extra)) {
      const acc = { id: extra, name: '', numbers: [] };
      try { acc.name = (await waGet(env, `${extra}?fields=name`)).name || ''; } catch { /* name hidden */ }
      try { acc.numbers = (await waGet(env, `${extra}/phone_numbers?fields=id,display_phone_number,verified_name,status,platform_type`)).data || []; } catch (e) { throw new Error(`Can't read WhatsApp account ${extra}: ${e.message}. Assign it to the system user (Business settings → System users → Assign assets).`); }
      accounts.push(acc);
    }
    const pool = accounts.filter((a) => a.id !== old).flatMap((a) => (a.numbers || []).map((n) => ({ a, n })));
    let hit;
    if (want) hit = pool.find((x) => digits(x.n.display_phone_number).endsWith(want));
    else if (pool.length === 1) hit = pool[0];
    else hit = pool.find((x) => digits(x.n.display_phone_number).endsWith('7559353503'));
    if (!hit) {
      const seen = pool.map((x) => x.n.display_phone_number).join(', ');
      throw new Error(want
        ? `+91 ${want} isn't in any WhatsApp account this token can reach${seen ? ` (found: ${seen})` : ''}. Add it in Meta (app → WhatsApp → API Setup → Add phone number), assign the new WhatsApp account to the system user, then try again.`
        : pool.length ? `Several numbers found (${seen}). Type the one to use and press again.` : 'No new WhatsApp account found. Add the number in Meta (app → WhatsApp → API Setup → Add phone number) and assign the new WhatsApp account to the system user, then try again.');
    }
    const phoneId = String(hit.n.id);
    /* A number added through API Setup is verified but not always registered for sending. Register it with a
       new two-step PIN (shown once, kept in settings) unless Meta already reports it as connected. */
    let registered = String(hit.n.status || '').toUpperCase() === 'CONNECTED';
    let pin = '', regError = '';
    if (!registered) {
      /* reuse the saved PIN: a number moved between accounts keeps its two-step PIN */
      pin = w.pin || String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
      const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/register`, { method: 'POST', headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', pin }) });
      const j = await res.json().catch(() => ({}));
      registered = !!j.success;
      if (!registered) regError = j.error?.error_user_msg || j.error?.message || 'HTTP ' + res.status;
      else { w.pin = pin; w.pin_phone = phoneId; }
    }
    w.prev_waba = old; w.waba_id = hit.a.id; w.phone_id = phoneId; w.number = digits(hit.n.display_phone_number);
    await putSetting(env, 'wa', w);
    clearMetaCache();
    let linked = false;
    try { const r = await fetch(`https://graph.facebook.com/v21.0/${hit.a.id}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${env.WA_TOKEN}` } }); linked = !!(await r.json().catch(() => ({}))).success; } catch { /* shown as not linked */ }
    return { ok: true, waba: hit.a.id, name: hit.a.name, phone_id: phoneId, number: hit.n.display_phone_number, status: hit.n.status, from: old, linked, registered, pin: registered && pin ? pin : '', reg_error: regError };
  },
  /* ---- Meta's supported number migration between two WhatsApp accounts the token can manage ----
     Keeps display name, quality, limits and approved templates. Needs: display name approved, two-step
     verification turned OFF on the number, and a payment method (card or prepaid funds) on the destination. */
  async wa_move_check(env, b) {
    const s = await getSettings(env, true);
    const w = s.wa || {};
    const dest = digits(b.dest);
    const out = { number: '', name_status: '', dest_ok: false, dest_name: '', notes: [] };
    try {
      const p = await waGet(env, `${w.phone_id}?fields=display_phone_number,verified_name,name_status,status`);
      out.number = p.display_phone_number; out.name_status = p.name_status || '';
      if (!/APPROVED|AVAILABLE_WITHOUT_REVIEW/.test(out.name_status)) out.notes.push(`Display name "${p.verified_name}" is ${out.name_status || 'not approved yet'}. Meta only allows the move once it is approved.`);
    } catch (e) { out.notes.push('Could not read the current number: ' + e.message); }
    if (dest) {
      try { const d = await waGet(env, `${dest}?fields=name`); out.dest_ok = true; out.dest_name = d.name || ''; } catch (e) { out.notes.push(`Can't reach WhatsApp account ${dest}: ${e.message}`); }
      if (dest === String(w.waba_id)) out.notes.push('That is the account the number is already in.');
    } else out.notes.push('Enter the WhatsApp account ID to move to.');
    out.notes.push('Before sending the code: WhatsApp Manager → Phone numbers → ⚙ on the number → Two-step verification → Turn off.');
    return out;
  },
  async wa_move_start(env, b) {
    const s = await getSettings(env, true);
    const w = { ...s.wa };
    const dest = digits(b.dest);
    if (!dest) throw new Error('Enter the WhatsApp account ID to move to');
    if (dest === String(w.waba_id)) throw new Error('The number is already in that account');
    const num = digits(b.number || w.number).slice(-10);
    if (!/^\d{10}$/.test(num)) throw new Error('Enter the 10-digit number to move');
    const post = async (path, body) => {
      const r = await fetch(`https://graph.facebook.com/v21.0/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error((j.error?.error_user_msg || j.error?.message || 'HTTP ' + r.status) + (j.error?.code ? ` (#${j.error.code}${j.error.error_subcode ? '/' + j.error.error_subcode : ''})` : ''));
      return j;
    };
    /* Meta requires an app subscribed to the destination's webhooks before a Cloud API number can move in. */
    await post(`${dest}/subscribed_apps`).catch(() => {});
    const m = await post(`${dest}/phone_numbers`, { cc: '91', phone_number: num, migrate_phone_number: true });
    if (!m.id) throw new Error('Meta did not return a phone number ID');
    await post(`${m.id}/request_code`, { code_method: b.voice ? 'VOICE' : 'SMS', language: 'en_US' });
    w.move = { dest, phone_id: String(m.id), from_waba: String(w.waba_id || ''), number: num, at: Date.now() };
    await putSetting(env, 'wa', w);
    return { ok: true, phone_id: String(m.id), sent: b.voice ? 'call' : 'SMS', to: '+91 ' + num };
  },
  async wa_move_verify(env, b) {
    const s = await getSettings(env, true);
    const w = { ...s.wa };
    const mv = w.move;
    if (!mv?.phone_id) throw new Error('Press "Send code" first');
    const code = digits(b.code);
    if (code.length !== 6) throw new Error('Enter the 6-digit code from the SMS');
    const post = async (path, body) => {
      const r = await fetch(`https://graph.facebook.com/v21.0/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error((j.error?.error_user_msg || j.error?.message || 'HTTP ' + r.status) + (j.error?.code ? ` (#${j.error.code}${j.error.error_subcode ? '/' + j.error.error_subcode : ''})` : ''));
      return j;
    };
    await post(`${mv.phone_id}/verify_code`, { code });
    const pin = w.pin || String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
    await post(`${mv.phone_id}/register`, { messaging_product: 'whatsapp', pin });
    w.prev_waba = mv.from_waba || w.waba_id; w.waba_id = mv.dest; w.phone_id = mv.phone_id; w.pin = pin; w.pin_phone = mv.phone_id; w.number = '91' + mv.number;
    delete w.move;
    await putSetting(env, 'wa', w);
    clearMetaCache();
    return { ok: true, waba: w.waba_id, phone_id: w.phone_id, pin };
  },
  async wa_template_detail(env, b) {
    const { templateDetails } = await import('./wa-migrate.js');
    const s = await getSettings(env, true);
    const names = String(b.names || '').split(',').map((x) => x.trim()).filter(Boolean);
    return { templates: await templateDetails(env, s.wa.waba_id || env.WA_WABA_ID, names) };
  },
  /* Submit new templates (b.templates = [{name, category, parameter_format, components}]) to the current account. */
  async wa_create_templates(env, b) {
    const { createTemplate, accessibleAccounts } = await import('./wa-migrate.js');
    const s = await getSettings(env, true);
    const waba = s.wa.waba_id || env.WA_WABA_ID;
    const list = Array.isArray(b.templates) ? b.templates.slice(0, 4) : [];
    if (!list.length) throw new Error('No templates given');
    let appId = '';
    try { appId = (await accessibleAccounts(env)).appId; } catch { /* only needed for image headers */ }
    if (!appId) appId = String(b.app_id || '');
    const sampleImage = b.sample_image || env.WA_HEADER_IMAGE || (await searchProducts(env, '').catch(() => [])).find((p) => p.image)?.image || '';
    const out = [];
    for (const tpl of list) {
      if (!/^[a-z0-9_]{1,512}$/.test(tpl.name || '')) { out.push({ name: tpl.name, status: 'FAILED', error: 'name must be lowercase letters, digits and _' }); continue; }
      try { const r = await createTemplate(env, { waba, appId, tpl, sampleImage }); out.push({ name: tpl.name, status: r.status || 'PENDING', category: r.category || '', id: r.id }); }
      catch (e) { out.push({ name: tpl.name, status: 'FAILED', error: String(e.message || e).slice(0, 300) }); }
    }
    return { created: out };
  },
  async wa_copy_templates(env) {
    const { copyTemplates, accessibleAccounts } = await import('./wa-migrate.js');
    const s = await getSettings(env, true);
    if (!s.wa.prev_waba) throw new Error('Press "I\'ve moved the number: finish setup" first');
    const { appId } = await accessibleAccounts({ ...env, WA_TOKEN: s.wa.token || env.WA_TOKEN }).catch(() => ({ appId: '' }));
    const fallbackImage = env.WA_HEADER_IMAGE || (await searchProducts(env, '').catch(() => [])).find((p) => p.image)?.image || '';
    return await copyTemplates({ ...env, WA_TOKEN: s.wa.token || env.WA_TOKEN }, { from: s.wa.prev_waba, to: s.wa.waba_id, appId, fallbackImage, max: 3 });
  },
  async wa_subscribe(env) {
    if (!env.WA_WABA_ID || !env.WA_TOKEN) throw new Error('Save the WhatsApp Business Account ID and the access token first');
    const res = await fetch(`https://graph.facebook.com/v21.0/${env.WA_WABA_ID}/subscribed_apps`, { method: 'POST', headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.success) throw new Error(j.error?.message || 'HTTP ' + res.status);
    return { ok: true };
  },
  async wa_send_test(env, b) {
    const key = String(b.trigger);
    if (!TRIGGERS[key]) throw new Error('Unknown template');
    const to = cleanPhone(b.to) || cleanPhone(env.WA_ADMIN_PHONE);
    if (!to) throw new Error('Enter a 10-digit number to send the test to');
    const sample = { name: 'Test', order: '#TEST', total: '499.00', courier: 'Delhivery', tracking: 'TEST123', items: 'Test item', link: env.STORE_URL, method: 'COD', risk: '40 (medium)', reasons: 'test',
      pct: String(env.COD_CONVERT_DISCOUNT || 10), newtotal: '449.00', confirm: env.STORE_URL, pay: env.STORE_URL };
    /* Image-header templates need a picture: use a real product shot for the test. */
    if (TRIGGERS[key].media === 'video') sample.video = (await import('./apply-guide.js')).applyVideo(env);
    else if (TRIGGERS[key].media && (!env.WA_HEADER_IMAGE || b.image_q)) sample.image = (await searchProducts(env, String(b.image_q || '')).catch(() => [])).find((p) => p.image)?.image || '';
    if (b.image_q) sample.items = (await searchProducts(env, String(b.image_q)).catch(() => []))[0]?.title || sample.items;
    /* b.template: test one exact template (no rotation) instead of whatever today's rotation picks for this number. */
    const pick = /^[a-z0-9_]{1,512}$/.test(String(b.template || '')) ? String(b.template) : '';
    const forced = { ...env, SETTINGS: { ...env.SETTINGS, templates: { ...env.SETTINGS.templates, [key]: { ...(env.SETTINGS.templates?.[key] || {}), enabled: true, name: pick || triggerConfig(env, key).name, ...(pick ? { variants: [pick] } : {}) } } } };
    const r = await fireTrigger(forced, key, { to, vars: sample, orderId: '0', orderName: '#TEST' });
    return r;
  },
  async products(env, b) { return { products: await searchProducts(env, String(b.q || '').trim()) }; },
  async save_upsells(env, b) {
    const list = (Array.isArray(b.upsells) ? b.upsells : []).slice(0, 6).map((u) => ({
      variantId: String(u.variantId).replace(/\D/g, ''), title: String(u.title || '').slice(0, 100), image: String(u.image || '').slice(0, 400), price: +u.price || 0,
      pct: Math.max(0, Math.min(80, +u.pct || 0)), headline: String(u.headline || '').slice(0, 80), enabled: u.enabled !== false, minCart: Math.max(0, +u.minCart || 0),
    })).filter((u) => u.variantId);
    await putSetting(env, 'upsells', list);
    return { ok: true };
  },
  async save_logos(env, b) {
    const l = {}; for (const k of ['gpay', 'phonepe', 'paytm', 'any']) l[k] = String((b.logos || {})[k] || '').trim().slice(0, 500);
    await putSetting(env, 'upi_logos', l);
    return { ok: true };
  },
  async change_password(env, b) {
    const s = await getSettings(env, true);
    if (!safeEqual(await hashPw(s.admin.salt, String(b.current || '')), s.admin.hash)) throw new Error('Current password is wrong');
    if (String(b.next || '').length < 8) throw new Error('New password must be at least 8 characters');
    const salt = Math.random().toString(36).slice(2);
    await putSetting(env, 'admin', { ...s.admin, salt, hash: await hashPw(salt, String(b.next)) });
    return { ok: true };
  },
};

/** For tests: one dashboard action by name. */
export const action = (name) => ACTIONS[name];

export async function handleRpc(req, env) {
  const who = await checkToken(env, req);
  if (!who) return json({ ok: false, error: 'unauthorized' }, 401);
  const b = await req.json().catch(() => ({}));
  const fn = ACTIONS[b.action];
  if (!fn) return json({ ok: false, error: 'unknown action' }, 400);
  try { return json({ ok: true, ...(await fn(env, b)) }); } catch (e) { return json({ ok: false, error: String(e.message || e) }, 200); }
}

/** POST /api/admin/label {id} -> that order's label as a PDF (binary, so it is not an RPC action). The browser joins many into one file. */
export async function handleLabel(req, env) {
  if (!(await checkToken(env, req))) return json({ ok: false, error: 'unauthorized' }, 401);
  const b = await req.json().catch(() => ({}));
  try {
    const pdf = await labelPdf(await withSettingsFresh(env), b.id);
    return new Response(pdf, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' } });
  } catch (e) { return json({ ok: false, error: String(e.message || e) }); }
}

/* ---------------- cron: abandoned nudge + COD reminder ---------------- */
export async function runAutomations(env) {
  const out = { nudged: 0, reminded: 0 };
  const t = now();
  if (triggerConfig(env, 'abandoned_cart').enabled) {
    /* 20 minutes after the shopper went quiet (the cron runs every 5 minutes). */
    const rows = (await env.DB.prepare("SELECT * FROM leads WHERE status='open' AND nudged_at IS NULL AND updated_at<? AND updated_at>? LIMIT 30").bind(t - 20 * 60, t - 6 * 3600).all()).results;
    for (const l of rows) {
      await env.DB.prepare('UPDATE leads SET nudged_at=? WHERE phone=?').bind(t, l.phone).run();
      await fireTrigger(env, 'abandoned_cart', { to: l.phone, vars: { name: l.name?.split(' ')[0] || 'there', items: 'your Ink Kulture cart', link: await cartLink(env, l.phone) } });
      out.nudged++;
    }
  }
  if (triggerConfig(env, 'cod_reminder').enabled) {
    const rows = (await env.DB.prepare("SELECT * FROM orders WHERE method='cod' AND status='placed' AND confirmed_at IS NULL AND reminded_at IS NULL AND created_at<? AND created_at>? LIMIT 30").bind(t - 20 * 3600, t - 5 * 86400).all()).results;
    for (const o of rows) {
      await env.DB.prepare('UPDATE orders SET reminded_at=? WHERE txnid=?').bind(t, o.txnid).run();
      await fireTrigger(env, 'cod_reminder', { to: o.phone, vars: { name: o.first_name, order: o.order_name, total: rupees(o.total_paise) }, orderId: o.order_id, orderName: o.order_name });
      out.reminded++;
    }
  }
  /* Orders cancelled in Shopify or by another COD app, so they leave "To ship" here too */
  try {
    const open = (await env.DB.prepare("SELECT order_id FROM orders WHERE order_id IS NOT NULL AND shipped_at IS NULL AND status NOT IN ('cancelled','failed','pending_payment','completing') AND created_at>? ORDER BY created_at DESC LIMIT 300").bind(t - 30 * 86400).all()).results;
    out.cancelSynced = (await syncCancelledOrders(env, open.map((r) => String(r.order_id)))).length;
    out.fulfilSynced = (await syncFulfilledOrders(env, open.map((r) => String(r.order_id)))).length;
  } catch (e) { console.error('cancel-sync', e); }
  /* Shipments tab: keep every live parcel's Shiprocket status fresh (pickup-stage ones every 15 min) */
  try { out.shipRefresh = await refreshDue(env); } catch (e) { console.error('ship-refresh', e); }
  /* Cancelled orders whose parcel is still booked: cancel the pickup (or flag it if the courier already has it) */
  try { const sw = await sweepCancelled(env); out.cancelSweep = sw; } catch (e) { console.error('cancel-sweep', e); }
  /* WhatsApp assistant: answer phones queued by the rate limit (spaced, a few per run) */
  try { const { drainQueue, aiOn } = await import('./wa-ai.js'); if (aiOn(env)) out.aiQueue = await drainQueue(env, { max: 6, gapMs: 2500 }); } catch (e) { console.error('ai-queue', e); }
  /* Product order in Bestsellers / All Tattoos / Home page: sold out last, a few bigger designs up top (daily) */
  try { const r = await resendPurchases(env, { limit: 40 }); if (r.tried) out.capi = r; } catch (e) { console.error('capi retry', e); }
  try { const { rankAll } = await import('./ranking.js'); const r = await rankAll(env); if (!r.skipped) out.rank = { ok: r.ok, error: r.error }; } catch (e) { console.error('rank', e); }
  /* Reconciliation audit (Shopify x Shiprocket x here) every ~30 minutes; it only records issues, the owner fixes them from the Shipments tab */
  try {
    const last = Number((await env.DB.prepare("SELECT v FROM settings WHERE k='ship_audit_at'").first())?.v) || 0;
    if (t - last > 29 * 60) { const a = await shipAudit(env, { days: 45, max: 300 }); out.audit = { checked: a.checked, found: a.found }; }
  } catch (e) { console.error('ship-audit', e); }
  /* Shiprocket bookings that are not fulfilled in Shopify yet (the step failed, or the page was closed mid-way): retry a few per run */
  try {
    const stuck = (await env.DB.prepare(`SELECT s.order_id FROM shipments s JOIN orders o ON o.order_id = s.order_id
      WHERE s.awb IS NOT NULL AND s.awb<>'' AND COALESCE(s.status,'')<>'cancelled' AND o.shipped_at IS NULL AND COALESCE(o.status,'')<>'cancelled' AND s.created_at>?
      ORDER BY s.created_at LIMIT 5`).bind(t - 14 * 86400).all()).results;
    out.fulfilled = 0;
    for (const s of stuck) if (!(await fulfilBooked(env, s.order_id))) out.fulfilled++;
  } catch (e) { console.error('fulfil-retry', e); }
  return out;
}
