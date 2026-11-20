/**
 * Email for customer updates (Resend, https://resend.com). Used when WhatsApp is not connected or a WhatsApp send
 * fails, or for every update when settings email.always = true (or EMAIL_ALWAYS=1).
 * Env: RESEND_API_KEY, EMAIL_FROM (default "Ink Kulture <updates@inkkulture.in>"), optional EMAIL_REPLY_TO.
 * The sending domain must be verified in Resend (SPF + DKIM DNS records on inkkulture.in).
 */
export const emailOn = (env) => !!env.RESEND_API_KEY && env.SETTINGS?.email?.on !== false;
export const emailAlways = (env) => env.SETTINGS?.email?.always === true || env.EMAIL_ALWAYS === '1';
const FROM = (env) => env.EMAIL_FROM || 'Ink Kulture <updates@inkkulture.in>';
const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** One email. Returns the Resend id; throws on failure. */
export async function sendEmail(env, { to, subject, html, text, tags = [] }) {
  if (!emailOn(env)) throw new Error('email not connected');
  if (!okEmail(to)) throw new Error('no valid email');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM(env), to: [to], subject, html, text, reply_to: env.EMAIL_REPLY_TO || undefined, tags }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.id) throw new Error(j.message || 'HTTP ' + res.status);
  return j.id;
}

/** Brand layout: purple header, plain body, one button. */
export function layout({ title, lines = [], button = null }) {
  const p = lines.filter(Boolean).map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;color:#1a1a1a">${l}</p>`).join('');
  const b = button ? `<p style="margin:20px 0"><a href="${esc(button.url)}" style="background:#5b2bd6;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${esc(button.text)}</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f5efe6;font-family:Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#2a1a5e;padding:18px 24px;color:#fff;font-size:20px;font-weight:700">Ink Kulture</td></tr>
<tr><td style="padding:24px"><h2 style="margin:0 0 14px;font-size:19px;color:#2a1a5e">${esc(title)}</h2>${p}${b}</td></tr>
<tr><td style="padding:14px 24px;background:#f5efe6;font-size:12px;color:#666">Be yourself without pain · inkkulture.in</td></tr>
</table></td></tr></table></body></html>`;
}

/* Customer WhatsApp triggers -> email copy. Triggers not listed here (team alerts, broadcasts, OTP) get no email. */
const T = {
  cod_confirm: (v) => ({ s: `Order ${v.order} placed`, t: 'Your order is placed', l: [`Hi ${v.name}, thanks for your order ${v.order}: ${v.items}.`, 'Please confirm your Cash on Delivery order so we can ship it.'], b: v.confirm && { text: 'Confirm order', url: v.confirm } }),
  cod_placed: (v) => ({ s: `Order ${v.order} confirmed`, t: 'Your order is confirmed', l: [`Hi ${v.name}, your order ${v.order} (${v.items}) is confirmed.`, 'Please check your delivery address. Reply to this email if anything needs fixing.'] }),
  cod_reminder: (v) => ({ s: `Please confirm order ${v.order}`, t: 'Confirm your order', l: [`Hi ${v.name}, your COD order ${v.order} is not confirmed yet.`], b: v.confirm && { text: 'Confirm order', url: v.confirm } }),
  cod_cancel_warning: (v) => ({ s: `Order ${v.order} will be cancelled`, t: 'Your order is not confirmed', l: [`Hi ${v.name}, please confirm order ${v.order}, otherwise it will be cancelled.`], b: v.confirm && { text: 'Confirm order', url: v.confirm } }),
  cod_to_prepaid: (v) => ({ s: `Pay online for order ${v.order} and save`, t: 'Pay online and save', l: [`Hi ${v.name}, pay online for ${v.order} and get a discount.`], b: v.pay && { text: 'Pay now', url: v.pay } }),
  partial_paid: (v) => ({ s: `Advance received for ${v.order}`, t: 'Advance received', l: [`Hi ${v.name}, we got your advance for ${v.order}. Your order is confirmed.`] }),
  prepaid_paid: (v) => ({ s: `Order ${v.order} confirmed`, t: 'Payment received', l: [`Hi ${v.name}, your payment for ${v.order} (${v.items}) is received.`, v.edd && `Expected delivery: ${v.edd}.`] }),
  order_shipped: (v) => ({ s: `Order ${v.order} shipped`, t: 'Your order is on the way', l: [`Hi ${v.name}, your order ${v.order} is shipped.`], b: v.track && { text: 'Track order', url: v.track } }),
  ship_booked: (v) => ({ s: `Order ${v.order} is packed`, t: 'Your order is packed', l: [`Hi ${v.name}, your order ${v.order} is packed and ready for pickup.`, 'Tip: tattoos look invisible at first and develop fully in 18-24 hours.'], b: v.track && { text: 'Track order', url: v.track } }),
  ship_picked: (v) => ({ s: `Order ${v.order} picked up`, t: 'Picked up by the courier', l: [`Hi ${v.name}, your order ${v.order} is with the courier.`], b: v.track && { text: 'Track order', url: v.track } }),
  ship_ofd: (v) => ({ s: `Order ${v.order} out for delivery`, t: 'Out for delivery today', l: [`Hi ${v.name}, your order ${v.order} is out for delivery today. Please keep your phone reachable.`], b: v.track && { text: 'Track order', url: v.track } }),
  ship_delivered: (v) => ({ s: `Order ${v.order} delivered: how to apply`, t: 'Delivered!', l: [`Hi ${v.name}, your order ${v.order} is delivered.`, 'Apply on clean skin with the wipe, press with the wet magic coin, and give it 18-24 hours to develop.'], b: { text: 'How to apply', url: 'https://www.inkkulture.in' } }),
  dlv_credit: (v) => ({ s: '₹50 store credit added', t: '₹50 credit added', l: [`Hi ${v.name}, ₹50 store credit is added to your number for your next order.`] }),
  ref_credit: (v) => ({ s: 'Referral credit added', t: 'Your friend ordered!', l: [`Hi ${v.name}, ₹100 store credit is added for your referral.`] }),
  review_ask: (v) => ({ s: 'How are your tattoos?', t: 'How did we do?', l: [`Hi ${v.name}, we would love a quick review of your Ink Kulture order.`], b: { text: 'Leave a review', url: 'https://www.inkkulture.in' } }),
};
export const emailTriggers = () => Object.keys(T);

