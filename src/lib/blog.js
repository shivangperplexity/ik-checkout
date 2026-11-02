/**
 * SEO blog engine (Nov 2026): writes and publishes articles to the Shopify blog "News" every day, on the 5-minute cron.
 *   - Settings > blog: on, per_day (default 12), hours 7-22 IST, blog id, author
 *   - one article per cron run (spaced ~every 15 min of the day window) until the day's quota is done
 *   - topics: a long rotating list (TOPICS) + the LLM's own angle, never the same title twice (table blog_posts)
 *   - writer: the same LLM the WhatsApp assistant uses (lib/wa-ai.js aiCfg), asked for a human, first-person-plural,
 *     India-specific piece with its own structure each time; the text is checked for near-duplicates of earlier posts
 *     (shingle overlap) and rejected if too close, so posts never repeat each other
 *   - published through the Admin API articleCreate with tags, summary and a product link block at the end
 */
import { gql } from './shopify.orig.js';
import { claim } from './once.js';

const now = () => Math.floor(Date.now() / 1000);
const IST = 19800;
const istHour = () => new Date((now() + IST) * 1000).getUTCHours();
const istDay = () => new Date((now() + IST) * 1000).toISOString().slice(0, 10);

export const BLOG_DEFAULTS = { on: true, per_day: 12, from: 7, to: 22, blog_id: 'gid://shopify/Blog/107386700011', author: 'Ink Kulture', min_words: 900 };
export const blogCfg = (env) => ({ ...BLOG_DEFAULTS, ...(env.SETTINGS?.blog || {}) });

/* Topic seeds: the writer picks an angle and a title of its own around one of these. Hundreds of combinations with the
   audience / occasion / placement lists below, so the queue does not run dry for months. */
export const TOPICS = [
  'how semi-permanent tattoos work and what the ink actually is', 'how long a semi-permanent tattoo lasts and what shortens it',
  'how to apply a semi-permanent tattoo so it lasts the full two weeks', 'how to remove a semi-permanent tattoo early without hurting the skin',
  'semi-permanent vs temporary sticker tattoos vs permanent tattoos', 'are semi-permanent tattoos safe for sensitive skin',
  'why the design looks faint on day one and darker on day two', 'where on the body a semi-permanent tattoo lasts longest',
  'semi-permanent tattoos for a wedding week: sangeet, mehendi, reception', 'tattoo ideas for a college fest or farewell',
  'tattoo ideas for a beach holiday that will fade before you are back at work', 'can you shower, swim or go to the gym with a semi-permanent tattoo',
  'trying a design before committing to a permanent tattoo', 'matching tattoos for couples that do not have to be forever',
  'small tattoo ideas for the wrist, ankle and behind the ear', 'arm band tattoo designs for men', 'full sleeve tattoos without the needle',
  'script and lettering tattoos: fonts, placements and what to write', 'spiritual and Indic tattoo designs: Om, Trishul, Shiva, Shakti, lotus',
  'tattoo ideas for Diwali, Christmas and New Year parties', 'what to tell your parents about a semi-permanent tattoo',
  'how to photograph a semi-permanent tattoo so it looks real on Instagram', 'skin care before and after applying a tattoo',
  'how Ink Kulture designs are made for Indian skin tones', 'buy 1 get 1: how to pair two designs that work together',
  'minimal fine-line tattoo ideas', 'bold blackwork tattoo ideas', 'animal tattoo designs and what they mean', 'flower tattoo designs and what they mean',
  'tattoo placement for different outfits: sarees, kurtas, crop tops, sleeveless', 'tattoos for men who have never had one',
  'tattoos for office-goers that are gone by Monday', 'how to pick a tattoo size that suits the placement',
  'the history of temporary tattoos in India, from mehendi to today', 'common mistakes people make when applying a tattoo at home',
  'how cash on delivery works for a small online tattoo order and why prepaid gets a discount', 'what to expect when your Ink Kulture order arrives',
  'tattoo ideas by zodiac sign', 'tattoo ideas by personality: introvert, extrovert, dreamer', 'tattoos as a gift: when it works and when it does not',
  'semi-permanent tattoos for kids parties and school events: what is safe', 'dark skin and tattoo visibility: what to choose',
  'how to make a semi-permanent tattoo last longer than two weeks', 'why some tattoos peel early and how to avoid it',
];
const ANGLES = ['a practical how-to', 'a myth-busting explainer', 'a listicle with concrete design suggestions', 'a first-person story from the team',
  'a question-and-answer piece built from real customer questions', 'a comparison with a clear verdict', 'a seasonal guide', 'a beginner guide'];
