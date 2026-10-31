/**
 * Video broadcast (More > Broadcast): one marketing template with a video header, sent to an audience you choose.
 *
 *   Audience   'abandoned': phones that started the checkout (leads) and never ordered; never anyone who replied STOP,
 *              never twice to the same phone for the same campaign.
 *   Template   ik_video_offer_v1 (trigger broadcast_video): video header + Hinglish offer text + "Shop now" button.
 *              Created from the dashboard with the video's public URL as Meta's sample.
 *   Sending    from the cron, 10 am - 8 pm IST, 15 per run (every 5 min) through fireTrigger, so the WhatsApp
 *              rate-limit back-off (lib/wa-gate.js) and the message log apply. ~₹1.02 per delivered message (Meta's
 *              Oct 2026 India marketing rate + GST).
 * State: settings 'broadcast' = { template, video, status: draft|sending|paused|done, audience, started_at, sent, failed, skipped }.
 */
const now = () => Math.floor(Date.now() / 1000);
const KEY = 'broadcast';
export const TEMPLATE = 'ik_video_offer_v1';
export const SHOP_URL = 'https://www.inkkulture.in/?utm_source=whatsapp&utm_medium=broadcast&utm_campaign=video_offer_1';
export const COST_PER_MSG = 1.02;
export const BODY = [
  'Hi {{1}} 👋',
  '',
  'Ye dekho Ink Kulture ka semi-permanent tattoo ✨',
  '',
  '🖤 Bilkul asli tattoo jaisa dikhta hai, bina needle, bina dard',
  '⏳ Lagbhag 2 hafte tak chalta hai, phir apne aap fade ho jaata hai',
  '🎁 Buy 1 Get 1 FREE',
  '💳 Online payment pe extra 10% OFF',
  '',
  'Apna design chuno aur aaj hi order karo 👇',
].join('\n');

export async function state(env) {
  const r = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(KEY).first().catch(() => null);
  try { return r ? JSON.parse(r.v) : { status: 'draft', template: TEMPLATE, audience: 'abandoned' }; } catch { return { status: 'draft', template: TEMPLATE, audience: 'abandoned' }; }
}
const save = (env, v) => env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v').bind(KEY, JSON.stringify(v)).run();
const p10 = (x) => String(x || '').replace(/\D/g, '').slice(-10);

/** Who still gets it: [{ phone, name }] for the audience, minus STOP, buyers and those already sent this template. */
export async function audience(env, { template = TEMPLATE, kind = 'abandoned' } = {}) {
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results;
  const opt = new Set((await q('SELECT phone FROM wa_optout')).map((r) => p10(r.phone)));
  const buyers = new Set((await q('SELECT phone FROM orders')).map((r) => p10(r.phone)));
  const done = new Set((await q("SELECT phone FROM messages WHERE direction='out' AND trigger='broadcast_video' AND template=? AND status NOT IN ('failed','skipped')", template)).map((r) => p10(r.phone)));
  const out = new Map();
  if (kind === 'abandoned') {
    for (const r of await q('SELECT phone, name, updated_at FROM leads ORDER BY updated_at DESC')) {
      const ph = p10(r.phone);
      if (ph.length !== 10 || opt.has(ph) || buyers.has(ph) || done.has(ph) || out.has(ph)) continue;
      out.set(ph, { phone: ph, name: String(r.name || '').trim().split(/\s+/)[0] || 'there' });
    }
  }
  return [...out.values()];
}

/** Dashboard view. */
export async function overview(env) {
  const st = await state(env);
  const left = await audience(env, { template: st.template || TEMPLATE, kind: st.audience || 'abandoned' });
  let tpl = null;
  try { const { metaTemplate } = await import('./whatsapp.js'); tpl = await metaTemplate(env, st.template || TEMPLATE); } catch (e) { tpl = null; }
  return { ok: true, ...st, body: BODY, shop_url: SHOP_URL, left: left.length, cost_left: Math.round(left.length * COST_PER_MSG), template_status: tpl ? tpl.status : 'NOT SUBMITTED', sample: left.slice(0, 3).map((x) => x.name) };
}

/** Submit the template to Meta with the video as its sample (the video must be a public https .mp4, under 16 MB). */
export async function submit(env, video) {
  const url = String(video || '').trim();
  if (!/^https:\/\/\S+\.mp4(\?\S*)?$/i.test(url)) throw new Error('Give the public link of the .mp4 video');
  const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
  const size = Number(head?.headers.get('content-length')) || 0;
  if (!head?.ok) throw new Error('The video link does not open');
  if (size > 16 * 1024 * 1024) throw new Error(`The video is ${(size / 1048576).toFixed(1)} MB; WhatsApp allows 16 MB`);
  const { accessibleAccounts, createTemplate } = await import('./wa-migrate.js');
  const { appId } = await accessibleAccounts(env);
  if (!appId || !env.WA_WABA_ID) throw new Error('WhatsApp account or app not found (Settings > WhatsApp)');
  const st = await state(env);
  const tpl = { name: st.template || TEMPLATE, language: 'en', category: 'MARKETING', sample_url: url, components: [
    { type: 'HEADER', format: 'VIDEO' },
    { type: 'BODY', text: BODY, example: { body_text: [['Riya']] } },
    { type: 'FOOTER', text: 'Reply STOP to stop offers' },
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop now', url: SHOP_URL }] },
  ] };
  const r = await createTemplate(env, { waba: env.WA_WABA_ID, appId, tpl });
  await save(env, { ...st, video: url, submitted_at: now(), status: st.status === 'sending' ? 'sending' : 'draft', meta_status: r.status || '' });
  return { ok: true, status: r.status || 'PENDING' };
}

export async function start(env) {
  const st = await state(env);
  if (!st.video) throw new Error('Submit the template with the video first');
  await save(env, { ...st, status: 'sending', started_at: st.started_at || now() });
  return overview(env);
}
export async function pause(env) { const st = await state(env); await save(env, { ...st, status: 'paused' }); return overview(env); }

/** Cron: send the next few. */
export async function broadcastTick(env, { per = 15 } = {}) {
  const st = await state(env);
  if (st.status !== 'sending') return { idle: st.status };
  const h = new Date(Date.now() + 19800000).getUTCHours();
  if (h < 10 || h >= 20) return { waiting: 'daytime only' };
  const { metaTemplate, fireTrigger } = await import('./whatsapp.js');
  const tpl = await metaTemplate(env, st.template || TEMPLATE).catch(() => null);
  if (!tpl || tpl.status !== 'APPROVED') return { waiting: 'template ' + (tpl?.status || 'not found') };
  const list = await audience(env, { template: st.template || TEMPLATE, kind: st.audience || 'abandoned' });
  if (!list.length) { await save(env, { ...st, status: 'done', finished_at: now() }); return { done: true }; }
  let sent = 0, failed = 0, skipped = 0;
  for (const p of list.slice(0, per)) {
    const r = await fireTrigger(env, 'broadcast_video', { to: p.phone, vars: { name: p.name, video: st.video }, force: true }).catch((e) => ({ ok: false, error: e.message }));
    if (r.deferred) break;
    if (r.ok) sent++; else if (r.skipped) skipped++; else failed++;
  }
  const fresh = await state(env);
  await save(env, { ...fresh, sent: (fresh.sent || 0) + sent, failed: (fresh.failed || 0) + failed, skipped: (fresh.skipped || 0) + skipped });
  return { sent, failed, skipped, left: list.length - sent - failed - skipped };
}