/**
 * Email version of a WhatsApp trigger. Looks up the order's email (or uses vars.email). Never throws.
 * Returns { ok, id } | { skipped } | { ok:false, error }.
 */
export async function emailTrigger(env, key, { vars = {}, orderId, orderName } = {}) {
  try {
    if (!emailOn(env)) return { skipped: 'noemail' };
    const f = T[key]; if (!f) return { skipped: 'no email copy' };
    const v = { name: 'there', ...vars, order: orderName || vars.order || '' };
    let to = vars.email || '';
    if (orderId && orderId !== '0') {
      const { orderForShipping } = await import('./shopify.js');
      const o = await orderForShipping(env, orderId).catch(() => null);
      if (o) {
        to = to || o.email; v.order = v.order || o.name;
        if (!vars.name && o.address?.firstName) v.name = o.address.firstName;
        if (!vars.items && o.items?.length) v.items = o.items.map((i) => `${i.title} × ${i.quantity}`).join(', ');
      }
      if (!v.track) { const { trackLink } = await import('./self-cancel.js'); v.track = await trackLink(env, orderId).catch(() => ''); }
    }
    if (!okEmail(to)) return { skipped: 'no email on order' };
    v.items = v.items || 'your Ink Kulture order';
    for (const k of Object.keys(v)) if (typeof v[k] === 'string' && !/^https?:/.test(v[k])) v[k] = esc(v[k]);
    const m = f(v);
    /* same email, same order: once per 10 minutes */
    if (env.DB) { const { claim } = await import('./once.js'); if (!(await claim(env, `e:${to}:${key}:${v.order}`, 600))) return { skipped: 'duplicate' }; }
    const id = await sendEmail(env, { to, subject: m.s, html: layout({ title: m.t, lines: m.l, button: m.b || null }), tags: [{ name: 'trigger', value: key }] });
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** COD / credit OTP by email. */
export async function emailOtp(env, to, code) {
  return sendEmail(env, { to, subject: `${code} is your Ink Kulture code`, tags: [{ name: 'trigger', value: 'cod_otp' }],
    html: layout({ title: 'Your verification code', lines: [`<span style="font-size:30px;font-weight:700;letter-spacing:6px;color:#2a1a5e">${code}</span>`, 'Enter this code at checkout. It is valid for 10 minutes. Never share it with anyone.'] }),
    text: `${code} is your Ink Kulture code. Valid for 10 minutes.` });
}
