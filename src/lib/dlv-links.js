/**
 * One-off (19 Nov 2026): send every customer whose parcel is with Delhivery and not yet delivered/returned a WhatsApp
 * with Delhivery's own tracking page (mobile + OTP login there lets them call the delivery executive on OFD day).
 * Template ik_dlv_track_v1 (UTILITY, order update). Settings 'dlv_links' = { status: scheduled|done, at, sent, failed }.
 * Cron sends from `at` (unix) onwards, 9 am - 8 pm IST, 25 per run, each order once (trigger 'dlv_track').
 */
const now = () => Math.floor(Date.now() / 1000);
const KEY = 'dlv_links', TEMPLATE = 'ik_dlv_track_v1', TRIGGER = 'dlv_track';
const BODY = [
  'Hi {{1}}, your Ink Kulture order {{2}} is with Delhivery 🚚',
  '',
  'Track it live on Delhivery\'s page below. On the day it is out for delivery, log in there with your mobile number + OTP to call your delivery executive directly.',
  '',
  'Please keep your phone reachable so the delivery isn\'t missed.',
].join('\n');

const p10 = (x) => String(x || '').replace(/\D/g, '').slice(-10);
async function state(env) {
  const r = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(KEY).first().catch(() => null);
  try { return r ? JSON.parse(r.v) : {}; } catch { return {}; }
}
const save = (env, v) => env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v').bind(KEY, JSON.stringify(v)).run();

export async function audience(env) {
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results;
  const done = new Set((await q("SELECT order_name FROM messages WHERE direction='out' AND trigger=? AND status NOT IN ('failed','skipped')", TRIGGER)).map((r) => r.order_name));
  const opt = new Set((await q('SELECT phone FROM wa_optout')).map((r) => p10(r.phone)));
  const rows = await q(`SELECT s.order_name, s.awb, s.courier, s.stage, o.phone, o.first_name AS name FROM shipments s JOIN orders o ON o.order_id=s.order_id
    WHERE s.awb<>'' AND LOWER(s.courier) LIKE '%delhivery%' AND s.stage IN ('pickup_pending','transit','ofd','ndr') AND s.created_at > ?`, now() - 30 * 86400);
  return rows.filter((r) => /^[6-9]\d{9}$/.test(p10(r.phone)) && !opt.has(p10(r.phone)) && !done.has(r.order_name))
    .map((r) => ({ phone: p10(r.phone), name: String(r.name || '').trim().split(/\s+/)[0] || 'there', order: r.order_name, awb: r.awb, stage: r.stage }));
}

/** Submit the template and schedule the send for `at` (unix seconds). */
export async function setup(env, { at }) {
  const { accessibleAccounts, createTemplate, templateDetails } = await import('./wa-migrate.js');
  const have = (await templateDetails(env, env.WA_WABA_ID, [TEMPLATE]).catch(() => []))[0];
  let tpl = have ? { status: have.status } : null;
  if (!have || have.status === 'REJECTED') {
    const { appId } = await accessibleAccounts(env);
    const t = { name: TEMPLATE, language: 'en', category: 'UTILITY', components: [
      { type: 'BODY', text: BODY, example: { body_text: [['Riya', '#2372']] } },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Track on Delhivery', url: 'https://www.delhivery.com/track-v2/package/{{1}}', example: ['https://www.delhivery.com/track-v2/package/49712810231545'] }] },
    ] };
    try { const r = await createTemplate(env, { waba: env.WA_WABA_ID, appId, tpl: t }); tpl = { status: r.status || 'PENDING', category: r.category }; }
    catch (e) { tpl = { status: 'FAILED', error: String(e.message || e).slice(0, 300) }; }
  }
  await save(env, { status: 'scheduled', at: Number(at) || now(), sent: 0, failed: 0 });
  const list = await audience(env);
  return { ok: true, template: tpl, at: Number(at), audience: list.length, by_stage: list.reduce((m, x) => ((m[x.stage] = (m[x.stage] || 0) + 1), m), {}) };
}

export async function overview(env) {
  const st = await state(env);
  const { metaTemplate } = await import('./whatsapp.js');
  const t = await metaTemplate(env, TEMPLATE).catch(() => null);
  return { ok: true, ...st, template_status: t ? t.status : 'NOT SUBMITTED', template_category: t?.category, left: (await audience(env)).length };
}

export async function dlvTick(env, { per = 25 } = {}) {
  const st = await state(env);
  if (st.status !== 'scheduled' || now() < (st.at || 0)) return { idle: st.status || 'none' };
  const h = new Date(Date.now() + 19800000).getUTCHours();
  if (h < 9 || h >= 20) return { waiting: 'daytime only' };
  const { metaSendTemplate, metaTemplate } = await import('./whatsapp.js');
  const t = await metaTemplate(env, TEMPLATE).catch(() => null);
  if (!t || t.status !== 'APPROVED') return { waiting: 'template ' + (t ? t.status : 'not found') };
  if (t.category && t.category !== 'UTILITY') { await save(env, { ...st, status: 'held', why: 'Meta made the template ' + t.category }); return { held: t.category }; }
  const list = await audience(env);
  if (!list.length) { await save(env, { ...st, status: 'done', finished_at: now() }); return { done: true }; }
  let sent = 0, failed = 0;
  const log = (p, o, status, wamid, error, preview) => env.DB.prepare('INSERT INTO messages (ts,direction,phone,trigger,template,status,order_name,wamid,error,preview) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(now(), 'out', p, TRIGGER, TEMPLATE, status, o, wamid, error, preview).run().catch(() => {});
  for (const p of list.slice(0, per)) {
    let preview = '';
    try {
      const id = await metaSendTemplate(env, { name: TEMPLATE, phone: p.phone, keys: [], values: [p.name, p.order], urlParam: p.awb, onText: (x) => { preview = x; } });
      await log(p.phone, p.order, 'sent', id, null, preview.slice(0, 500)); sent++;
    } catch (e) { await log(p.phone, p.order, 'failed', null, String(e.message || e).slice(0, 300), null); failed++; }
  }
  const fresh = await state(env);
  await save(env, { ...fresh, sent: (fresh.sent || 0) + sent, failed: (fresh.failed || 0) + failed });
  return { sent, failed, left: list.length - sent - failed };
}
