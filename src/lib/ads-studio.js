/**
 * Ads studio (dashboard → More → Meta ads): every campaign / ad set / ad with its numbers, pause / resume / delete an
 * ad, and a new Reel ad from an MP4 uploaded in the dashboard, made like the best ad already in that ad set (same Page,
 * Instagram account, text, headline, button, link and URL tags; only the video is new).
 *
 * Video upload: Meta's chunked upload (advideos, upload_phase start / transfer / finish). Meta says which byte range it
 * wants next; the dashboard sends that range in parts of up to ~2.4 MB (a request to us is limited to ~4.5 MB), the
 * parts wait in ad_upload until the range is complete, then the range goes to Meta in one transfer call.
 */
import { adsCfg, graph, all, setStatus } from './meta-ads.js';

const now = () => Math.floor(Date.now() / 1000);
const VIDEO = 'https://graph-video.facebook.com';
const num = (v) => Number(v) || 0;
const act = (list, types) => (list || []).filter((a) => types.includes(a.action_type)).reduce((m, a) => Math.max(m, num(a.value)), 0);
const PURCH = ['offsite_conversion.fb_pixel_purchase', 'purchase', 'omni_purchase'];

/** Campaigns → ad sets → ads, with spend, purchases, purchase value, ROAS, CTR, CPM for the period. */
export async function tree(env, { preset = 'last_7d' } = {}) {
  const c = adsCfg(env);
  const live = JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW', 'DISAPPROVED'] }]);
  const [camps, sets, ads, ins] = await Promise.all([
    all(env, `${c.account}/campaigns`, { fields: 'id,name,status,effective_status,daily_budget', filtering: live, limit: 200 }, 300),
    all(env, `${c.account}/adsets`, { fields: 'id,name,status,effective_status,campaign_id,daily_budget', filtering: live, limit: 200 }, 500),
    all(env, `${c.account}/ads`, { fields: 'id,name,status,effective_status,adset_id,campaign_id,created_time,creative{thumbnail_url,video_id}', filtering: live, limit: 200 }, 800),
    all(env, `${c.account}/insights`, { level: 'ad', date_preset: preset, fields: 'ad_id,spend,impressions,inline_link_clicks,ctr,cpm,actions,action_values', limit: 500 }, 1500).catch(() => []),
  ]);
  const m = Object.fromEntries(ins.map((r) => {
    const spend = num(r.spend), p = act(r.actions, PURCH), v = act(r.action_values, PURCH);
    return [r.ad_id, { spend, purchases: p, value: Math.round(v), roas: spend ? +(v / spend).toFixed(2) : 0, cpa: p ? Math.round(spend / p) : 0, ctr: +num(r.ctr).toFixed(2), cpm: Math.round(num(r.cpm)), clicks: num(r.inline_link_clicks), impressions: num(r.impressions) }];
  }));
  const zero = { spend: 0, purchases: 0, value: 0, roas: 0, cpa: 0, ctr: 0, cpm: 0, clicks: 0, impressions: 0 };
  const sum = (rows) => { const t = rows.reduce((a, r) => ({ spend: a.spend + r.m.spend, purchases: a.purchases + r.m.purchases, value: a.value + r.m.value }), { spend: 0, purchases: 0, value: 0 }); return { ...t, spend: Math.round(t.spend), roas: t.spend ? +(t.value / t.spend).toFixed(2) : 0, cpa: t.purchases ? Math.round(t.spend / t.purchases) : 0 }; };
  const adRows = ads.map((a) => ({ id: a.id, name: a.name, status: a.status, eff: a.effective_status, adset_id: a.adset_id, created: a.created_time, thumb: a.creative?.thumbnail_url || '', video: !!a.creative?.video_id, m: m[a.id] || zero }));
  const setRows = sets.map((s) => { const list = adRows.filter((a) => a.adset_id === s.id).sort((x, y) => y.m.spend - x.m.spend); return { id: s.id, name: s.name, status: s.status, eff: s.effective_status, campaign_id: s.campaign_id, daily: num(s.daily_budget) / 100, ads: list, m: sum(list) }; });
  const campRows = camps.map((k) => { const list = setRows.filter((s) => s.campaign_id === k.id); return { id: k.id, name: k.name, status: k.status, eff: k.effective_status, daily: num(k.daily_budget) / 100, sets: list, m: sum(list.flatMap((s) => s.ads)) }; })
    .sort((a, b) => (a.status === 'ACTIVE' ? 0 : 1) - (b.status === 'ACTIVE' ? 0 : 1) || b.m.spend - a.m.spend);
  return { preset, campaigns: campRows };
}

