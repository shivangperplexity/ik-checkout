/**
 * Ink Kulture creator program (affiliates).
 *
 *   Apply   /creator (public page on this app): name, WhatsApp number, social link, followers. Status pending.
 *   Approve dashboard (More > Creators): a code from their handle (RIYAINK), WhatsApp "you're in" with the login link.
 *   Login   /creator: number -> 4-digit WhatsApp code (the COD OTP template) -> signed token (30 days).
 *   Link    https://ik-checkout.vercel.app/c/CODE counts the open, then goes to the store with ?ref=CODE&utm_...
 *   Orders  any order whose attribution.ref is the creator's code (COD and online payment), except the creator's own
 *           number. Followers get FOLLOWER_OFF off when they pay online, once per number per code.
 *   Earn    only when the order is DELIVERED: cash (paid monthly by UPI) or store credit (double), chosen once at
 *           first login and kept for every order after. Refused at the door (RTO) / cancelled orders earn nothing.
 *   Credit  spent with one-time voucher codes the creator makes on their dashboard (typed in the checkout, online
 *           payment), so nobody can spend a creator's credit by typing their number.
 *
 * Money is integer paise.
 */
import { hmacSha256hex, safeEqual } from './util.js';

const now = () => Math.floor(Date.now() / 1000);
export const STORE = 'https://www.inkkulture.in';
export const APP = (env) => String(env.WORKER_URL || 'https://ik-checkout.vercel.app').replace(/\/$/, '');
export const DEFAULTS = { on: true, follower_off: 5000, cash: 6000, credit: 12000, min_payout: 50000 };
export const cfg = (env) => ({ ...DEFAULTS, ...(env.SETTINGS?.creators || {}) });
const cleanPhone = (p) => { const d = String(p || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, ''); return /^[6-9]\d{9}$/.test(d) ? d : ''; };
export const normCode = (c) => String(c || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16);
export const linkOf = (env, code) => `${APP(env)}/c/${encodeURIComponent(code)}`;
export const storeLink = (code) => `${STORE}/?ref=${encodeURIComponent(code)}&utm_source=creator&utm_medium=affiliate&utm_campaign=${encodeURIComponent(code)}`;

/* ---------- order status as the creator sees it ---------- */
export function stageLabel(o) {
  if (o.order_status === 'cancelled') return { key: 'cancelled', label: 'Cancelled' };
  const st = String(o.stage || '');
  if (st === 'delivered') return { key: 'delivered', label: 'Delivered' };
  if (st === 'rto' || o.rto === true) return { key: 'refused', label: 'Delivery refused' };
  if (st === 'lost') return { key: 'refused', label: 'Not delivered' };
  if (st === 'ofd') return { key: 'ofd', label: 'Out for delivery' };
  if (st === 'ndr') return { key: 'transit', label: 'Delivery attempt failed, trying again' };
  if (st === 'transit') return { key: 'transit', label: 'Shipped' };
  if (st === 'pickup_pending' || st === 'pickup_failed') return { key: 'packed', label: 'Packed' };
  return { key: 'placed', label: 'Order placed' };
}

/* ---------- apply / approve ---------- */
export function cleanApplication(b) {
  const s = (v, n) => String(v || '').replace(/[<>]/g, '').trim().slice(0, n);
  const phone = cleanPhone(b.phone);
  const name = s(b.name, 60), link = s(b.link, 300), handle = s(b.handle, 60).replace(/^@/, '');
  const followers = Math.max(0, Math.min(1e8, Math.round(Number(String(b.followers || '').replace(/[^\d]/g, '')) || 0)));
  if (!name) throw new Error('Please enter your name');
  if (!phone) throw new Error('Please enter your 10-digit WhatsApp number');
  if (!link && !handle) throw new Error('Please add your Instagram (or other) profile link');
  if (!b.agree) throw new Error('Please accept the program terms');
  const platform = /youtu/i.test(link) ? 'YouTube' : /snapchat/i.test(link) ? 'Snapchat' : /facebook|fb\.com/i.test(link) ? 'Facebook' : /x\.com|twitter/i.test(link) ? 'X' : 'Instagram';
  const h = handle || (/instagram\.com\/([A-Za-z0-9._]+)/i.exec(link) || [])[1] || '';
  return { name, phone, link: link || (h ? `https://instagram.com/${h}` : ''), handle: h, platform, followers, city: s(b.city, 60), email: s(b.email, 120), about: s(b.about, 500) };
}

