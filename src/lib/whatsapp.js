import { hmacSha256hex, safeEqual } from './util.js';
import * as g4w from './go4whatsup.js';
import { confirmLink, payLink } from './wa-token.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

/** Meta details saved in the dashboard (phone number ID + permanent token) always win over Go4WhatsUp. */
export const metaFromDashboard = (env) => !!(env.SETTINGS?.wa?.phone_id && env.SETTINGS?.wa?.token);
/** Go4WhatsUp only when chosen in the dashboard (WhatsApp → "Send through"); Meta direct is the default. */
export const viaG4w = (env) => !!(env.G4W_API_KEY && env.G4W_SECURE_KEY) && env.SETTINGS?.wa?.transport === 'g4w';
/** Any transport configured at all. */
export const waConnected = (env) => viaG4w(env) || !!(env.WA_PHONE_ID && env.WA_TOKEN);

/**
 * Free text. Only delivered inside the 24h window after the customer messaged us (a button tap counts).
 * Never throws. Returns { ok, id, via, error }: ok means the provider accepted it (delivery receipts come later, by id).
 */
export async function sendText(env, phone91, text) {
  { const { claim, h } = await import('./once.js');
    if (!(await claim(env, `x:${String(phone91).slice(-10)}:${h(text)}`, 180))) return { ok: false, skipped: 'duplicate', error: 'same text already sent in the last 3 minutes' }; }
  /* A reply to an inbound message goes back the way it came (processInbound sets REPLY_ROUTE): Meta only opens
     the 24h window between the customer and the number they wrote to, so replying from another number fails
     with 131047 "Re-engagement message". */
  const route = env.REPLY_ROUTE;
  const useG4w = route?.via === 'g4w' ? !!(env.G4W_API_KEY && env.G4W_SECURE_KEY) : route?.via === 'meta' ? false : viaG4w(env);
  const phoneId = (route?.via === 'meta' && route.phoneId) || env.WA_PHONE_ID;
  if (useG4w) {
    try {
      const j = await g4w.sendText(env, phone91, text);
      const d = j?.Data || j?.data || {};
      return { ok: true, via: 'g4w', id: String(d.messageId || d.MessageId || d.wamid || d.id || j?.messageId || '') };
    } catch (e) { console.error('g4w sendText', e.message); return { ok: false, via: 'g4w', error: String(e.message || e) }; }
  }
  if (!phoneId || !env.WA_TOKEN) return { ok: false, via: 'none', error: route?.via === 'g4w' ? 'The message came in through Go4WhatsUp but the Go4WhatsUp keys are not set' : 'WhatsApp is not connected (no phone number ID / token, and Go4WhatsUp is not selected)' };
  try {
    const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WA_TOKEN}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone91, type: 'text', text: { body: text } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const e = j.error || {};
      const err = `Meta ${e.code || r.status}: ${e.error_data?.details || e.message || 'rejected'}`;
      console.error('meta sendText', err);
      return { ok: false, via: 'meta', error: err };
    }
    return { ok: true, via: 'meta', id: String(j.messages?.[0]?.id || '') };
  } catch (e) { console.error('meta sendText', e.message); return { ok: false, via: 'meta', error: String(e.message || e) }; }
}

export async function verifySignature(env, req, raw) {
  if (!env.WA_APP_SECRET) return false;
  const sig = (req.headers.get('X-Hub-Signature-256') || '').replace('sha256=', '');
  return safeEqual(await hmacSha256hex(env.WA_APP_SECRET, raw), sig);
}

/** Pull {action, orderId, from} out of a Meta webhook payload (quick-reply button taps). */
export function parseReplies(payload) {
  const out = [];
  for (const e of payload.entry || [])
    for (const c of e.changes || [])
      for (const m of c.value?.messages || []) {
        const raw = m.button?.payload || m.interactive?.button_reply?.id || '';
        const [action, orderId] = raw.split(':');
        if ((action === 'CONFIRM' || action === 'CANCEL') && orderId) out.push({ action, orderId, from: m.from });
      }
  return out;
}

/**
 * Drop inbound messages this app has already handled (Meta retries / duplicate deliveries), so a tap or a typed
 * reply is acted on exactly once. Returns a copy of the payload with only first-seen messages; statuses untouched.
 */
