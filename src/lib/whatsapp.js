import { hmacSha256hex, safeEqual } from './util.js';
import * as g4w from './go4whatsup.js';
import { confirmLink, payLink } from './wa-token.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

/** True when outbound WhatsApp goes through Go4WhatsUp instead of Meta direct. Nothing changes until G4W keys are set. */
export const viaG4w = (env) => !!(env.G4W_API_KEY && env.G4W_SECURE_KEY);
/** Any transport configured at all. */
export const waConnected = (env) => viaG4w(env) || !!(env.WA_PHONE_ID && env.WA_TOKEN);

/** Free text. Only delivered inside the 24h window after the customer messaged us (a button tap counts). */
export async function sendText(env, phone91, text) {
  if (viaG4w(env)) {
    try { await g4w.sendText(env, phone91, text); } catch (e) { console.error('g4w sendText', e.message); }
    return;
  }
  if (!env.WA_PHONE_ID || !env.WA_TOKEN) return;
  await fetch(`${GRAPH}/${env.WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WA_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone91, type: 'text', text: { body: text } }),
  });
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

export function parseStatuses(payload) {
  const out = [];
  for (const e of payload.entry || []) for (const c of e.changes || []) for (const st of c.value?.statuses || []) out.push({ id: st.id, status: st.status, error: st.errors?.[0]?.title || '' });
  return out;
}

async function logMsg(env, m) {
  if (!env.DB) return null;
  const r = await env.DB.prepare('INSERT INTO messages (ts,direction,phone,trigger,template,status,order_name,wamid,error,preview) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id')
    .bind(Math.floor(Date.now() / 1000), m.direction || 'out', m.phone || '', m.trigger || '', m.template || '', m.status || '', m.orderName || '', m.wamid || '', (m.error || '').slice(0, 300), (m.preview || '').slice(0, 300)).first();
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
export async function fireTrigger(env, key, { to, vars = {}, orderId, orderName }) {
  const { TRIGGERS, triggerConfig } = await import('./settings.js');
  const t = TRIGGERS[key];
  if (!t) return { skipped: 'unknown' };
  const cfg = triggerConfig(env, key);
  if (!cfg.enabled) return { skipped: 'disabled' };
  const phone = String(to || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  const v = { ...vars };
  let templateName = pickVariant(cfg, phone);
  const base = () => ({ phone, trigger: key, template: templateName, orderName: orderName || v.order || '', preview: cfg.vars.map((k) => `${k}=${v[k] ?? ''}`).join(' | ') });

  try {
    if (!phone) { await logMsg(env, { ...base(), status: 'skipped', error: 'no phone number' }); return { skipped: 'nophone' }; }
    if (!waConnected(env)) { await logMsg(env, { ...base(), status: 'skipped', error: 'WhatsApp not connected' }); return { skipped: 'nowa' }; }
    if (t.marketing && (await optedOut(env, phone))) { await logMsg(env, { ...base(), status: 'skipped', error: 'customer replied STOP' }); return { skipped: 'optout' }; }

    /* The real cart line and design image beat any generic text a caller passed ("your Ink Kulture cart"). */
    let image = v.image || '';
    delete v.image;
    const wantItems = cfg.vars.includes('items');
    if ((wantItems || t.media) && (orderId || phone)) {
      const m = orderId && orderId !== '0' ? await orderMedia(env, orderId) : await leadMedia(env, phone);
      if (m.items) v.items = m.items;
      if (!image && m.image) image = m.image;
    }
    if (wantItems && !v.items) v.items = 'your Ink Kulture order';
    if (t.media && !image) image = env.WA_HEADER_IMAGE || '';

    /* Signed one-tap links, deterministic even when a button payload is lost in transit. */
    if (orderId && orderId !== '0') {
      if (cfg.vars.includes('confirm') && !v.confirm) v.confirm = (await confirmLink(env, orderId)) || '';
      if (cfg.vars.includes('pay') && !v.pay) v.pay = (await payLink(env, orderId)) || '';
      if (cfg.vars.includes('btnurl') && !v.btnurl) v.btnurl = (await confirmLink(env, orderId)) || '';
    }
    for (const k of ['confirm', 'pay', 'btnurl']) if (cfg.vars.includes(k) && !v[k]) v[k] = env.STORE_URL || 'https://www.inkkulture.in';

    if (t.media && !image) { await logMsg(env, { ...base(), status: 'failed', error: 'template needs a header image: none found on the order and WA_HEADER_IMAGE is not set' }); return { ok: false }; }

    let wamid = '';
    if (viaG4w(env)) {
      const body = Object.fromEntries(cfg.vars.filter((k) => k !== 'btnurl').map((k) => [k, v[k] ?? '-']));
      const button = cfg.vars.includes('btnurl') ? { btnurl: v.btnurl } : {};
      const send = (name) => g4w.sendTemplate(env, { name, to: phone, body, button, fileUrl: t.media ? image : '' });
      let r;
      try {
        r = await send(templateName);
      } catch (e) {
        /* A rotation variant still awaiting approval must not cost a send: retry once on the base template. */
        if (templateName === cfg.name || !/not found or not approved/.test(String(e.message))) throw e;
        templateName = cfg.name;
        r = await send(templateName);
      }
      wamid = r.wamid;
    } else {
      const components = [];
      if (t.media && image) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: image } }] });
      if (cfg.vars.length) components.push({ type: 'body', parameters: cfg.vars.map((k) => ({ type: 'text', text: String(v[k] ?? '-').slice(0, 300) || '-' })) });
      if (t.buttons && orderId) {
        components.push({ type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'CONFIRM:' + orderId }] });
        components.push({ type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'CANCEL:' + orderId }] });
      }
      const res = await fetch(`${GRAPH}/${env.WA_PHONE_ID}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WA_TOKEN}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: '91' + phone, type: 'template', template: { name: templateName, language: { code: cfg.lang }, components } }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.messages?.[0]?.id) throw new Error(j.error?.message || 'HTTP ' + res.status);
      wamid = j.messages[0].id;
    }
    if (t.buttons && orderId && orderId !== '0') await rememberPending(env, phone, orderId, orderName || v.order);
    await logMsg(env, { ...base(), status: 'sent', wamid });
    return { ok: true, template: templateName };
  } catch (e) {
    await logMsg(env, { ...base(), status: 'failed', error: String(e.message || e) }).catch(() => {});
    return { ok: false, error: String(e.message || e) };
  }
}

export async function waGet(env, path) {
  const res = await fetch(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || 'HTTP ' + res.status);
  return j;
}
