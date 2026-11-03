/**
 * CodWing app routes (served from app.codwing.com, inside Shopify admin):
 *   GET  /api/cw/app        the embedded admin page (also app.codwing.com/)
 *   GET  /api/cw/me         shop + settings (secrets masked); first call also installs (token exchange)
 *   POST /api/cw/settings   save settings; secret fields are sealed, blank secret = keep the stored one
 *   POST /api/cw/webhooks   app/uninstalled + the three mandatory compliance topics
 *   GET  /api/cw/health
 * Tables live beside IK Checkout's in the same database, all prefixed cw_.
 */
import { cwCfg, verifySessionToken, exchangeToken, verifyWebhook, seal, unseal, shopFromUrl, adminGraphql } from './shopify.js';
import { PAGE } from './page.js';
import { STORE_DDL, handleStore, forget, sj, DEMO, seller } from './store.js';
import { SHIP_DDL, unshippedOrders, ratesFor, pickCourier, book, labels, srPickups, shipReady, trackUrl } from './ship.js';
import { followUpText, STEPS, onlineReady, waReady } from './pricing.js';

const DDL = [
  `CREATE TABLE IF NOT EXISTS cw_shops (shop TEXT PRIMARY KEY, token_box TEXT, scopes TEXT, installed_at BIGINT, uninstalled_at BIGINT, settings TEXT, secrets_box TEXT, updated_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS cw_events (id SERIAL PRIMARY KEY, shop TEXT, topic TEXT, at BIGINT, body TEXT)`,
  ...STORE_DDL,
  ...SHIP_DDL,
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
  payu_key: { type: 'text' }, payu_salt: { type: 'secret' }, payu_test: { type: 'bool', def: false },
  wa_phone_id: { type: 'text' }, wa_waba_id: { type: 'text' }, wa_token: { type: 'secret' },
  pixel_id: { type: 'text' }, capi_token: { type: 'secret' },
  cod_on: { type: 'bool', def: true },
  cod_otp: { type: 'bool', def: true },
  prepaid_discount: { type: 'int', min: 0, max: 5000, def: 50 },
  partial_advance: { type: 'int', min: 0, max: 5000, def: 0 },
  partial_states: { type: 'text', def: '' },
  cod_max: { type: 'int', min: 0, max: 100000, def: 0 },
  cod_fee: { type: 'int', min: 0, max: 500, def: 0 },
  sheet_on: { type: 'bool', def: true },
  open_on_add: { type: 'bool', def: false },
  brand_color: { type: 'text', def: '#111111' },
  wa_otp_template: { type: 'text', def: 'codwing_otp' },
  support_email: { type: 'text' }, support_phone: { type: 'text' },
  ship_provider: { type: 'enum', values: ['none', 'shiprocket', 'shipprime'], def: 'none' },
  sr_email: { type: 'text' }, sr_password: { type: 'secret' }, sr_pickup: { type: 'text' }, sp_token: { type: 'secret' },
  pickup_phone: { type: 'text' }, pickup_address1: { type: 'text' }, pickup_address2: { type: 'text' }, pickup_city: { type: 'text' }, pickup_state: { type: 'text' }, pickup_pin: { type: 'text' },
  pkg_weight_g: { type: 'int', min: 10, max: 30000, def: 300 }, pkg_extra_g: { type: 'int', min: 0, max: 5000, def: 0 },
  pkg_l: { type: 'int', min: 1, max: 200, def: 20 }, pkg_b: { type: 'int', min: 1, max: 200, def: 15 }, pkg_h: { type: 'int', min: 1, max: 200, def: 5 },
  ship_rule: { type: 'enum', values: ['rto', 'cheapest', 'fastest'], def: 'rto' },
  ship_max_extra: { type: 'int', min: 0, max: 500, def: 15 },
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
  if ('brand_color' in settings && !/^#[0-9a-f]{6}$/i.test(settings.brand_color)) settings.brand_color = '#111111';
  if ('wa_otp_template' in settings) settings.wa_otp_template = settings.wa_otp_template.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 60) || 'codwing_otp';
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
    /* app/uninstalled -> clear the token (Dev Dashboard apps have no webhook form; subscribe per shop) */
    adminGraphql(s.shop, t.token, `mutation { webhookSubscriptionCreate(topic: APP_UNINSTALLED, webhookSubscription: { uri: "https://app.codwing.com/api/cw/webhooks" }) { userErrors { message } } }`)
      .catch((e) => console.warn('cw webhook', s.shop, e.message));
    try {
      const d = await adminGraphql(s.shop, t.token, '{ shop { name primaryDomain { url } } }');
      await env.DB.prepare('UPDATE cw_shops SET name = ?, domain = ? WHERE shop = ?').bind(d.shop.name, d.shop.primaryDomain?.url || null, s.shop).run();
    } catch (e) { console.warn('cw shop info', s.shop, e.message); }
    row = await getShop(env, s.shop);
  }
  return { shop: s.shop, row, cfg };
}

