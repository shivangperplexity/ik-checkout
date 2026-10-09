import { hmacSha256hex, safeEqual } from './util.js';

export async function sendText(env, phone91, text) {
  if (!env.WA_PHONE_ID || !env.WA_TOKEN) return;
  await fetch(`https://graph.facebook.com/v21.0/${env.WA_PHONE_ID}/messages`, {
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

/** Pull {action, orderId, from} out of a webhook payload (quick-reply button taps). */
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

const GRAPH = 'https://graph.facebook.com/v21.0';
async function logMsg(env, m) {
  if (!env.DB) return null;
  const r = await env.DB.prepare('INSERT INTO messages (ts,direction,phone,trigger,template,status,order_name,wamid,error,preview) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id')
    .bind(Math.floor(Date.now() / 1000), m.direction || 'out', m.phone || '', m.trigger || '', m.template || '', m.status || '', m.orderName || '', m.wamid || '', (m.error || '').slice(0, 300), (m.preview || '').slice(0, 300)).first();
  return r?.id;
}
export { logMsg };

/** Fire a configured trigger. vars = {name, order, ...}; to = 10-digit phone (or admin phone for admin_* triggers). Never throws. */
export async function fireTrigger(env, key, { to, vars = {}, orderId, orderName }) {
  const { TRIGGERS, triggerConfig } = await import('./settings.js');
  const t = TRIGGERS[key];
  const cfg = triggerConfig(env, key);
  if (!t || !cfg.enabled) return { skipped: 'disabled' };
  const phone = String(to || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  const preview = cfg.vars.map((v) => `${v}=${vars[v] ?? ''}`).join(' | ');
  const base = { phone, trigger: key, template: cfg.name, orderName: orderName || vars.order || '', preview };
  if (!phone) { await logMsg(env, { ...base, status: 'skipped', error: 'no phone number' }); return { skipped: 'nophone' }; }
  if (!env.WA_PHONE_ID || !env.WA_TOKEN) { await logMsg(env, { ...base, status: 'skipped', error: 'WhatsApp not connected' }); return { skipped: 'nowa' }; }
  const components = [{ type: 'body', parameters: cfg.vars.map((v) => ({ type: 'text', text: String(vars[v] ?? '-').slice(0, 300) })) }];
  if (!cfg.vars.length) components.pop();
  if (t.buttons && orderId) {
    components.push({ type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'CONFIRM:' + orderId }] });
    components.push({ type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'CANCEL:' + orderId }] });
  }
  try {
    const res = await fetch(`${GRAPH}/${env.WA_PHONE_ID}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WA_TOKEN}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: '91' + phone, type: 'template', template: { name: cfg.name, language: { code: cfg.lang }, components } }),
    });
    const j = await res.json().catch(() => ({}));
    const ok = res.ok && j.messages?.[0]?.id;
    await logMsg(env, { ...base, status: ok ? 'sent' : 'failed', wamid: j.messages?.[0]?.id, error: ok ? '' : (j.error?.message || 'HTTP ' + res.status) });
    return { ok: !!ok };
  } catch (e) {
    await logMsg(env, { ...base, status: 'failed', error: String(e.message || e) });
    return { ok: false };
  }
}

export async function waGet(env, path) {
  const res = await fetch(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${env.WA_TOKEN}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || 'HTTP ' + res.status);
  return j;
}
