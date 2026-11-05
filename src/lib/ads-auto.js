/**
 * Ads autopilot (Nov 2026, owner's rules):
 *  - night: every delivering ad set / CBO campaign is paused 23:00–06:00 IST (night orders came back 68% of the time)
 *    and switched back on in the morning; only what we paused is resumed (ads_night setting).
 *  - scale: once a day, the best ad set of the last 3 days gets +₹100 (CPA ≤ 1.2× target) or +₹50 (CPA ≤ 1.5× target,
 *    ≥ 3 purchases). The account caps in Settings → Meta rise with it, up to `ads_ceiling` (default ₹5,000/day).
 *  - reels: once a WEEK (owner, 3 Nov), the strongest recent Instagram reel that is not an ad yet becomes an ACTIVE ad in
 *    the best ad set. Reels Meta refuses (licensed music, policy) are remembered and skipped.
 *  - losers: a reel ad that has spent ₹150 (lifetime) with 0 purchases is paused, never the last live ad of its ad set.
 * All state lives in settings rows: ads_night {paused:[ids], at}, ads_auto {log:[...], reels:{media_id: ...}}.
 */
import { adsCfg, graph, all, overview, activeBudgets, igAd, identities } from './meta-ads.js';
import { putSetting } from './settings.js';
import { claim } from './once.js';

const IST = 19800;
const nowSec = () => Math.floor(Date.now() / 1000);
export const istHour = (t = nowSec()) => new Date((t + IST) * 1000).getUTCHours();
const CONFIRMED = '1141111382186066';
export const REEL_EVERY = 7 * 86400 - 3600; /* one new reel ad a week */
export const LOSER_SPEND = 150;            /* ₹ spent with no purchase -> pause */ /* "Confirmed Purchase" custom conversion: the purchases we trust */

