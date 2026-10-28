/**
 * Instagram comment -> DM. Someone comments "link" (or any keyword) on a reel / post: they get a private reply in
 * their DMs with that design's link, tracked as utm_source=instagram&utm_medium=dm&utm_content=<media id>, so the
 * orders show up as "Instagram comment DM" in the source reports. Optionally a short public reply under the comment.
 *
 * Instagram API with Instagram Login (graph.instagram.com), the business's own account: Standard Access, no App
 * Review needed. Permissions: instagram_business_basic, instagram_business_manage_comments,
 * instagram_business_manage_messages. Webhook field: comments. Meta allows one private reply per comment, within 7 days.
 *
 * Settings row 'ig' (never sent to the browser whole): { app_id, app_secret, verify_token, token, token_at, user_id,
 * username, on, mode: 'keywords'|'all', keywords: [], text, public_reply, public_text, default_url, media: { id: url },
 * hourly_cap }.
 * Table ig_dm: one row per comment (dedupe, log, and one DM per person per post).
 */
import { hmacSha256hex, safeEqual } from './util.js';

const now = () => Math.floor(Date.now() / 1000);
const GRAPH = 'https://graph.instagram.com/v21.0';
export const STORE = 'https://www.inkkulture.in';
export const SCOPES = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';
export const DEFAULTS = {
  on: false, mode: 'keywords',
  keywords: ['link', 'price', 'buy', 'order', 'want', 'need', 'details', 'dm', 'kitne', 'kaise', 'chahiye', 'kaha', 'where', 'how much', 'cost'],
  text: 'Hi {name} 🖤 Here is the link for this design: {link}\n\nCash on delivery available across India. Reply here if you have any question.',
  public_reply: true, public_text: 'Sent you the link in DM 📩', default_url: STORE, media: {}, hourly_cap: 150,
};