export async function apply(env, b) {
  const a = cleanApplication(b);
  const have = await env.DB.prepare('SELECT status FROM creators WHERE phone=?').bind(a.phone).first();
  if (have?.status === 'approved') return { ok: true, already: 'approved' };
  await env.DB.prepare(`INSERT INTO creators (phone, name, handle, platform, profile_url, followers, city, email, about, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?)
      ON CONFLICT (phone) DO UPDATE SET name=EXCLUDED.name, handle=EXCLUDED.handle, platform=EXCLUDED.platform, profile_url=EXCLUDED.profile_url, followers=EXCLUDED.followers,
      city=EXCLUDED.city, email=EXCLUDED.email, about=EXCLUDED.about, status=CASE WHEN creators.status='rejected' THEN 'pending' ELSE creators.status END`)
    .bind(a.phone, a.name, a.handle, a.platform, a.link, a.followers, a.city, a.email, a.about, now()).run();
  return { ok: true, status: 'pending' };
}

/** A code from the handle (or name): letters/digits, upper case, unique across creator AND customer codes. */
export function codeBase(c) {
  const b = String(c.handle || c.name || 'IK').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10);
  return b.length >= 3 ? b : (b + 'INK').slice(0, 6);
}
async function freeCode(env, base) {
  for (let i = 0; i < 30; i++) {
    const c = i === 0 ? base : (base.slice(0, 8) + (i < 10 ? String(i * 7 + 3) : String(Math.floor(Math.random() * 900) + 100)));
    const a = await env.DB.prepare('SELECT 1 AS x FROM creators WHERE code=?').bind(c).first();
    const b = await env.DB.prepare('SELECT 1 AS x FROM ref_codes WHERE code=?').bind(c).first().catch(() => null);
    if (!a && !b) return c;
  }
  throw new Error('No free code, set one by hand');
}

export async function approve(env, id, { code = '' } = {}) {
  const c = await env.DB.prepare('SELECT * FROM creators WHERE id=?').bind(Number(id)).first();
  if (!c) throw new Error('Creator not found');
  let want = normCode(code) || c.code || await freeCode(env, codeBase(c));
  if (normCode(code) && normCode(code) !== c.code) {
    const taken = await env.DB.prepare('SELECT id FROM creators WHERE code=? AND id<>?').bind(want, c.id).first();
    const cust = await env.DB.prepare('SELECT 1 AS x FROM ref_codes WHERE code=?').bind(want).first().catch(() => null);
    if (taken || cust) throw new Error(`Code ${want} is taken`);
  }
  await env.DB.prepare("UPDATE creators SET status='approved', code=?, approved_at=COALESCE(approved_at, ?), rejected_at=NULL WHERE id=?").bind(want, now(), c.id).run();
  let told = { skipped: 'already told' };
  if (!c.told_at) {
    const { fireTrigger } = await import('./whatsapp.js');
    told = await fireTrigger(env, 'creator_approved', { to: c.phone, vars: { name: String(c.name || '').split(/\s+/)[0] || 'there', code: want } }).catch((e) => ({ ok: false, error: e.message }));
    if (told.ok) await env.DB.prepare('UPDATE creators SET told_at=? WHERE id=?').bind(now(), c.id).run();
  }
  return { ok: true, code: want, whatsapp: told.ok ? 'sent' : (told.error || told.skipped || 'not sent') };
}
export async function reject(env, id, note = '') {
  await env.DB.prepare("UPDATE creators SET status='rejected', rejected_at=?, note=? WHERE id=?").bind(now(), String(note).slice(0, 300), Number(id)).run();
  return { ok: true };
}

