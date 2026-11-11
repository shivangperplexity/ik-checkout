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

export async function fixAlts(env, { dry = true, max = 2000 } = {}) {
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
  if (dry) return { dry: true, products, changes: changes.length, sample: todo.slice(0, 8) };
  let ok = 0; const errors = [];
  for (let i = 0; i < todo.length; i += 50) {
    const d = await gql(env, 'mutation($f:[FileUpdateInput!]!){ fileUpdate(files:$f){ files{ id } userErrors{ field message } } }',
      { f: todo.slice(i, i + 50).map(({ id, alt }) => ({ id, alt })) });
    ok += d.fileUpdate.files?.length || 0;
    errors.push(...(d.fileUpdate.userErrors || []).map((e) => e.message));
  }
  return { products, changes: changes.length, updated: ok, errors: errors.slice(0, 5) };
}