export async function dedupeInbound(env, payload) {
  if (!env.DB) return payload;
  const t = Math.floor(Date.now() / 1000);
  const out = JSON.parse(JSON.stringify(payload || {}));
  for (const e of out.entry || []) for (const c of e.changes || []) {
    const msgs = c.value?.messages;
    if (!Array.isArray(msgs) || !msgs.length) continue;
    const keep = [];
    for (const m of msgs) {
      if (!m.id) { keep.push(m); continue; }
      const claim = await env.DB.prepare('INSERT INTO wa_seen (id, at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING RETURNING id').bind(String(m.id), t).first();
      if (claim) keep.push(m);
    }
    c.value.messages = keep;
  }
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM wa_seen WHERE at < ?').bind(t - 7 * 86400).run().catch(() => {});
  return out;
}

export function parseStatuses(payload) {
  const out = [];
  for (const e of payload.entry || []) for (const c of e.changes || []) for (const st of c.value?.statuses || []) {
    const er = st.errors?.[0];
    /* keep Meta's code and detail with the title ("Rate limit hit · 130429 · ..."): the title alone does not say which limit */
    if (er) console.log('wa status error', JSON.stringify({ status: st.status, code: er.code, title: er.title, details: er.error_data?.details || er.message || '', pricing: st.pricing?.category || '', conv: st.conversation?.origin?.type || '' }));
    out.push({ id: st.id, status: st.status, error: er ? [er.title || er.message || 'failed', er.code, er.error_data?.details].filter(Boolean).join(' · ') : '' });
  }
  return out;
}

async function logMsg(env, m) {
  if (!env.DB) return null;
  const r = await env.DB.prepare('INSERT INTO messages (ts,direction,phone,trigger,template,status,order_name,wamid,error,preview) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id')
    .bind(Math.floor(Date.now() / 1000), m.direction || 'out', m.phone || '', m.trigger || '', m.template || '', m.status || '', m.orderName || '', m.wamid || '', (m.error || '').slice(0, 300), (m.preview || '').slice(0, 2000)).first();
  return r?.id;
}
export { logMsg };

/**
 * Remember which order we last asked this phone to confirm. Go4WhatsUp strips the quick-reply payload, so
 * a button tap comes back as label text + phone only; this row turns it back into one specific order.
 */
async function rememberPending(env, phone, orderId, orderName) {
  if (!env.DB || !orderId) return;
  await env.DB.prepare(
    `INSERT INTO wa_pending (phone, order_id, order_name, sent_at) VALUES (?,?,?,?)
     ON CONFLICT(phone) DO UPDATE SET order_id=excluded.order_id, order_name=excluded.order_name, sent_at=excluded.sent_at`,
  ).bind(phone, String(orderId), orderName || '', Math.floor(Date.now() / 1000)).run();
}

async function optedOut(env, phone) {
  if (!env.DB || !phone) return false;
  try { return !!(await env.DB.prepare('SELECT phone FROM wa_optout WHERE phone=?').bind(phone).first()); } catch { return false; }
}

const summarise = (rows) => (rows.slice(0, 3).map((r) => `${r.title}${r.qty > 1 ? ' x' + r.qty : ''}`).join(', ') + (rows.length > 3 ? `, +${rows.length - 3} more` : '')).slice(0, 200);

/** Cart summary + design image for a template, straight from the Shopify order. */
export async function orderMedia(env, orderId) {
  try {
    const { orderDetail } = await import('./shopify.js');
    const o = await orderDetail(env, orderId);
    const li = o?.lineItems?.nodes || [];
    if (!li.length) return {};
    return { items: summarise(li.map((l) => ({ title: l.title, qty: l.quantity }))), image: li.find((l) => l.image?.url)?.image?.url || '' };
  } catch (e) {
    console.error('orderMedia', e.message);
    return {};
  }
}

/** Same for an abandoned checkout, where there is no order yet: the lead's saved cart, looked up in Shopify. */
export async function leadMedia(env, phone) {
  try {
    if (!env.DB) return {};
    const row = await env.DB.prepare('SELECT cart_json FROM leads WHERE phone=?').bind(phone).first();
    const lines = JSON.parse(row?.cart_json || '[]').filter((l) => l && /^\d+$/.test(String(l.variant_id)) && !l.upsell);
    if (!lines.length) return {};
    const { gql } = await import('./shopify.js');
    const d = await gql(env, `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant { id image{url} product{ title featuredImage{url} } } } }`,
      { ids: lines.slice(0, 10).map((l) => `gid://shopify/ProductVariant/${l.variant_id}`) });
    const rows = (d.nodes || []).map((n, i) => n && n.product ? { title: n.product.title, qty: Number(lines[i].quantity) || 1, image: n.image?.url || n.product.featuredImage?.url || '' } : null).filter(Boolean);
    if (!rows.length) return {};
    return { items: summarise(rows), image: rows.find((r) => r.image)?.image || '' };
  } catch (e) {
    console.error('leadMedia', e.message);
    return {};
  }
}