/* ---------- login: WhatsApp code, then a signed token ---------- */
const secret = (env) => env.ADMIN_SECRET || env.CRON_SECRET || 'ik|' + (env.DATABASE_URL || env.POSTGRES_URL || 'x');
export async function makeToken(env, phone, ttl = 30 * 86400) {
  const exp = now() + ttl, body = `${phone}.${exp}`;
  return `${body}.${(await hmacSha256hex(secret(env), 'creator:' + body)).slice(0, 32)}`;
}
export async function readToken(env, tok) {
  const m = /^(\d{10})\.(\d{10})\.([a-f0-9]{32})$/.exec(String(tok || ''));
  if (!m || Number(m[2]) < now()) return null;
  const want = (await hmacSha256hex(secret(env), `creator:${m[1]}.${m[2]}`)).slice(0, 32);
  return safeEqual(want, m[3]) ? m[1] : null;
}
async function approvedBy(env, phone) {
  return env.DB.prepare("SELECT * FROM creators WHERE phone=? AND status='approved'").bind(phone).first();
}

/* ---------- link opens ---------- */
export async function click(env, code, req) {
  const c = normCode(code);
  const row = c && await env.DB.prepare("SELECT code FROM creators WHERE code=? AND status='approved'").bind(c).first();
  if (row) {
    const day = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim(), ua = req.headers.get('User-Agent') || '';
    const bot = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord/i.test(ua);
    if (!bot) {
      const k = (await hmacSha256hex(secret(env), `${c}|${day}|${ip}|${ua}`)).slice(0, 24);
      const fresh = await env.DB.prepare('INSERT INTO creator_seen (k, at) VALUES (?, ?) ON CONFLICT (k) DO NOTHING RETURNING k').bind(k, now()).first().catch(() => null);
      await env.DB.prepare(`INSERT INTO creator_clicks (code, day, n, uniq) VALUES (?,?,1,?) ON CONFLICT (code, day) DO UPDATE SET n=creator_clicks.n+1, uniq=creator_clicks.uniq+EXCLUDED.uniq`)
        .bind(c, day, fresh ? 1 : 0).run().catch(() => {});
    }
  }
  return new Response(null, { status: 302, headers: { Location: row ? storeLink(c) : STORE, 'Cache-Control': 'no-store' } });
}

/* ---------- orders ---------- */
export async function creatorByCode(env, code) {
  const c = normCode(code);
  if (!c) return null;
  return env.DB.prepare("SELECT * FROM creators WHERE code=? AND status='approved'").bind(c).first();
}
/** The follower discount for a creator code + number (online payment only). { ok, amount, why, creator } */
export async function followerOffer(env, code, phone = '') {
  const c = await creatorByCode(env, code);
  if (!c || !cfg(env).on) return null;                       /* not a creator code */
  const p = cleanPhone(phone), off = Number(cfg(env).follower_off) || 0;
  if (p && p === c.phone) return { ok: false, amount: 0, why: 'This is your own creator code', creator: c };
  if (p) {
    const used = await env.DB.prepare("SELECT 1 AS x FROM creator_orders WHERE code=? AND phone=? AND COALESCE(discount,0)>0 AND status<>'void' LIMIT 1").bind(c.code, p).first();
    if (used) return { ok: false, amount: 0, why: 'This code was already used on this number', creator: c };
  }
  return { ok: off > 0, amount: off, why: '', creator: c };
}
/** Every order through a creator code (any payment), recorded at checkout; the cron follows it to delivery. */
export async function noteOrder(env, { idem, code, phone, method, total, discount }) {
  const c = await creatorByCode(env, code);
  if (!c || cleanPhone(phone) === c.phone) return;
  await env.DB.prepare(`INSERT INTO creator_orders (idem, code, creator_id, phone, method, total, discount, status, created_at) VALUES (?,?,?,?,?,?,?,'pending',?)
      ON CONFLICT (idem) DO UPDATE SET method=EXCLUDED.method, total=EXCLUDED.total, discount=EXCLUDED.discount`)
    .bind(idem, c.code, c.id, cleanPhone(phone), method, Number(total) || 0, Number(discount) || 0, now()).run();
}

/* ---------- vouchers (spending credit) ---------- */
export async function voucher(env, code) {
  const v = normCode(code);
  if (!/^V[A-Z0-9]{7,}$/.test(v)) return null;
  return env.DB.prepare("SELECT * FROM creator_vouchers WHERE code=? AND status='active'").bind(v).first();
}
export async function holdVoucher(env, code, idem) {
  return env.DB.prepare("UPDATE creator_vouchers SET status='held', idem=?, held_at=? WHERE code=? AND status='active' RETURNING amount").bind(idem, now(), normCode(code)).first();
}

