/**
 * Meta Marketing API (Ads Manager without the browser).
 *
 * Token: Settings → Meta → "Ads API token" (settings row meta.ads_token, never sent back whole), or the
 * META_ADS_TOKEN env var. Make it once in Business Settings → Users → System users → Generate token with
 * ads_management, ads_read, business_management, pages_read_engagement, pages_show_list, instagram_basic
 * (and the ad account + Page + Instagram account assigned to that system user). A system-user token does not expire.
 *
 * Everything here is called from admin RPC actions (ads_*), so it works from the dashboard and from the signed
 * agent endpoint (lib/agent.js). Nothing here deletes anything; new ads, ad sets and copies start PAUSED unless asked.
 */
import { sha256hex } from './util.js';

const GRAPH = 'https://graph.facebook.com';
export const AD_ACCOUNT = '2076578653221250';

export function adsCfg(env) {
  const m = env.SETTINGS?.meta || {};
  return {
    token: String(m.ads_token || env.META_ADS_TOKEN || '').trim(),
    account: 'act_' + String(m.ad_account || env.META_AD_ACCOUNT || AD_ACCOUNT).replace(/^act_/, ''),
    version: String(m.ads_version || env.META_ADS_VERSION || 'v26.0').trim(), /* Meta answers #2635 with the version it wants; graph() follows it */
    maxDaily: Math.max(100, Number(m.ads_max_daily) || 5000), /* rupees: no ad set or campaign can be set above this per day */
    target: Math.max(1, Number(m.ads_target_cpa) || 80), /* rupees per purchase the scaling rules aim for */
  };
}

function base(c) { return c.version ? `${GRAPH}/${c.version}` : GRAPH; }
const enc = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

/** One Graph call. Throws Error(message) with .code / .sub on a Meta error. */
let upgraded = ''; /* the version Meta asked for in a #2635 answer, kept for this instance */
export async function graph(env, method, path, params = {}, token, retry = true) {
  const c = adsCfg(env);
  if (upgraded) c.version = upgraded;
  const tok = token || c.token;
  if (!tok) throw new Error('Meta Ads token not set: Settings → Meta → Ads API token');
  const p = String(path).replace(/^\/+/, '');
  if (!/^[\w./-]+$/.test(p)) throw new Error('bad path');
  const u = new URL(`${base(c)}/${p}`);
  let init = { method };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, enc(v));
    u.searchParams.set('access_token', tok);
  } else {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, enc(v));
    body.set('access_token', tok);
    init = { method, body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
  }
  const res = await fetch(u.toString(), init);
  const j = await res.json().catch(() => ({}));
  if ((!res.ok || j.error) && j.error?.code === 2635 && retry) {
    const v = /v(\d{2,3}\.\d)/.exec(j.error.message || '')?.[0];
    if (v && v !== c.version) { upgraded = v; return graph(env, method, path, params, token, false); }
  }
  if (!res.ok || j.error) {
    const e = new Error(j.error?.error_user_msg || j.error?.message || `HTTP ${res.status}`);
    e.code = j.error?.code; e.sub = j.error?.error_subcode; e.trace = j.error?.fbtrace_id;
    throw e;
  }
  return j;
}

/** Follow paging.next for list endpoints (bounded). */
async function all(env, path, params, max = 500) {
  const out = [];
  let j = await graph(env, 'GET', path, { limit: 200, ...params });
  for (;;) {
    out.push(...(j.data || []));
    const after = j.paging?.cursors?.after;
    if (!j.paging?.next || !after || out.length >= max) break;
    j = await graph(env, 'GET', path, { limit: 200, ...params, after });
  }
  return out;
}