/** A Shopify cart permalink that rebuilds this lead's cart on any device. storefront=true lands on the store's cart
    page (where the IK checkout opens), not Shopify's own checkout. Falls back to the store's /cart. */
export async function cartLink(env, phone) {
  const store = String(env.STORE_URL || 'https://www.inkkulture.in').replace(/\/$/, '');
  try {
    const row = env.DB ? await env.DB.prepare('SELECT cart_json FROM leads WHERE phone=?').bind(String(phone)).first() : null;
    const lines = JSON.parse(row?.cart_json || '[]').filter((l) => l && /^\d+$/.test(String(l.variant_id)) && !l.upsell);
    if (lines.length) return `${store}/cart/${lines.slice(0, 20).map((l) => `${l.variant_id}:${Math.max(1, Number(l.quantity) || 1)}`).join(',')}?storefront=true&utm_source=whatsapp&utm_medium=nudge`;
  } catch (e) { console.error('cartLink', e.message); }
  return store + '/cart';
}

/* ---------------- Meta Cloud API: read each template's real shape ---------------- */

/* Templates made in Go4WhatsUp may use named variables ({{name}}) or numbered ones ({{1}}), any language code,
   and an image header. Reading the approved template from Meta means we always send exactly what it expects. */
const metaCache = new Map();
export async function metaTemplate(env, name) {
  if (!env.WA_WABA_ID) return null;
  const hit = metaCache.get(name);
  if (hit && Date.now() - hit.at < 600000) return hit.t;
  const j = await waGet(env, `${env.WA_WABA_ID}/message_templates?name=${encodeURIComponent(name)}&fields=name,language,status,parameter_format,components&limit=50`);
  const all = (j.data || []).filter((x) => x.name === name);
  const t = all.find((x) => x.status === 'APPROVED') || all[0] || null;
  metaCache.set(name, { at: Date.now(), t });
  return t;
}
export const clearMetaCache = () => metaCache.clear();

const clean = (x) => String(x ?? '-').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 900) || '-';

/* WhatsApp image headers take JPEG/PNG under 5 MB. Shopify's CDN can serve any product photo as a resized
   progressive JPEG, so WebP/HEIC uploads and huge originals still arrive. */
export function waImage(url) {
  try {
    const u = new URL(url);
    /* WhatsApp shows template header photos as a ~1.91:1 banner and crops anything else. Pad the design onto a
       white 1200x628 canvas (Shopify's pad_color) so the whole tattoo is visible. */
    if (/(^|\.)cdn\.shopify\.com$/.test(u.hostname) || u.pathname.startsWith('/cdn/shop/')) { u.searchParams.set('width', '1200'); u.searchParams.set('height', '628'); u.searchParams.set('pad_color', 'ffffff'); u.searchParams.set('format', 'pjpg'); }
    return u.toString();
  } catch { return url; }
}