/** Pause / resume / delete one ad. */
export async function adStatus(env, id, status) {
  const s = String(status).toUpperCase();
  if (!/^\d{6,25}$/.test(String(id))) throw new Error('bad id');
  if (s === 'DELETED') { await graph(env, 'POST', String(id), { status: 'DELETED' }); return { id, status: s }; }
  return setStatus(env, id, s);
}

/* ---------- video upload ---------- */
async function videoCall(env, form) {
  const c = adsCfg(env);
  if (!c.token) throw new Error('Meta Ads token not set: Settings → Meta → Ads API token');
  form.set('access_token', c.token);
  const res = await fetch(`${VIDEO}/${c.version}/${c.account}/advideos`, { method: 'POST', body: form });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error?.error_user_msg || j.error?.message || `Meta upload HTTP ${res.status}`);
  return j;
}
export async function videoStart(env, { size }) {
  const n = Math.round(num(size));
  if (n < 1000 || n > 1024 * 1024 * 1024) throw new Error('Video must be between 1 KB and 1 GB');
  const f = new FormData(); f.set('upload_phase', 'start'); f.set('file_size', String(n));
  const j = await videoCall(env, f);
  return { session: String(j.upload_session_id), video_id: String(j.video_id), start: num(j.start_offset), end: num(j.end_offset) };
}
async function partsTable(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS ad_upload (session TEXT NOT NULL, start BIGINT NOT NULL, part INT NOT NULL, data TEXT NOT NULL, at BIGINT NOT NULL)').run();
}
/** One part of Meta's requested range [start, end). When the last part is in, the range goes to Meta. */
export async function videoChunk(env, { session, start, part = 0, parts = 1, data }) {
  if (!/^\d{5,30}$/.test(String(session))) throw new Error('bad session');
  if (typeof data !== 'string' || data.length > 3.6 * 1024 * 1024) throw new Error('part too big');
  let bytes;
  if (Number(parts) > 1) {
    await partsTable(env);
    await env.DB.prepare('INSERT INTO ad_upload (session, start, part, data, at) VALUES (?,?,?,?,?)').bind(String(session), num(start), num(part), data, now()).run();
    if (num(part) < num(parts) - 1) return { stored: true };
    const rows = (await env.DB.prepare('SELECT part, data FROM ad_upload WHERE session=? AND start=? ORDER BY part').bind(String(session), num(start)).all()).results;
    if (rows.length !== num(parts)) throw new Error('missing parts, upload again');
    bytes = Buffer.concat(rows.map((r) => Buffer.from(r.data, 'base64')));
    await env.DB.prepare('DELETE FROM ad_upload WHERE session=? OR at<?').bind(String(session), now() - 6 * 3600).run();
  } else bytes = Buffer.from(data, 'base64');
  const f = new FormData();
  f.set('upload_phase', 'transfer'); f.set('upload_session_id', String(session)); f.set('start_offset', String(num(start)));
  f.set('video_file_chunk', new Blob([bytes], { type: 'video/mp4' }), 'chunk.mp4');
  const j = await videoCall(env, f);
  return { start: num(j.start_offset), end: num(j.end_offset) };
}
export async function videoFinish(env, { session, title }) {
  const f = new FormData(); f.set('upload_phase', 'finish'); f.set('upload_session_id', String(session)); f.set('title', String(title || 'IK reel').slice(0, 100));
  const j = await videoCall(env, f);
  return { ok: !!j.success };
}
/** Processing state, cover picture, length; Meta's copyright check when it has one. */
export async function videoInfo(env, { video_id }) {
  if (!/^\d{6,25}$/.test(String(video_id))) throw new Error('bad video id');
  const v = await graph(env, 'GET', String(video_id), { fields: 'status,length,picture,thumbnails{uri,is_preferred}' });
  const thumbs = v.thumbnails?.data || [];
  const cover = (thumbs.find((t) => t.is_preferred) || thumbs[0])?.uri || v.picture || '';
  let copyright = '';
  try { const x = await graph(env, 'GET', String(video_id), { fields: 'copyright_monitoring_status' }); copyright = String(x.copyright_monitoring_status || ''); } catch (e) { copyright = ''; }
  return { status: v.status?.video_status || '', phase: v.status?.processing_phase?.status || '', progress: num(v.status?.processing_progress), length: num(v.length), cover, copyright };
}