const AUDIENCES = ['college students', 'brides and their friends', 'men trying a tattoo for the first time', 'people who work in offices', 'couples',
  'parents of teenagers', 'gym-goers', 'travellers', 'people who already have permanent tattoos', 'anyone curious but nervous'];

const SYSTEM = `You write blog posts for Ink Kulture (inkkulture.in), an Indian semi-permanent tattoo brand. Facts you must respect:
- Semi-permanent tattoos: a printed design transferred onto the skin; the ink develops darker over 24-48 hours and lasts up to 2 weeks depending on placement and skin; waterproof, no needles, no pain; removed early by exfoliating.
- Designs from 5.5 x 5.5 cm to full sleeves (15.5 x 46.5 cm), priced about Rs 399 to Rs 1,199. Buy 1 Get 1 Free on every design (the lower-priced of each pair is free at checkout, no code). Cash on delivery available across India; paying online gets a discount.
- Made for Indian skin tones. Team: CEO Shivang Gupta, CFO Sristi Gupta, COO Shivam Mali (mention them only when natural, never in every post).
Writing rules: sound like a real person on the team, not a brochure. Specific, concrete, a little opinionated. Short paragraphs. Indian context (festivals, weddings, weather, offices, hostels). No clichés like "in today's fast-paced world", no "unleash", no "elevate", no exclamation marks, no emojis. Never invent studies, statistics, doctors or customer names. British/Indian English. Do not copy or paraphrase any existing article; use your own structure and examples.
Output strict JSON only: {"title": "...", "handle": "kebab-case-url-slug", "summary": "one or two sentences, plain text", "tags": ["3-6 tags"], "body_html": "<p>...</p> with <h2> sections, <ul>/<ol> where useful, 900-1300 words, no <h1>, no inline styles, no images"}`;

/** titles already published (and the posts' text), for the duplicate check */
async function history(env, limit = 400) {
  const rows = (await env.DB.prepare('SELECT title, topic, shingles FROM blog_posts ORDER BY id DESC LIMIT ?').bind(limit).all()).results;
  return rows;
}
const words = (html) => String(html).replace(/<[^>]+>/g, ' ').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
/** 5-word shingles, hashed and sampled (every 7th), as a compact signature */
export function shingles(html) {
  const w = words(html), out = new Set();
  for (let i = 0; i + 5 <= w.length; i++) { const s = w.slice(i, i + 5).join(' '); let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; if (h % 7 === 0) out.add(h); }
  return [...out];
}
export function overlap(a, b) { if (!a.length || !b.length) return 0; const B = new Set(b); let n = 0; for (const x of a) if (B.has(x)) n++; return n / Math.min(a.length, b.length); }

function pickTopic(hist) {
  const used = new Map(); for (const h of hist) used.set(h.topic, (used.get(h.topic) || 0) + 1);
  const least = Math.min(...TOPICS.map((t) => used.get(t) || 0));
  const pool = TOPICS.filter((t) => (used.get(t) || 0) === least);
  const r = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return { topic: r(pool), angle: r(ANGLES), audience: r(AUDIENCES) };
}