export async function igCfg(env) {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='ig'").first().catch(() => null);
  let v = {}; try { v = r ? JSON.parse(r.v) || {} : {}; } catch { v = {}; }
  return { ...DEFAULTS, ...v, media: v.media || {} };
}
export async function saveIg(env, patch) {
  const cur = await igCfg(env);
  const next = { ...cur, ...patch };
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('ig', ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v").bind(JSON.stringify(next)).run();
  return next;
}
export const callbackUrl = (env) => `${String(env.WORKER_URL || 'https://ik-checkout.vercel.app').replace(/\/$/, '')}/api/ig/callback`;
export const webhookUrl = (env) => `${String(env.WORKER_URL || 'https://ik-checkout.vercel.app').replace(/\/$/, '')}/api/ig/webhook`;

/* ---------------- pure helpers (tested) ---------------- */

/** Does this comment ask for the link? */
export function wantsLink(text, c) {
  const s = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ@ ]/g, ' ').replace(/\s+/g, ' ')} `;
  if (c.mode === 'all') return s.trim().length > 0;
  return (c.keywords || []).some((k) => { const w = String(k || '').toLowerCase().trim(); return w && s.includes(` ${w} `); });
}
/** The design link for a post, tagged so the order is credited to this post. */
export function linkFor(c, mediaId) {
  const base = String((c.media || {})[mediaId] || c.default_url || STORE).trim();
  const u = new URL(/^https?:\/\//.test(base) ? base : STORE + '/' + base.replace(/^\//, ''));
  u.searchParams.set('utm_source', 'instagram'); u.searchParams.set('utm_medium', 'dm');
  u.searchParams.set('utm_campaign', 'comment'); u.searchParams.set('utm_content', String(mediaId || ''));
  return u.toString();
}
export const fill = (t, v) => String(t || '').replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? String(v[k]) : ''));

/** Comment changes out of a webhook payload. */
export function commentsOf(payload) {
  const out = [];
  for (const e of payload?.entry || []) for (const ch of e.changes || []) {
    if (ch.field !== 'comments' || !ch.value) continue;
    const v = ch.value;
    out.push({ account: String(e.id || ''), id: String(v.id || ''), text: String(v.text || ''), from_id: String(v.from?.id || ''), username: String(v.from?.username || ''), media_id: String(v.media?.id || ''), parent: String(v.parent_id || '') });
  }
  return out.filter((c) => c.id);
}

/* ---------------- Instagram calls ---------------- */

async function ig(env, c, method, path, body) {
  const url = `${GRAPH}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(c.token)}`;
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message ? `${j.error.message} (${j.error.code || r.status})` : 'HTTP ' + r.status);
  return j;
}

/** Handle one comment: dedupe, decide, DM, optional public reply, log. */
export async function handleComment(env, c, cm) {
  if (!c.on || !c.token) return 'off';
  if (cm.from_id && (cm.from_id === c.user_id || cm.from_id === cm.account || (c.username && cm.username === c.username))) return 'own';
  const t = now();
  const claim = await env.DB.prepare(`INSERT INTO ig_dm (comment_id, media_id, from_id, username, text, status, created_at) VALUES (?,?,?,?,?,'new',?) ON CONFLICT (comment_id) DO NOTHING RETURNING comment_id`)
    .bind(cm.id, cm.media_id, cm.from_id, cm.username.slice(0, 60), cm.text.slice(0, 500), t).first();
  if (!claim) return 'dup';
  const set = (status, error = '') => env.DB.prepare('UPDATE ig_dm SET status=?, error=?, sent_at=? WHERE comment_id=?').bind(status, String(error).slice(0, 300), now(), cm.id).run();
  if (!wantsLink(cm.text, c)) { await set('no keyword'); return 'skip'; }
  const before = await env.DB.prepare("SELECT 1 AS x FROM ig_dm WHERE media_id=? AND from_id=? AND status='sent' AND comment_id<>? LIMIT 1").bind(cm.media_id, cm.from_id, cm.id).first();
  if (before) { await set('already sent on this post'); return 'skip'; }
  const hour = await env.DB.prepare("SELECT COUNT(*) AS n FROM ig_dm WHERE status='sent' AND sent_at>?").bind(t - 3600).first();
  if (Number(hour?.n) >= (Number(c.hourly_cap) || 150)) { await set('hourly cap reached'); return 'cap'; }
  const link = linkFor(c, cm.media_id);
  const name = cm.username ? '@' + cm.username : 'there';
  try {
    await ig(env, c, 'POST', `${c.user_id || 'me'}/messages`, { recipient: { comment_id: cm.id }, message: { text: fill(c.text, { name, link }) } });
    await set('sent');
  } catch (e) { await set('failed', e.message); return 'failed'; }
  if (c.public_reply && c.public_text) { try { await ig(env, c, 'POST', `${cm.id}/replies`, { message: fill(c.public_text, { name }) }); } catch (e) { console.error('ig public reply', e.message); } }
  return 'sent';
}

/** /api/ig/webhook (GET verify, POST events), /api/ig/callback (login). */
export async function handleIg(req, env, ctx) {
  const url = new URL(req.url);
  const c = await igCfg(env);
  if (url.pathname === '/api/ig/webhook' && req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && c.verify_token && url.searchParams.get('hub.verify_token') === c.verify_token;
    return new Response(ok ? url.searchParams.get('hub.challenge') || '' : 'forbidden', { status: ok ? 200 : 403 });
  }
  if (url.pathname === '/api/ig/webhook' && req.method === 'POST') {
    const raw = await req.text();
    const sig = String(req.headers.get('x-hub-signature-256') || '').replace(/^sha256=/, '');
    if (!c.app_secret || !safeEqual(sig, await hmacSha256hex(c.app_secret, raw))) return new Response('bad signature', { status: 401 });
    let payload = {}; try { payload = JSON.parse(raw); } catch { /* empty */ }
    const work = (async () => { for (const cm of commentsOf(payload)) await handleComment(env, c, cm).catch((e) => console.error('ig comment', e.message)); })();
    if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
    return new Response('ok');
  }
  if (url.pathname === '/api/ig/callback') return callback(env, c, url);
  return new Response('not found', { status: 404 });
}

/* ---------------- connect (Business Login for Instagram) ---------------- */

const stateSecret = (env) => env.ADMIN_SECRET || env.CRON_SECRET || 'ig|' + (env.DATABASE_URL || 'x');
export async function connectUrl(env) {
  const c = await igCfg(env);
  if (!c.app_id || !c.app_secret) throw new Error('Paste the Instagram app ID and app secret first');
  const t = String(now());
  const state = t + '.' + (await hmacSha256hex(stateSecret(env), 'igstate:' + t)).slice(0, 24);
  const u = new URL('https://www.instagram.com/oauth/authorize');
  u.searchParams.set('client_id', c.app_id); u.searchParams.set('redirect_uri', callbackUrl(env));
  u.searchParams.set('response_type', 'code'); u.searchParams.set('scope', SCOPES); u.searchParams.set('state', state);
  u.searchParams.set('enable_fb_login', '0'); u.searchParams.set('force_authentication', '1');
  return u.toString();
}
const page = (title, msg) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px system-ui;padding:32px;max-width:520px;margin:auto"><h2>${title}</h2><p>${msg}</p><p><a href="/admin#more">Back to the dashboard</a></p>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

async function callback(env, c, url) {
  const [t, mac] = String(url.searchParams.get('state') || '').split('.');
  const want = (await hmacSha256hex(stateSecret(env), 'igstate:' + t)).slice(0, 24);
  if (!t || !safeEqual(mac || '', want) || now() - Number(t) > 1800) return page('Link expired', 'Start again from the dashboard (More → Instagram DM → Connect).');
  if (url.searchParams.get('error')) return page('Not connected', String(url.searchParams.get('error_description') || url.searchParams.get('error')).slice(0, 200));
  const code = String(url.searchParams.get('code') || '').replace(/#_$/, '');
  try {
    const form = new URLSearchParams({ client_id: c.app_id, client_secret: c.app_secret, grant_type: 'authorization_code', redirect_uri: callbackUrl(env), code });
    const s = await (await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form })).json();
    const short = s.access_token || s.data?.[0]?.access_token;
    if (!short) throw new Error(s.error_message || s.error?.message || 'no token');
    const l = await (await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(c.app_secret)}&access_token=${encodeURIComponent(short)}`)).json();
    const token = l.access_token || short;
    const me = await (await fetch(`${GRAPH}/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`)).json();
    const next = await saveIg(env, { token, token_at: now(), user_id: String(me.user_id || me.id || s.user_id || ''), username: me.username || '' });
    /* the account sends its comment events to this app */
    let sub = '';
    try { await ig(env, next, 'POST', 'me/subscribed_apps?subscribed_fields=comments,messages'); sub = ' Comment events are switched on.'; } catch (e) { sub = ' Could not switch on comment events yet: ' + e.message; }
    return page('Instagram connected', `@${me.username || 'account'} is connected.${sub} Turn the auto-DM on in the dashboard.`);
  } catch (e) {
    return page('Not connected', String(e.message || e).slice(0, 300));
  }
}