function view(row, cfg) {
  const settings = { ...defaults(), ...JSON.parse(row.settings || '{}') };
  let secrets = {}; try { secrets = row.secrets_box ? JSON.parse(unseal(row.secrets_box, cfg.secret)) : {}; } catch { /* key rotated: treat as unset */ }
  const set = {}; for (const [k, f] of Object.entries(FIELDS)) if (f.type === 'secret') set[k] = !!secrets[k];
  return { shop: row.shop, name: row.name || row.shop, domain: row.domain || 'https://' + row.shop, installed_at: row.installed_at, scopes: row.scopes, settings, secrets_set: set,
    ready: { online: onlineReady(settings, set), whatsapp: waReady(settings, set), pixel: !!settings.pixel_id, cod: settings.cod_on !== false, shipping: shipReady(settings, set) } };
}

const STORE_ROUTES = new Set(['cfg', 'track', 'pin', 'quote', 'otp', 'order', 'paid', 'restore', 'payu_return']);
const SF_URL = 'https://app.codwing.com/sf.js';

export const OTP_TEMPLATE_BODY = (name) => ({
  name, language: 'en', category: 'AUTHENTICATION',
  components: [
    { type: 'BODY', add_security_recommendation: true },
    { type: 'FOOTER', code_expiration_minutes: 10 },
    { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
  ],
});

/** Dashboard numbers for one shop: funnel, live visitors, abandoned checkouts with a WhatsApp follow-up, orders. */
async function stats(env, shop, row, days) {
  const t = now(), since = t - days * 86400;
  const steps = (await env.DB.prepare('SELECT step, COUNT(*) AS n FROM cw_sessions WHERE shop = ? AND last_at >= ? GROUP BY step').bind(shop, since).all()).results;
  const funnel = STEPS.map((name, i) => ({ name, n: steps.filter((r) => Number(r.step) >= i + 1).reduce((x, r) => x + Number(r.n), 0) }));
  const live = (await env.DB.prepare('SELECT sid, step, name, city, value, last_at FROM cw_sessions WHERE shop = ? AND last_at >= ? AND order_name IS NULL ORDER BY last_at DESC LIMIT 30').bind(shop, t - 300).all()).results
    .map((r) => ({ step: STEPS[Number(r.step) - 1] || 'visit', name: r.name || '', city: r.city || '', value: Number(r.value) || 0, ago: t - Number(r.last_at) }));
  const domain = (row.domain || 'https://' + shop).replace(/\/$/, '');
  const store = row.name || shop.replace('.myshopify.com', '');
  const ab = (await env.DB.prepare(`SELECT sid, phone, name, city, cart, value, step, last_at, contacted_at FROM cw_sessions
      WHERE shop = ? AND phone IS NOT NULL AND order_name IS NULL AND last_at >= ? AND last_at < ? ORDER BY last_at DESC LIMIT 100`).bind(shop, since, t - 900).all()).results
    .map((r) => {
      const items = JSON.parse(r.cart || '[]');
      const link = `${domain}/?cwr=${r.sid}`;
      return { sid: r.sid, phone: r.phone, name: r.name || '', city: r.city || '', value: Number(r.value) || 0, step: STEPS[Number(r.step) - 1] || 'visit', at: Number(r.last_at), contacted_at: r.contacted_at ? Number(r.contacted_at) : null,
        items: items.map((i) => ({ t: i.t, q: i.q })), wa: `https://wa.me/91${r.phone}?text=${encodeURIComponent(followUpText({ name: r.name, items, store, link }))}` };
    });
  const om = (await env.DB.prepare('SELECT method, status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS v FROM cw_orders WHERE shop = ? AND created_at >= ? GROUP BY method, status').bind(shop, since).all()).results;
  const recent = (await env.DB.prepare('SELECT method, status, total, paid, order_name, error, created_at FROM cw_orders WHERE shop = ? ORDER BY id DESC LIMIT 20').bind(shop).all()).results
    .map((r) => ({ method: r.method, status: r.status, total: Number(r.total), paid: Number(r.paid), name: r.order_name || '', error: r.error || '', at: Number(r.created_at) }));
  const placed = om.filter((r) => r.status === 'placed');
  const orders = { count: placed.reduce((x, r) => x + Number(r.n), 0), value: placed.reduce((x, r) => x + Number(r.v), 0),
    by: Object.fromEntries(['online', 'cod', 'partial'].map((m) => [m, placed.filter((r) => r.method === m).reduce((x, r) => x + Number(r.n), 0)])),
    stuck: om.filter((r) => r.status === 'paid_no_order').reduce((x, r) => x + Number(r.n), 0) };
  return { days, funnel, live, abandoned: ab, orders, recent };
}

export async function handleCw(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const cfg = cwCfg(env);
  const name = path.slice('/api/cw/'.length);
  if (path === '/api/cw/health') return json({ ok: true, configured: !!(cfg.key && cfg.secret), db: !!env.DB });
  if (path === '/api/cw/app' || path === '/api/cw/') {
    const shop = shopFromUrl(url.searchParams.get('shop'));
    const ancestors = shop ? `https://${shop} https://admin.shopify.com` : 'https://admin.shopify.com https://*.myshopify.com';
    const demo = url.searchParams.get('demo') === '1';
    const html = (demo ? PAGE.replace(/<!--AB-->[\s\S]*?<!--\/AB-->/, '') : PAGE).replace('__API_KEY__', cfg.key);
    return new Response(html, { headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `frame-ancestors ${ancestors};`,
    } });
  }
  if (STORE_ROUTES.has(name)) {
    const isDemo = req.method === 'GET' || name === 'payu_return' ? url.searchParams.get('shop') === DEMO : true;
    if ((!cfg.secret || !env.DB) && !(isDemo || name === 'pin')) return sj({ ok: false, error: 'not configured' }, 503);
    try {
      if (env.DB && cfg.secret) await ready(env);
      return await handleStore(req, env, path, { secret: cfg.secret, view: (row) => view(row, cfg), origin: url.host.endsWith('codwing.com') ? url.origin : 'https://app.codwing.com' });
    } catch (e) { console.error('cw store', name, e.message); return sj({ ok: false, error: 'Something went wrong. Please try again.' }, 500); }
  }
  if (path === '/api/cw/webhooks' && req.method === 'POST') {
    const raw = await req.text();
    if (!verifyWebhook(raw, req.headers.get('X-Shopify-Hmac-Sha256'), cfg.secret)) return new Response('unauthorized', { status: 401 });
    const topic = req.headers.get('X-Shopify-Topic') || '';
    const shop = shopFromUrl(req.headers.get('X-Shopify-Shop-Domain'));
    await ready(env);
    await env.DB.prepare('INSERT INTO cw_events (shop, topic, at, body) VALUES (?, ?, ?, ?)').bind(shop, topic, now(), raw.slice(0, 4000)).run();
    if (topic === 'app/uninstalled' && shop) { forget(shop); await env.DB.prepare('UPDATE cw_shops SET token_box = NULL, uninstalled_at = ?, updated_at = ? WHERE shop = ?').bind(now(), now(), shop).run(); }
    /* shop/redact arrives 48 h after uninstall: delete everything we hold for the shop */
    if (topic === 'shop/redact' && shop) {
      for (const tb of ['cw_shops', 'cw_sessions', 'cw_orders', 'cw_otps']) await env.DB.prepare(`DELETE FROM ${tb} WHERE shop = ?`).bind(shop).run();
    }
    /* customers/redact: drop that buyer's saved checkout sessions and codes */
    if (topic === 'customers/redact' && shop) {
      let phone = null; try { phone = String(JSON.parse(raw).customer?.phone || '').replace(/\D/g, '').slice(-10) || null; } catch { /* ignore */ }
      if (phone) { await env.DB.prepare('DELETE FROM cw_sessions WHERE shop = ? AND phone = ?').bind(shop, phone).run(); await env.DB.prepare('DELETE FROM cw_otps WHERE shop = ? AND phone = ?').bind(shop, phone).run(); }
    }
    return new Response('ok');
  }
  if (!cfg.key || !cfg.secret) return json({ ok: false, error: 'CodWing is not configured yet' }, 503);
  try {
    if (path === '/api/cw/me' && req.method === 'GET') {
      const a = await authed(req, env);
      const seen = await env.DB.prepare('SELECT 1 AS x FROM cw_sessions WHERE shop = ? LIMIT 1').bind(a.shop).first();
      return json({ ok: true, ...view(a.row, a.cfg), installed: !!seen, sf_url: `${SF_URL}?shop=${a.shop}` });
    }
    if (path === '/api/cw/stats' && req.method === 'GET') {
      const a = await authed(req, env);
      const days = [1, 7, 30].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 1;
      return json({ ok: true, ...(await stats(env, a.shop, a.row, days)) });
    }
    if (path === '/api/cw/contacted' && req.method === 'POST') {
      const a = await authed(req, env);
      const b = await req.json().catch(() => ({}));
      await env.DB.prepare('UPDATE cw_sessions SET contacted_at = ? WHERE shop = ? AND sid = ?').bind(now(), a.shop, String(b.sid || '').slice(0, 64)).run();
      return json({ ok: true });
    }
    if (path === '/api/cw/install' && req.method === 'POST') {
      const a = await authed(req, env);
      const src = `${SF_URL}?shop=${a.shop}`;
      const token = unseal(a.row.token_box, a.cfg.secret);
      try {
        const d = await adminGraphql(a.shop, token, '{ scriptTags(first: 20) { nodes { id src } } }');
        if (d.scriptTags.nodes.some((n) => n.src.startsWith(SF_URL))) return json({ ok: true, already: true, src });
        const r = await adminGraphql(a.shop, token, 'mutation($i: ScriptTagInput!) { scriptTagCreate(input: $i) { scriptTag { id } userErrors { message } } }', { i: { src, displayScope: 'ONLINE_STORE', cache: false } });
        const e = r.scriptTagCreate.userErrors; if (e?.length) throw new Error(e.map((x) => x.message).join('; '));
        return json({ ok: true, src });
      } catch (e) {
        console.warn('cw install', a.shop, e.message);
        return json({ ok: false, src, error: 'Could not add it automatically. Paste the line below into your theme instead.' });
      }
    }
    if (path === '/api/cw/wa_template' && req.method === 'POST') {
      const a = await authed(req, env);
      const v = view(a.row, a.cfg);
      let secrets = {}; try { secrets = a.row.secrets_box ? JSON.parse(unseal(a.row.secrets_box, a.cfg.secret)) : {}; } catch { secrets = {}; }
      if (!v.settings.wa_waba_id || !secrets.wa_token) return json({ ok: false, error: 'Add your WhatsApp Business Account ID and access token first, then save.' });
      const r = await fetch(`https://graph.facebook.com/v21.0/${v.settings.wa_waba_id}/message_templates`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secrets.wa_token}` }, body: JSON.stringify(OTP_TEMPLATE_BODY(v.settings.wa_otp_template || 'codwing_otp')) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return json({ ok: false, error: /already exists|duplicate/i.test(j.error?.message || '') ? 'The code template already exists in your WhatsApp account.' : 'WhatsApp said: ' + (j.error?.error_user_msg || j.error?.message || 'error ' + r.status) });
      return json({ ok: true, status: j.status || 'PENDING' });
    }
    if (name.startsWith('ship_')) {
      const a = await authed(req, env);
      const sel = await seller(env, a.shop, { secret: a.cfg.secret, view: (row) => view(row, a.cfg), fresh: true });
      const b = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      try {
        if (name === 'ship_pickups') return json({ ok: true, pickups: await srPickups(sel) });
        if (name === 'ship_list') {
          const ready = shipReady(sel.settings, sel.set);
          const orders = await unshippedOrders(sel).catch((e) => { throw new Error('Could not read orders from Shopify: ' + e.message); });
          const recs = (await env.DB.prepare('SELECT * FROM cw_shipments WHERE shop = ? ORDER BY updated_at DESC LIMIT 200').bind(a.shop).all()).results;
          const byId = Object.fromEntries(recs.map((r) => [String(r.order_id), r]));
          const pub = (r) => r && { awb: r.awb, courier: r.courier, charge: Number(r.charge), label_url: r.label_url, status: r.status, packed: !!r.packed_at, fulfilled: !!r.fulfilled, track: trackUrl(r), error: r.error || '' };
          return json({ ok: true, ready, provider: sel.settings.ship_provider, rule: sel.settings.ship_rule || 'rto',
            orders: orders.map((o) => ({ ...o, gid: undefined, shipment: pub(byId[o.id]) })),
            shipped: recs.filter((r) => r.awb).slice(0, 60).map((r) => ({ order_id: r.order_id, order_name: r.order_name, cod: Number(r.cod_amount) > 0, collect: Number(r.cod_amount), at: Number(r.created_at), ...pub(r) })) });
        }
        if (name === 'ship_rates') {
          const all = await unshippedOrders(sel);
          const o = all.find((x) => x.id === String(b.order_id));
          if (!o) return json({ ok: false, error: 'Order not found or already shipped' });
          const { parcel, rates } = await ratesFor(sel, o);
          const p = pickCourier(rates, { cod: o.cod, rule: sel.settings.ship_rule || 'rto', maxExtra: Number(sel.settings.ship_max_extra ?? 15) });
          return json({ ok: true, parcel, rates: rates.sort((x, y) => x.charge - y.charge), pick: p.pick?.id || null, why: p.why });
        }
        if (name === 'ship_book') {
          if (!shipReady(sel.settings, sel.set)) return json({ ok: false, error: 'Connect Shiprocket or ShipPrime first.' });
          const r = await book(env, sel, String(b.order_id || ''), { courierId: b.courier_id || '' });
          return json({ ok: true, ...r });
        }
        if (name === 'ship_labels') return json({ ok: true, labels: await labels(env, sel, (b.order_ids || []).slice(0, 100)) });
        if (name === 'ship_pack') {
          for (const id of (b.order_ids || []).slice(0, 200)) await env.DB.prepare('UPDATE cw_shipments SET packed_at = ?, updated_at = ? WHERE shop = ? AND order_id = ?').bind(b.packed === false ? null : now(), now(), a.shop, String(id)).run();
          return json({ ok: true });
        }
      } catch (e) {
        console.warn('cw ship', name, a.shop, e.message);
        if (name === 'ship_book' && b.order_id) await env.DB.prepare('UPDATE cw_shipments SET error = ?, updated_at = ? WHERE shop = ? AND order_id = ?').bind(String(e.message).slice(0, 300), now(), a.shop, String(b.order_id)).run().catch(() => {});
        return json({ ok: false, error: String(e.message || e).slice(0, 300) });
      }
    }
    if (path === '/api/cw/settings' && req.method === 'POST') {
      const a = await authed(req, env);
      const body = await req.json().catch(() => ({}));
      const { settings, secrets } = cleanSettings(body, JSON.parse(a.row.settings || '{}'));
      let prev = {}; try { prev = a.row.secrets_box ? JSON.parse(unseal(a.row.secrets_box, a.cfg.secret)) : {}; } catch { prev = {}; }
      for (const k of body.clear || []) if (FIELDS[k]?.type === 'secret') delete prev[k];
      const box = seal(JSON.stringify({ ...prev, ...secrets }), a.cfg.secret);
      await env.DB.prepare('UPDATE cw_shops SET settings = ?, secrets_box = ?, updated_at = ? WHERE shop = ?').bind(JSON.stringify(settings), box, now(), a.shop).run();
      forget(a.shop);
      return json({ ok: true, ...view(await getShop(env, a.shop), a.cfg), sf_url: `${SF_URL}?shop=${a.shop}` });
    }
  } catch (e) {
    console.error('cw', path, e.message);
    return json({ ok: false, error: e.status === 401 ? 'Please reopen CodWing from your Shopify admin.' : 'Something went wrong. Please try again.' }, e.status || 500);
  }
  return json({ ok: false, error: 'not found' }, 404);
}