/* ---------- a new ad like the ad set's best one ---------- */
/** The ad to copy: the one with most purchases (then spend) in the last 14 days, else the newest. */
export async function bestAd(env, adset_id) {
  const ads = await all(env, `${adset_id}/ads`, { fields: 'id,name,created_time,effective_status', limit: 100 }, 200);
  if (!ads.length) return null;
  const ins = await all(env, `${adset_id}/insights`, { level: 'ad', date_preset: 'last_14d', fields: 'ad_id,spend,actions', limit: 200 }, 300).catch(() => []);
  const score = Object.fromEntries(ins.map((r) => [r.ad_id, act(r.actions, PURCH) * 1e6 + num(r.spend)]));
  return ads.sort((a, b) => (score[b.id] || 0) - (score[a.id] || 0) || String(b.created_time).localeCompare(String(a.created_time)))[0];
}
/** What a new ad copies from the template: identity, text, headline, button, link, URL tags. */
export async function templateOf(env, ad_id) {
  const ad = await graph(env, 'GET', String(ad_id), { fields: 'name,creative{id,object_story_spec,asset_feed_spec,url_tags,body,title,link_url,call_to_action_type,instagram_user_id,actor_id,object_id,source_instagram_media_id,effective_instagram_media_id}' });
  const cr = ad.creative || {}, os = cr.object_story_spec || {}, d = os.video_data || os.link_data || {}, af = cr.asset_feed_spec || {};
  const cta = d.call_to_action || {};
  return {
    ad_id: String(ad_id), name: ad.name,
    page_id: os.page_id || cr.object_id || cr.actor_id || '',
    ig_id: os.instagram_user_id || cr.instagram_user_id || '',
    message: d.message || cr.body || af.bodies?.[0]?.text || '',
    title: d.title || d.name || cr.title || af.titles?.[0]?.text || '',
    cta: cta.type || cr.call_to_action_type || af.call_to_action_types?.[0] || 'SHOP_NOW',
    link: cta.value?.link || d.link || cr.link_url || af.link_urls?.[0]?.website_url || 'https://www.inkkulture.in/',
    url_tags: cr.url_tags || '',
  };
}
export async function createVideoAd(env, { adset_id, video_id, cover, name, template_ad_id, message, title, status = 'PAUSED' }) {
  const c = adsCfg(env);
  if (!/^\d{6,25}$/.test(String(adset_id)) || !/^\d{6,25}$/.test(String(video_id))) throw new Error('bad ad set or video');
  const tplAd = template_ad_id ? { id: String(template_ad_id) } : await bestAd(env, adset_id);
  const t = tplAd ? await templateOf(env, tplAd.id) : { cta: 'SHOP_NOW', link: 'https://www.inkkulture.in/', url_tags: '' };
  if (!t.page_id || !t.ig_id) {
    const { identities } = await import('./meta-ads.js');
    const who = (await identities(env)).find((x) => x.ig_id) || {};
    t.page_id = t.page_id || who.page_id; t.ig_id = t.ig_id || who.ig_id;
  }
  if (!t.page_id) throw new Error('No Facebook Page found for the ad');
  const pic = cover || (await videoInfo(env, { video_id })).cover;
  if (!pic) throw new Error('Meta is still processing the video (no cover yet). Try again in a minute.');
  const video_data = { video_id: String(video_id), image_url: pic, message: String(message || t.message || 'Semi-permanent tattoos that last up to 2 weeks. Buy 1 Get 1 Free. Shop now on inkkulture.in'), call_to_action: { type: t.cta || 'SHOP_NOW', value: { link: t.link } } };
  const ttl = String(title || t.title || ''); if (ttl) video_data.title = ttl;
  const spec = { page_id: t.page_id, video_data }; if (t.ig_id) spec.instagram_user_id = t.ig_id;
  const nm = String(name || 'Reel ' + new Date(Date.now() + 19800e3).toISOString().slice(0, 16).replace('T', ' ')).slice(0, 100);
  const cr = await graph(env, 'POST', `${c.account}/adcreatives`, { name: nm, object_story_spec: spec, url_tags: t.url_tags || undefined });
  const ad = await graph(env, 'POST', `${c.account}/ads`, { name: nm, adset_id: String(adset_id), creative: { creative_id: cr.id }, status: status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED' });
  return { ad_id: ad.id, creative_id: cr.id, copied_from: tplAd ? { id: tplAd.id, name: t.name } : null, text: video_data.message, cta: video_data.call_to_action.type, link: t.link };
}
