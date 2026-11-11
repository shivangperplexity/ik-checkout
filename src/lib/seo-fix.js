/**
 * One-off / on-demand SEO clean-ups on the Shopify catalogue, run from the dashboard (admin action seo_alts).
 * Image alt text: every product photo gets an alt that names the product, so Google Images and AI search
 * know what the picture shows. Alts that already name the product are kept.
 */
import { gql } from './shopify.js';

const SKIN = /skin|applied|after|wear|wrist|arm|hand|neck|leg|ankle|back|model|on (her|him)/i;
export function altFor(title, alt, i) {
  const t = String(title || '').trim(), a = String(alt || '').trim();
  if (a && a.toLowerCase().includes(t.toLowerCase())) return null;           // already names the product
  if (i === 0) return `${t} – semi-permanent tattoo design`;
  if (SKIN.test(a)) return `${t} – semi-permanent tattoo on skin`;
  return `${t} – semi-permanent tattoo, photo ${i + 1}`;
}

export async function fixAlts(env, { dry = true, max = 2000, full = false } = {}) {
  const changes = []; let after = null, products = 0;
  for (let p = 0; p < 10; p++) {
    const d = await gql(env, `query($after:String){ products(first:50, after:$after, query:"status:active"){ nodes{ title
      media(first:20){ nodes{ id alt mediaContentType status } } } pageInfo{ hasNextPage endCursor } } }`, { after });
    for (const pr of d.products.nodes) {
      products++;
      pr.media.nodes.forEach((m, i) => {
        if (m.mediaContentType !== 'IMAGE' || m.status !== 'READY') return;
        const alt = altFor(pr.title, m.alt, i);
        if (alt && alt !== m.alt) changes.push({ id: m.id, alt, was: m.alt || '' });
      });
    }
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  const todo = changes.slice(0, max);
  if (dry) return { dry: true, products, changes: changes.length, sample: todo.slice(0, 8), ...(full ? { all: todo.map((c) => [c.id.split('/').pop(), c.alt]) } : {}) };
  let ok = 0; const errors = [];
  for (let i = 0; i < todo.length; i += 50) {
    const d = await gql(env, 'mutation($f:[FileUpdateInput!]!){ fileUpdate(files:$f){ files{ id } userErrors{ field message } } }',
      { f: todo.slice(i, i + 50).map(({ id, alt }) => ({ id, alt })) });
    ok += d.fileUpdate.files?.length || 0;
    errors.push(...(d.fileUpdate.userErrors || []).map((e) => e.message));
  }
  return { products, changes: changes.length, updated: ok, errors: errors.slice(0, 5) };
}

/** Collection page copy (src/lib/seo-collections.json): 150-200 words with question headings, plus fixed meta descriptions. */
export async function applyCollections(env, { dry = true } = {}) {
  const { default: list } = await import('./seo-collections.js');
  if (dry) return { dry: true, collections: list.length, handles: list.map((c) => c.handle) };
  const done = [], errors = [];
  for (const c of list) {
    const input = { id: c.id, descriptionHtml: c.descriptionHtml, ...(c.seo ? { seo: c.seo } : {}) };
    try {
      const d = await gql(env, 'mutation($i:CollectionInput!){ collectionUpdate(input:$i){ collection{ handle } userErrors{ message } } }', { i: input });
      const e = d.collectionUpdate.userErrors; if (e?.length) errors.push(`${c.handle}: ${e[0].message}`); else done.push(c.handle);
    } catch (e) { errors.push(`${c.handle}: ${e.message}`); }
  }
  return { updated: done.length, errors };
}

/** Fetches store pages (optionally a theme preview) and reports what search engines see: title, description,
 *  canonical, H1s, JSON-LD types (and parse errors) and any Liquid errors. Only www.inkkulture.in URLs. */
export function inspectHtml(html) {
  const pick = (re) => (html.match(re) || [])[1] || '';
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => {
    try {
      const j = JSON.parse(m[1]);
      const nodes = j['@graph'] || [j];
      return nodes.map((n) => n['@type'] + (n.aggregateRating ? `(rating ${n.aggregateRating.ratingValue}/${n.aggregateRating.reviewCount})` : '') + (n.mainEntity?.length ? `(${n.mainEntity.length})` : '')).join('+');
    } catch (e) { return 'PARSE ERROR: ' + e.message.slice(0, 80) + ' :: ' + m[1].slice(0, 120); }
  });
  return {
    title: pick(/<title>([\s\S]*?)<\/title>/i).replace(/\s+/g, ' ').trim(),
    description: pick(/<meta\s+name="description"\s+content="([^"]*)"/i),
    canonical: pick(/<link\s+rel="canonical"\s+href="([^"]*)"/i),
    og_image: !!pick(/property="og:image"\s+content="([^"]*)"/i),
    h1: [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').trim()).slice(0, 3),
    jsonld: ld,
    jsonld_raw: [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim().slice(0, 220)),
    liquid_errors: [...html.matchAll(/Liquid (?:syntax )?error[^<]{0,160}/gi)].map((m) => m[0]).slice(0, 5),
    has_crumbs: html.includes('ikl-crumbs'), has_reviews: html.includes('ikl-prv__sum'), has_copy: html.includes('ikl-ccopy'), has_pages: html.includes('ikl-cpages'),
    bytes: html.length,
  };
}
export async function seoCheck(env, { urls = [], theme = '' } = {}) {
  const out = [];
  for (const u of urls.slice(0, 8)) {
    const url = new URL(u, 'https://www.inkkulture.in');
    if (url.hostname !== 'www.inkkulture.in') { out.push({ url: u, error: 'host not allowed' }); continue; }
    if (theme) url.searchParams.set('preview_theme_id', String(theme).replace(/\D/g, ''));
    try {
      /* a theme preview answers with a redirect that sets a cookie: follow by hand, carrying the cookies */
      let cur = url.toString(), r, jar = {};
      for (let i = 0; i < 6; i++) {
        r = await fetch(cur, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IK-SEO-check)', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, redirect: 'manual' });
        for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const k = kv.split('=')[0]; jar[k] = kv.slice(k.length + 1); }
        if (r.status < 300 || r.status >= 400) break;
        cur = new URL(r.headers.get('location'), cur).toString();
      }
      const html = await r.text();
      out.push({ url: url.pathname, status: r.status, theme: (html.match(/Shopify\.theme\s*=\s*\{[^}]*"id":(\d+)/) || [])[1] || '', ...inspectHtml(html) });
    } catch (e) { out.push({ url: u, error: e.message }); }
  }
  return { pages: out };
}

