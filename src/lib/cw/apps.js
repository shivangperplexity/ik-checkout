/**
 * One CodWing Shopify app per seller. Shopify lets a custom-distribution app go on one store only, so each seller
 * gets "CodWing – Brand" in our Dev Dashboard with its own client ID + secret. They live in cw_apps (secret sealed
 * with the vault key); the default app can also come from env (CW_SHOPIFY_API_KEY / CW_SHOPIFY_API_SECRET).
 * Which app a request is for:
 *   embedded admin page   ?app=<client id> in the App URL, else the app saved for ?shop=, else the default
 *   session token         its `aud` claim (the client id)
 *   webhooks              the app saved for the shop, else the default
 * Everything stored per shop (offline token, seller secrets) is sealed with the vault key, not an app secret, so it
 * does not matter which app a shop came through.
 */
import crypto from 'node:crypto';
import { seal, unseal, shopFromUrl } from './shopify.js';

export const APPS_DDL = [
  `CREATE TABLE IF NOT EXISTS cw_apps (client_id TEXT PRIMARY KEY, label TEXT, secret_box TEXT, shop TEXT, created_at BIGINT, updated_at BIGINT)`,
  `ALTER TABLE cw_shops ADD COLUMN IF NOT EXISTS app_key TEXT`,
];

/** The key everything at rest is sealed with. Changing it makes saved tokens unreadable (shops reinstall). */
export function vaultOf(env) {
  const base = env.CW_MASTER_KEY || env.CRON_SECRET || env.AGENT_KEY || '';
  return base ? crypto.createHash('sha256').update('codwing-vault-v1|' + base).digest('hex') : '';
}

export function defaultApp(env) {
  return env.CW_SHOPIFY_API_KEY ? { key: env.CW_SHOPIFY_API_KEY, secret: env.CW_SHOPIFY_API_SECRET || '' } : null;
}

const cache = new Map();
export async function appFor(env, clientId) {
  clientId = String(clientId || '').trim();
  if (!clientId) return null;
  const hit = cache.get(clientId);
  if (hit && hit.at > Date.now() - 60000) return hit.v;
  const d = defaultApp(env);
  let v = null;
  const row = env.DB ? await env.DB.prepare('SELECT * FROM cw_apps WHERE client_id = ?').bind(clientId).first().catch(() => null) : null;
  if (row?.secret_box) { try { v = { key: row.client_id, secret: unseal(row.secret_box, vaultOf(env)), label: row.label, shop: row.shop }; } catch { v = null; } }
  if (!v && d && d.key === clientId && d.secret) v = d;
  cache.set(clientId, { at: Date.now(), v });
  return v;
}

/** The app a shop uses: the one it installed through, else the one saved for it, else the default. */
export async function appForShop(env, shop) {
  shop = shopFromUrl(shop);
  if (shop && env.DB) {
    const s = await env.DB.prepare('SELECT app_key FROM cw_shops WHERE shop = ?').bind(shop).first().catch(() => null);
    if (s?.app_key) { const a = await appFor(env, s.app_key); if (a) return a; }
    const r = await env.DB.prepare('SELECT client_id FROM cw_apps WHERE shop = ? ORDER BY updated_at DESC LIMIT 1').bind(shop).first().catch(() => null);
    if (r) { const a = await appFor(env, r.client_id); if (a) return a; }
  }
  const d = defaultApp(env);
  return d ? await appFor(env, d.key) : null;
}

/** Read the client id from a session token without trusting it yet (it is verified with that app's secret after). */
export function peekAud(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).aud || ''; } catch { return ''; }
}

export async function saveApp(env, { client_id, secret, label, shop }) {
  const id = String(client_id || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error('Client ID should be 32 letters/numbers (copy it from the app page in the Dev Dashboard)');
  const sh = shop ? shopFromUrl(String(shop).includes('.') ? shop : shop + '.myshopify.com') : null;
  if (shop && !sh) throw new Error('Store should look like brand.myshopify.com');
  const vault = vaultOf(env);
  if (!vault) throw new Error('No vault key on the server');
  const t = Math.floor(Date.now() / 1000);
  const prev = await env.DB.prepare('SELECT * FROM cw_apps WHERE client_id = ?').bind(id).first();
  const sec = String(secret || '').trim();
  if (!prev && !sec) throw new Error('Paste the client secret');
  await env.DB.prepare(`INSERT INTO cw_apps (client_id, label, secret_box, shop, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (client_id) DO UPDATE SET label = EXCLUDED.label, secret_box = COALESCE(NULLIF(EXCLUDED.secret_box, ''), cw_apps.secret_box), shop = EXCLUDED.shop, updated_at = EXCLUDED.updated_at`)
    .bind(id, String(label || '').slice(0, 80), sec ? seal(sec, vault) : '', sh, t, t).run();
  cache.delete(id);
  return { client_id: id, label, shop: sh, app_url: `https://app.codwing.com/?app=${id}` };
}

export async function listApps(env) {
  const rows = (await env.DB.prepare('SELECT a.client_id, a.label, a.shop, a.created_at, s.installed_at, s.uninstalled_at FROM cw_apps a LEFT JOIN cw_shops s ON s.shop = a.shop ORDER BY a.created_at DESC').all()).results;
  const d = defaultApp(env);
  return { default_app: d ? { client_id: d.key, env_secret: !!d.secret } : null,
    apps: rows.map((r) => ({ client_id: r.client_id, label: r.label, shop: r.shop, app_url: `https://app.codwing.com/?app=${r.client_id}`, installed: !!(r.installed_at && !r.uninstalled_at), created_at: Number(r.created_at) })) };
}
