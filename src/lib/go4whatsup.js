/**
 * Go4WhatsUp BSP transport.
 *
 * Every endpoint is POST and carries auth in the PATH, not a header:
 *   https://api.go4whatsup.com/developerApi/<action>/v1/<API_KEY>/<SECURE_KEY>
 * Keys: app.go4whatsup.com -> API -> Generate Api Key.
 *
 * Env: G4W_API_KEY, G4W_SECURE_KEY (G4W_ORG_ID optional, only for the credits check).
 */

const BASE = 'https://api.go4whatsup.com/developerApi';

function authPath(env) {
  if (!env.G4W_API_KEY || !env.G4W_SECURE_KEY) throw new Error('G4W keys not set');
  return `${encodeURIComponent(env.G4W_API_KEY)}/${encodeURIComponent(env.G4W_SECURE_KEY)}`;
}

async function g4w(env, action, body) {
  const res = await fetch(`${BASE}/${action}/v1/${authPath(env)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !(j.ErrorCode === 200 || j.Succeeded === true)) {
    throw new Error(String(j.ErrorMessage || j.message || `go4whatsup ${action} HTTP ${res.status}`).slice(0, 280));
  }
  return j;
}

/* ---------------- templates ---------------- */

/** Approved templates: [{ _id, templateName, ... }] */
export async function listTemplates(env, { name, skip = 0, limit = 200 } = {}) {
  const j = await g4w(env, 'getApproveTemplates', { name: name || '', skip, limit });
  const m = j.message ?? j.getApproveTemplates ?? j.data ?? [];
  return Array.isArray(m) ? m : [m];
}

/** Full design for one template (read back the variable names typed in the designer). */
export const getTemplate = (env, templateId) => g4w(env, 'getTemplate', { templateId });

/* You send by _id, never by name. Cache the name -> _id map for 10 minutes per warm instance. */
let idCache = { at: 0, map: null };
export async function templateId(env, name) {
  if (!idCache.map || Date.now() - idCache.at > 600000) {
    const rows = await listTemplates(env);
    idCache = { at: Date.now(), map: new Map(rows.filter((t) => t && t._id).map((t) => [String(t.templateName || t.name || '').toLowerCase(), t._id])) };
  }
  const id = idCache.map.get(String(name).toLowerCase());
  if (!id) throw new Error(`template "${name}" not found or not approved`);
  return id;
}
export const clearTemplateCache = () => { idCache = { at: 0, map: null }; };

/* ---------------- sending ---------------- */

export const to91 = (p) => '+91' + String(p || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '').slice(-10);
const pairs = (o) => Object.entries(o || {}).map(([variableKey, v]) => ({ variableKey, variableValue: String(v ?? '-').slice(0, 900) || '-' }));

/**
 * Send an approved template.
 *
 * `body` / `header` keys must match the variable names typed in the Go4WhatsUp template designer
 * (they are named, not positional {{1}}/{{2}}).
 *
 * `button` is for a Call-To-Action button whose URL Type is "Dynamic". Their documented payload has no
 * button array, so it is sent BOTH merged into variablesBody and as a variablesButton array; an unknown
 * key is ignored server-side. Unverified: the signed link in the body is what actually carries the
 * guarantee.
 */
export async function sendTemplate(env, { name, to, body = {}, header = {}, button = {}, fileUrl = '' }) {
  const hasButton = Object.keys(button).length > 0;
  const payload = {
    templateId: await templateId(env, name),
    mobileNo: to91(to),
    variablesHeader: pairs(header),
    variablesBody: pairs({ ...body, ...button }),
    ...(hasButton ? { variablesButton: pairs(button) } : {}),
  };
  if (fileUrl) payload.fileurl = fileUrl;
  const j = await g4w(env, fileUrl ? 'sendAttachmentWithVariable' : 'sendTemplateWithVariable', payload);
  return { ok: true, wamid: j.message?.whatsappMsgId || j.message?.wamid || j.whatsappMsgId || '' };
}

/** Template with no variables at all. */
export async function sendTemplatePlain(env, { name, to }) {
  const j = await g4w(env, 'sendTemplate', { templateId: await templateId(env, name), mobileNo: to91(to) });
  return { ok: true, wamid: j.message?.whatsappMsgId || '' };
}

/** Free-form text. Only lands inside a 24h session, i.e. after the customer messages you. */
export const sendText = (env, to, text) => g4w(env, 'sendTextMessage', { customerMobileNo: to91(to), message: String(text).slice(0, 4000) });

/** Wallet balance: cheap health check that the keys work. */
export const credits = (env) => g4w(env, 'getOrgCredits', { orgId: env.G4W_ORG_ID || '' });

/* ---------------- inbound ---------------- */

/* Things that describe OUR outgoing messages (delivery receipts, echoes). A status callback can carry the
   template's button labels, and "Yes, confirm" must never be read as the customer's answer. */
const OUTBOUND_STATUS = /^(sent|delivered|read|failed|queued|accepted|pending|submitted|enroute|undelivered|deleted)$/i;
function looksOutbound(n) {
  if (n.fromMe === true || n.isOutgoing === true || n.outgoing === true || n.isEcho === true) return true;
  const dir = String(n.direction || n.messageDirection || n.type_of_message || '').toLowerCase();
  if (/^(out|outgoing|outbound|sent|send|business)$/.test(dir)) return true;
  const st = n.messageStatus ?? n.msgStatus ?? n.status;
  if (typeof st === 'string' && OUTBOUND_STATUS.test(st) && !n.buttonText && !n.button && !n.interactive) return true;
  return false;
}

/**
 * Go4WhatsUp's "Chat / Receive Message" webhook shape is undocumented, so this walks whatever arrives and
 * pulls out { from, text }. Flat, Meta-style, nested and interactive shapes are all handled. When nothing is
 * found the caller logs the raw body so the real field names can be read in the dashboard.
 */
export function parseInbound(payload) {
  const out = [];
  const seen = new WeakSet();
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) return n.forEach(walk);
    if (Array.isArray(n.statuses) && !n.messages) return; /* Meta-style delivery receipts */
    if (looksOutbound(n)) return;
    const from = n.customerMobileNo || n.mobileNo || n.from || n.waId || n.wa_id || n.customerNumber || n.sender || n.senderMobile || n.phone || n.contact?.wa_id;
    const text = n.buttonText || n.button?.text || n.button?.payload
      || n.interactive?.button_reply?.title || n.interactive?.button_reply?.id
      || n.text?.body || n.messageText || n.msgText || n.body?.text
      || (typeof n.text === 'string' ? n.text : '')
      || (typeof n.message === 'string' ? n.message : n.message?.text);
    if (from && text && typeof text === 'string') {
      const d = String(from).replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
      if (/^\d{10}$/.test(d)) out.push({ from: d, text: text.trim().slice(0, 300) });
    }
    Object.values(n).forEach(walk);
  })(payload);
  /* de-dupe: the same pair often appears at two nesting levels */
  const seenKey = new Set();
  return out.filter((m) => { const k = m.from + '|' + m.text; if (seenKey.has(k)) return false; seenKey.add(k); return true; });
}

/**
 * Go4WhatsUp gives no button payload id, so map the visible label instead. The WHOLE message must match:
 * "No problem, please confirm" must never cancel an order, so free text that merely starts with "no" is
 * ignored (it is still logged for a human to read).
 */
export function replyAction(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(stop|unsubscribe|opt out|optout|stop messages)$/.test(t)) return 'STOP';
  if (/^(start|subscribe)$/.test(t)) return 'START';
  if (/^(no|no cancel|cancel|cancel order|cancel it|cancel my order|please cancel|dont want|don t want|nahi|nahin|na)$/.test(t)) return 'CANCEL';
  if (/^(yes|yes confirm|confirm|confirm order|confirmed|yes confirm order|confirm my order|yes please|ok|okay|yep|yeah|haan|han|ha|ji|haa)$/.test(t)) return 'CONFIRM';
  return null;
}
