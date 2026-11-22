/**
 * Instagram comments inbox + big followers (dashboard tab "IG comments").
 *
 * Comments: every comment on the account's recent reels that is real text (not only emojis) and is not a link /
 * price ask (those are the comment -> DM keywords in lib/ig-dm.js and get the DM automatically). Reply from the
 * dashboard: POST /<comment-id>/replies. Uses the same Instagram Login token as lib/ig-dm.js.
 *
 * Big followers: Instagram does not give anyone the list of an account's followers. What it does give (User Profile
 * API, instagram_business_manage_messages) is, for a person who has messaged the account, their follower_count and
 * whether they follow us (is_user_follow_business). So we check everyone in the DM inbox plus everyone who commented,
 * cache the answer in ig_people for 7 days, and list followers with 10k+ followers. People who never messaged the
 * account usually can't be looked up (Instagram answers with a consent error); they are stored with that error.
 */
import { igCfg, wantsLink, igApi } from './ig-dm.js';

const now = () => Math.floor(Date.now() / 1000);
export const MIN_FOLLOWERS = 10000;
const RECHECK = 7 * 86400;

/* ---------------- pure helpers (tested) ---------------- */

/** True when the comment has no letters or digits at all: only emojis, symbols, punctuation or spaces. */
export function emojiOnly(text) {
  return !/[\p{L}\p{N}]/u.test(String(text || ''));
}
/** A comment worth showing: real text, not a link / price ask, not from our own account. */
export function worthShowing(cm, c) {
  if (!cm || emojiOnly(cm.text)) return false;
  if (c.username && cm.username === c.username) return false;
  /* strip @mentions first: "@friend look" is a real comment, "@friend" alone is just a tag */
  const plain = String(cm.text).replace(/@[\w.]+/g, ' ');
  if (emojiOnly(plain)) return false;
  if (linkTypo(plain)) return false;
  return !wantsLink(plain, { ...c, mode: 'keywords' });
}
/** "lonk", "lnk", "linl", "liink": a word one typo away from "link" (real words like "like", "line" don't count). */
export function linkTypo(text) {
  const REAL = new Set(['like', 'line', 'lick', 'lint', 'pink', 'sink', 'wink', 'mink', 'rink', 'kink', 'ink', 'lino', 'lin']);
  const words = String(text || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
  return words.some((w) => !REAL.has(w) && w !== 'link' && w.length >= 3 && w.length <= 5 && dist(w, 'link') === 1);
}
function dist(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/* ---------------- comments ---------------- */

async function inChunks(list, n, fn) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(...(await Promise.all(list.slice(i, i + n).map(fn))));
  return out;
}

/** Comments from the last `reels` reels, newest first, with whether we already replied. */
export async function commentsFeed(env, { reels = 25, all = false } = {}) {
  const c = await igCfg(env);
  if (!c.token) throw new Error('Instagram is not connected (Instagram DM tab)');
  const media = ((await igApi(env, c, 'GET', `me/media?fields=id,caption,media_type,media_product_type,permalink,thumbnail_url,timestamp,comments_count&limit=${Math.min(50, reels)}`)).data || [])
    .filter((m) => (all || m.media_product_type === 'REELS') && m.comments_count > 0);
  const errors = [];
  const per = await inChunks(media, 5, async (m) => {
    try {
      const rows = [];
      let path = `${m.id}/comments?fields=id,text,username,timestamp,like_count,from,replies{id,text,username,from,timestamp}&limit=50`;
      for (let page = 0; path && page < 4; page++) {
        const j = await igApi(env, c, 'GET', path);
        rows.push(...(j.data || []));
        path = j.paging?.next ? j.paging.next.replace(/^https:\/\/graph\.instagram\.com\/v[\d.]+\//, '').replace(/[&?]access_token=[^&]*/, '') : '';
      }
      return rows.map((x) => ({ ...x, media: m }));
    } catch (e) { errors.push(e.message); return []; }
  });
  const rows = per.flat().map((x) => {
    const replies = (x.replies?.data || []).map((r) => {
      const u = r.username || r.from?.username || '';
      const ours = (u && u === c.username) || (r.from?.id && String(r.from.id) === String(c.user_id));
      return { id: r.id, text: r.text, username: u || (ours ? c.username : ''), at: r.timestamp, ours: !!ours };
    });
    const who = x.username || x.from?.username || '';
    return {
      id: x.id, text: String(x.text || ''), username: who, from_id: x.from?.id || '',
      at: x.timestamp, likes: x.like_count || 0, replies,
      /* our replies start with "@<commenter>" (auto-DM / bio replies); a reply by the commenter themself is not ours */
      replied: replies.some((r) => r.ours || (!r.username && who && String(r.text || '').startsWith('@' + who))),
      media_id: x.media.id, media_url: x.media.permalink, thumb: x.media.thumbnail_url || '',
      caption: String(x.media.caption || '').replace(/\s+/g, ' ').slice(0, 60),
    };
  });
  const shown = rows.filter((r) => worthShowing(r, c)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { ok: true, username: c.username, reels: media.length, total: rows.length, hidden: rows.length - shown.length, rows: shown, errors: errors.slice(0, 3) };
}

/** Public reply under a comment. */
export async function replyComment(env, id, message) {
  const c = await igCfg(env);
  if (!c.token) throw new Error('Instagram is not connected');
  const msg = String(message || '').trim();
  if (!/^\d+$/.test(String(id || ''))) throw new Error('Bad comment id');
  if (!msg) throw new Error('Type a reply');
  if (msg.length > 2000) throw new Error('Reply is too long');
  const j = await igApi(env, c, 'POST', `${id}/replies?message=${encodeURIComponent(msg)}`);
  return { ok: true, id: j.id || '' };
}

/* ---------------- big followers ---------------- */

/** IG-scoped ids of people in the DM inbox and people who commented. */
async function candidates(env, c, feedIds = []) {
  const ids = new Map();
  try {
    let path = 'me/conversations?platform=instagram&fields=participants&limit=50';
    for (let page = 0; path && page < 6; page++) {
      const j = await igApi(env, c, 'GET', path);
      for (const conv of j.data || []) for (const p of conv.participants?.data || []) {
        if (p.id && p.id !== c.user_id && p.username !== c.username) ids.set(String(p.id), p.username || '');
      }
      path = j.paging?.next ? j.paging.next.replace(/^https:\/\/graph\.instagram\.com\/v[\d.]+\//, '').replace(/[&?]access_token=[^&]*/, '') : '';
    }
  } catch (e) { console.error('ig conversations', e.message); }
  const dm = await env.DB.prepare("SELECT DISTINCT from_id, username FROM ig_dm WHERE from_id IS NOT NULL AND from_id<>''").all().then((r) => r.results).catch(() => []);
  for (const r of dm) if (!ids.has(String(r.from_id))) ids.set(String(r.from_id), r.username || '');
  for (const [id, u] of feedIds) if (id && !ids.has(String(id))) ids.set(String(id), u || '');
  return ids;
}

/** Look up people not checked in the last 7 days (at most `max` per call), then list followers with 10k+. */
export async function bigFollowers(env, { check = false, max = 60, min = MIN_FOLLOWERS } = {}) {
  const c = await igCfg(env);
  if (!c.token) throw new Error('Instagram is not connected (Instagram DM tab)');
  let checked = 0, left = 0;
  if (check) {
    let feedIds = [];
    try { feedIds = (await commentsFeed(env, { reels: 25, all: true })).rows.map((r) => [r.from_id, r.username]); } catch { feedIds = []; }
    const ids = await candidates(env, c, feedIds);
    const known = Object.fromEntries((await env.DB.prepare('SELECT igsid, checked_at FROM ig_people').all()).results.map((r) => [String(r.igsid), Number(r.checked_at) || 0]));
    const todo = [...ids.keys()].filter((id) => now() - (known[id] || 0) > RECHECK);
    left = Math.max(0, todo.length - max);
    await inChunks(todo.slice(0, max), 6, async (id) => {
      let p = {}, err = '';
      try { p = await igApi(env, c, 'GET', `${id}?fields=name,username,profile_pic,follower_count,is_user_follow_business,is_verified_user`); } catch (e) { err = String(e.message || e).slice(0, 200); }
      await env.DB.prepare(`INSERT INTO ig_people (igsid, username, name, followers, follows_us, verified, pic, err, checked_at) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT (igsid) DO UPDATE SET username=EXCLUDED.username, name=EXCLUDED.name, followers=EXCLUDED.followers, follows_us=EXCLUDED.follows_us, verified=EXCLUDED.verified, pic=EXCLUDED.pic, err=EXCLUDED.err, checked_at=EXCLUDED.checked_at`)
        .bind(id, String(p.username || ids.get(id) || '').slice(0, 60), String(p.name || '').slice(0, 80), p.follower_count ?? null,
          p.is_user_follow_business == null ? null : (p.is_user_follow_business ? 1 : 0), p.is_verified_user ? 1 : 0, String(p.profile_pic || '').slice(0, 600), err, now()).run();
      checked++;
    });
  }
  const rows = (await env.DB.prepare('SELECT igsid, username, name, followers, follows_us, verified, pic, checked_at FROM ig_people WHERE followers >= ? ORDER BY followers DESC LIMIT 300').bind(min).all()).results;
  const stat = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN err IS NULL OR err='' THEN 1 ELSE 0 END) AS ok FROM ig_people").first().catch(() => ({}));
  return {
    ok: true, min, checked, left,
    looked_up: Number(stat?.n) || 0, readable: Number(stat?.ok) || 0,
    followers: rows.filter((r) => Number(r.follows_us) === 1).map((r) => ({ ...r, followers: Number(r.followers) })),
    not_following: rows.filter((r) => Number(r.follows_us) !== 1).map((r) => ({ ...r, followers: Number(r.followers) })),
  };
}
