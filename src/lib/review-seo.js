/**
 * Puts real customer reviews into Shopify metafields so the theme can print them in the page HTML (and in
 * Product / AggregateRating structured data) instead of only loading them in the browser. Google and AI search
 * read the HTML; reviews that only appear after JavaScript runs are mostly invisible to them.
 *
 * Per product: a review counts for every product that was in the reviewed order (reviews.items lists the titles).
 *   reviews.rating        (rating, 1-5)   average of all real reviews for that product
 *   reviews.rating_count  (number_integer)
  *   ikseo.reviews          (json)          up to 5 published, consented reviews: [{ n, c, r, t, d }]
 * Shop: ikseo.reviews_summary (json) { count, avg, recommend, top: [...] } for the homepage / Organization block.
 *
 * Runs at most once every 20 h from the cron, or on demand from the dashboard (review_seo_sync).
 */
import { gql } from './shopify.js';
import { claim } from './once.js';

export const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const round1 = (n) => Math.round(n * 10) / 10;

/** Pure: reviews + products -> per-product stats. */
export function buildStats(reviews, products) {
  const byTitle = new Map(products.map((p) => [norm(p.title), p.id]));
  const out = new Map();
  for (const r of reviews) {
    const ids = new Set(String(r.items || '').split('·').map((x) => byTitle.get(norm(x))).filter(Boolean));
    for (const id of ids) {
      const s = out.get(id) || { sum: 0, n: 0, shown: [] };
      s.sum += Number(r.rating) || 0; s.n += 1;
      if (r.status === 'published' && r.consent && String(r.body || '').trim()) s.shown.push(r);
      out.set(id, s);
    }
  }
  for (const s of out.values()) {
    s.avg = round1(s.sum / s.n);
    s.shown = s.shown.sort((a, b) => (b.pinned - a.pinned) || (Number(b.created_at) - Number(a.created_at))).slice(0, 5).map(card);
  }
  return out;
}
export function card(r) {
  return { n: String(r.name || 'Customer').slice(0, 40), c: String(r.city || '').slice(0, 40), r: Number(r.rating) || 5, t: String(r.body || '').slice(0, 400), d: new Date(Number(r.created_at) * 1000).toISOString().slice(0, 10) };
}

async function allProducts(env) {
  const out = []; let after = null;
  for (let i = 0; i < 10; i++) {
    const d = await gql(env, `query($after:String){ products(first:100, after:$after, query:"status:active"){ nodes{ id title
      mc: metafield(namespace:"reviews", key:"rating_count"){ id value } } pageInfo{ hasNextPage endCursor } } }`, { after });
    out.push(...d.products.nodes);
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  return out;
}

async function setAll(env, mfs) {
  let ok = 0; const errors = [];
  for (let i = 0; i < mfs.length; i += 25) {
    const d = await gql(env, `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ metafields{ id } userErrors{ field message } } }`, { m: mfs.slice(i, i + 25) });
    ok += d.metafieldsSet.metafields?.length || 0;
    errors.push(...(d.metafieldsSet.userErrors || []).map((e) => e.message));
  }
  return { ok, errors: errors.slice(0, 5) };
}

export async function reviewSeoSync(env, { force = false, dry = false } = {}) {
  if (!force && !(await claim(env, 'review-seo-sync', 20 * 3600))) return { skipped: true };
  const reviews = (await env.DB.prepare('SELECT id, name, city, rating, body, items, status, consent, pinned, created_at FROM reviews WHERE NOT test').all()).results;
  const products = await allProducts(env);
  const stats = buildStats(reviews, products);
  const mfs = [];
  for (const [id, s] of stats) {
    mfs.push({ ownerId: id, namespace: 'reviews', key: 'rating', type: 'rating', value: JSON.stringify({ value: s.avg.toFixed(1), scale_min: '1.0', scale_max: '5.0' }) });
    mfs.push({ ownerId: id, namespace: 'reviews', key: 'rating_count', type: 'number_integer', value: String(s.n) });
    mfs.push({ ownerId: id, namespace: 'ikseo', key: 'reviews', type: 'json', value: JSON.stringify(s.shown) });
  }
  /* shop-wide summary */
  const real = reviews.length, avg = real ? round1(reviews.reduce((a, r) => a + (Number(r.rating) || 0), 0) / real) : 0;
  const good = reviews.filter((r) => Number(r.rating) >= 4).length;
  const top = reviews.filter((r) => r.status === 'published' && r.consent && String(r.body || '').trim())
    .sort((a, b) => (b.pinned - a.pinned) || (Number(b.created_at) - Number(a.created_at))).slice(0, 6).map(card);
  const shop = (await gql(env, '{ shop { id } }')).shop.id;
  mfs.push({ ownerId: shop, namespace: 'ikseo', key: 'reviews_summary', type: 'json', value: JSON.stringify({ count: real, avg, recommend: real ? Math.round((good / real) * 100) : 0, top }) });
  /* products whose reviews were all removed: drop the stale rating */
  const stale = products.filter((p) => p.mc && !stats.has(p.id)).map((p) => p.id);
  if (dry) return { dry: true, products: stats.size, metafields: mfs.length, stale: stale.length, sample: [...stats].slice(0, 3).map(([id, s]) => ({ id, avg: s.avg, n: s.n, shown: s.shown.length })) };
  const r = await setAll(env, mfs);
  if (stale.length) {
    const ids = stale.flatMap((id) => [['reviews', 'rating'], ['reviews', 'rating_count'], ['ikseo', 'reviews']].map(([namespace, key]) => ({ ownerId: id, namespace, key })));
    await gql(env, 'mutation($m:[MetafieldIdentifierInput!]!){ metafieldsDelete(metafields:$m){ userErrors{ message } } }', { m: ids }).catch((e) => r.errors.push(e.message));
  }
  return { products: stats.size, written: r.ok, stale: stale.length, errors: r.errors, shop: { count: real, avg } };
}
