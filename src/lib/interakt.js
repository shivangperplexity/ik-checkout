/**
 * Interakt as the WhatsApp transport (Nov 2026: number moved to Interakt because Meta billing blocked sends, 131042).
 *
 * Settings > WhatsApp: wa.transport = 'interakt', wa.interakt_key (Developer Settings API key), wa.interakt_secret
 * (webhook secret). Every module still builds WhatsApp Cloud API requests; while Interakt is on, POSTs to
 * graph.facebook.com/.../messages are translated here into Interakt's public API (one place, no change in the
 * 8 modules that send). Interakt's webhooks (POST /api/interakt/webhook) are turned back into Cloud API webhook
 * payloads, so the existing reply / status code runs unchanged.
 *
 * Docs: https://interakt.shop/resource-center/how-to-send-whatsapp-templates-using-apis-webhooks (send),
 *       https://www.interakt.shop/?p=6254 (webhook format, Interakt-Signature).
 */
const API = 'https://api.interakt.ai/v1/public/message/';
let CFG = { key: '' };

/** Called by settings.js whenever settings load. */
export function configureInterakt(s) {
  const w = s?.wa || {};
  CFG = { key: w.transport === 'interakt' ? String(w.interakt_key || '').trim() : '' };
}
export const interaktOn = () => !!CFG.key;

const split = (to) => { const d = String(to || '').replace(/\D/g, ''); return { countryCode: '+' + (d.length > 10 ? d.slice(0, d.length - 10) : '91'), phoneNumber: d.slice(-10) }; };
const txt = (p) => String(p?.text ?? p?.payload ?? p?.coupon_code ?? '');

/** Cloud API message body -> Interakt body (null when it can't be expressed). */
export function toInterakt(b) {
  const base = { ...split(b.to), callbackData: String(b.biz_opaque_callback_data || '').slice(0, 500) || undefined };
  if (b.type === 'text') return { ...base, type: 'Text', data: { message: String(b.text?.body || '') } };
  if (b.type === 'template') {
    const t = b.template || {}, comps = t.components || [];
    const out = { name: t.name, languageCode: t.language?.code || 'en' };
    for (const c of comps) {
      const ps = c.parameters || [];
      if (c.type === 'header') {
        const m = ps.find((p) => p.image || p.video || p.document);
        if (m) { const md = m.image || m.video || m.document; out.headerValues = [md.link]; if (m.document) out.fileName = md.filename || 'document.pdf'; }
        else out.headerValues = ps.map(txt);
      } else if (c.type === 'body') out.bodyValues = ps.map(txt);
      else if (c.type === 'button') {
        const i = String(c.index ?? 0);
        if (c.sub_type === 'quick_reply') (out.buttonPayload = out.buttonPayload || {})[i] = ps.map(txt);
        else (out.buttonValues = out.buttonValues || {})[i] = ps.map(txt);
      }
    }
    return { ...base, type: 'Template', template: out };
  }
  if (b.type === 'image' || b.type === 'video' || b.type === 'document') {
    const m = b[b.type] || {};
    return { ...base, type: b.type[0].toUpperCase() + b.type.slice(1), data: { message: String(m.caption || ''), mediaUrl: m.link, ...(b.type === 'document' ? { fileName: m.filename || 'document.pdf' } : {}) } };
  }
  if (b.type === 'interactive') {
    /* Interakt's public API documents only Template / Text: buttons become a text the customer can answer by typing
       (the reply parser already understands "yes", "cancel", "re-attempt", "return", 1 / 2 ...). */
    const it = b.interactive || {};
    const body = [it.header?.text, it.body?.text].filter(Boolean).join('\n\n');
    const btns = it.action?.buttons?.map((x) => x.reply?.title).filter(Boolean)
      || (it.action?.sections || []).flatMap((s) => (s.rows || []).map((r) => r.title)).filter(Boolean)
      || [];
    const extra = it.type === 'cta_url' && it.action?.parameters?.url ? `\n\n${it.action.parameters.display_text || 'Open'}: ${it.action.parameters.url}` : '';
    const opts = btns.length ? '\n\nReply with: ' + btns.map((t, i) => `${i + 1}) ${t}`).join('  ') : '';
    return { ...base, type: 'Text', data: { message: (body + extra + opts + (it.footer?.text ? '\n\n' + it.footer.text : '')).trim() } };
  }
  return null;
}

