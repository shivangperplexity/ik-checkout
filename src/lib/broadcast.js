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
/* Same offer, worded differently: Meta reviews each on its own, the first approved one is used, and a person gets
   only one of them (the "already sent" check covers every variant). */
export const VARIANTS = [
  { name: TEMPLATE, body: BODY, campaign: 'video_offer_1' },
  { name: 'ik_video_offer_v2', campaign: 'video_offer_2', body: [
    'Hey {{1}}! ✨',
    '',
    'Tattoo ka shauk hai par needle se darr lagta hai? 😅',
    'Ink Kulture ke semi-permanent tattoos try karo:',
    '',
    '✅ Bina needle, bina dard, ghar pe khud lagao',
    '✅ 1-2 hafte tak asli tattoo jaisa dikhta hai',
    '✅ Buy 1 Get 1 FREE',
    '✅ Online payment pe extra 10% OFF',
    '',
    'Video dekho aur apna design chuno 👇',
  ].join('\n') },
  { name: 'ik_video_offer_v3', campaign: 'video_offer_3', body: [
    'Hi {{1}},',
    '',
    'Upar video dekho, yahi hai Ink Kulture ka semi-permanent tattoo.',
    '',
    '• Needle nahi, dard nahi',
    '• Lagbhag 2 hafte chalta hai, phir apne aap fade ho jaata hai',
    '• Har design pe Buy 1 Get 1 FREE',
    '• Prepaid order pe 10% extra discount',
    '',
    'Pasand aaye toh aaj hi order karo 👇',
  ].join('\n') },
];
const shopUrl = (campaign) => SHOP_URL.replace('video_offer_1', campaign);

/** Meta status of every variant, and the first approved one (null when none is yet). */
export async function variantStatus(env) {
  const { metaTemplate } = await import('./whatsapp.js');
  const out = [];
  for (const v of VARIANTS) { const t = await metaTemplate(env, v.name).catch(() => null); out.push({ name: v.name, status: t ? t.status : 'NOT SUBMITTED' }); }
  return { list: out, use: out.find((x) => x.status === 'APPROVED')?.name || null };
}

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
  const done = new Set((await q("SELECT phone FROM messages WHERE direction='out' AND trigger='broadcast_video' AND template LIKE 'ik_video_offer%' AND status NOT IN ('failed','skipped')")).map((r) => p10(r.phone)));
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
  let vs = { list: [], use: null };
  try { vs = await variantStatus(env); } catch (e) { /* shown as not submitted */ }
  const template_status = vs.use ? 'APPROVED' : (vs.list.find((x) => x.status !== 'NOT SUBMITTED')?.status || 'NOT SUBMITTED');
  return { ok: true, ...st, template: vs.use || vs.list.map((x) => x.name + ' ' + x.status).join(', ') || st.template, variants: vs.list, body: BODY, shop_url: SHOP_URL, left: left.length, cost_left: Math.round(left.length * COST_PER_MSG), template_status, sample: left.slice(0, 3).map((x) => x.name) };
}

/** Submit the template to Meta with the video as its sample (the video must be a public https .mp4, under 16 MB). */
export async function submit(env, video, only = null) {
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
  const { templateDetails } = await import('./wa-migrate.js');
  const have = new Map((await templateDetails(env, env.WA_WABA_ID, VARIANTS.map((v) => v.name)).catch(() => [])).map((t) => [t.name, t.status]));
  const created = [];
  for (const v of VARIANTS) {
    if (only ? !only.includes(v.name) : have.has(v.name) && have.get(v.name) !== 'REJECTED') continue;
    const tpl = { name: v.name, language: 'en', category: 'MARKETING', sample_url: url, components: [
      { type: 'HEADER', format: 'VIDEO' },
      { type: 'BODY', text: v.body, example: { body_text: [['Riya']] } },
      { type: 'FOOTER', text: 'Reply STOP to stop offers' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop now', url: shopUrl(v.campaign) }] },
    ] };
    try { const r = await createTemplate(env, { waba: env.WA_WABA_ID, appId, tpl }); created.push({ name: v.name, status: r.status || 'PENDING' }); }
    catch (e) { created.push({ name: v.name, status: 'FAILED', error: String(e.message || e).slice(0, 200) }); }
  }
  await save(env, { ...st, video: url, submitted_at: now(), status: st.status === 'sending' ? 'sending' : 'draft' });
  return { ok: true, created, status: created[0]?.status || 'PENDING' };
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
  const { fireTrigger } = await import('./whatsapp.js');
  const vs = await variantStatus(env);
  if (!vs.use) return { waiting: 'no variant approved yet' };
  /* send through the approved variant (the trigger's template name is swapped for this run only) */
  const tpls = env.SETTINGS?.templates || {};
  const envUse = { ...env, SETTINGS: { ...(env.SETTINGS || {}), templates: { ...tpls, broadcast_video: { ...(tpls.broadcast_video || {}), name: vs.use, variants: [] } } } };
  const list = await audience(env, { kind: st.audience || 'abandoned' });
  if (!list.length) { await save(env, { ...st, status: 'done', finished_at: now() }); return { done: true }; }
  let sent = 0, failed = 0, skipped = 0;
  for (const p of list.slice(0, per)) {
    const r = await fireTrigger(envUse, 'broadcast_video', { to: p.phone, vars: { name: p.name, video: st.video }, force: true }).catch((e) => ({ ok: false, error: e.message }));
    if (r.deferred) break;
    if (r.ok) sent++; else if (r.skipped) skipped++; else failed++;
  }
  const fresh = await state(env);
  await save(env, { ...fresh, sent: (fresh.sent || 0) + sent, failed: (fresh.failed || 0) + failed, skipped: (fresh.skipped || 0) + skipped });
  return { sent, failed, skipped, left: list.length - sent - failed - skipped };
}
