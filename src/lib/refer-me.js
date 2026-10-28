/**
 * A customer's own referral corner: their code, share link, store credit and friends' orders.
 * Shown on /refer (WhatsApp OTP login) and sent as a WhatsApp reply when they write "code" / "credit".
 */
import { codeFor, creditBalance, refLink, REF_OFF, REF_CREDIT, CREDIT_DAYS, MONTHLY_CAP, dateIst } from './referral.js';
import { makeToken, readToken } from './creators.js';
import { cleanPhone } from './util.js';

const now = () => Math.floor(Date.now() / 1000);
const J = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export const PAGE = 'https://ik-checkout.vercel.app/refer';

/** Who can have a code: anyone with an order that reached the store, or a code already made for them. */
async function eligible(env, phone) {
  const o = await env.DB.prepare("SELECT first_name FROM orders WHERE phone=? AND order_id IS NOT NULL AND COALESCE(status,'') NOT IN ('failed','pending_payment') ORDER BY created_at DESC LIMIT 1").bind(phone).first();
  if (o) return { ok: true, name: o.first_name || '' };
  const rc = await env.DB.prepare('SELECT name FROM ref_codes WHERE phone=?').bind(phone).first();
  return rc ? { ok: true, name: rc.name || '' } : { ok: false };
}

const STATUS = {
  credited: ['₹' + REF_CREDIT / 100 + ' credit added', 'ok'],
  placed: ['Paid, credit on its way', 'wait'],
  pending: ['Waiting for payment', 'wait'],
  capped: ['Monthly limit reached', 'no'],
  revoked: ['Order returned, credit taken back', 'no'],
  void: ['Not completed', 'no'],
};

/** Everything the page shows. */
export async function referInfo(env, phone) {
  const e = await eligible(env, phone);
  if (!e.ok) return { ok: false, eligible: false };
  const rc = await codeFor(env, phone, e.name);
  const [credit, credits, refs] = await Promise.all([
    creditBalance(env, phone),
    env.DB.prepare('SELECT amount_paise, left_paise, reason, created_at, expires_at FROM credits WHERE phone=? ORDER BY created_at DESC LIMIT 20').bind(phone).all().then((r) => r.results),
    env.DB.prepare('SELECT order_name, amount, status, created_at, credited_at FROM referrals WHERE referrer_phone=? ORDER BY created_at DESC LIMIT 50').bind(phone).all().then((r) => r.results),
  ]);
  const t = now();
  const live = credits.filter((c) => Number(c.left_paise) > 0 && Number(c.expires_at) > t);
  const next = live.sort((a, b) => a.expires_at - b.expires_at)[0];
  const n = (s) => refs.filter((r) => r.status === s).length;
  return {
    ok: true, eligible: true,
    name: String(rc.name || e.name || '').split(/\s+/)[0],
    code: rc.code, link: refLink(rc.code),
    credit: credit / 100,
    expires: next ? { amount: Number(next.left_paise) / 100, on: dateIst(next.expires_at) } : null,
    stats: { friends: refs.filter((r) => r.status !== 'pending' && r.status !== 'void').length, credited: n('credited'), earned: credits.filter((c) => c.reason !== 'manual').reduce((s, c) => s + Number(c.amount_paise), 0) / 100 },
    friends: refs.filter((r) => r.status !== 'pending').slice(0, 30).map((r) => ({ order: r.order_name || '', date: Number(r.created_at), status: (STATUS[r.status] || [r.status, 'no'])[0], tone: (STATUS[r.status] || [0, 'no'])[1] })),
    credits: credits.slice(0, 10).map((c) => ({ amount: Number(c.amount_paise) / 100, left: Number(c.left_paise) / 100, added: Number(c.created_at), expires: dateIst(c.expires_at), expired: Number(c.expires_at) <= t })),
    rules: { friend_off: REF_OFF / 100, you_get: REF_CREDIT / 100, days: CREDIT_DAYS, cap: MONTHLY_CAP },
  };
}

