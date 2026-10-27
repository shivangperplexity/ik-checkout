/**
 * Refer and earn.
 *
 *   A customer whose order was delivered gets a personal code on WhatsApp, with the link
 *   https://www.inkkulture.in/?ref=CODE to forward. A friend who comes through it (or types the code) gets
 *   REF_OFF off their FIRST order, online payment only. When the friend's order is DELIVERED the customer gets
 *   REF_CREDIT store credit, valid CREDIT_DAYS days, used automatically on their next online payment.
 *
 *   Guards: the friend must be new (no earlier order on that number) and not the referrer; credit only after
 *   delivery (an RTO / cancelled order earns nothing); at most MONTHLY_CAP credits per referrer per 30 days.
 *   Discount and credit apply to prepaid orders only, never Cash on delivery.
 *
 * Money is integer paise, like the rest of the checkout.
 */
export const REF_OFF = 10000, REF_CREDIT = 10000, CREDIT_DAYS = 60, MONTHLY_CAP = 10;
export const MIN_TOTAL = 100;          /* an order never goes below ₹1 */
export const HOLD = 2 * 3600;          /* credit held for an unpaid online order this long */
const now = () => Math.floor(Date.now() / 1000);
export const STORE = 'https://www.inkkulture.in';
export const refLink = (code) => `${STORE}/?ref=${encodeURIComponent(code)}`;

export const normCode = (c) => String(c || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16);
const cleanPhone = (p) => { const d = String(p || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, ''); return /^[6-9]\d{9}$/.test(d) ? d : ''; };

