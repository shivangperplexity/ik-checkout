import { json, hmacSha256hex, sha256hex, safeEqual, cleanPhone } from './util.js';
import { getSettings, putSetting, TRIGGERS, VAR_LABELS, triggerConfig } from './settings.js';
async function withSettingsFresh(env) { return { ...env, SETTINGS: await getSettings(env, true) }; }
import { orderDetail, shipOrder, searchProducts, addTags, removeTags, cancelOrder } from './shopify.js';
import { fireTrigger, waGet, logMsg } from './whatsapp.js';
import { rupees } from './pricing.js';

const now = () => Math.floor(Date.now() / 1000);
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
  if (o.method === 'cod') {
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
function orderOut(o, all) {
  const r = scoreOrder(o, all);
  return {
    id: o.order_id, name: o.order_name, txnid: o.txnid, method: o.method, status: o.status, total: num(o.total_paise) / 100, phone: o.phone, customer: `${o.first_name || ''} ${o.last_name || ''}`.trim(),
    city: o.city, pincode: o.pincode, state: o.state_code, created_at: num(o.created_at), confirmed_at: num(o.confirmed_at) || null, shipped_at: num(o.shipped_at) || null, tracking: o.tracking || '',
    risk: r.score, level: r.level,
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
const mask = (v) => (v ? '••••••' + String(v).slice(-4) : '');
const IST = 19800;

async function liveData(env) {
  const t = now();
  const rows = (await env.DB.prepare('SELECT * FROM sessions WHERE last_seen>? ORDER BY last_seen DESC LIMIT 80').bind(t - 1800).all()).results;
  const mapped = rows.map((s) => ({
    sid: s.sid.slice(0, 8), phone: s.phone, name: s.name, device: s.device, step: s.step || 'cart', max_step: s.max_step, method: s.method, source: s.source || 'direct',
    cart: JSON.parse(s.cart_json || '[]'), value: num(s.cart_value), ordered: !!s.ordered, order: s.order_name, last_seen: num(s.last_seen), first_seen: num(s.first_seen), active: t - num(s.last_seen) < 90,
  }));
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

const ACTIONS = {
  async live(env) { return liveData(env); },
  async analytics(env, b) { return analytics(env, Math.min(90, Math.max(1, +b.days || 7))); },
  async orders(env, b) {
    const all = await recentOrders(env, 90);
    let list = all.map((o) => orderOut(o, all));
    if (b.filter === 'high') list = list.filter((o) => o.level === 'high');
    if (b.filter === 'toship') list = list.filter((o) => !o.shipped_at && o.status !== 'cancelled' && (o.method !== 'cod' || o.confirmed_at));
    if (b.filter === 'unconfirmed') list = list.filter((o) => o.method === 'cod' && !o.confirmed_at && o.status !== 'cancelled');
    if (b.filter === 'shipped') list = list.filter((o) => o.shipped_at);
    if (b.q) { const q = String(b.q).toLowerCase(); list = list.filter((o) => `${o.name} ${o.phone} ${o.customer} ${o.pincode}`.toLowerCase().includes(q)); }
    return { orders: list.slice(0, 200) };
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
  async confirm(env, b) {
    const gid = `gid://shopify/Order/${b.id}`;
    await removeTags(env, gid, ['cod-unconfirmed']); await addTags(env, gid, ['cod-confirmed']);
    await env.DB.prepare('UPDATE orders SET confirmed_at=? WHERE order_id=?').bind(now(), String(b.id)).run();
    return { ok: true };
  },
  async cancel(env, b) {
    const gid = `gid://shopify/Order/${b.id}`;
    await cancelOrder(env, gid, 'Cancelled from Ink Kulture dashboard');
    await env.DB.prepare("UPDATE orders SET status='cancelled' WHERE order_id=?").bind(String(b.id)).run();
    return { ok: true };
  },
  async ship(env, b) {
    const company = String(b.company || '').trim(), number = String(b.number || '').trim();
    if (!company || !number) throw new Error('Enter courier name and tracking number');
    const o = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(String(b.id)).first();
    if (!o) throw new Error('Order not found');
    await shipOrder(env, b.id, { company, number, url: String(b.url || '').trim(), notify: b.notify !== false });
    await env.DB.prepare('UPDATE orders SET shipped_at=?, tracking=? WHERE order_id=?').bind(now(), `${company} ${number}`, String(b.id)).run();
    const w = await fireTrigger(env, 'order_shipped', { to: o.phone, vars: { name: o.first_name, order: o.order_name, courier: company, tracking: number }, orderName: o.order_name });
    return { ok: true, whatsapp: w };
  },
  async leads(env) {
    const rows = (await env.DB.prepare("SELECT phone,name,pincode,cart_json,utm_json,step,updated_at,nudged_at FROM leads WHERE status='open' AND updated_at>? ORDER BY updated_at DESC LIMIT 200").bind(now() - 7 * 86400).all()).results;
    return { leads: rows.map((l) => ({ ...l, cart: JSON.parse(l.cart_json || '[]').length, updated_at: num(l.updated_at), nudged_at: num(l.nudged_at) || null })) };
  },
  async nudge(env, b) {
    const l = await env.DB.prepare('SELECT * FROM leads WHERE phone=?').bind(String(b.phone)).first();
    if (!l) throw new Error('Lead not found');
    const r = await fireTrigger(env, 'abandoned_cart', { to: l.phone, vars: { name: l.name?.split(' ')[0] || 'there', items: 'your Ink Kulture cart', link: env.STORE_URL + '/cart' } });
    if (r.skipped) throw new Error(r.skipped === 'disabled' ? 'Turn on the "Abandoned checkout nudge" template first (WhatsApp tab)' : r.skipped === 'nowa' ? 'WhatsApp is not connected yet' : 'No phone');
    await env.DB.prepare('UPDATE leads SET nudged_at=? WHERE phone=?').bind(now(), l.phone).run();
    return { ok: !!r.ok };
  },
  async messages(env) {
    return { messages: (await env.DB.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 150').all()).results };
  },
  async settings(env) {
    const s = await getSettings(env, true);
    const w = s.wa;
    return {
      wa: { phone_id: w.phone_id, waba_id: w.waba_id, admin_phone: w.admin_phone, lang: w.lang, token: mask(w.token), app_secret: mask(w.app_secret), verify_token: w.verify_token, has_token: !!(w.token || env.WA_TOKEN), connected: !!((w.phone_id || env.WA_PHONE_ID) && (w.token || env.WA_TOKEN)) },
      webhook: 'https://ik-checkout.vercel.app/api/wa/webhook',
      triggers: Object.entries(TRIGGERS).map(([key, t]) => ({ key, label: t.label, to: t.to, when: t.when, buttons: !!t.buttons, allVars: t.vars, ...triggerConfig({ ...env, SETTINGS: s }, key) })),
      var_labels: VAR_LABELS,
      upsells: s.upsells, upi_logos: s.upi_logos, email: s.admin?.email,
      shipping: { nimbus_email: s.shipping.nimbus_email, nimbus_password: mask(s.shipping.nimbus_password), origin_pin: s.shipping.origin_pin, weight_g: s.shipping.weight_g, connected: !!(s.shipping.nimbus_email && s.shipping.nimbus_password) },
    };
  },
  async save_shipping(env, b) {
    const s = await getSettings(env, true);
    const sh = { ...s.shipping };
    if (b.nimbus_email !== undefined) sh.nimbus_email = String(b.nimbus_email).trim().slice(0, 200);
    if (b.nimbus_password && !String(b.nimbus_password).startsWith('••')) sh.nimbus_password = String(b.nimbus_password).trim();
    if (b.origin_pin !== undefined && /^\d{6}$/.test(String(b.origin_pin).trim())) sh.origin_pin = String(b.origin_pin).trim();
    if (b.weight_g !== undefined) sh.weight_g = Math.max(10, Math.min(5000, +b.weight_g || 50));
    await putSetting(env, 'shipping', sh);
    return { ok: true };
  },
  async shipping_test(env, b) {
    const { shippingEstimate } = await import('./shipping.js');
    const pin = String(b.pin || '').trim() || '411001';
    const fresh = await withSettingsFresh(env);
    const r = await shippingEstimate(new Request('https://x/api/shipping?pin=' + pin + '&cod=1&nocache=1'), fresh);
    return await r.json();
  },
  async save_wa(env, b) {
    const s = await getSettings(env, true);
    const w = { ...s.wa };
    for (const k of ['phone_id', 'waba_id', 'admin_phone', 'lang', 'verify_token']) if (b[k] !== undefined) w[k] = String(b[k]).trim().slice(0, 200);
    for (const k of ['token', 'app_secret']) if (b[k] && !String(b[k]).startsWith('••')) w[k] = String(b[k]).trim();
    if (!w.verify_token) w.verify_token = 'ik_' + Math.random().toString(36).slice(2, 12);
    await putSetting(env, 'wa', w);
    return { ok: true };
  },
  async save_triggers(env, b) {
    const t = {};
    for (const [k, v] of Object.entries(b.triggers || {})) if (TRIGGERS[k]) t[k] = { enabled: !!v.enabled, name: String(v.name || '').trim().slice(0, 100), lang: String(v.lang || 'en').slice(0, 10), vars: (v.vars || []).filter((x) => TRIGGERS[k].vars.includes(x)) };
    await putSetting(env, 'templates', t);
    return { ok: true };
  },
  async wa_test(env) {
    if (!env.WA_PHONE_ID || !env.WA_TOKEN) throw new Error('Add Phone number ID and access token first');
    const me = await waGet(env, `${env.WA_PHONE_ID}?fields=display_phone_number,verified_name,quality_rating`);
    let templates = [];
    if (env.WA_WABA_ID) {
      try { templates = (await waGet(env, `${env.WA_WABA_ID}/message_templates?fields=name,status,language,category&limit=100`)).data || []; } catch (e) { templates = [{ name: 'Could not list templates: ' + e.message, status: '' }]; }
    }
    return { ok: true, number: me.display_phone_number, name: me.verified_name, quality: me.quality_rating, templates };
  },
  async wa_send_test(env, b) {
    const key = String(b.trigger);
    if (!TRIGGERS[key]) throw new Error('Unknown template');
    const to = cleanPhone(b.to) || cleanPhone(env.WA_ADMIN_PHONE);
    if (!to) throw new Error('Enter a 10-digit number to send the test to');
    const sample = { name: 'Test', order: '#TEST', total: '499.00', courier: 'Delhivery', tracking: 'TEST123', items: 'Test item', link: env.STORE_URL, method: 'COD', risk: '40 (medium)', reasons: 'test' };
    const forced = { ...env, SETTINGS: { ...env.SETTINGS, templates: { ...env.SETTINGS.templates, [key]: { ...(env.SETTINGS.templates?.[key] || {}), enabled: true, name: triggerConfig(env, key).name } } } };
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

export async function handleRpc(req, env) {
  const who = await checkToken(env, req);
  if (!who) return json({ ok: false, error: 'unauthorized' }, 401);
  const b = await req.json().catch(() => ({}));
  const fn = ACTIONS[b.action];
  if (!fn) return json({ ok: false, error: 'unknown action' }, 400);
  try { return json({ ok: true, ...(await fn(env, b)) }); } catch (e) { return json({ ok: false, error: String(e.message || e) }, 200); }
}

/* ---------------- cron: abandoned nudge + COD reminder ---------------- */
export async function runAutomations(env) {
  const out = { nudged: 0, reminded: 0 };
  const t = now();
  if (triggerConfig(env, 'abandoned_cart').enabled) {
    const rows = (await env.DB.prepare("SELECT * FROM leads WHERE status='open' AND nudged_at IS NULL AND updated_at<? AND updated_at>? LIMIT 30").bind(t - 45 * 60, t - 6 * 3600).all()).results;
    for (const l of rows) {
      await env.DB.prepare('UPDATE leads SET nudged_at=? WHERE phone=?').bind(t, l.phone).run();
      await fireTrigger(env, 'abandoned_cart', { to: l.phone, vars: { name: l.name?.split(' ')[0] || 'there', items: 'your Ink Kulture cart', link: env.STORE_URL + '/cart' } });
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
  return out;
}
