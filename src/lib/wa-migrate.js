/**
 * After the business moves its number out of a partner-owned WhatsApp account into one it owns:
 * find that account, switch the dashboard to it, link the app, and copy the checkout's templates across.
 * Template copying is done a few at a time (call repeatedly until done) to stay inside the function time limit.
 */
const GRAPH = 'https://graph.facebook.com/v21.0';
const digits = (s) => String(s || '').replace(/\D/g, '');

async function g(env, path, opts = {}) {
  const res = await fetch(`${GRAPH}/${path}`, { ...opts, headers: { Authorization: `Bearer ${env.WA_TOKEN}`, ...(opts.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error?.error_user_msg || j.error?.message || 'HTTP ' + res.status);
  return j;
}

/** Every WhatsApp account the saved token can reach, with its numbers. */
export async function accessibleAccounts(env) {
  const d = (await g(env, `debug_token?input_token=${encodeURIComponent(env.WA_TOKEN)}`)).data || {};
  const ids = new Set();
  for (const s of d.granular_scopes || []) if (/^whatsapp_business_/.test(s.scope)) (s.target_ids || []).forEach((i) => ids.add(String(i)));
  const out = [];
  for (const id of ids) {
    const acc = { id, name: '', numbers: [] };
    try { acc.name = (await g(env, `${id}?fields=name`)).name || ''; } catch { /* name hidden */ }
    try { acc.numbers = ((await g(env, `${id}/phone_numbers?fields=id,display_phone_number,verified_name,status,platform_type`)).data || []); } catch (e) { acc.error = e.message; }
    out.push(acc);
  }
  return { appId: String(d.app_id || ''), accounts: out };
}

/** The checkout's own templates (the ones worth copying). */
export const CHECKOUT_TEMPLATES = ['cod_order_confirm', 'cod_to_prepaid', 'checkout_reminder', 'checkout_reminder_commitment', 'checkout_reminder_ghosted', 'checkout_reminder_softlaunch', 'checkout_reminder_talkstage', 'checkout_reminder_redflag', 'checkout_reminder_regret', 'checkout_reminder_overthink'];

/* Image headers need a fresh upload handle in the new account (Resumable Upload API). */
async function imageHandle(env, appId, url) {
  const img = await fetch(url);
  if (!img.ok) throw new Error('could not download sample image');
  const type = (img.headers.get('content-type') || 'image/jpeg').split(';')[0];
  const buf = new Uint8Array(await img.arrayBuffer());
  const sess = await g(env, `${appId}/uploads?file_name=header.${type.includes('png') ? 'png' : 'jpg'}&file_length=${buf.length}&file_type=${encodeURIComponent(type)}`, { method: 'POST' });
  const res = await fetch(`${GRAPH}/${sess.id}`, { method: 'POST', headers: { Authorization: `OAuth ${env.WA_TOKEN}`, file_offset: '0' }, body: buf });
  const j = await res.json().catch(() => ({}));
  if (!j.h) throw new Error('image upload failed: ' + (j.error?.message || res.status));
  return j.h;
}

/** Copy up to `max` missing checkout templates from one account to another. */
export async function copyTemplates(env, { from, to, appId, fallbackImage, max = 3 }) {
  const fields = 'name,language,category,status,parameter_format,components';
  const src = ((await g(env, `${from}/message_templates?fields=${fields}&limit=200`)).data || []).filter((t) => t.status === 'APPROVED' && CHECKOUT_TEMPLATES.includes(t.name));
  const have = new Set(((await g(env, `${to}/message_templates?fields=name,language&limit=200`)).data || []).map((t) => t.name + '|' + t.language));
  const todo = src.filter((t) => !have.has(t.name + '|' + t.language));
  const done = [];
  for (const t of todo.slice(0, max)) {
    try {
      const components = [];
      for (const c of t.components || []) {
        const x = { ...c };
        if (x.type === 'HEADER' && x.format === 'IMAGE') {
          const sample = x.example?.header_handle?.[0] || fallbackImage;
          let h;
          try { h = await imageHandle(env, appId, sample); } catch (e) { if (!fallbackImage || sample === fallbackImage) throw e; h = await imageHandle(env, appId, fallbackImage); }
          x.example = { header_handle: [h] };
        }
        components.push(x);
      }
      const body = { name: t.name, language: t.language, category: t.category, components };
      if (t.parameter_format) body.parameter_format = t.parameter_format;
      const r = await g(env, `${to}/message_templates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      done.push({ name: t.name, status: r.status || 'PENDING' });
    } catch (e) {
      done.push({ name: t.name, status: 'FAILED', error: e.message });
    }
  }
  return { copied: done, remaining: Math.max(0, todo.length - Math.min(max, todo.length)), total: src.length };
}

/** Full content of templates in one account (for writing new ones in the same format). */
export async function templateDetails(env, waba, names = []) {
  const rows = (await g(env, `${waba}/message_templates?fields=name,language,category,status,parameter_format,components&limit=200`)).data || [];
  return rows.filter((t) => !names.length || names.includes(t.name));
}

/**
 * Submit one new template. An IMAGE header needs a sample upload handle; `sampleImage` (a public URL) is uploaded
 * through the app's Resumable Upload session. Returns Meta's { id, status, category }.
 */
export async function createTemplate(env, { waba, appId, tpl, sampleImage }) {
  const components = [];
  for (const c of tpl.components || []) {
    const x = { ...c };
    if (x.type === 'HEADER' && x.format === 'IMAGE') x.example = { header_handle: [await imageHandle(env, appId, sampleImage)] };
    components.push(x);
  }
  const body = { name: tpl.name, language: tpl.language || 'en', category: tpl.category || 'MARKETING', components };
  if (tpl.parameter_format) body.parameter_format = tpl.parameter_format;
  return g(env, `${waba}/message_templates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