export async function writePost(env, { topic, angle, audience, avoidTitles = [] }) {
  const { aiCfg, callModel } = await import('./wa-ai.js');
  const { PROVIDERS } = await import('./wa-ai.js');
  const c = aiCfg(env); if (!c.key) throw new Error('No AI key (Settings > AI)');
  const P = PROVIDERS[c.provider];
  const user = `Write one post. Topic: ${topic}. Treat it as ${angle}, written for ${audience}. Pick a specific, searchable title (people type it into Google) that is NOT any of these already-used titles: ${avoidTitles.slice(0, 60).map((t) => JSON.stringify(t)).join(', ') || 'none yet'}. Include one natural link to https://www.inkkulture.in/collections/all-tattoos with anchor text that fits the sentence, and at most one more to a relevant collection (bestsellers, arm-band-tattoos, full-sleeve-tattoos, script-cursive, minimal-fineline, blackwork-bold, navratri-collection). End with a short, useful closing paragraph, not a sales pitch.`;
  const { r, j, out } = await callModel(c, P, SYSTEM, [{ role: 'user', content: user }], { max_tokens: 3500, timeout: 60000 });
  if (!r.ok) throw new Error(`${c.provider} ${r.status}: ${j.error?.message || 'no answer'}`);
  const m = /\{[\s\S]*\}/.exec(out); if (!m) throw new Error('writer did not return JSON');
  let p; try { p = JSON.parse(m[0]); } catch { throw new Error('writer JSON unreadable'); }
  if (!p.title || !p.body_html) throw new Error('writer left out title/body');
  p.handle = String(p.handle || p.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  p.tags = Array.isArray(p.tags) ? p.tags.map(String).slice(0, 6) : ['semi-permanent tattoo'];
  if (!p.tags.some((t) => /semi/i.test(t))) p.tags.unshift('semi-permanent tattoo');
  p.words = words(p.body_html).length;
  return p;
}

export async function publishPost(env, p, cfg = blogCfg(env)) {
  const d = await gql(env, `mutation($a: ArticleCreateInput!) { articleCreate(article: $a) { article { id handle } userErrors { field message } } }`, {
    a: { blogId: cfg.blog_id, title: p.title, handle: p.handle, author: { name: cfg.author }, body: p.body_html, summary: `<p>${String(p.summary || '').replace(/<[^>]+>/g, '')}</p>`, tags: p.tags, isPublished: true },
  });
  const e = d.articleCreate.userErrors; if (e?.length) throw new Error(e.map((x) => x.message).join('; '));
  return d.articleCreate.article;
}

/** One cron tick: publish at most one post, inside the day window, until per_day is reached. */
export async function blogTick(env, { force = false, dry = false } = {}) {
  const cfg = blogCfg(env);
  if (!cfg.on && !force) return { skipped: 'off' };
  const h = istHour(); if (!force && (h < cfg.from || h >= cfg.to)) return { skipped: 'night' };
  const day = istDay();
  const today = Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM blog_posts WHERE day=?').bind(day).first())?.n) || 0;
  if (!force && today >= cfg.per_day) return { skipped: 'quota', today };
  /* spread the quota across the window: one post per slot */
  const slotMin = Math.max(5, Math.floor(((cfg.to - cfg.from) * 60) / cfg.per_day));
  if (!dry && !(await claim(env, 'blog:tick', force ? 1 : slotMin * 60 - 30))) return { skipped: 'slot', today };
  const hist = await history(env);
  const pick = pickTopic(hist);
  let post, tries = 0, reason = '';
  while (tries++ < 3) {
    post = await writePost(env, { ...pick, avoidTitles: hist.map((x) => x.title) });
    if (post.words < cfg.min_words * 0.7) { reason = `too short (${post.words} words)`; continue; }
    if (hist.some((x) => x.title.toLowerCase() === post.title.toLowerCase())) { reason = 'title used'; continue; }
    const sig = shingles(post.body_html);
    const near = hist.map((x) => overlap(sig, JSON.parse(x.shingles || '[]'))).reduce((a, b) => Math.max(a, b), 0);
    if (near > 0.18) { reason = `too similar to an earlier post (${Math.round(near * 100)}%)`; continue; }
    post.shingles = sig; reason = ''; break;
  }
  if (reason) { console.error('blog', reason); return { error: reason, topic: pick.topic }; }
  if (dry) return { dry: true, pick, post: { title: post.title, handle: post.handle, summary: post.summary, tags: post.tags, words: post.words, body_html: post.body_html } };
  /* handle collision with an existing article: add a suffix */
  const taken = await env.DB.prepare('SELECT 1 FROM blog_posts WHERE handle=?').bind(post.handle).first();
  if (taken) post.handle = `${post.handle}-${Math.floor(Date.now() / 1000) % 10000}`;
  const art = await publishPost(env, post, cfg);
  await env.DB.prepare('INSERT INTO blog_posts (day, title, handle, topic, angle, audience, words, tags, article_id, shingles, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .bind(day, post.title, art.handle, pick.topic, pick.angle, pick.audience, post.words, post.tags.join(','), art.id, JSON.stringify(post.shingles), now()).run();
  return { published: { title: post.title, handle: art.handle, words: post.words, topic: pick.topic }, today: today + 1 };
}

export async function blogStatus(env) {
  const cfg = blogCfg(env);
  const rows = (await env.DB.prepare('SELECT day, title, handle, topic, words, created_at FROM blog_posts ORDER BY id DESC LIMIT 60').all()).results;
  const days = {}; for (const r of rows) days[r.day] = (days[r.day] || 0) + 1;
  return { ok: true, cfg, today: istDay(), by_day: days, recent: rows.map((r) => ({ ...r, url: `https://www.inkkulture.in/blogs/news/${r.handle}` })) };
}