/** A short code from the first name: RIYA + 2-3 digits. Pure (the digits come from `seed`). */
export function makeCode(name, seed) {
  const base = String(name || '').normalize('NFKD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 6) || 'INK';
  return base + String(100 + (Math.abs(Number(seed) || 0) % 900));
}

/** The customer's own code (created once). */
export async function codeFor(env, phone, name) {
  const p = cleanPhone(phone);
  if (!p) return null;
  const have = await env.DB.prepare('SELECT * FROM ref_codes WHERE phone=?').bind(p).first();
  if (have) return have;
  for (let i = 0; i < 12; i++) {
    const code = makeCode(name, Number(p.slice(-6)) + i * 7919 + (i > 5 ? Math.floor(Math.random() * 1e6) : 0));
    const taken = await env.DB.prepare('SELECT 1 AS x FROM ref_codes WHERE code=?').bind(code).first();
    if (taken) continue;
    await env.DB.prepare('INSERT INTO ref_codes (phone, code, name, created_at) VALUES (?,?,?,?) ON CONFLICT (phone) DO NOTHING').bind(p, code, String(name || '').slice(0, 60), now()).run();
    return env.DB.prepare('SELECT * FROM ref_codes WHERE phone=?').bind(p).first();
  }
  throw new Error('could not make a referral code');
}

export async function lookupCode(env, code) {
  const c = normCode(code);
  if (!c) return null;
  return env.DB.prepare('SELECT * FROM ref_codes WHERE code=?').bind(c).first();
}

/** Has this number ordered before (any order that reached Shopify)? */
async function hasOrdered(env, phone) {
  const r = await env.DB.prepare("SELECT 1 AS x FROM orders WHERE phone=? AND order_id IS NOT NULL AND COALESCE(status,'') NOT IN ('failed','pending_payment') LIMIT 1").bind(phone).first();
  return !!r;
}

/**
 * The friend's discount for this code + number. { ok, amount, code, name, why }.
 * Without a phone (cart opened, number not typed yet) only the code is checked.
 */
export async function friendOffer(env, code, phone = '') {
  const row = await lookupCode(env, code);
  if (!row) return { ok: false, amount: 0, why: code ? 'This referral code is not valid' : '' };
  const first = String(row.name || '').split(/\s+/)[0];
  const p = cleanPhone(phone);
  if (p) {
    if (p === row.phone) return { ok: false, amount: 0, code: row.code, name: first, why: 'You cannot use your own referral code' };
    if (await hasOrdered(env, p)) return { ok: false, amount: 0, code: row.code, name: first, why: 'Referral discount is for first orders only' };
  }
  return { ok: true, amount: REF_OFF, code: row.code, name: first, referrer: row.phone };
}

/** Store credit this number can spend now (expired credit and credit held by an unpaid order left out). */
export async function creditBalance(env, phone) {
  const p = cleanPhone(phone);
  if (!p) return 0;
  const r = await env.DB.prepare('SELECT COALESCE(SUM(left_paise),0) AS s FROM credits WHERE phone=? AND left_paise>0 AND expires_at>?').bind(p, now()).first();
  return Number(r?.s) || 0;
}

/** Pure: the referral discount and credit on an online-payment total. */
export function applyTo(total, { ref = 0, credit = 0 } = {}) {
  const room = Math.max(0, total - MIN_TOTAL);
  const r = Math.min(Math.max(0, ref), room), c = Math.min(Math.max(0, credit), room - r);
  return { ref: r, credit: c, total: total - r - c };
}

/** Quote: the friend's discount on the online-payment price (number not known yet). */
export async function quoteRef(env, q, attribution) {
  const code = normCode(attribution?.ref);
  if (!code || !q?.prepaid) return q;
  const o = await friendOffer(env, code).catch(() => null);
  if (!o?.ok) return q;
  const a = applyTo(q.prepaid.total, { ref: o.amount });
  return { ...q, prepaid: { ...q.prepaid, ref: a.ref, total: a.total }, ref: { code: o.code, name: o.name, amount: a.ref } };
}

/**
 * Order (online payment): the friend's discount and the buyer's own credit, checked against the real number.
 * Holds the credit used (released if the payment never completes). Returns { ref, credit, total, offer, notes }.
 */
export async function forOrder(env, { idem, phone, total, attribution }) {
  const code = normCode(attribution?.ref);
  const offer = code ? await friendOffer(env, code, phone).catch(() => null) : null;
  const bal = await creditBalance(env, phone).catch(() => 0);
  const a = applyTo(total, { ref: offer?.ok ? offer.amount : 0, credit: bal });
  if (a.credit > 0) await holdCredit(env, idem, phone, a.credit);
  if (offer?.ok && a.ref > 0) {
    await env.DB.prepare(`INSERT INTO referrals (idem, code, referrer_phone, friend_phone, amount, status, created_at) VALUES (?,?,?,?,?,'pending',?)
        ON CONFLICT (idem) DO UPDATE SET amount=EXCLUDED.amount`).bind(idem, offer.code, offer.referrer, cleanPhone(phone), a.ref, now()).run();
  }
  return { ...a, offer };
}

/* Credit is spent oldest-expiry first; each hold remembers what it took so a release puts it back. */
async function holdCredit(env, idem, phone, amount) {
  const p = cleanPhone(phone);
  const prev = await env.DB.prepare('SELECT * FROM credit_uses WHERE idem=?').bind(idem).first();
  if (prev && prev.status !== 'released') return;
  const rows = (await env.DB.prepare('SELECT id, left_paise FROM credits WHERE phone=? AND left_paise>0 AND expires_at>? ORDER BY expires_at, id').bind(p, now()).all()).results;
  let need = amount; const took = [];
  for (const r of rows) {
    if (need <= 0) break;
    const x = Math.min(need, Number(r.left_paise));
    const ok = await env.DB.prepare('UPDATE credits SET left_paise=left_paise-? WHERE id=? AND left_paise>=? RETURNING id').bind(x, r.id, x).first();
    if (!ok) continue;
    took.push([r.id, x]); need -= x;
  }
  await env.DB.prepare(`INSERT INTO credit_uses (idem, phone, amount, took, status, created_at) VALUES (?,?,?,?,'held',?)
      ON CONFLICT (idem) DO UPDATE SET amount=EXCLUDED.amount, took=EXCLUDED.took, status='held', created_at=EXCLUDED.created_at`).bind(idem, p, amount - need, JSON.stringify(took), now()).run();
}
async function releaseCredit(env, idem) {
  const u = await env.DB.prepare("UPDATE credit_uses SET status='released' WHERE idem=? AND status='held' RETURNING took").bind(idem).first();
  if (!u) return false;
  let took = []; try { took = JSON.parse(u.took || '[]'); } catch { took = []; }
  for (const [id, x] of took) await env.DB.prepare('UPDATE credits SET left_paise=left_paise+? WHERE id=?').bind(Number(x), id).run();
  return true;
}

/** Payment done, order created: the held credit is spent and the referral is waiting for delivery. */
export async function onPaid(env, { idem, order_id, order_name }) {
  await env.DB.prepare("UPDATE credit_uses SET status='used', order_id=?, used_at=? WHERE idem=? AND status='held'").bind(String(order_id || ''), now(), idem).run().catch(() => {});
  await env.DB.prepare("UPDATE referrals SET status='placed', order_id=?, order_name=?, placed_at=? WHERE idem=? AND status='pending'").bind(String(order_id || ''), order_name || '', now(), idem).run().catch(() => {});
}

/**
 * Cron:
 *  - holds of online payments that never completed go back to the customer;
 *  - a friend's order delivered: the referrer gets REF_CREDIT (WhatsApp "credit added");
 *  - a friend's order cancelled / returned: the referral earns nothing;
 *  - customers with a delivered order 2-30 days ago get their code once (WhatsApp invite, 9 am - 9 pm).
 */
export async function referralSweep(env, { invites = 15 } = {}) {
  const t = now(), out = { released: 0, credited: 0, void: 0, invited: 0 };
  const stale = (await env.DB.prepare(`SELECT u.idem FROM credit_uses u LEFT JOIN orders o ON o.idem=u.idem
      WHERE u.status='held' AND u.created_at<? AND (o.idem IS NULL OR o.status IN ('failed','pending_payment','cancelled'))`).bind(t - HOLD).all()).results;
  for (const s of stale) if (await releaseCredit(env, s.idem)) out.released++;
  await env.DB.prepare("UPDATE referrals SET status='void', note='payment not completed' WHERE status='pending' AND created_at<?").bind(t - HOLD).run().catch(() => {});

  const open = (await env.DB.prepare(`SELECT r.*, s.stage, s.rto, o.status AS order_status, rc.name AS referrer_name
      FROM referrals r LEFT JOIN shipments s ON s.order_id=r.order_id LEFT JOIN orders o ON o.order_id=r.order_id LEFT JOIN ref_codes rc ON rc.phone=r.referrer_phone
      WHERE r.status='placed' LIMIT 50`).all()).results;
  const { fireTrigger } = await import('./whatsapp.js');
  for (const r of open) {
    if (r.order_status === 'cancelled' || r.stage === 'rto' || r.rto === true || r.stage === 'lost') {
      await env.DB.prepare("UPDATE referrals SET status='void', note=? WHERE idem=?").bind(r.order_status === 'cancelled' ? 'order cancelled' : 'not delivered', r.idem).run();
      out.void++; continue;
    }
    if (r.stage !== 'delivered') continue;
    const month = await env.DB.prepare("SELECT COUNT(*) AS n FROM referrals WHERE referrer_phone=? AND status='credited' AND credited_at>?").bind(r.referrer_phone, t - 30 * 86400).first();
    if (Number(month?.n) >= MONTHLY_CAP) { await env.DB.prepare("UPDATE referrals SET status='capped', note='monthly limit reached' WHERE idem=?").bind(r.idem).run(); continue; }
    const claim = await env.DB.prepare("UPDATE referrals SET status='credited', credited_at=? WHERE idem=? AND status='placed' RETURNING idem").bind(t, r.idem).first();
    if (!claim) continue;
    const exp = t + CREDIT_DAYS * 86400;
    await env.DB.prepare('INSERT INTO credits (phone, amount_paise, left_paise, reason, ref_idem, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
      .bind(r.referrer_phone, REF_CREDIT, REF_CREDIT, `Referral: ${r.order_name || 'friend order'} delivered`, r.idem, t, exp).run();
    out.credited++;
    await fireTrigger(env, 'ref_credit', { to: r.referrer_phone, vars: { name: String(r.referrer_name || '').split(/\s+/)[0] || 'there', amount: String(REF_CREDIT / 100), till: dateIst(exp) } }).catch(() => {});
  }

  /* invites: 9 am - 9 pm IST only */
  const m = Math.floor(((t + 19800) % 86400) / 60);
  /* only once Meta has approved the invite template (until then every send would just fail and be retried) */
  let approved = false;
  try { const { metaTemplate } = await import('./whatsapp.js'); const tp = await metaTemplate(env, INVITE_TEMPLATE); approved = tp?.status === 'APPROVED'; } catch { approved = false; }
  out.invite_template = approved ? 'approved' : 'waiting';
  if (approved && m >= 9 * 60 && m < 21 * 60 && invites > 0) {
    const due = (await env.DB.prepare(`SELECT o.phone, MAX(o.first_name) AS first_name FROM orders o JOIN shipments s ON s.order_id=o.order_id
        LEFT JOIN ref_codes rc ON rc.phone=o.phone
        WHERE s.stage='delivered' AND s.delivered_at BETWEEN ? AND ? AND (rc.phone IS NULL OR rc.invited_at IS NULL)
        GROUP BY o.phone LIMIT ?`).bind(t - 30 * 86400, t - 2 * 86400, invites).all()).results;
    for (const d of due) {
      const rc = await codeFor(env, d.phone, d.first_name).catch(() => null);
      if (!rc) continue;
      await env.DB.prepare('UPDATE ref_codes SET invited_at=? WHERE phone=?').bind(t, rc.phone).run();
      const r = await fireTrigger(env, 'ref_invite', { to: rc.phone, vars: { name: String(d.first_name || '').split(/\s+/)[0] || 'there', code: rc.code, link: refLink(rc.code) } }).catch((e) => ({ ok: false, error: e.message }));
      if (r?.ok) out.invited++;
      else if (!r?.skipped) await env.DB.prepare('UPDATE ref_codes SET invited_at=NULL WHERE phone=?').bind(rc.phone).run();   /* retried next run */
    }
  }
  return out;
}

export const dateIst = (t) => new Date((Number(t) + 19800) * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/* ---------- WhatsApp templates ---------- */
export const INVITE_TEMPLATE = 'ik_refer_v1', CREDIT_TEMPLATE = 'ik_ref_credit_v1';
export function referralTemplates() {
  return [
    { name: INVITE_TEMPLATE, language: 'en', category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, hope you are loving your Ink Kulture tattoos! 🖤\n\nShare them with your friends: they get ₹100 off their first order when they pay online, and you get ₹100 store credit when their order is delivered.\n\nYour code: *{{2}}*\nYour link: {{3}}\n\nJust forward this message to a friend.',
          example: { body_text: [['Riya', 'RIYA123', 'https://www.inkkulture.in/?ref=RIYA123']] } },
        { type: 'FOOTER', text: 'Reply STOP to stop offers' },
      ] },
    { name: CREDIT_TEMPLATE, language: 'en', category: 'UTILITY', allow_category_change: true,
      components: [
        { type: 'BODY', text: 'Hi {{1}}, your friend\'s Ink Kulture order has been delivered, so ₹{{2}} store credit has been added to your number.\n\nIt is valid till {{3}} and is applied automatically on your next order when you pay online at inkkulture.in.\n\nHappy tattooing! 🖤',
          example: { body_text: [['Riya', '100', '27 Dec 2026']] } },
      ] },
  ];
}

/* ---------- dashboard ---------- */
export async function referralStats(env) {
  const t = now();
  const one = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).first()) || {};
  const [codes, invited, refs, credited, voided, credit, used] = await Promise.all([
    one('SELECT COUNT(*) AS n FROM ref_codes'),
    one('SELECT COUNT(*) AS n FROM ref_codes WHERE invited_at IS NOT NULL'),
    one("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM referrals WHERE status IN ('placed','credited','capped')"),
    one("SELECT COUNT(*) AS n FROM referrals WHERE status='credited'"),
    one("SELECT COUNT(*) AS n FROM referrals WHERE status='void' AND COALESCE(note,'')<>'payment not completed'"),
    one('SELECT COALESCE(SUM(amount_paise),0) AS given, COALESCE(SUM(CASE WHEN expires_at>? THEN left_paise ELSE 0 END),0) AS open FROM credits', t),
    one("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM credit_uses WHERE status='used'"),
  ]);
  const top = (await env.DB.prepare(`SELECT rc.code, rc.name, rc.phone, COUNT(r.idem) AS orders, SUM(CASE WHEN r.status='credited' THEN 1 ELSE 0 END) AS delivered
      FROM ref_codes rc JOIN referrals r ON r.code=rc.code AND r.status IN ('placed','credited','capped','void') GROUP BY rc.code, rc.name, rc.phone ORDER BY orders DESC LIMIT 15`).all()).results;
  const recent = (await env.DB.prepare('SELECT order_name, code, status, amount, created_at, note FROM referrals ORDER BY created_at DESC LIMIT 30').all()).results;
  return { ok: true, codes: Number(codes.n) || 0, invited: Number(invited.n) || 0, orders: Number(refs.n) || 0, discount: (Number(refs.amt) || 0) / 100,
    delivered: Number(credited.n) || 0, returned: Number(voided.n) || 0, credit_given: (Number(credit.given) || 0) / 100, credit_open: (Number(credit.open) || 0) / 100,
    credit_used: (Number(used.amt) || 0) / 100, credit_used_orders: Number(used.n) || 0,
    top: top.map((x) => ({ code: x.code, name: x.name, phone: String(x.phone).replace(/^(\d{2})\d{5}/, '$1•••••'), orders: Number(x.orders), delivered: Number(x.delivered) })),
    recent: recent.map((r) => ({ ...r, amount: Number(r.amount) / 100 })) };
}