async function sendInterakt(body) {
  const ib = toInterakt(body);
  if (!ib) return new Response(JSON.stringify({ error: { code: 400, message: 'Interakt: message type ' + body.type + ' is not supported' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const r = await realFetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + CFG.key }, body: JSON.stringify(ib) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.result === false) {
    const msg = `Interakt ${r.status}: ${j.message || JSON.stringify(j).slice(0, 200)}`;
    console.error('interakt send', ib.type, ib.template?.name || '', msg);
    return new Response(JSON.stringify({ error: { code: r.status, message: msg, error_data: { details: msg } } }), { status: r.ok ? 400 : r.status, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ wa_id: body.to }], messages: [{ id: String(j.id || '') }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/* ---- route Cloud API sends through Interakt while it is switched on ---- */
const realFetch = globalThis.fetch.bind(globalThis);
if (!globalThis.__ikInteraktPatched) {
  globalThis.__ikInteraktPatched = true;
  globalThis.fetch = async function (input, init) {
    try {
      if (CFG.key) {
        const url = typeof input === 'string' ? input : input?.url || String(input);
        const method = String(init?.method || input?.method || 'GET').toUpperCase();
        if (method === 'POST' && /^https:\/\/graph\.facebook\.com\/v[\d.]+\/\d+\/messages\b/.test(url)) {
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : await new Response(init?.body).text());
          if (body?.messaging_product === 'whatsapp' && body.status !== 'read') return sendInterakt(body);
          if (body?.status === 'read') return new Response('{"success":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
      }
    } catch (e) { console.error('interakt route', e.message); }
    return realFetch(input, init);
  };
}

/* ---- webhooks: Interakt -> Cloud API shape ---- */
async function hmacHex(secret, raw) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function interaktSignatureOk(env, req, raw) {
  const secret = String(env.SETTINGS?.wa?.interakt_secret || '').trim();
  if (!secret) return true; /* no secret saved: accept (Interakt sends the header only when a secret is set) */
  const got = String(req.headers.get('Interakt-Signature') || '');
  const want = 'sha256=' + (await hmacHex(secret, raw));
  return got.length === want.length && got === want;
}

const ts = (s) => String(Math.floor((Date.parse(String(s || '').replace(/(\.\d{3})\d*$/, '$1') + (/[zZ+]/.test(String(s || '').slice(-6)) ? '' : 'Z')) || Date.now()) / 1000));

/** One Interakt webhook -> one Cloud API webhook payload (or null when there's nothing for us). */
export function fromInterakt(j, phoneId) {
  const d = j?.data || {}, c = d.customer || {}, m = d.message || {};
  const from = String(c.channel_phone_number || c.phone_number || '').replace(/\D/g, '');
  const value = { messaging_product: 'whatsapp', metadata: { phone_number_id: String(phoneId || '') } };
  if (j?.type === 'message_received') {
    const kind = String(m.message_content_type || 'Text');
    let msg;
    const raw = typeof m.message === 'string' ? m.message : JSON.stringify(m.message || '');
    let parsed = null; try { parsed = JSON.parse(raw); } catch { /* plain text */ }
    if (/button|interactive/i.test(kind)) {
      const title = String(parsed?.title || parsed?.text || parsed?.button_text || raw || '');
      const payload = String(parsed?.payload || parsed?.id || parsed?.button_payload || title);
      msg = { type: 'button', button: { text: title, payload } };
    } else if (/image|video|document|audio|sticker/i.test(kind)) {
      const t = kind.toLowerCase().replace(/[^a-z]/g, '');
      msg = { type: 'text', text: { body: String(parsed?.caption || (typeof parsed === 'string' ? parsed : '') || `[${t}] ${m.media_url || ''}`).trim() } };
    } else msg = { type: 'text', text: { body: typeof parsed === 'string' ? parsed : raw } };
    value.contacts = [{ wa_id: from, profile: { name: String(c.traits?.name || '') } }];
    value.messages = [{ from, id: 'ik_' + String(m.id || Date.now()), timestamp: ts(m.received_at_utc || j.timestamp), ...msg }];
  } else {
    const st = { message_api_sent: 'sent', message_api_delivered: 'delivered', message_api_read: 'read', message_api_failed: 'failed',
      message_campaign_sent: 'sent', message_campaign_delivered: 'delivered', message_campaign_read: 'read', message_campaign_failed: 'failed' }[j?.type];
    if (!st || !m.id) return null;
    value.statuses = [{ id: String(m.id), status: st, timestamp: ts(m.seen_at_utc || m.delivered_at_utc || m.received_at_utc || j.timestamp), recipient_id: from,
      ...(st === 'failed' ? { errors: [{ code: Number(m.channel_error_code) || 0, title: String(m.channel_failure_reason || 'failed'), error_data: { details: String(m.channel_failure_reason || '') } }] } : {}) }];
  }
  return { object: 'whatsapp_business_account', entry: [{ id: 'interakt', changes: [{ field: 'messages', value }] }] };
}
