/**
 * Ads autopilot (Nov 2026, owner's rules):
 *  - night: every delivering ad set / CBO campaign is paused 23:00–06:00 IST (night orders came back 68% of the time)
 *    and switched back on in the morning; only what we paused is resumed (ads_night setting).
 *  - scale: once a day, the best ad set of the last 3 days gets +₹100 (CPA ≤ 1.2× target) or +₹50 (CPA ≤ 1.5× target,
 *    ≥ 3 purchases). The account caps in Settings → Meta rise with it, up to `ads_ceiling` (default ₹5,000/day).
 *  - reels: once a day, the strongest recent Instagram reel that is not an ad yet becomes an ACTIVE ad in the best ad
 *    set. Reels Meta refuses (licensed music, policy) are remembered and skipped. One new ad per day.
 * All state lives in settings rows: ads_night {paused:[ids], at}, ads_auto {log:[...], reels:{media_id: ...}}.
 */
import { adsCfg, graph, all, overview, activeBudgets, igAd, identities } from './meta-ads.js';
import { putSetting } from './settings.js';
import { claim } from './once.js';

const IST = 19800;
const nowSec = () => Math.floor(Date.now() / 1000);
export const istHour = (t = nowSec()) => new Date((t + IST) * 1000).getUTCHours();
const CONFIRMED = '1141111382186066'; /* "Confirmed Purchase" custom conversion: the purchases we trust */

export function autoCfg(env) {
  const m = env.SETTINGS?.meta || {};
  return {
    night: m.ads_night_off !== false, nightFrom: Number(m.ads_night_from ?? 23), nightTo: Number(m.ads_night_to ?? 6),
    scale: m.ads_scale_off !== true, ceiling: Math.max(500, Number(m.ads_ceiling) || 5000), stepBig: 100, stepSmall: 50,
    reels: m.ads_reels_off !== true, reelDays: 21, minViews: Number(m.ads_reel_min_views) || 0,
  };
}

/** Pure: is the IST hour inside the night window [from, to) (wrapping midnight)? */
export function isNight(h, from = 23, to = 6) { return from > to ? (h >= from || h < to) : (h >= from && h < to); }

/** Pure: the ad set to grow and by how much, from overview rows. Returns null when nothing qualifies. */
export function pickScale(rows, { target, stepBig = 100, stepSmall = 50 }) {
  const live = rows.filter((s) => s.status === 'ACTIVE' && s.daily);
  const score = (s) => { const p = s.custom?.[CONFIRMED] ?? s.purchases; return { p, cpa: p ? s.spend / p : null }; };
  const ok = live.map((s) => ({ s, ...score(s) })).filter((x) => x.p >= 3 && x.cpa !== null).sort((a, b) => a.cpa - b.cpa);
  if (!ok.length) return null;
  const best = ok[0];
  const step = best.cpa <= 1.2 * target ? stepBig : best.cpa <= 1.5 * target ? stepSmall : 0;
  return step ? { id: best.s.id, name: best.s.name, cpa: Math.round(best.cpa), purchases: best.p, from: best.s.daily, to: best.s.daily + step } : null;
}

/** Pure: pick the reel to promote: not used, recent, and clearly above the pack. */
export function pickReel(reels, { used = {}, minViews = 0 } = {}) {
  const fresh = reels.filter((r) => /REEL/i.test(r.type || '') && !used[r.id]);
  if (!fresh.length) return null;
  const val = (r) => Number(r.views || 0) || (Number(r.likes || 0) + 5 * Number(r.comments || 0)) * 20;
  const vals = fresh.map(val).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)] || 0;
  const top = [...fresh].sort((a, b) => val(b) - val(a))[0];
  const v = val(top);
  if (v < minViews) return null;
  if (fresh.length >= 4 && v < 1.5 * median) return null;
  return top;
}

export async function nightTick(env) {
  const c = autoCfg(env); if (!c.night) return { skipped: 'off' };
  const h = istHour(), state = env.SETTINGS?.meta?.ads_night || {};
  const night = isNight(h, c.nightFrom, c.nightTo);
  if (night && !state.paused?.length) {
    if (!(await claim(env, 'ads:night:off', 3600))) return { skipped: 'slot' };
    const live = await activeBudgets(env);
    for (const b of live) await graph(env, 'POST', b.id, { status: 'PAUSED' });
    await putSetting(env, 'meta', { ...(env.SETTINGS?.meta || {}), ads_night: { paused: live.map((b) => b.id), names: live.map((b) => b.name), at: nowSec() } });
    return { paused: live.map((b) => b.name) };
  }
  if (!night && state.paused?.length) {
    if (!(await claim(env, 'ads:night:on', 3600))) return { skipped: 'slot' };
    const back = [];
    for (const id of state.paused) { try { await graph(env, 'POST', id, { status: 'ACTIVE' }); back.push(id); } catch (e) { console.error('night resume', id, e.message); } }
    await putSetting(env, 'meta', { ...(env.SETTINGS?.meta || {}), ads_night: { paused: [], resumed: back, at: nowSec() } });
    return { resumed: back };
  }
  return { night, idle: true };
}

