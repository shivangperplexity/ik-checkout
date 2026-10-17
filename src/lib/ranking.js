// src/lib/ranking.js — product order in the main collections (Bestsellers, All Tattoos, Home page).
//
// Shopify's "Best selling" sort puts sold-out designs among the top sellers and shows only small designs first
// (small ones sell the most units). This keeps the best-selling order but:
//   - sold-out designs go to the end;
//   - in the first 24 places a few bigger designs are mixed in, so every size is seen early:
//       medium (forearm / band, tags size-b..e, 6x10cm, 10x4cm) at places 4, 10, 16, 22,
//       large (tag size-large) at places 6, 12, 18, 24 — the best-selling ones of each size;
//   - everything after place 24 stays in best-selling order.
// The collections are switched to "Manual" sort so Shopify keeps this order; the cron re-ranks them daily so new
// sales, new products and stock changes are picked up.

const now = () => Math.floor(Date.now() / 1000);
export const RANK_COLLECTIONS = ['bestsellers', 'all-tattoos', 'frontpage'];
const MEDIUM = ['size-b', 'size-c', 'size-d', 'size-e', '6x10cm', '10x4cm'];

export function sizeOf(tags = []) {
  const t = tags.map((x) => String(x).toLowerCase());
  if (t.includes('size-large') || t.some((x) => /^size-[fghi]$/.test(x))) return 'large';
  if (t.some((x) => MEDIUM.includes(x))) return 'medium';
  return 'small';
}

/** list: [{ id, available, size }] in best-selling order → ids in the new order. Pure. */
export function rankOrder(list, { top = 24, mediumAt = [3, 9, 15, 21], largeAt = [5, 11, 17, 23] } = {}) {
  const avail = list.filter((p) => p.available), sold = list.filter((p) => !p.available);
  const used = new Set(), out = [];
  const next = (pred) => { const p = avail.find((x) => !used.has(x.id) && pred(x)); if (p) used.add(p.id); return p; };
  for (let i = 0; i < Math.min(top, avail.length); i++) {
    const want = mediumAt.includes(i) ? 'medium' : largeAt.includes(i) ? 'large' : null;
    const p = (want && next((x) => x.size === want)) || next(() => true);
    if (p) out.push(p.id);
  }
  for (const p of avail) if (!used.has(p.id)) out.push(p.id);
  for (const p of sold) out.push(p.id);
  return out;
}

async function collectionProducts(gql, handle, sortKey) {
  let after = null, coll = null;
  const nodes = [];
  do {
    const d = await gql(`query($h:String!,$a:String){ collectionByHandle(handle:$h){ id sortOrder products(first:250, after:$a, sortKey:${sortKey}){
      nodes{ id tags totalInventory tracksInventory variants(first:20){ nodes{ availableForSale } } } pageInfo{ hasNextPage endCursor } } } }`, { h: handle, a: after });
    coll = d.collectionByHandle;
    if (!coll) return null;
    nodes.push(...coll.products.nodes);
    after = coll.products.pageInfo.hasNextPage ? coll.products.pageInfo.endCursor : null;
  } while (after);
  return { id: coll.id, sortOrder: coll.sortOrder, nodes };
}

/** Re-rank one collection. gql: (query, variables) => data. Returns { handle, products, moved, sold_out }. */
export async function rankCollection(gql, handle) {
  const c = await collectionProducts(gql, handle, 'BEST_SELLING');
  if (!c) return { handle, error: 'not found' };
  const list = c.nodes.map((p) => ({ id: p.id, size: sizeOf(p.tags), available: (p.variants?.nodes || []).some((v) => v.availableForSale) }));
  const order = rankOrder(list);
  if (c.sortOrder !== 'MANUAL') {
    const u = await gql('mutation($i:CollectionInput!){ collectionUpdate(input:$i){ userErrors{ message } } }', { i: { id: c.id, sortOrder: 'MANUAL' } });
    const e = u.collectionUpdate.userErrors; if (e?.length) throw new Error('collectionUpdate: ' + e.map((x) => x.message).join('; '));
  }
  const cur = (await collectionProducts(gql, handle, 'COLLECTION_DEFAULT')).nodes.map((p) => p.id);
  let moved = 0;
  if (cur.join() !== order.join()) {
    const moves = order.map((id, i) => ({ id, newPosition: String(i) }));
    for (let i = 0; i < moves.length; i += 250) {
      const r = await gql('mutation($id:ID!,$m:[MoveInput!]!){ collectionReorderProducts(id:$id, moves:$m){ job{ id } userErrors{ message } } }', { id: c.id, m: moves.slice(i, i + 250) });
      const e = r.collectionReorderProducts.userErrors; if (e?.length) throw new Error('collectionReorderProducts: ' + e.map((x) => x.message).join('; '));
    }
    moved = order.length;
  }
  return { handle, products: list.length, moved, sold_out: list.filter((p) => !p.available).length };
}

/** Daily from the cron (and "Re-rank now" in Settings). Stores the result in settings.rank_status. */
export async function rankAll(env, { force = false } = {}) {
  const st = await env.DB.prepare("SELECT v FROM settings WHERE k='rank_status'").first().catch(() => null);
  let last = {}; try { last = JSON.parse(st?.v || '{}'); } catch { last = {}; }
  if (!force && now() - Number(last.at || 0) < 20 * 3600) return { skipped: true, last };
  const { gql } = await import('./shopify.js');
  const results = [];
  let error = '';
  for (const h of RANK_COLLECTIONS) {
    try { results.push(await rankCollection((q, v) => gql(env, q, v), h)); }
    catch (e) {
      error = String(e.message || e).slice(0, 300);
      if (/access denied|write_products|not approved/i.test(error)) error = 'The IK app needs the "write_products" scope to keep product order (Shopify Dev Dashboard → your app → Versions → add write_products → release, then re-install). ' + error;
      results.push({ handle: h, error });
    }
  }
  const status = { at: now(), ok: !error, error, results };
  await env.DB.prepare("INSERT INTO settings (k,v) VALUES ('rank_status',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(status)).run();
  return status;
}
