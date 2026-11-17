/**
 * ₹50 credit for abandoned checkouts (Nov 2026).
 *
 *   Credit     promo code CREDIT50 (Settings 'promos'): ₹50 off the online-payment price, any order, valid till
 *              `until` (lib/settings.js promoOf). COD is still allowed, the ₹50 applies only to online payment.
 *   Audience   phones that started the checkout (leads) and never ordered, in the last `days` days; never anyone who
 *              replied STOP, never twice (trigger 'credit50').
 *   Template   ik_credit50_v1, MARKETING (it is an offer), body with name + valid-till date, a "Complete my order"
 *              button whose link rebuilds the person's cart and carries ?ref=CREDIT50 (the store keeps ref 30 days).
 *   Sending    cron, 10 am - 8 pm IST, 20 per run. ~₹1.02 per delivered message.
 * State: settings 'credit50' = { status: draft|sending|paused|done, until, days, sent, failed, started_at }.
 */
const now = () => Math.floor(Date.now() / 1000);
const KEY = 'credit50';
export const CODE = 'CREDIT50';
export const TEMPLATE = 'ik_credit50_v1';
export const TRIGGER = 'credit50';
const STORE = 'https://www.inkkulture.in/';
export const BODY = [
  'Hi {{1}} 👋',
  '',
  '🎁 Aapke Ink Kulture account mein ₹50 credit add ho gaya hai!',
  '',
  'Aapka cart abhi bhi wait kar raha hai. Online payment karoge toh ₹50 OFF apne aap lag jayega, saath mein Buy 1 Get 1 FREE bhi.',
  '',
  '⏳ Credit valid till {{2}}',
  '',
  'Neeche tap karke order complete karo 👇',
].join('\n');