/** Which tokens can run the ad account (no token values are returned). */
export async function probe(env) {
  const c = adsCfg(env);
  const cands = [['settings', env.SETTINGS?.meta?.ads_token], ['META_ADS_TOKEN', env.META_ADS_TOKEN], ['META_CAPI_TOKEN', env.META_CAPI_TOKEN], ['WA_TOKEN', env.WA_TOKEN]]
    .filter(([, t]) => t);
  const out = [];
  for (const [name, t] of cands) {
    const r = { name };
    try { const me = await graph(env, 'GET', 'me', { fields: 'id,name' }, t); r.who = me.name || me.id; } catch (e) { r.error = e.message; out.push(r); continue; }
    try { r.perms = (await graph(env, 'GET', 'me/permissions', {}, t)).data.filter((p) => p.status === 'granted').map((p) => p.permission); } catch (e) { r.perms_error = e.message; }
    try { const a = await graph(env, 'GET', c.account, { fields: 'name,account_status,currency,amount_spent' }, t); r.account = { name: a.name, status: a.account_status, currency: a.currency }; } catch (e) { r.account_error = e.message; }
    out.push(r);
  }
  return { account: c.account, active: c.token ? (env.SETTINGS?.meta?.ads_token ? 'settings' : 'META_ADS_TOKEN') : null, tokens: out };
}

const PURCHASE = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
function pick(list, types) {
  const arr = list || [];
  for (const t of types) { const a = arr.find((x) => x.action_type === t); if (a) return Number(a.value); }
  return 0;
}
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Campaigns, ad sets and ads with their numbers for a date preset (today, yesterday, last_3d, last_7d, last_14d, last_30d, maximum).
 * Only delivering / paused / in-review items unless all=true.
 */