export function autoCfg(env) {
  const m = env.SETTINGS?.meta || {};
  return {
    night: m.ads_night_off !== false, nightFrom: Number(m.ads_night_from ?? 23), nightTo: Number(m.ads_night_to ?? 6),
    scale: m.ads_scale_off !== true, ceiling: Math.max(500, Number(m.ads_ceiling) || 5000), stepBig: 100, stepSmall: 50,
    reels: m.ads_reels_off !== true, reelDays: 21, losers: m.ads_losers_off !== true, loserSpend: Number(m.ads_loser_spend) || LOSER_SPEND, minViews: Number(m.ads_reel_min_views) || 0,
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
  if (!force && !(await claim(env, 'ads:reels', REEL_EVERY))) return { skipped: 'slot' };
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

/** Pure: which reel ads to pause. rows = ads with lifetime spend/purchases; a reel ad = name starts with "Reel" or
    carries "(auto)". Never pauses the last live ad of an ad set. */
export function pickLosers(rows, { spend = LOSER_SPEND } = {}) {
  const isReel = (a) => /^reel\b/i.test(a.name || '') || /\(auto\)/i.test(a.name || '');
  const live = rows.filter((a) => a.status === 'ACTIVE');
  const liveBySet = {}; for (const a of live) liveBySet[a.adset_id] = (liveBySet[a.adset_id] || 0) + 1;
  const out = [];
  for (const a of live.filter(isReel).sort((x, y) => y.spend - x.spend)) {
    const p = Math.max(Number(a.purchases) || 0, Number(a.custom?.[CONFIRMED]) || 0);
    if (Number(a.spend) >= spend && p === 0 && liveBySet[a.adset_id] > 1) { out.push({ id: a.id, name: a.name, spend: Math.round(a.spend) }); liveBySet[a.adset_id]--; }
  }
  return out;
}

export async function loserTick(env, { force = false } = {}) {
  const c = autoCfg(env); if (!c.losers && !force) return { skipped: 'off' };
  const h = istHour(); if (!force && (h < 7 || h >= 22)) return { skipped: 'hour' };
  if (!force && !(await claim(env, 'ads:losers', 3 * 3600))) return { skipped: 'slot' };
  const ov = await overview(env, { preset: 'maximum' });
  const rows = ov.campaigns.flatMap((k) => k.adsets.flatMap((s) => s.ads || []));
  const pick = pickLosers(rows, { spend: c.loserSpend });
  const meta = env.SETTINGS?.meta || {};
  for (const a of pick) await graph(env, 'POST', a.id, { status: 'PAUSED' });
  if (pick.length) await putSetting(env, 'meta', { ...meta, ads_auto: { ...(meta.ads_auto || {}), log: [{ at: nowSec(), kind: 'loser', paused: pick }, ...((meta.ads_auto || {}).log || [])].slice(0, 60) } });
  return { paused: pick };
}

/* ---------------- Rebalance (owner, 5 Nov 2026: "the good ads should get more of the money") ----------------
 * Budget-neutral, once a day after the scale step, on the last 3 days (confirmed purchases where Meta has them):
 *  - ad sets: move ₹100-200/day from the ad set with the worst CPA to the one with the best, total unchanged.
 *    Only when the best has ≥ 3 purchases, the worst costs ≥ 1.5× the best and more than the target, and the worst
 *    keeps at least ₹300/day. Never above the per-ad-set cap.
 *  - ads: inside an ad set, an ad that spent ≥ ₹400 in 3 days at ≥ 2.5× the ad set's best ad CPA (and ≥ 2× target),
 *    or ≥ ₹400 with no purchase while a sibling sells, is paused so Meta spends that ad set's money on the sibling.
 *    Never the last live ad of an ad set.
 */
const purchasesOf = (x) => Math.max(Number(x.custom?.[CONFIRMED]) || 0, Number(x.purchases) || 0);
const cpaOf = (x) => { const p = purchasesOf(x); return p ? Number(x.spend) / p : null; };

/** Pure: the budget move between ad sets, or null. rows = ad sets (overview shape) for one window. */
export function pickShift(rows, { target = 80, step = 200, minStep = 100, floor = 300, cap = 1750 } = {}) {
  const live = rows.filter((s) => s.status === 'ACTIVE' && Number(s.daily) > 0 && Number(s.spend) > 0);
  if (live.length < 2) return null;
  const scored = live.map((s) => ({ s, p: purchasesOf(s), cpa: cpaOf(s) }));
  const best = scored.filter((x) => x.p >= 3 && x.cpa !== null).sort((a, b) => a.cpa - b.cpa)[0];
  if (!best) return null;
  /* worst: highest CPA; an ad set that spent 2× target with nothing counts as infinitely bad */
  const worst = scored.filter((x) => x.s.id !== best.s.id).map((x) => ({ ...x, eff: x.cpa ?? (Number(x.s.spend) >= 2 * target ? Infinity : null) }))
    .filter((x) => x.eff !== null).sort((a, b) => b.eff - a.eff)[0];
  if (!worst || !(worst.eff >= 1.5 * best.cpa && worst.eff > target)) return null;
  const amt = Math.min(step, Number(worst.s.daily) - floor, cap - Number(best.s.daily));
  if (amt < minStep) return null;
  const r = (n) => Math.round(n);
  return { from: { id: worst.s.id, name: worst.s.name, cpa: worst.cpa === null ? null : r(worst.cpa), daily: Number(worst.s.daily), to: Number(worst.s.daily) - amt },
    to: { id: best.s.id, name: best.s.name, cpa: r(best.cpa), daily: Number(best.s.daily), to: Number(best.s.daily) + amt }, amount: amt };
}

/** Pure: ads to pause inside their ad sets. adsets = overview ad sets with .ads (same window). */
export function pickLaggards(adsets, { target = 80, minSpend = 400, ratio = 2.5 } = {}) {
  const out = [];
  for (const s of adsets) {
    const ads = (s.ads || []).filter((a) => a.status === 'ACTIVE');
    if (ads.length < 2) continue;
    const sellers = ads.filter((a) => purchasesOf(a) > 0).map((a) => cpaOf(a)).sort((a, b) => a - b);
    if (!sellers.length) continue;
    const bestCpa = sellers[0];
    let live = ads.length;
    for (const a of [...ads].sort((x, y) => Number(y.spend) - Number(x.spend))) {
      if (live <= 1) break;
      if (Number(a.spend) < minSpend) continue;
      const c = cpaOf(a);
      const bad = c === null ? true : (c >= ratio * bestCpa && c >= 2 * target);
      if (bad && c !== bestCpa) { out.push({ id: a.id, name: a.name, adset: s.name, spend: Math.round(a.spend), cpa: c === null ? null : Math.round(c), best: Math.round(bestCpa) }); live--; }
    }
  }
  return out;
}

export async function rebalanceTick(env, { force = false, dry = false } = {}) {
  const m = env.SETTINGS?.meta || {};
  if (m.ads_rebalance_off === true && !force) return { skipped: 'off' };
  const h = istHour(); if (!force && (h < 12 || h >= 14)) return { skipped: 'hour' };
  if (!force && !dry && !(await claim(env, 'ads:rebalance', 20 * 3600))) return { skipped: 'slot' };
  const a = adsCfg(env);
  const d3 = await overview(env, { preset: 'last_3d' });
  const sets = d3.campaigns.flatMap((k) => k.adsets);
  const shift = pickShift(sets, { target: a.target, cap: a.maxDaily });
  const laggards = pickLaggards(sets.filter((s) => s.status === 'ACTIVE'), { target: a.target });
  if (dry) return { dry: true, shift, laggards };
  const done = { shift: null, paused: [] };
  if (shift) {
    /* lower first, then raise: the account total never goes above what it was */
    await graph(env, 'POST', shift.from.id, { daily_budget: shift.from.to * 100 });
    await graph(env, 'POST', shift.to.id, { daily_budget: shift.to.to * 100 });
    done.shift = shift;
  }
  for (const x of laggards) { try { await graph(env, 'POST', x.id, { status: 'PAUSED' }); done.paused.push(x); } catch (e) { console.error('rebalance pause', x.id, e.message); } }
  const fresh = env.SETTINGS?.meta || {};
  if (done.shift || done.paused.length) await putSetting(env, 'meta', { ...fresh, ads_auto: { ...(fresh.ads_auto || {}), log: [{ at: nowSec(), kind: 'rebalance', ...done }, ...((fresh.ads_auto || {}).log || [])].slice(0, 60) } });
  else await putSetting(env, 'meta', { ...fresh, ads_auto: { ...(fresh.ads_auto || {}), log: [{ at: nowSec(), kind: 'rebalance', skipped: 'nothing clearly worse' }, ...((fresh.ads_auto || {}).log || [])].slice(0, 60) } });
  return done;
}