/** Cron: long-lived tokens last 60 days; refresh weekly. */
export async function igRefresh(env) {
  const c = await igCfg(env);
  if (!c.token || now() - (c.token_at || 0) < 7 * 86400) return { skipped: true };
  const j = await (await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(c.token)}`)).json().catch(() => ({}));
  if (!j.access_token) return { error: j.error?.message || 'refresh failed' };
  await saveIg(env, { token: j.access_token, token_at: now() });
  return { refreshed: true };
}

/* ---------------- dashboard ---------------- */

export async function igDashboard(env) {
  const c = await igCfg(env);
  let media = [], mediaErr = '';
  if (c.token) {
    try { media = (await ig(env, c, 'GET', `${c.user_id || 'me'}/media?fields=id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp&limit=24`)).data || []; } catch (e) { mediaErr = e.message; }
  }
  const t = now();
  const stats = await env.DB.prepare(`SELECT media_id, COUNT(*) AS comments, SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent FROM ig_dm WHERE created_at>? GROUP BY media_id`).bind(t - 60 * 86400).all().then((r) => r.results).catch(() => []);
  const orders = await env.DB.prepare(`SELECT src_detail, COUNT(*) AS n, SUM(CASE WHEN state='delivered' THEN 1 ELSE 0 END) AS delivered, SUM(COALESCE(total_paise,0)) AS paise FROM rev_orders WHERE src='ig_dm' GROUP BY src_detail`).all().then((r) => r.results).catch(() => []);
  const recent = await env.DB.prepare('SELECT comment_id, media_id, username, text, status, error, created_at FROM ig_dm ORDER BY created_at DESC LIMIT 30').all().then((r) => r.results).catch(() => []);
  const byMedia = (id) => { const s = stats.find((x) => x.media_id === id) || {}; const o = orders.filter((x) => String(x.src_detail || '').includes(id)); return { comments: Number(s.comments) || 0, sent: Number(s.sent) || 0, orders: o.reduce((a, x) => a + Number(x.n), 0), delivered: o.reduce((a, x) => a + Number(x.delivered), 0) }; };
  return {
    ok: true,
    connected: !!c.token, username: c.username || '', has_app: !!(c.app_id && c.app_secret), app_id: c.app_id || '',
    verify_token: c.verify_token || '', webhook: webhookUrl(env), callback: callbackUrl(env),
    on: !!c.on, mode: c.mode, keywords: c.keywords, text: c.text, public_reply: !!c.public_reply, public_text: c.public_text, default_url: c.default_url, hourly_cap: c.hourly_cap,
    media: media.map((m) => ({ id: m.id, caption: String(m.caption || '').slice(0, 140), type: m.media_product_type || m.media_type, url: m.permalink, thumb: m.thumbnail_url || (m.media_type === 'IMAGE' ? m.media_url : '') || '', at: m.timestamp, link: c.media[m.id] || '', ...byMedia(m.id) })),
    media_error: mediaErr,
    totals: { comments: stats.reduce((a, x) => a + Number(x.comments), 0), sent: stats.reduce((a, x) => a + Number(x.sent), 0), orders: orders.reduce((a, x) => a + Number(x.n), 0), delivered: orders.reduce((a, x) => a + Number(x.delivered), 0), sales: Math.round(orders.reduce((a, x) => a + Number(x.paise), 0) / 100) },
    recent: recent.map((r) => ({ ...r, created_at: Number(r.created_at) })),
  };
}

/** Save from the dashboard. Secrets are only replaced when a new value is typed. */
export async function igSave(env, b) {
  const p = {};
  if (b.app_id !== undefined) p.app_id = String(b.app_id || '').replace(/\D/g, '');
  if (b.app_secret) p.app_secret = String(b.app_secret).trim();
  if (b.on !== undefined) p.on = !!b.on;
  if (b.mode) p.mode = b.mode === 'all' ? 'all' : 'keywords';
  if (b.keywords !== undefined) p.keywords = String(b.keywords).split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 60);
  if (b.text !== undefined) { if (!/\{link\}/.test(b.text)) throw new Error('The DM text needs {link}'); p.text = String(b.text).slice(0, 900); }
  if (b.public_reply !== undefined) p.public_reply = !!b.public_reply;
  if (b.public_text !== undefined) p.public_text = String(b.public_text).slice(0, 200);
  if (b.default_url !== undefined) p.default_url = String(b.default_url).trim() || STORE;
  if (b.hourly_cap !== undefined) p.hourly_cap = Math.max(10, Math.min(1000, Number(b.hourly_cap) || 150));
  if (b.media_id) { const cur = await igCfg(env); p.media = { ...cur.media, [String(b.media_id)]: String(b.link || '').trim() }; if (!p.media[b.media_id]) delete p.media[b.media_id]; }
  const cur = await igCfg(env);
  if (!cur.verify_token && !p.verify_token) p.verify_token = 'ik_' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
  if (p.on && !cur.token) throw new Error('Connect Instagram first');
  await saveIg(env, p);
  return igDashboard(env);
}
