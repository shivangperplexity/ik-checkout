/**
 * Refer and earn.
 *
 *   A customer whose order was delivered gets a personal code on WhatsApp, with the link
 *   https://www.inkkulture.in/?ref=CODE to forward. A friend who comes through it (or types the code) gets
 *   REF_OFF off their FIRST order, online payment only. The moment the friend's payment goes through the customer
 *   gets REF_CREDIT store credit (prepaid orders cannot be cancelled by the buyer), valid CREDIT_DAYS days, used
 *   automatically on their next online payment.
 *
 *   Guards: the friend must be new (no earlier order on that number) and not the referrer; if the friend's order is
 *   later cancelled / refunded or comes back, whatever of that credit is still unspent is taken back; at most
 *   MONTHLY_CAP credits per referrer per 30 days.
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
  /* creator codes (lib/creators.js) and creator credit vouchers share the same code box */
  const C = await import('./creators.js');
  const v = await C.voucher(env, code).catch(() => null);
  if (v) return { ok: true, amount: Number(v.amount), code: v.code, name: '', kind: 'voucher' };
  const cr = await C.followerOffer(env, code, phone).catch(() => null);
  if (cr) return { ok: cr.ok, amount: cr.amount, code: cr.creator.code, name: String(cr.creator.name || '').split(/\s+/)[0], kind: 'creator', why: cr.why };
  const row = await lookupCode(env, code);
  if (!row) return { ok: false, amount: 0, why: code ? 'This code is not valid' : '' };
  const first = String(row.name || '').split(/\s+/)[0];
  const p = cleanPhone(phone);
  if (p) {
    if (p === row.phone) return { ok: false, amount: 0, code: row.code, name: first, why: 'You cannot use your own referral code' };
    if (await hasOrdered(env, p)) return { ok: false, amount: 0, code: row.code, name: first, why: 'Referral discount is for first orders only' };
  }
  return { ok: true, amount: REF_OFF, code: row.code, name: first, referrer: row.phone, kind: 'referral' };
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
  return { ...q, prepaid: { ...q.prepaid, ref: a.ref, total: a.total }, ref: { code: o.code, name: o.name, amount: a.ref, kind: o.kind } };
}

/**
 * Order (online payment): the friend's discount and the buyer's own credit, checked against the real number.
 * Holds the credit used (released if the payment never completes). Returns { ref, credit, total, offer, notes }.
 */