export async function scaleTick(env) {
  const c = autoCfg(env); if (!c.scale) return { skipped: 'off' };
  const h = istHour(); if (h < 10 || h >= 12) return { skipped: 'hour' };
  if (!(await claim(env, 'ads:scale', 20 * 3600))) return { skipped: 'slot' };
  const a = adsCfg(env);
  const d3 = await overview(env, { preset: 'last_3d' });
  const rows = d3.campaigns.flatMap((k) => k.adsets);
  const pick = pickScale(rows, { target: a.target, stepBig: c.stepBig, stepSmall: c.stepSmall });
  const meta = env.SETTINGS?.meta || {};
  const log = (entry) => putSetting(env, 'meta', { ...meta, ads_auto: { ...(meta.ads_auto || {}), log: [{ at: nowSec(), ...entry }, ...((meta.ads_auto || {}).log || [])].slice(0, 60) } });
  if (!pick) { await log({ kind: 'scale', skipped: 'no ad set with ≥3 purchases and CPA ≤ 1.5× target' }); return { skipped: 'no candidate' }; }
  const total = (await activeBudgets(env)).reduce((t, b) => t + b.daily, 0) + (pick.to - pick.from);
  if (total > c.ceiling) { await log({ kind: 'scale', skipped: `ceiling ₹${c.ceiling}/day`, ...pick }); return { skipped: 'ceiling', pick }; }
  await graph(env, 'POST', pick.id, { daily_budget: pick.to * 100 });
  /* the caps in Settings → Meta follow the autopilot so manual tools keep working */
  meta.ads_max_daily = Math.max(Number(meta.ads_max_daily) || 0, pick.to);
  meta.ads_max_total = Math.max(Number(meta.ads_max_total) || 0, Math.ceil(total));
  await log({ kind: 'scale', ...pick });
  return { scaled: pick, total };
}

/** Recent reels with views from the Instagram account behind the ad account's Page. */
export async function recentReels(env, { days = 21 } = {}) {
  const who = (await identities(env)).find((x) => x.ig_id); if (!who) throw new Error('No Instagram account linked');
  const j = await graph(env, 'GET', `${who.ig_id}/media`, { fields: 'id,shortcode,caption,media_product_type,like_count,comments_count,timestamp,permalink', limit: 60 });
  const since = Date.now() - days * 86400e3;
  const reels = (j.data || []).filter((m) => /REEL/i.test(m.media_product_type || '') && Date.parse(m.timestamp) > since);
  for (const m of reels) {
    try { const ins = await graph(env, 'GET', `${m.id}/insights`, { metric: 'views,reach,saved,shares' }); for (const d of ins.data || []) m[d.name] = Number(d.values?.[0]?.value || 0); } catch { /* older media: no insights */ }
  }
  return reels.map((m) => ({ id: m.id, shortcode: m.shortcode, type: m.media_product_type, at: m.timestamp, likes: m.like_count || 0, comments: m.comments_count || 0, views: m.views || 0, reach: m.reach || 0, saved: m.saved || 0, shares: m.shares || 0, link: m.permalink, caption: String(m.caption || '').slice(0, 70) }));
}

export async function reelTick(env, { force = false } = {}) {
  const c = autoCfg(env); if (!c.reels && !force) return { skipped: 'off' };
  const h = istHour(); if (!force && (h < 11 || h >= 13)) return { skipped: 'hour' };
  if (!force && !(await claim(env, 'ads:reels', 20 * 3600))) return { skipped: 'slot' };
  const meta = env.SETTINGS?.meta || {}; const auto = meta.ads_auto || {}; const used = auto.reels || {};
  /* reels already running as ads (by source media id in the creative) count as used */
  const a = adsCfg(env);
  try { for (const cr of await all(env, `${a.account}/adcreatives`, { fields: 'id,source_instagram_media_id' }, 500)) if (cr.source_instagram_media_id) used[cr.source_instagram_media_id] = used[cr.source_instagram_media_id] || { ad: 'existing' }; } catch { /* fine */ }
  const reels = await recentReels(env, { days: c.reelDays });
  const pick = pickReel(reels, { used, minViews: c.minViews });
  const save = (entry) => putSetting(env, 'meta', { ...meta, ads_auto: { ...auto, reels: used, log: [{ at: nowSec(), kind: 'reel', ...entry }, ...(auto.log || [])].slice(0, 60) } });
  if (!pick) { await save({ skipped: 'no reel clearly above the pack' }); return { skipped: 'no candidate', considered: reels.length }; }
  /* best ad set of the last 3 days (by confirmed-purchase CPA), else the first delivering one */
  const d3 = await overview(env, { preset: 'last_3d' });
  const rows = d3.campaigns.flatMap((k) => k.adsets).filter((s) => s.status === 'ACTIVE' && s.daily);
  const best = rows.map((s) => ({ s, p: s.custom?.[CONFIRMED] ?? s.purchases })).map((x) => ({ ...x, cpa: x.p ? x.s.spend / x.p : 9e9 })).sort((x, y) => x.cpa - y.cpa)[0]?.s || rows[0];
  if (!best) { await save({ skipped: 'no active ad set' }); return { skipped: 'no ad set' }; }
  try {
    const r = await igAd(env, { adset_id: best.id, media_id: pick.id, name: `Reel ${pick.shortcode || pick.id} (auto)`, status: 'ACTIVE' });
    used[pick.id] = { ad: r.ad_id, adset: best.id, at: nowSec(), views: pick.views };
    await save({ added: pick.shortcode || pick.id, views: pick.views, adset: best.name, ad: r.ad_id });
    return { added: { reel: pick.link, views: pick.views, adset: best.name, ad_id: r.ad_id } };
  } catch (e) {
    used[pick.id] = { error: String(e.message).slice(0, 160), at: nowSec() };
    await save({ rejected: pick.shortcode || pick.id, error: String(e.message).slice(0, 160) });
    return { rejected: { reel: pick.link, error: e.message } };
  }
}