const p10 = (x) => String(x || '').replace(/\D/g, '').slice(-10);
export async function state(env) {
  const r = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(KEY).first().catch(() => null);
  try { return r ? JSON.parse(r.v) : { status: 'draft' }; } catch { return { status: 'draft' }; }
}
const save = (env, v) => env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v').bind(KEY, JSON.stringify(v)).run();
const tillText = (until) => new Date((until + 19800) * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Abandoned checkouts still to message: [{ phone, name }] */
export async function audience(env, { days = 30 } = {}) {
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results;
  const opt = new Set((await q('SELECT phone FROM wa_optout')).map((r) => p10(r.phone)));
  const buyers = new Set((await q("SELECT phone FROM orders WHERE order_id IS NOT NULL")).map((r) => p10(r.phone)));
  const done = new Set((await q("SELECT phone FROM messages WHERE direction='out' AND trigger=? AND (status NOT IN ('failed','skipped') OR error LIKE '%131026%' OR error LIKE '%131050%' OR error LIKE '%130472%')", TRIGGER)).map((r) => p10(r.phone)));
  const out = new Map();
  for (const r of await q('SELECT phone, name FROM leads WHERE updated_at > ? ORDER BY updated_at DESC', now() - days * 86400)) {
    const ph = p10(r.phone);
    if (!/^[6-9]\d{9}$/.test(ph) || opt.has(ph) || buyers.has(ph) || done.has(ph) || out.has(ph)) continue;
    out.set(ph, { phone: ph, name: String(r.name || '').trim().split(/\s+/)[0] || 'there' });
  }
  return [...out.values()];
}

/** Turn the code on (valid `validDays`), submit the template, set the campaign up as draft. */
export async function setup(env, { validDays = 7, days = 30 } = {}) {
  const until = now() + validDays * 86400;
  /* the promo code */
  const cur = JSON.parse((await env.DB.prepare("SELECT v FROM settings WHERE k='promos'").first().catch(() => null))?.v || 'null') || env.SETTINGS?.promos || {};
  cur[CODE] = { amount: 5000, on: true, until };
  const { putSetting } = await import('./settings.js');
  await putSetting(env, 'promos', cur);
  /* the template */
  const { accessibleAccounts, createTemplate, templateDetails } = await import('./wa-migrate.js');
  const have = (await templateDetails(env, env.WA_WABA_ID, [TEMPLATE]).catch(() => []))[0];
  let tpl = have ? { status: have.status, existed: true } : null;
  if (!have || have.status === 'REJECTED') {
    const { appId } = await accessibleAccounts(env);
    const t = { name: TEMPLATE, language: 'en', category: 'MARKETING', components: [
      { type: 'BODY', text: BODY, example: { body_text: [['Riya', '24 Nov']] } },
      { type: 'FOOTER', text: 'Reply STOP to stop offers' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Complete my order', url: STORE + '{{1}}', example: [STORE + 'cart?ref=CREDIT50'] }] },
    ] };
    try { const r = await createTemplate(env, { waba: env.WA_WABA_ID, appId, tpl: t }); tpl = { status: r.status || 'PENDING' }; }
    catch (e) { tpl = { status: 'FAILED', error: String(e.message || e).slice(0, 300) }; }
  }
  const st = await state(env);
  await save(env, { ...st, status: st.status === 'sending' ? 'sending' : 'draft', until, days });
  return { ok: true, code: CODE, until: tillText(until), template: tpl, audience: (await audience(env, { days })).length };
}

export async function overview(env) {
  const st = await state(env);
  const { metaTemplate } = await import('./whatsapp.js');
  const t = await metaTemplate(env, TEMPLATE).catch(() => null);
  const left = await audience(env, { days: st.days || 30 });
  return { ok: true, ...st, until_text: st.until ? tillText(st.until) : '', template_status: t ? t.status : 'NOT SUBMITTED', left: left.length, cost_left: Math.round(left.length * 1.02) };
}
export async function start(env) { const st = await state(env); await save(env, { ...st, status: 'sending', started_at: st.started_at || now() }); return overview(env); }
export async function pause(env) { const st = await state(env); await save(env, { ...st, status: 'paused' }); return overview(env); }

/** The button's link (after the store address): the person's cart rebuilt, with the credit code and tracking. */
async function linkFor(env, phone) {
  const tag = 'ref=' + CODE + '&utm_source=whatsapp&utm_medium=broadcast&utm_campaign=credit50';
  try {
    const row = await env.DB.prepare('SELECT cart_json FROM leads WHERE phone=?').bind(String(phone)).first();
    const lines = JSON.parse(row?.cart_json || '[]').filter((l) => l && /^\d+$/.test(String(l.variant_id)) && !l.upsell);
    if (lines.length) return 'cart/' + lines.slice(0, 20).map((l) => `${l.variant_id}:${Math.max(1, Number(l.quantity) || 1)}`).join(',') + '?storefront=true&' + tag;
  } catch { /* plain cart link */ }
  return 'collections/bestsellers?' + tag;
}

/** Cron: send the next few. */
export async function creditTick(env, { per = 20 } = {}) {
  const st = await state(env);
  if (st.status !== 'sending') return { idle: st.status };
  if (st.until && now() > st.until - 86400) { await save(env, { ...st, status: 'done', finished_at: now(), why: 'credit expires within a day' }); return { done: true }; }
  const h = new Date(Date.now() + 19800000).getUTCHours();
  if (h < 10 || h >= 20) return { waiting: 'daytime only' };
  const { metaSendTemplate, metaTemplate } = await import('./whatsapp.js');
  const t = await metaTemplate(env, TEMPLATE).catch(() => null);
  if (!t || t.status !== 'APPROVED') return { waiting: 'template ' + (t ? t.status : 'not found') };
  const list = await audience(env, { days: st.days || 30 });
  if (!list.length) { await save(env, { ...st, status: 'done', finished_at: now() }); return { done: true }; }
  let sent = 0, failed = 0;
  const log = (p, status, wamid, error, preview) => env.DB.prepare('INSERT INTO messages (ts,direction,phone,trigger,template,status,order_name,wamid,error,preview) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(now(), 'out', p, TRIGGER, TEMPLATE, status, null, wamid, error, preview).run().catch(() => {});
  for (const p of list.slice(0, per)) {
    let preview = '';
    try {
      const id = await metaSendTemplate(env, { name: TEMPLATE, phone: p.phone, keys: [], values: [p.name, tillText(st.until)], urlParam: await linkFor(env, p.phone), onText: (t) => { preview = t; } });
      await log(p.phone, 'sent', id, null, preview.slice(0, 500)); sent++;
    } catch (e) {
      const m = String(e.message || e);
      await log(p.phone, 'failed', null, m.slice(0, 300), null); failed++;
      if (/not found or not approved|code (10|200|4|80007|130429)\b/.test(m)) break;   /* template not ready / rate limit: stop this run */
    }
  }
  const fresh = await state(env);
  await save(env, { ...fresh, sent: (fresh.sent || 0) + sent, failed: (fresh.failed || 0) + failed });
  return { sent, failed, left: list.length - sent - failed };
}