/* ---------- money ---------- */
export async function balances(env, creatorId) {
  const one = async (sql) => (await env.DB.prepare(sql).bind(Number(creatorId)).first()) || {};
  const [cash, credit, paid, vouch] = await Promise.all([
    one("SELECT COALESCE(SUM(earned),0) AS s FROM creator_orders WHERE creator_id=? AND reward_type='cash' AND earned_at IS NOT NULL"),
    one("SELECT COALESCE(SUM(earned),0) AS s FROM creator_orders WHERE creator_id=? AND reward_type='credit' AND earned_at IS NOT NULL"),
    one('SELECT COALESCE(SUM(amount),0) AS s FROM creator_payouts WHERE creator_id=?'),
    one("SELECT COALESCE(SUM(amount),0) AS s FROM creator_vouchers WHERE creator_id=? AND status<>'void'"),
  ]);
  return { cash_earned: Number(cash.s) || 0, cash_paid: Number(paid.s) || 0, cash_due: (Number(cash.s) || 0) - (Number(paid.s) || 0),
    credit_earned: Number(credit.s) || 0, credit_spent: Number(vouch.s) || 0, credit_left: (Number(credit.s) || 0) - (Number(vouch.s) || 0) };
}

/** Pure: what a delivered order earns for this creator now. null = no payout choice yet. */
export function rewardFor(creator, c) {
  if (creator.payout === 'cash') return { type: 'cash', amount: Number(c.cash) || 0 };
  if (creator.payout === 'credit') return { type: 'credit', amount: Number(c.credit) || 0 };
  return null;
}

/**
 * Cron: pending -> placed (order reached Shopify) or void (never completed); delivered -> earned (amount fixed at
 * the creator's choice then); vouchers held by an unpaid order go back.
 */
export async function creatorSweep(env) {
  const t = now(), out = { placed: 0, earned: 0, void: 0, vouchers: 0 };
  const pend = (await env.DB.prepare(`SELECT co.idem, o.order_id, o.order_name, o.status FROM creator_orders co LEFT JOIN orders o ON o.idem=co.idem
      WHERE co.status='pending' LIMIT 100`).all()).results;
  for (const p of pend) {
    if (p.order_id && ['placed', 'paid'].includes(p.status)) {
      await env.DB.prepare("UPDATE creator_orders SET status='placed', order_id=?, order_name=? WHERE idem=?").bind(String(p.order_id), p.order_name || '', p.idem).run(); out.placed++;
    } else if (!p.status || ['failed', 'cancelled'].includes(p.status)) {
      await env.DB.prepare("UPDATE creator_orders SET status='void' WHERE idem=? AND created_at<?").bind(p.idem, t - 2 * 3600).run();
    }
  }
  const c = cfg(env);
  const due = (await env.DB.prepare(`SELECT co.idem, cr.id AS cid, cr.payout, s.stage, o.status AS order_status FROM creator_orders co JOIN creators cr ON cr.id=co.creator_id
      LEFT JOIN shipments s ON s.order_id=co.order_id LEFT JOIN orders o ON o.order_id=co.order_id
      WHERE co.status='placed' AND co.earned_at IS NULL AND (s.stage='delivered' OR o.status='cancelled' OR s.stage IN ('rto','lost')) LIMIT 100`).all()).results;
  for (const d of due) {
    if (d.stage !== 'delivered') { await env.DB.prepare("UPDATE creator_orders SET status='void' WHERE idem=?").bind(d.idem).run(); out.void++; continue; }
    const r = rewardFor(d, c);
    if (!r) continue;                                         /* waits for the creator's first login */
    await env.DB.prepare('UPDATE creator_orders SET earned=?, reward_type=?, earned_at=? WHERE idem=? AND earned_at IS NULL').bind(r.amount, r.type, t, d.idem).run(); out.earned++;
  }
  /* vouchers: used once their order is paid, back to active if the payment never completed */
  const held = (await env.DB.prepare(`SELECT v.code, v.idem, v.held_at, o.status FROM creator_vouchers v LEFT JOIN orders o ON o.idem=v.idem WHERE v.status='held' LIMIT 50`).all()).results;
  for (const h of held) {
    if (h.status === 'paid') { await env.DB.prepare("UPDATE creator_vouchers SET status='used', used_at=? WHERE code=?").bind(t, h.code).run(); out.vouchers++; }
    else if (Number(h.held_at) < t - 2 * 3600) await env.DB.prepare("UPDATE creator_vouchers SET status='active', idem=NULL, held_at=NULL WHERE code=? AND status='held'").bind(h.code).run();
  }
  return out;
}

