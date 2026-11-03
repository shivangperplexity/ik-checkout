/**
 * CodWing app routes (served from app.codwing.com, inside Shopify admin):
 *   GET  /api/cw/app        the embedded admin page (also app.codwing.com/)
 *   GET  /api/cw/me         shop + settings (secrets masked); first call also installs (token exchange)
 *   POST /api/cw/settings   save settings; secret fields are sealed, blank secret = keep the stored one
 *   POST /api/cw/webhooks   app/uninstalled + the three mandatory compliance topics
 *   GET  /api/cw/health
 * Tables live beside IK Checkout's in the same database, all prefixed cw_.
 */
import { cwCfg, verifySessionToken, exchangeToken, verifyWebhook, seal, unseal, shopFromUrl } from './shopify.js';
import { PAGE } from './page.js';

const DDL = [
  `CREATE TABLE IF NOT EXISTS cw_shops (shop TEXT PRIMARY KEY, token_box TEXT, scopes TEXT, installed_at BIGINT, uninstalled_at BIGINT, settings TEXT, secrets_box TEXT, updated_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS cw_events (id SERIAL PRIMARY KEY, shop TEXT, topic TEXT, at BIGINT, body TEXT)`,
];
let ddlDone;
async function ready(env) {
  ddlDone ||= (async () => { for (const s of DDL) await env.DB.prepare(s).run(); })().catch((e) => { ddlDone = null; throw e; });
  return ddlDone;
}

const now = () => Math.floor(Date.now() / 1000);
const json = (o, status = 200, h = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...h } });

/* What a seller can set. `secret` fields are never sent back, only whether they are set. */
export const FIELDS = {
  gateway: { type: 'enum', values: ['none', 'razorpay', 'payu'], def: 'none' },
  razorpay_key_id: { type: 'text' }, razorpay_key_secret: { type: 'secret' },
  payu_key: { type: 'text' }, payu_salt: { type: 'secret' },
  wa_phone_id: { type: 'text' }, wa_waba_id: { type: 'text' }, wa_token: { type: 'secret' },
  pixel_id: { type: 'text' }, capi_token: { type: 'secret' },
  cod_on: { type: 'bool', def: true },
  cod_otp: { type: 'bool', def: true },
  prepaid_discount: { type: 'int', min: 0, max: 5000, def: 50 },
  partial_advance: { type: 'int', min: 0, max: 5000, def: 0 },
  partial_states: { type: 'text', def: '' },
  cod_max: { type: 'int', min: 0, max: 100000, def: 0 },
  support_email: { type: 'text' }, support_phone: { type: 'text' },
};

/** Pure: clean a posted settings object. Returns { settings, secrets } with only known fields. */
export function cleanSettings(input, prevSettings = {}) {
  const settings = { ...prevSettings }; const secrets = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    if (!(k in (input || {}))) continue;
    const v = input[k];
    if (f.type === 'secret') { const s = String(v ?? '').trim(); if (s) secrets[k] = s.slice(0, 500); continue; }
    if (f.type === 'bool') settings[k] = v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
    else if (f.type === 'int') { const n = Math.round(Number(v)); settings[k] = Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.def; }
    else if (f.type === 'enum') settings[k] = f.values.includes(v) ? v : f.def;
    else settings[k] = String(v ?? '').trim().slice(0, 200);
  }
  if (settings.partial_states) settings.partial_states = settings.partial_states.toUpperCase().split(/[^A-Z]+/).filter((s) => s.length === 2).join(',');
  return { settings, secrets };
}

function defaults() { const o = {}; for (const [k, f] of Object.entries(FIELDS)) if ('def' in f) o[k] = f.def; return o; }

async function getShop(env, shop) {
  return env.DB.prepare('SELECT * FROM cw_shops WHERE shop = ?').bind(shop).first();
}

/** Verify the session token; on a shop's first request (or after reinstall), get and store an offline token. */
async function authed(req, env) {
  const cfg = cwCfg(env);
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') || '');
  if (!m) throw Object.assign(new Error('no session'), { status: 401 });
  let s;
  try { s = verifySessionToken(m[1], cfg); } catch (e) { throw Object.assign(new Error('session: ' + e.message), { status: 401 }); }
  await ready(env);
  let row = await getShop(env, s.shop);
  if (!row || !row.token_box || row.uninstalled_at) {
    const t = await exchangeToken(s.shop, m[1], cfg);
    await env.DB.prepare(`INSERT INTO cw_shops (shop, token_box, scopes, installed_at, uninstalled_at, settings, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT (shop) DO UPDATE SET token_box = EXCLUDED.token_box, scopes = EXCLUDED.scopes, installed_at = EXCLUDED.installed_at, uninstalled_at = NULL, updated_at = EXCLUDED.updated_at`)
      .bind(s.shop, seal(t.token, cfg.secret), t.scope, now(), JSON.stringify(defaults()), now()).run();
    row = await getShop(env, s.shop);
  }
  return { shop: s.shop, row, cfg };
}