export async function forOrder(env, { idem, phone, total, attribution }) {
  const code = normCode(attribution?.ref);
  let offer = code ? await friendOffer(env, code, phone).catch(() => null) : null;
  /* a creator voucher is used once: held for this order now, spent when it is paid (lib/creators.js sweep) */
  if (offer?.ok && offer.kind === 'voucher') {
    const { holdVoucher } = await import('./creators.js');
    const h = await holdVoucher(env, offer.code, idem).catch(() => null);
    if (!h) offer = { ...offer, ok: false, amount: 0, why: 'This voucher was already used' };
  }
  const bal = await creditBalance(env, phone).catch(() => 0);
  const a = applyTo(total, { ref: offer?.ok ? offer.amount : 0, credit: bal });
  if (a.credit > 0) await holdCredit(env, idem, phone, a.credit);
  if (offer?.ok && a.ref > 0 && offer.kind === 'referral') {
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

/**
 * Payment done, order created: the buyer's held credit is spent, and the referrer gets their credit straight away
 * (the WhatsApp "credit added" goes out on the next cron run).
 */
export async function onPaid(env, { idem, order_id, order_name }) {
  await env.DB.prepare("UPDATE credit_uses SET status='used', order_id=?, used_at=? WHERE idem=? AND status='held'").bind(String(order_id || ''), now(), idem).run().catch(() => {});
  const r = await env.DB.prepare("UPDATE referrals SET status='placed', order_id=?, order_name=?, placed_at=? WHERE idem=? AND status='pending' RETURNING *").bind(String(order_id || ''), order_name || '', now(), idem).first().catch(() => null);
  if (r) await creditReferrer(env, r).catch((e) => console.error('referral credit', e.message));
}
/** Give the referrer REF_CREDIT for a paid friend order (once; MONTHLY_CAP per 30 days). Returns true when given. */
export async function creditReferrer(env, r) {
  const t = now();
  const month = await env.DB.prepare("SELECT COUNT(*) AS n FROM referrals WHERE referrer_phone=? AND status IN ('credited','revoked') AND credited_at>?").bind(r.referrer_phone, t - 30 * 86400).first();
  if (Number(month?.n) >= MONTHLY_CAP) { await env.DB.prepare("UPDATE referrals SET status='capped', note='monthly limit reached' WHERE idem=? AND status='placed'").bind(r.idem).run(); return false; }
  const claim = await env.DB.prepare("UPDATE referrals SET status='credited', credited_at=? WHERE idem=? AND status='placed' RETURNING idem").bind(t, r.idem).first();
  if (!claim) return false;
  await env.DB.prepare('INSERT INTO credits (phone, amount_paise, left_paise, reason, ref_idem, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
    .bind(r.referrer_phone, REF_CREDIT, REF_CREDIT, `Referral: ${r.order_name || 'friend order'}`, r.idem, t, t + CREDIT_DAYS * 86400).run();
  return true;
}

/**
 * Cron:
 *  - holds of online payments that never completed go back to the customer;
 *  - a friend's order delivered: the referrer gets REF_CREDIT (WhatsApp "credit added");
 *  - a friend's order cancelled / returned: the referral earns nothing;
 *  - customers with a delivered order 2-30 days ago get their code once (WhatsApp invite, 9 am - 9 pm).
 */
export async function referralSweep(env, { invites = INVITE_RUN } = {}) {
  const t = now(), out = { released: 0, credited: 0, void: 0, invited: 0 };
  const stale = (await env.DB.prepare(`SELECT u.idem FROM credit_uses u LEFT JOIN orders o ON o.idem=u.idem
      WHERE u.status='held' AND u.created_at<? AND (o.idem IS NULL OR o.status IN ('failed','pending_payment','cancelled'))`).bind(t - HOLD).all()).results;
  for (const s of stale) if (await releaseCredit(env, s.idem)) out.released++;
  await env.DB.prepare("UPDATE referrals SET status='void', note='payment not completed' WHERE status='pending' AND created_at<?").bind(t - HOLD).run().catch(() => {});

  const { fireTrigger } = await import('./whatsapp.js');
  /* a paid friend order the instant credit missed (an error at payment time): credit it now */
  const missed = (await env.DB.prepare("SELECT * FROM referrals WHERE status='placed' LIMIT 50").all()).results;
  for (const r of missed) if (await creditReferrer(env, r).catch(() => false)) out.credited++;
  /* "credit added" on WhatsApp, once per referral */
  const tell = (await env.DB.prepare(`SELECT r.idem, r.referrer_phone, c.expires_at, rc.name AS referrer_name FROM referrals r JOIN credits c ON c.ref_idem=r.idem
      LEFT JOIN ref_codes rc ON rc.phone=r.referrer_phone WHERE r.status='credited' AND r.told_at IS NULL AND c.left_paise>0 LIMIT 30`).all()).results;
  for (const r of tell) {
    const claim = await env.DB.prepare('UPDATE referrals SET told_at=? WHERE idem=? AND told_at IS NULL RETURNING idem').bind(t, r.idem).first();
    if (!claim) continue;
    await fireTrigger(env, 'ref_credit', { to: r.referrer_phone, vars: { name: String(r.referrer_name || '').split(/\s+/)[0] || 'there', amount: String(REF_CREDIT / 100), till: dateIst(r.expires_at) } }).catch(() => {});
  }
  /* friend's order cancelled / refunded / back to us: the unspent part of that credit is taken back */
  const gone = (await env.DB.prepare(`SELECT r.idem, o.status AS order_status, s.stage, s.rto FROM referrals r LEFT JOIN orders o ON o.order_id=r.order_id LEFT JOIN shipments s ON s.order_id=r.order_id
      WHERE r.status IN ('credited','placed','capped') AND (o.status='cancelled' OR s.stage IN ('rto','lost') OR s.rto=TRUE) LIMIT 50`).all()).results;
  for (const r of gone) {
    const left = await env.DB.prepare('UPDATE credits SET left_paise=0 WHERE ref_idem=? AND left_paise>0 RETURNING amount_paise').bind(r.idem).first();
    await env.DB.prepare("UPDATE referrals SET status=CASE WHEN status='credited' THEN 'revoked' ELSE 'void' END, note=? WHERE idem=?")
      .bind((r.order_status === 'cancelled' ? 'order cancelled' : 'not delivered') + (left ? ', credit taken back' : ''), r.idem).run();
    out.void++;
  }

  /* invites: 9 am - 9 pm IST only */
  const m = Math.floor(((t + 19800) % 86400) / 60);
  /* only once Meta has approved the invite template (until then every send would just fail and be retried) */
  let approved = false;
  try { const { metaTemplate } = await import('./whatsapp.js'); const tp = await metaTemplate(env, INVITE_TEMPLATE); approved = tp?.status === 'APPROVED'; } catch { approved = false; }
  out.invite_template = approved ? 'approved' : 'waiting';
  /* Gentle: a few per run, a daily cap, and a full stop for an hour after WhatsApp pushes back on anything.
     (28 Oct: 15 per 5-minute run tripped Meta's "Rate limit hit" for the whole number, OTPs and COD confirmations included.) */
  if (approved) {
    /* an invite Meta refused for a rate limit goes back in line once (after 6 hours) */
    await env.DB.prepare(`UPDATE ref_codes SET invited_at=NULL WHERE invited_at IS NOT NULL AND invited_at<? AND phone IN (
        SELECT phone FROM messages WHERE trigger='ref_invite' AND direction='out' AND ts>? GROUP BY phone
        HAVING SUM(CASE WHEN status='failed' AND error ILIKE '%rate limit%' THEN 1 ELSE 0 END)=1 AND SUM(CASE WHEN status IN ('sent','delivered','read','accepted') THEN 1 ELSE 0 END)=0)`)
      .bind(t - 6 * 3600, t - 3 * 86400).run().catch((e) => console.error('ref requeue', e.message));
    const pushback = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction='out' AND status='failed' AND ts>? AND (error ILIKE '%rate limit%' OR error ILIKE '%131048%' OR error ILIKE '%131049%' OR error ILIKE '%healthy ecosystem%')`).bind(t - 3600).first().catch(() => null);
    const today = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages WHERE trigger='ref_invite' AND direction='out' AND status<>'skipped' AND ts>?`).bind(t - 86400).first().catch(() => null);
    const left = INVITE_DAY - (Number(today?.n) || 0);
    if (Number(pushback?.n) > 0) { out.invite_paused = 'WhatsApp rate limit in the last hour'; invites = 0; }
    else invites = Math.max(0, Math.min(invites, left));
    out.invites_left_today = Math.max(0, left);
  }
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
/** invites per cron run (every 5 min) and per 24 hours */
export const INVITE_RUN = 2, INVITE_DAY = 25;
export const INVITE_TEMPLATE = 'ik_refer_v2', CREDIT_TEMPLATE = 'ik_ref_credit_v2';
export function referralTemplates() {
  return [
    { name: INVITE_TEMPLATE, language: 'en', category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, hope you are loving your Ink Kulture tattoos! 🖤\n\nShare them with your friends: they get ₹100 off their first order when they pay online, and you get ₹100 store credit as soon as they order.\n\nYour code: *{{2}}*\nYour link: {{3}}\n\nJust forward this message to a friend.',
          example: { body_text: [['Riya', 'RIYA123', 'https://www.inkkulture.in/?ref=RIYA123']] } },
        { type: 'FOOTER', text: 'Reply STOP to stop offers' },
      ] },
    { name: CREDIT_TEMPLATE, language: 'en', category: 'UTILITY', allow_category_change: true,
      components: [
        { type: 'BODY', text: 'Hi {{1}}, your friend just ordered from Ink Kulture with your code, so ₹{{2}} store credit has been added to your number.\n\nIt is valid till {{3}} and is applied automatically on your next order when you pay online at inkkulture.in.\n\nHappy tattooing! 🖤',
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
    one("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM referrals WHERE status IN ('placed','credited','capped','revoked')"),
    one("SELECT COUNT(*) AS n FROM referrals WHERE status='credited'"),
    one("SELECT COUNT(*) AS n FROM referrals WHERE status='revoked' OR (status='void' AND COALESCE(note,'')<>'payment not completed')"),
    one('SELECT COALESCE(SUM(amount_paise),0) AS given, COALESCE(SUM(CASE WHEN expires_at>? THEN left_paise ELSE 0 END),0) AS open FROM credits', t),
    one("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM credit_uses WHERE status='used'"),
  ]);
  const top = (await env.DB.prepare(`SELECT rc.code, rc.name, rc.phone, COUNT(r.idem) AS orders, SUM(CASE WHEN r.status='credited' THEN 1 ELSE 0 END) AS delivered
      FROM ref_codes rc JOIN referrals r ON r.code=rc.code AND r.status IN ('placed','credited','capped','void','revoked') GROUP BY rc.code, rc.name, rc.phone ORDER BY orders DESC LIMIT 15`).all()).results;
  const recent = (await env.DB.prepare('SELECT order_name, code, status, amount, created_at, note FROM referrals ORDER BY created_at DESC LIMIT 30').all()).results;
  return { ok: true, codes: Number(codes.n) || 0, invited: Number(invited.n) || 0, orders: Number(refs.n) || 0, discount: (Number(refs.amt) || 0) / 100,
    delivered: Number(credited.n) || 0, returned: Number(voided.n) || 0, credit_given: (Number(credit.given) || 0) / 100, credit_open: (Number(credit.open) || 0) / 100,
    credit_used: (Number(used.amt) || 0) / 100, credit_used_orders: Number(used.n) || 0,
    top: top.map((x) => ({ code: x.code, name: x.name, phone: String(x.phone).replace(/^(\d{2})\d{5}/, '$1•••••'), orders: Number(x.orders), delivered: Number(x.delivered) })),
    recent: recent.map((r) => ({ ...r, amount: Number(r.amount) / 100 })) };
}