/* ---------- the creator's own API (/api/creator/*) ---------- */
const J = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function dashboard(env, c) {
  const k = cfg(env);
  const [clicks, week, orders, bal] = await Promise.all([
    env.DB.prepare('SELECT COALESCE(SUM(n),0) AS n, COALESCE(SUM(uniq),0) AS u FROM creator_clicks WHERE code=?').bind(c.code).first(),
    env.DB.prepare('SELECT COALESCE(SUM(n),0) AS n FROM creator_clicks WHERE code=? AND day>=?').bind(c.code, new Date(Date.now() + 19800000 - 6 * 86400000).toISOString().slice(0, 10)).first(),
    env.DB.prepare(`SELECT co.*, s.stage, s.rto, o.status AS order_status FROM creator_orders co LEFT JOIN shipments s ON s.order_id=co.order_id LEFT JOIN orders o ON o.order_id=co.order_id
        WHERE co.creator_id=? AND co.status IN ('placed','void') AND co.order_id IS NOT NULL ORDER BY co.created_at DESC LIMIT 200`).bind(c.id).all(),
    balances(env, c.id),
  ]);
  const list = orders.results.map((o) => {
    const st = stageLabel(o), r = rewardFor(c, k);
    const earned = o.earned_at ? Number(o.earned) : 0;
    return { order: o.order_name, date: Number(o.created_at), pay: o.method === 'prepaid' ? 'Online' : 'COD', status: st.label, key: st.key,
      earn: earned ? earned / 100 : 0, will: !earned && r && ['placed', 'packed', 'transit', 'ofd'].includes(st.key) ? r.amount / 100 : 0 };
  });
  const n = (key) => list.filter((x) => x.key === key).length;
  const vouchers = (await env.DB.prepare("SELECT code, amount, status, created_at FROM creator_vouchers WHERE creator_id=? AND status<>'void' ORDER BY created_at DESC LIMIT 20").bind(c.id).all()).results;
  return { ok: true, name: c.name, code: c.code, link: linkOf(env, c.code), store_link: storeLink(c.code), payout: c.payout || '', upi: c.upi || '', pan: c.pan ? 'XXXXX' + String(c.pan).slice(-5) : '',
    rules: { follower_off: k.follower_off / 100, cash: k.cash / 100, credit: k.credit / 100, min_payout: k.min_payout / 100 },
    stats: { opens: Number(clicks?.n) || 0, people: Number(clicks?.u) || 0, opens_7d: Number(week?.n) || 0, orders: list.length, online: list.filter((x) => x.pay === 'Online').length,
      delivered: n('delivered'), on_way: n('placed') + n('packed') + n('transit') + n('ofd'), refused: n('refused'), cancelled: n('cancelled') },
    money: { cash_earned: bal.cash_earned / 100, cash_paid: bal.cash_paid / 100, cash_due: bal.cash_due / 100, credit_earned: bal.credit_earned / 100, credit_left: bal.credit_left / 100,
      pending: list.reduce((a, x) => a + x.will, 0) },
    orders: list.slice(0, 100), vouchers: vouchers.map((v) => ({ code: v.code, amount: Number(v.amount) / 100, status: v.status, at: Number(v.created_at) })) };
}