export async function overview(env, { preset = 'last_7d', all: everything = false } = {}) {
  const c = adsCfg(env);
  const live = (s) => everything || ['ACTIVE', 'PAUSED', 'PENDING_REVIEW', 'IN_PROCESS', 'WITH_ISSUES', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PREAPPROVED', 'DISAPPROVED'].includes(s);
  const [camps, sets, ads, ins] = await Promise.all([
    all(env, `${c.account}/campaigns`, { fields: 'id,name,status,effective_status,daily_budget,objective' }),
    all(env, `${c.account}/adsets`, { fields: 'id,name,campaign_id,status,effective_status,daily_budget,optimization_goal,promoted_object' }),
    all(env, `${c.account}/ads`, { fields: 'id,name,adset_id,campaign_id,status,effective_status' }),
    all(env, `${c.account}/insights`, { level: 'ad', date_preset: preset, fields: 'ad_id,spend,impressions,clicks,ctr,cpm,actions,action_values' }, 2000),
  ]);
  const byAd = new Map(ins.map((i) => [i.ad_id, i]));
  const num = (i) => {
    const spend = Number(i?.spend || 0), pur = pick(i?.actions, PURCHASE), val = pick(i?.action_values, PURCHASE);
    const custom = (i?.actions || []).filter((a) => a.action_type.startsWith('offsite_conversion.custom.')).reduce((o, a) => ({ ...o, [a.action_type.split('.').pop()]: Number(a.value) }), {});
    return { spend, purchases: pur, value: val, impressions: Number(i?.impressions || 0), clicks: Number(i?.clicks || 0), custom };
  };
  const sum = (rows) => rows.reduce((o, r) => {
    o.spend += r.spend; o.purchases += r.purchases; o.value += r.value; o.impressions += r.impressions; o.clicks += r.clicks;
    for (const [k, v] of Object.entries(r.custom)) o.custom[k] = (o.custom[k] || 0) + v;
    return o;
  }, { spend: 0, purchases: 0, value: 0, impressions: 0, clicks: 0, custom: {} });
  const fin = (o) => ({ ...o, spend: r2(o.spend), value: r2(o.value), cpa: o.purchases ? r2(o.spend / o.purchases) : null, roas: o.spend ? r2(o.value / o.spend) : null, ctr: o.impressions ? r2(o.clicks * 100 / o.impressions) : null });
  const adRows = ads.filter((a) => live(a.effective_status) || byAd.has(a.id)).map((a) => ({ id: a.id, name: a.name, adset_id: a.adset_id, status: a.effective_status, ...num(byAd.get(a.id)) }));
  const setRows = sets.filter((s) => live(s.effective_status) || adRows.some((a) => a.adset_id === s.id && a.spend)).map((s) => {
    const mine = adRows.filter((a) => a.adset_id === s.id);
    return { id: s.id, name: s.name, campaign_id: s.campaign_id, status: s.effective_status, daily: s.daily_budget ? Number(s.daily_budget) / 100 : null, goal: s.optimization_goal, event: s.promoted_object?.custom_event_type || s.promoted_object?.custom_conversion_id || '', ...fin(sum(mine)), ads: mine.map((a) => ({ ...a, ...fin(a) })) };
  });
  const campRows = camps.filter((k) => live(k.effective_status) || setRows.some((s) => s.campaign_id === k.id)).map((k) => {
    const mine = setRows.filter((s) => s.campaign_id === k.id);
    return { id: k.id, name: k.name, status: k.effective_status, daily: k.daily_budget ? Number(k.daily_budget) / 100 : null, objective: k.objective, ...fin(sum(mine)), adsets: mine };
  });
  return { preset, account: c.account, total: fin(sum(adRows)), campaigns: campRows };
}

/** Pause / activate a campaign, ad set or ad. */
export async function setStatus(env, id, status) {
  const s = String(status).toUpperCase();
  if (!['ACTIVE', 'PAUSED'].includes(s)) throw new Error('status must be ACTIVE or PAUSED');
  if (!/^\d{6,25}$/.test(String(id))) throw new Error('bad id');
  await graph(env, 'POST', String(id), { status: s });
  return { id, status: s };
}

/** Daily budget in rupees for an ad set or campaign (capped by Settings → Meta → max daily). */
export async function setBudget(env, id, rupees) {
  const c = adsCfg(env);
  const r = Math.round(Number(rupees));
  if (!(r >= 50)) throw new Error('daily budget must be at least ₹50');
  if (r > c.maxDaily) throw new Error(`₹${r}/day is above the cap of ₹${c.maxDaily}/day (Settings → Meta)`);
  if (!/^\d{6,25}$/.test(String(id))) throw new Error('bad id');
  const before = await graph(env, 'GET', String(id), { fields: 'name,daily_budget' });
  await graph(env, 'POST', String(id), { daily_budget: r * 100 });
  return { id, name: before.name, from: before.daily_budget ? Number(before.daily_budget) / 100 : null, to: r };
}

/** Copy an ad set (with its ads) into the same campaign, PAUSED; optional new name and budget. */
export async function copyAdset(env, { adset_id, name, daily_rupees }) {
  const j = await graph(env, 'POST', `${adset_id}/copies`, { deep_copy: true, status_option: 'PAUSED' });
  const id = j.copied_adset_id || j.ad_object_ids?.find((o) => o.ad_object_type === 'ad_set')?.copied_id;
  if (!id) return { raw: j };
  if (name) await graph(env, 'POST', id, { name: String(name).slice(0, 200) });
  if (daily_rupees) await setBudget(env, id, daily_rupees);
  return { id, name };
}

/** The Facebook Page and Instagram account the ads run from. */
export async function identities(env) {
  const c = adsCfg(env);
  const pages = await all(env, `${c.account}/promote_pages`, { fields: 'id,name,instagram_business_account{id,username}' }, 20);
  return pages.map((p) => ({ page_id: p.id, page: p.name, ig_id: p.instagram_business_account?.id || null, ig: p.instagram_business_account?.username || null }));
}

/** Recent Instagram posts/reels with numbers (to pick ads from). */
export async function igMedia(env, { limit = 30 } = {}) {
  const id = (await identities(env)).find((x) => x.ig_id)?.ig_id;
  if (!id) throw new Error('No Instagram account linked to the ad account Page');
  const j = await graph(env, 'GET', `${id}/media`, { fields: 'id,shortcode,caption,media_product_type,like_count,comments_count,timestamp,permalink', limit: Math.min(100, limit) });
  return (j.data || []).map((m) => ({ id: m.id, shortcode: m.shortcode, type: m.media_product_type, likes: m.like_count, comments: m.comments_count, at: m.timestamp, caption: String(m.caption || '').slice(0, 80) }));
}

/** New ad from an existing Instagram post/reel (keeps its likes/comments). Starts PAUSED unless status: 'ACTIVE'. */
export async function igAd(env, { adset_id, media_id, shortcode, name, link = 'https://www.inkkulture.in/', cta = 'SHOP_NOW', status = 'PAUSED' }) {
  const c = adsCfg(env);
  const who = (await identities(env)).find((x) => x.ig_id);
  if (!who) throw new Error('No Instagram account linked to the ad account Page');
  let mid = media_id;
  if (!mid && shortcode) mid = (await igMedia(env, { limit: 100 })).find((m) => m.shortcode === shortcode)?.id;
  if (!mid) throw new Error('Instagram post not found (give media_id or a shortcode from the last 100 posts)');
  const cr = await graph(env, 'POST', `${c.account}/adcreatives`, {
    name: (name || 'IG post ' + (shortcode || mid)).slice(0, 100),
    object_id: who.page_id,
    instagram_user_id: who.ig_id,
    source_instagram_media_id: mid,
    call_to_action: { type: cta, value: { link } },
  });
  const ad = await graph(env, 'POST', `${c.account}/ads`, { name: (name || 'IG ' + (shortcode || mid)).slice(0, 200), adset_id, creative: { creative_id: cr.id }, status: status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED' });
  return { ad_id: ad.id, creative_id: cr.id, media_id: mid };
}

/* ---------- customer-list audiences ---------- */
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export async function hashRow(r) {
  const raw = [String(r.phone || '').replace(/\D/g, ''), norm(r.fn), norm(r.ln), norm(r.ct), norm(r.st), String(r.zip || '').replace(/\D/g, ''), 'in'];
  return Promise.all(raw.map((v) => (v ? sha256hex(v) : '')));
}

/**
 * Create (or refresh, replacing members) a customer-list audience from rows {phone, fn, ln, ct, st, zip}.
 * Phones and names are SHA-256 hashed here; Meta never gets them in clear.
 */
export async function uploadAudience(env, name, rows) {
  const c = adsCfg(env);
  const list = await all(env, `${c.account}/customaudiences`, { fields: 'id,name,subtype' }, 1000);
  let aud = list.find((a) => a.name === name && a.subtype === 'CUSTOM');
  const created = !aud;
  if (!aud) aud = await graph(env, 'POST', `${c.account}/customaudiences`, { name, subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY', description: 'Synced from IK checkout' });
  const schema = ['PHONE', 'FN', 'LN', 'CT', 'ST', 'ZIP', 'COUNTRY'];
  const data = [];
  for (const r of rows) data.push(await hashRow(r));
  const session = { session_id: Date.now(), estimated_num_total: data.length };
  const chunks = [];
  for (let i = 0; i < data.length; i += 5000) chunks.push(data.slice(i, i + 5000));
  if (!chunks.length) chunks.push([]);
  let received = 0, invalid = 0;
  for (let i = 0; i < chunks.length; i++) {
    const j = await graph(env, 'POST', `${aud.id}/${created ? 'users' : 'usersreplace'}`, {
      session: { ...session, batch_seq: i + 1, last_batch_flag: i === chunks.length - 1 },
      payload: { schema, data: chunks[i] },
    });
    received += Number(j.num_received || 0); invalid += Number(j.num_invalid_entries || 0);
  }
  return { id: aud.id, name, created, sent: data.length, received, invalid };
}

/**
 * Scaling suggestions from the rules agreed with the owner (nothing is changed here):
 *  - ad set CPA ≤ target over 3 days and ≥ 3 purchases → raise budget 20%
 *  - ad with spend ≥ 2× target and CPA > 1.5× target (or no purchase) over 7 days → pause
 */
export async function suggestions(env) {
  const c = adsCfg(env);
  const [d3, d7] = await Promise.all([overview(env, { preset: 'last_3d' }), overview(env, { preset: 'last_7d' })]);
  const out = [];
  for (const k of d3.campaigns) for (const s of k.adsets) {
    if (s.status !== 'ACTIVE' || !s.daily) continue;
    if (s.purchases >= 3 && s.cpa !== null && s.cpa <= c.target) out.push({ kind: 'scale', id: s.id, name: s.name, cpa: s.cpa, purchases: s.purchases, from: s.daily, to: Math.min(c.maxDaily, Math.round(s.daily * 1.2)) });
  }
  for (const k of d7.campaigns) for (const s of k.adsets) for (const a of s.ads) {
    if (a.status !== 'ACTIVE') continue;
    if (a.spend >= 2 * c.target && (a.cpa === null || a.cpa > 1.5 * c.target)) out.push({ kind: 'pause', id: a.id, name: a.name, adset: s.name, spend: a.spend, purchases: a.purchases, cpa: a.cpa });
  }
  return { target: c.target, max_daily: c.maxDaily, actions: out };
}