/** Build and send one template on the Cloud API. keys/values are the checkout's variables in {{1}}..{{n}} order. */
export async function metaSendTemplate(env, { name, phone, keys, values, image, video = false, orderId, lang, urlParam = '', onText = null, qrKind = 'cod' }) {
  let tpl = null;
  try { tpl = await metaTemplate(env, name); } catch (e) { console.error('metaTemplate', name, e.message); }
  if (env.WA_WABA_ID && tpl === null) throw new Error(`template "${name}" not found or not approved in WhatsApp Manager`);
  if (tpl && tpl.status !== 'APPROVED') throw new Error(`template "${name}" not found or not approved (status ${tpl.status})`);
  const comps = tpl?.components || [];
  const body = comps.find((c) => c.type === 'BODY');
  const header = comps.find((c) => c.type === 'HEADER');
  const buttons = comps.find((c) => c.type === 'BUTTONS')?.buttons || [];
  const components = [];
  /* A URL button with {{1}}: filled with urlParam (e.g. the pay-page key); without one this checkout can't fill it. */
  const dyn = buttons.map((b, i) => ({ b, i })).filter((x) => x.b.type === 'URL' && /{{\s*\d+\s*}}/.test(x.b.url || ''));
  if (dyn.length && !urlParam) throw new Error(`template "${name}" has a dynamic link button this checkout can't fill`);

  if (!tpl ? image && video : header?.format === 'VIDEO') {
    if (!image) throw new Error(`template "${name}" has a video header but no video was given`);
    components.push({ type: 'header', parameters: [{ type: 'video', video: { link: image } }] });
  } else if (!tpl ? image : header?.format === 'IMAGE') {
    if (!image) throw new Error(`template "${name}" has an image header but no image was found`);
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: waImage(image) } }] });
  }

  const named = tpl?.parameter_format === 'NAMED';
  const text = body?.text || '';
  if (named) {
    const names = (body?.example?.body_text_named_params || []).map((x) => x.param_name);
    const found = names.length ? names : [...new Set([...text.matchAll(/{{\s*([a-z0-9_]+)\s*}}/gi)].map((m) => m[1]))];
    if (found.length) components.push({ type: 'body', parameters: found.map((n, i) => ({ type: 'text', parameter_name: n, text: clean(keys.includes(n) ? values[keys.indexOf(n)] : values[i]) })) });
  } else {
    const count = tpl ? Math.max(0, ...[...text.matchAll(/{{\s*(\d+)\s*}}/g)].map((m) => Number(m[1]))) : values.length;
    if (count) components.push({ type: 'body', parameters: Array.from({ length: count }, (_, i) => ({ type: 'text', text: clean(values[i]) })) });
  }

  /* Quick replies carry the order id, so a tap maps to exactly one order. */
  const qr = tpl ? buttons.map((b, i) => ({ b, i })).filter((x) => x.b.type === 'QUICK_REPLY') : (orderId ? [{ b: { text: 'Yes' }, i: 0 }, { b: { text: 'No' }, i: 1 }] : []);
  if (orderId && orderId !== '0') for (const { b, i } of qr) {
    const no = /\b(no|cancel)\b/i.test(b.text || '');
    /* COD confirmation buttons -> CONFIRM / CANCEL; the refused-delivery question (lib/ndr-ask.js) -> NDR_YES / NDR_NO */
    const act = qrKind === 'addr' ? (/edit|change|badl/i.test(b.text || '') ? 'ADDR_EDIT' : 'ADDR_OK') : qrKind === 'ndr' ? (no ? 'NDR_NO' : 'NDR_YES') : (no ? 'CANCEL' : 'CONFIRM');
    components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: act + ':' + orderId }] });
  }

  for (const { i } of dyn) components.push({ type: 'button', sub_type: 'url', index: String(i), parameters: [{ type: 'text', text: String(urlParam) }] });
  /* what the customer actually reads, for the message log / Chats */
  if (onText && text) {
    try {
      const filled = named
        ? text.replace(/{{\s*([a-z0-9_]+)\s*}}/gi, (m, n) => clean(keys.includes(n) ? values[keys.indexOf(n)] : m))
        : text.replace(/{{\s*(\d+)\s*}}/g, (m, n) => clean(values[Number(n) - 1]));
      const btns = buttons.map((b) => b.text).filter(Boolean);
      onText(filled + (btns.length ? `\n[${btns.join('] [')}]` : ''));
    } catch { /* preview only */ }
  }
  const res = await fetch(`${GRAPH}/${env.WA_PHONE_ID}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WA_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: '91' + phone, type: 'template', template: { name, language: { code: tpl?.language || lang || 'en' }, components } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.messages?.[0]?.id) {
    const e = j.error || {};
    const m = [e.message || 'HTTP ' + res.status, e.error_data?.details, `code ${e.code ?? '?'}${e.error_subcode ? '/' + e.error_subcode : ''}`, e.fbtrace_id ? 'trace ' + e.fbtrace_id : ''].filter(Boolean).join(' · ');
    if (/132001|does not exist/i.test(m)) throw new Error(`template "${name}" not found or not approved: ${m}`);
    if (j.error?.code === 10 || j.error?.code === 200) throw new Error(`${m}. Press Test connection to see which permission or link is missing.`);
    throw new Error(m);
  }
  return j.messages[0].id;
}

/* Stable per-recipient, per-day pick: a retry the same day repeats the same copy, a nudge next week differs. */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function pickVariant(cfg, phone, day = new Date().toISOString().slice(0, 10)) {
  const list = (cfg.variants || []).filter(Boolean);
  if (list.length < 2) return cfg.name;
  return list[hashStr(phone + ':' + day) % list.length];
}

/** Fire a configured trigger. vars = {name, order, ...}; to = 10-digit phone (or admin phone for admin_* triggers). Never throws. */
const ONCE_EXEMPT = new Set(['cod_otp', 'admin_new_order', 'admin_high_risk']);
export async function fireTrigger(env, key, { to, vars = {}, orderId, orderName, force = false }) {
  const { TRIGGERS, triggerConfig } = await import('./settings.js');
  const t = TRIGGERS[key];
  if (!t) return { skipped: 'unknown' };
  const cfg = triggerConfig(env, key);
  /* force: a person pressed a button in the dashboard. The on/off switch only governs automatic sends. */
  if (!cfg.enabled && !force) return { skipped: 'disabled' };
  const phone = String(to || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  const v = { ...vars };
  let templateName = pickVariant(cfg, phone);
  /* Not yet approved? A rotation variant falls back to the base template; the base falls back to the trigger's
     older approved template (e.g. a reworded version still in review). */
  /* x_offer -> x_img -> x: photo+offer, photo only, text only. */
  const alts = (n) => [n, String(n || '').replace(/_offer$/, '_img'), String(n || '').replace(/_(offer|img)$/, '')];
  const candidates = (n) => [...new Set([...alts(n), ...alts(cfg.name), t.fallback].filter(Boolean))];
  /* Worth trying the next template: not approved yet, an image version with no picture to send, or a button we can't fill. */
  const RETRY = /not found or not approved|image header but no image|dynamic link button/;
  let shown = '';   /* the template text as sent (Cloud API), else the variables */
  let onceKey = '';
  const base = () => ({ phone, trigger: key, template: templateName, orderName: orderName || v.order || '', preview: shown || cfg.vars.map((k) => `${k}=${v[k] ?? ''}`).join(' | ') });

  try {
    if (!phone) { await logMsg(env, { ...base(), status: 'skipped', error: 'no phone number' }); return { skipped: 'nophone' }; }
    if (!waConnected(env)) { await logMsg(env, { ...base(), status: 'skipped', error: 'WhatsApp not connected' }); return { skipped: 'nowa' }; }
    /* Never the same template to the same person for the same order twice within 10 minutes, whoever asks
       (a double-tapped button, parallel requests, a retry loop). OTP codes are exempt: "resend code" is real. */
    if (!ONCE_EXEMPT.has(key)) {
      const { claim } = await import('./once.js');
      onceKey = `t:${phone}:${key}:${orderName || v.order || ''}`;
      if (!(await claim(env, onceKey, 600))) { await logMsg(env, { ...base(), status: 'skipped', error: 'same message already sent in the last 10 minutes' }); return { skipped: 'duplicate' }; }
    }
    if (t.marketing && (await optedOut(env, phone))) { await logMsg(env, { ...base(), status: 'skipped', error: 'customer replied STOP' }); return { skipped: 'optout' }; }
    /* Meta throttled the number ("Rate limit hit"): wait it out instead of hammering (lib/wa-gate.js). The caller's retry sends it later. */
    const { gate } = await import('./wa-gate.js');
    const g = env.DB ? await gate(env, key).catch(() => ({ go: true })) : { go: true };
    if (!g.go) { if (onceKey) { const { release } = await import('./once.js'); await release(env, onceKey); } return { ok: false, deferred: true, error: 'paused after a WhatsApp rate limit, sent later' }; }
    /* never a burst: at least 0.7 s between template sends */
    const gap = 700 - (Date.now() - lastTemplateAt);
    if (gap > 0) await new Promise((ok) => setTimeout(ok, gap));
    lastTemplateAt = Date.now();

    /* The real cart line and design image beat any generic text a caller passed ("your Ink Kulture cart"). */
    let image = v.image || '';
    delete v.image;
    const wantItems = cfg.vars.includes('items');
    const isVideo = t.media === 'video';
    if (isVideo) image = v.video || image;
    delete v.video;
    if ((wantItems || t.media === true) && (orderId || phone)) {
      const m = orderId && orderId !== '0' ? await orderMedia(env, orderId) : await leadMedia(env, phone);
      if (m.items) v.items = m.items;
      if (!image && m.image) image = m.image;
    }
    if (wantItems && !v.items) v.items = 'your Ink Kulture order';
    if (cfg.vars.includes('edd') && !v.edd) v.edd = '4-7 days';
    /* the order's own track page link (button {{1}}): signed order key */
    if (t.urlParam === 'trackkey' && !v.trackkey && orderId && orderId !== '0') { const { trackKey } = await import('./self-cancel.js'); v.trackkey = await trackKey(env, orderId); }
    if (t.media === true && !image) image = env.WA_HEADER_IMAGE || '';
    if (isVideo && !image) { await logMsg(env, { ...base(), status: 'skipped', error: 'no how-to-apply video set' }); return { skipped: 'novideo' }; }

    /* Signed one-tap links, deterministic even when a button payload is lost in transit. */
    if (orderId && orderId !== '0') {
      if (cfg.vars.includes('confirm') && !v.confirm) v.confirm = (await confirmLink(env, orderId)) || '';
      if (cfg.vars.includes('pay') && !v.pay) v.pay = (await payLink(env, orderId)) || '';
      if (cfg.vars.includes('btnurl') && !v.btnurl) v.btnurl = (await confirmLink(env, orderId)) || '';
    }
    for (const k of ['confirm', 'pay', 'btnurl']) if (cfg.vars.includes(k) && !v[k]) v[k] = env.STORE_URL || 'https://www.inkkulture.in';

    if (t.media && !image && viaG4w(env)) { await logMsg(env, { ...base(), status: 'failed', error: 'template needs a header image: none found on the order and WA_HEADER_IMAGE is not set' }); return { ok: false }; }

    let wamid = '';
    if (viaG4w(env)) {
      const body = Object.fromEntries(cfg.vars.filter((k) => k !== 'btnurl').map((k) => [k, v[k] ?? '-']));
      const button = cfg.vars.includes('btnurl') ? { btnurl: v.btnurl } : t.urlParam && v[t.urlParam] ? { btnurl: v[t.urlParam] } : {};
      const send = (name) => g4w.sendTemplate(env, { name, to: phone, body, button, fileUrl: t.media ? image : '' });
      /* A rotation variant still awaiting approval must not cost a send: walk down to an approved one. */
      let r;
      const list = candidates(templateName);
      for (let i = 0; i < list.length; i++) {
        templateName = list[i];
        try { r = await send(templateName); break; } catch (e) {
          if (i === list.length - 1 || !RETRY.test(String(e.message))) throw e;
        }
      }
      wamid = r.wamid;
    } else {
      const send = (name) => metaSendTemplate(env, { name, phone, keys: cfg.vars, values: cfg.vars.map((k) => v[k]), image: t.media ? image : '', video: isVideo, orderId: t.buttons ? orderId : '', lang: cfg.lang,
        urlParam: t.urlParam ? v[t.urlParam] || '' : '', onText: (x) => { shown = x; }, qrKind: t.buttons === 'ndr' ? 'ndr' : t.buttons === 'addr' ? 'addr' : 'cod' });
      const list = candidates(templateName);
      for (let i = 0; i < list.length; i++) {
        templateName = list[i];
        try { wamid = await send(templateName); break; } catch (e) {
          if (i === list.length - 1 || !RETRY.test(String(e.message))) throw e;
        }
      }
    }
    if (t.buttons === true && orderId && orderId !== '0') await rememberPending(env, phone, orderId, orderName || v.order);
    await logMsg(env, { ...base(), status: 'sent', wamid });
    return { ok: true, template: templateName };
  } catch (e) {
    await logMsg(env, { ...base(), status: 'failed', error: String(e.message || e) }).catch(() => {});
    if (onceKey) { const { release } = await import('./once.js'); await release(env, onceKey); }
    try { const G = await import('./wa-gate.js'); if (env.DB && G.RATE_LIMIT.test(String(e.message || e))) await G.pushback(env); } catch { /* best effort */ }
    return { ok: false, error: String(e.message || e) };
  }
}
let lastTemplateAt = 0;

export async function waGet(env, path) {
  const res = await fetch(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || 'HTTP ' + res.status);
  return j;
}