export async function handleCreator(req, env) {
  const path = new URL(req.url).pathname;
  const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'x';
  const limit = async (k, max) => {
    const hr = Math.floor(Date.now() / 3600000);
    const r = await env.DB.prepare('INSERT INTO rl (ip, hr, n) VALUES (?,?,1) ON CONFLICT (ip, hr) DO UPDATE SET n=rl.n+1 RETURNING n').bind(k, hr).first().catch(() => null);
    return !r || Number(r.n) <= max;
  };
  try {
    if (path === '/api/creator/rules') { const k = cfg(env); return J({ ok: true, on: !!k.on, follower_off: k.follower_off / 100, cash: k.cash / 100, credit: k.credit / 100, min_payout: k.min_payout / 100 }); }
    if (path === '/api/creator/apply' && req.method === 'POST') {
      if (!(await limit('capply:' + ip, 10))) return J({ ok: false, error: 'Too many tries, please try again later' }, 429);
      return J(await apply(env, b));
    }
    if (path === '/api/creator/otp' && req.method === 'POST') {
      const phone = cleanPhone(b.phone);
      if (!phone) return J({ ok: false, error: 'Enter your 10-digit WhatsApp number' });
      if (!(await limit('cotp:' + ip, 20))) return J({ ok: false, error: 'Too many tries, please try again later' }, 429);
      const c = await env.DB.prepare('SELECT status FROM creators WHERE phone=?').bind(phone).first();
      if (!c) return J({ ok: false, error: 'No application on this number yet. Apply first.' });
      if (c.status !== 'approved') return J({ ok: false, error: c.status === 'rejected' ? 'Your application was not approved this time.' : 'Your application is still being reviewed. We will WhatsApp you once you are in.' });
      const { sendOtp } = await import('./cod-otp.js');
      const r = await sendOtp(env, phone);
      return J(r.ok ? { ok: true } : { ok: false, error: r.fallback ? 'Could not send the WhatsApp code right now. Please try again in a few minutes.' : r.error, wait: r.wait });
    }
    if (path === '/api/creator/verify' && req.method === 'POST') {
      const phone = cleanPhone(b.phone);
      if (!(await limit('cver:' + ip, 40))) return J({ ok: false, error: 'Too many tries, please try again later' }, 429);
      const { checkOtp } = await import('./cod-otp.js');
      const v = await checkOtp(env, phone, String(b.code || ''));
      if (!v.ok) return J({ ok: false, error: v.error });
      if (!(await approvedBy(env, phone))) return J({ ok: false, error: 'Not an approved creator' });
      return J({ ok: true, token: await makeToken(env, phone) });
    }
    /* everything below needs the token */
    const phone = await readToken(env, String(req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''));
    const c = phone && await approvedBy(env, phone);
    if (!c) return J({ ok: false, auth: true, error: 'Please log in again' }, 401);
    if (path === '/api/creator/me') return J(await dashboard(env, c));
    if (path === '/api/creator/payout' && req.method === 'POST') {
      if (c.payout) return J({ ok: false, error: 'Your payout choice is already set. Message us on WhatsApp to change it.' });
      const pick = b.payout === 'cash' ? 'cash' : b.payout === 'credit' ? 'credit' : '';
      if (!pick) return J({ ok: false, error: 'Choose cash or store credit' });
      const upi = String(b.upi || '').trim().slice(0, 80), pan = String(b.pan || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      if (pick === 'cash' && !/^[\w.-]{2,}@[A-Za-z][\w.-]+$/.test(upi)) return J({ ok: false, error: 'Enter your UPI ID (like name@okicici)' });
      if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) return J({ ok: false, error: 'PAN looks wrong (like ABCDE1234F)' });
      await env.DB.prepare('UPDATE creators SET payout=?, upi=?, pan=?, payout_at=? WHERE id=? AND payout IS NULL').bind(pick, pick === 'cash' ? upi : null, pan || null, now(), c.id).run();
      return J(await dashboard(env, { ...c, payout: pick, upi }));
    }
    if (path === '/api/creator/upi' && req.method === 'POST') {
      const upi = String(b.upi || '').trim().slice(0, 80), pan = String(b.pan || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      if (upi && !/^[\w.-]{2,}@[A-Za-z][\w.-]+$/.test(upi)) return J({ ok: false, error: 'Enter your UPI ID (like name@okicici)' });
      if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) return J({ ok: false, error: 'PAN looks wrong (like ABCDE1234F)' });
      await env.DB.prepare('UPDATE creators SET upi=COALESCE(NULLIF(?,\'\'), upi), pan=COALESCE(NULLIF(?,\'\'), pan) WHERE id=?').bind(upi, pan, c.id).run();
      return J({ ok: true });
    }
    if (path === '/api/creator/voucher' && req.method === 'POST') {
      if (c.payout !== 'credit') return J({ ok: false, error: 'Vouchers are for store credit' });
      const amt = Math.round(Number(b.amount) || 0) * 100, bal = await balances(env, c.id);
      if (amt < 5000) return J({ ok: false, error: 'Minimum ₹50' });
      if (amt > bal.credit_left) return J({ ok: false, error: `You have ₹${bal.credit_left / 100} credit` });
      const code = 'V' + (await hmacSha256hex(secret(env), `${c.id}|${now()}|${Math.random()}`)).slice(0, 8).toUpperCase();
      await env.DB.prepare("INSERT INTO creator_vouchers (code, creator_id, amount, status, created_at) VALUES (?,?,?,'active',?)").bind(code, c.id, amt, now()).run();
      return J(await dashboard(env, c));
    }
    return J({ ok: false, error: 'not found' }, 404);
  } catch (e) {
    return J({ ok: false, error: String(e.message || e).slice(0, 200) }, 400);
  }
}

