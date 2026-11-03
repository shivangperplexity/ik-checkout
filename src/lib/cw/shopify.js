/**
 * CodWing (multi-seller Shopify app): Shopify auth helpers.
 *  - session tokens: App Bridge puts an HS256 JWT in the Authorization header of every fetch from the embedded admin
 *    page; we verify it with the app's client secret and read the shop from `dest`.
 *  - token exchange: the first verified request swaps the session token for an offline Admin API token
 *    (Shopify-managed install, no OAuth redirects).
 *  - webhook HMAC: base64 HMAC-SHA256 of the raw body with the client secret.
 *  - secrets at rest: AES-256-GCM with a key derived from the client secret (no extra secret to manage).
 */
import crypto from 'node:crypto';

export const API_VERSION = '2026-10';

export function cwCfg(env) {
  return { key: env.CW_SHOPIFY_API_KEY || '', secret: env.CW_SHOPIFY_API_SECRET || '' };
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Verify an App Bridge session token. Returns { shop, sub, payload } or throws. Pure apart from Date.now. */
export function verifySessionToken(token, { key, secret }, now = Math.floor(Date.now() / 1000)) {
  if (!token || !secret) throw new Error('missing token');
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const [h, p, s] = parts;
  const want = crypto.createHmac('sha256', secret).update(h + '.' + p).digest();
  const got = unb64url(s);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new Error('bad signature');
  const header = JSON.parse(unb64url(h).toString('utf8'));
  if (header.alg !== 'HS256') throw new Error('bad alg');
  const payload = JSON.parse(unb64url(p).toString('utf8'));
  if (key && payload.aud !== key) throw new Error('bad audience');
  if (payload.exp && now > payload.exp + 5) throw new Error('expired');
  if (payload.nbf && now < payload.nbf - 5) throw new Error('not yet valid');
  const shop = shopFromUrl(payload.dest);
  if (!shop || shopFromUrl(payload.iss) !== shop) throw new Error('bad shop');
  return { shop, sub: payload.sub, payload };
}

/** "https://x.myshopify.com" or "x.myshopify.com/admin" -> "x.myshopify.com"; anything else -> null. */
export function shopFromUrl(u) {
  const m = /^(?:https?:\/\/)?([a-z0-9][a-z0-9-]*\.myshopify\.com)(?:\/|$)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : null;
}

export function verifyWebhook(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const want = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const got = Buffer.from(String(hmacHeader), 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Make a JWT the way App Bridge does; used by tests and local checks only. */
export function signSessionToken(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  return h + '.' + p + '.' + b64url(crypto.createHmac('sha256', secret).update(h + '.' + p).digest());
}

export async function exchangeToken(shop, sessionToken, { key, secret }, fetchImpl = fetch) {
  const r = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: key, client_secret: secret,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('token exchange failed: ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  return { token: j.access_token, scope: j.scope || '' };
}

export async function adminGraphql(shop, token, query, variables = {}, fetchImpl = fetch) {
  const r = await fetchImpl(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error('admin api ' + r.status + ' ' + JSON.stringify(j.errors || j).slice(0, 300));
  return j.data;
}

const keyOf = (secret) => crypto.createHash('sha256').update('codwing-secrets-v1:' + secret).digest();

export function seal(plain, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'v1.' + b64url(iv) + '.' + b64url(enc) + '.' + b64url(c.getAuthTag());
}

export function unseal(box, secret) {
  if (!box) return '';
  const [v, iv, enc, tag] = String(box).split('.');
  if (v !== 'v1') throw new Error('bad box');
  const d = crypto.createDecipheriv('aes-256-gcm', keyOf(secret), unb64url(iv));
  d.setAuthTag(unb64url(tag));
  return Buffer.concat([d.update(unb64url(enc)), d.final()]).toString('utf8');
}