/** Blog posts: SEO title/description, question H2s, related links (src/lib/seo-articles.js). */
export function patchBody(body, h, r) {
  let b = String(body || '');
  for (const [from, to] of Object.entries(h || {})) b = b.split(`>${from}</h2>`).join(`>${to}</h2>`);
  if (r && !b.includes('ik-related')) b += `\n<p class="ik-related"><strong>Related:</strong> ${r}</p>`;
  return b;
}
export async function applyArticles(env, { dry = true } = {}) {
  const { default: list } = await import('./seo-articles.js');
  const done = [], errors = [];
  for (const a of list) {
    const gid = `gid://shopify/Article/${a.id}`;
    try {
      const cur = (await gql(env, 'query($id:ID!){ article(id:$id){ body } }', { id: gid })).article;
      const body = patchBody(cur.body, a.h, a.r);
      const hit = Object.keys(a.h).filter((k) => cur.body.includes(`>${k}</h2>`)).length;
      if (dry) { done.push({ id: a.id, h2_found: hit, of: Object.keys(a.h).length }); continue; }
      const d = await gql(env, 'mutation($id:ID!,$a:ArticleUpdateInput!){ articleUpdate(id:$id, article:$a){ article{ id } userErrors{ message } } }', { id: gid, a: { body,
        metafields: [{ namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: a.t }, { namespace: 'global', key: 'description_tag', type: 'single_line_text_field', value: a.d }] } });
      const e = d.articleUpdate.userErrors; if (e?.length) errors.push(`${a.id}: ${e[0].message}`); else done.push({ id: a.id, h2: hit });
    } catch (e) { errors.push(`${a.id}: ${e.message.slice(0, 160)}`); }
  }
  return { dry, done, errors };
}