/* ---------- WhatsApp template ---------- */
export const APPROVED_TEMPLATE = 'ik_creator_status_v4';
/* v1-v3 were rejected (INCORRECT_CATEGORY): a bare status update about their own application, nothing promotional */
export function creatorTemplates(base) {
  return [{ name: APPROVED_TEMPLATE, language: 'en', category: 'UTILITY',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, your Ink Kulture creator application has been approved. Your creator code is {{2}}. You can log in with this WhatsApp number using the button below.',
        example: { body_text: [['Riya', 'RIYAINK']] } },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Log in', url: `${base}/creator` }] },
    ] }];
}

/* ---------- admin ---------- */
export async function adminList(env) {
  const rows = (await env.DB.prepare(`SELECT c.*, (SELECT COALESCE(SUM(n),0) FROM creator_clicks k WHERE k.code=c.code) AS opens,
      (SELECT COUNT(*) FROM creator_orders o WHERE o.creator_id=c.id AND o.status IN ('placed','void') AND o.order_id IS NOT NULL) AS orders,
      (SELECT COUNT(*) FROM creator_orders o WHERE o.creator_id=c.id AND o.earned_at IS NOT NULL) AS delivered,
      (SELECT COUNT(*) FROM creator_orders o WHERE o.creator_id=c.id AND o.status='void' AND o.order_id IS NOT NULL) AS lost
      FROM creators c ORDER BY CASE c.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, c.created_at DESC LIMIT 300`).all()).results;
  const out = [];
  for (const r of rows) {
    const bal = r.status === 'approved' ? await balances(env, r.id) : null;
    out.push({ id: r.id, name: r.name, phone: r.phone, handle: r.handle, platform: r.platform, link: r.profile_url, followers: Number(r.followers) || 0, city: r.city, email: r.email, about: r.about,
      status: r.status, code: r.code, payout: r.payout || '', upi: r.upi || '', pan: r.pan || '', applied: Number(r.created_at), approved: Number(r.approved_at) || null, told: !!r.told_at,
      opens: Number(r.opens) || 0, orders: Number(r.orders) || 0, delivered: Number(r.delivered) || 0, lost: Number(r.lost) || 0,
      cash_due: bal ? bal.cash_due / 100 : 0, cash_paid: bal ? bal.cash_paid / 100 : 0, credit_left: bal ? bal.credit_left / 100 : 0 });
  }
  return { ok: true, creators: out, cfg: { ...cfg(env), follower_off: cfg(env).follower_off / 100, cash: cfg(env).cash / 100, credit: cfg(env).credit / 100, min_payout: cfg(env).min_payout / 100 } };
}
export async function markPaid(env, id, amountRs, ref = '') {
  const c = await env.DB.prepare('SELECT * FROM creators WHERE id=?').bind(Number(id)).first();
  if (!c) throw new Error('Creator not found');
  const bal = await balances(env, c.id), amt = Math.round(Number(amountRs) * 100) || bal.cash_due;
  if (amt <= 0 || amt > bal.cash_due) throw new Error(`Nothing to pay (₹${bal.cash_due / 100} due)`);
  await env.DB.prepare('INSERT INTO creator_payouts (creator_id, amount, upi, ref, created_at) VALUES (?,?,?,?,?)').bind(c.id, amt, c.upi || '', String(ref).slice(0, 80), now()).run();
  return { ok: true, paid: amt / 100 };
}