function view(row, cfg) {
  const settings = { ...defaults(), ...JSON.parse(row.settings || '{}') };
  let secrets = {}; try { secrets = row.secrets_box ? JSON.parse(unseal(row.secrets_box, cfg.secret)) : {}; } catch { /* key rotated: treat as unset */ }
  const set = {}; for (const [k, f] of Object.entries(FIELDS)) if (f.type === 'secret') set[k] = !!secrets[k];
  return { shop: row.shop, installed_at: row.installed_at, scopes: row.scopes, settings, secrets_set: set };
}

export async function handleCw(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const cfg = cwCfg(env);
  if (path === '/api/cw/health') return json({ ok: true, configured: !!(cfg.key && cfg.secret), db: !!env.DB });
  if (path === '/api/cw/app' || path === '/api/cw/') {
    const shop = shopFromUrl(url.searchParams.get('shop'));
    const ancestors = shop ? `https://${shop} https://admin.shopify.com` : 'https://admin.shopify.com https://*.myshopify.com';
    return new Response(PAGE.replace('__API_KEY__', cfg.key), { headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `frame-ancestors ${ancestors};`,
    } });
  }
  if (path === '/api/cw/webhooks' && req.method === 'POST') {
    const raw = await req.text();
    if (!verifyWebhook(raw, req.headers.get('X-Shopify-Hmac-Sha256'), cfg.secret)) return new Response('unauthorized', { status: 401 });
    const topic = req.headers.get('X-Shopify-Topic') || '';
    const shop = shopFromUrl(req.headers.get('X-Shopify-Shop-Domain'));
    await ready(env);
    await env.DB.prepare('INSERT INTO cw_events (shop, topic, at, body) VALUES (?, ?, ?, ?)').bind(shop, topic, now(), raw.slice(0, 4000)).run();
    if (topic === 'app/uninstalled' && shop) await env.DB.prepare('UPDATE cw_shops SET token_box = NULL, uninstalled_at = ?, updated_at = ? WHERE shop = ?').bind(now(), now(), shop).run();
    /* shop/redact arrives 48 h after uninstall: delete everything we hold for the shop */
    if (topic === 'shop/redact' && shop) await env.DB.prepare('DELETE FROM cw_shops WHERE shop = ?').bind(shop).run();
    /* customers/data_request and customers/redact: CodWing keeps no buyer records of its own yet; logged above */
    return new Response('ok');
  }
  if (!cfg.key || !cfg.secret) return json({ ok: false, error: 'CodWing is not configured yet' }, 503);
  try {
    if (path === '/api/cw/me' && req.method === 'GET') {
      const a = await authed(req, env);
      return json({ ok: true, ...view(a.row, a.cfg) });
    }
    if (path === '/api/cw/settings' && req.method === 'POST') {
      const a = await authed(req, env);
      const body = await req.json().catch(() => ({}));
      const { settings, secrets } = cleanSettings(body, JSON.parse(a.row.settings || '{}'));
      let prev = {}; try { prev = a.row.secrets_box ? JSON.parse(unseal(a.row.secrets_box, a.cfg.secret)) : {}; } catch { prev = {}; }
      for (const k of body.clear || []) if (FIELDS[k]?.type === 'secret') delete prev[k];
      const box = seal(JSON.stringify({ ...prev, ...secrets }), a.cfg.secret);
      await env.DB.prepare('UPDATE cw_shops SET settings = ?, secrets_box = ?, updated_at = ? WHERE shop = ?').bind(JSON.stringify(settings), box, now(), a.shop).run();
      return json({ ok: true, ...view(await getShop(env, a.shop), a.cfg) });
    }
  } catch (e) {
    console.error('cw', path, e.message);
    return json({ ok: false, error: e.status === 401 ? 'Please reopen CodWing from your Shopify admin.' : 'Something went wrong. Please try again.' }, e.status || 500);
  }
  return json({ ok: false, error: 'not found' }, 404);
}