/** The WhatsApp reply. */
export function referText(i) {
  if (!i?.eligible) return `You get your own Ink Kulture referral code after your first order 🖤\n\nOnce you have it: your friends get ₹${REF_OFF / 100} off their first order (online payment) and you get ₹${REF_CREDIT / 100} store credit for each one.\n\nShop: https://www.inkkulture.in`;
  const bal = i.credit > 0
    ? `Store credit: *₹${i.credit}*${i.expires ? ` (₹${i.expires.amount} of it valid till ${i.expires.on})` : ''}. It is applied automatically when you pay online on inkkulture.in with this number.`
    : `Store credit: ₹0 for now.`;
  return `Hi ${i.name || 'there'} 🖤\n\nYour referral code: *${i.code}*\nShare link: ${i.link}\n\n${bal}\n\nFriends get ₹${i.rules.friend_off} off their first order (online payment). You get ₹${i.rules.you_get} credit for each friend who pays${i.stats.credited ? ` (${i.stats.credited} so far)` : ''}.\n\nSee everything here: ${PAGE}`;
}

/** "code", "my credit", "referral code", "balance"... as a whole message (not inside a longer question). */
export const asksReferral = (text) => {
  const s = String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || s.split(' ').length > 6) return false;
  return /^(hi |hello |hey )?(what is |whats |show |send |check )?(my )?(referral|refer|ref|invite|store credit|credits?|balance|wallet|refer and earn|referral code|refer code|my code|code)( code| balance| credit| credits)?( please| pls| plz)?$/.test(s);
};

/** WhatsApp inbound hook (lib/wa-g4w.js). True when handled. */
export async function referInbound(env, phone, text) {
  if (!asksReferral(text)) return false;
  const p = cleanPhone(phone);
  if (!p) return false;
  /* a bare "code" right after a checkout OTP is about that OTP, not the referral: leave it to the assistant */
  if (/^\W*(my\s+)?code\W*$/i.test(String(text || '').trim())) {
    const otp = await env.DB.prepare('SELECT sent_at FROM cod_otps WHERE phone=?').bind(p).first().catch(() => null);
    if (otp && Number(otp.sent_at) > now() - 1800) return false;
  }
  const { sendText } = await import('./whatsapp.js');
  await sendText(env, '91' + p, referText(await referInfo(env, p)));
  return true;
}

/** /api/refer/* : otp, verify, me */
export async function handleRefer(req, env) {
  const path = new URL(req.url).pathname;
  const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'x';
  const limit = async (k, max) => {
    const r = await env.DB.prepare('INSERT INTO rl (ip, hr, n) VALUES (?,?,1) ON CONFLICT (ip, hr) DO UPDATE SET n=rl.n+1 RETURNING n').bind(k, Math.floor(Date.now() / 3600000)).first().catch(() => null);
    return !r || Number(r.n) <= max;
  };
  try {
    if (path === '/api/refer/otp' && req.method === 'POST') {
      const phone = cleanPhone(b.phone);
      if (!phone) return J({ ok: false, error: 'Enter your 10-digit WhatsApp number' });
      if (!(await limit('rotp:' + ip, 20))) return J({ ok: false, error: 'Too many tries, please try again later' }, 429);
      if (!(await eligible(env, phone)).ok) return J({ ok: false, error: 'No order found on this number. Your referral code comes with your first order. Use the number you ordered with.' });
      const { sendOtp } = await import('./cod-otp.js');
      const r = await sendOtp(env, phone);
      return J(r.ok ? { ok: true } : { ok: false, error: r.fallback ? 'Could not send the WhatsApp code right now. Please try again in a few minutes.' : r.error, wait: r.wait });
    }
    if (path === '/api/refer/verify' && req.method === 'POST') {
      const phone = cleanPhone(b.phone);
      if (!(await limit('rver:' + ip, 40))) return J({ ok: false, error: 'Too many tries, please try again later' }, 429);
      const { checkOtp } = await import('./cod-otp.js');
      const v = await checkOtp(env, phone, String(b.code || ''));
      if (!v.ok) return J({ ok: false, error: v.error });
      return J({ ok: true, token: await makeToken(env, phone, 90 * 86400, 'refer') });
    }
    const phone = await readToken(env, String(req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), 'refer');
    if (!phone) return J({ ok: false, auth: true, error: 'Please log in again' }, 401);
    if (path === '/api/refer/me') { const i = await referInfo(env, phone); return J(i.eligible ? i : { ok: false, auth: true, error: 'No order found on this number' }, i.eligible ? 200 : 401); }
    return J({ ok: false, error: 'not found' }, 404);
  } catch (e) {
    return J({ ok: false, error: String(e.message || e).slice(0, 200) }, 400);
  }
}
