/**
 * Product order on the store's main collections, for a bigger basket:
 *   - the products that earn the most (last 30 days: units x price, so the bigger designs that sell rank up) lead,
 *   - every 4th place goes to a design that has hardly sold, rotated daily, so the whole catalogue gets seen,
 *   - sold-out products go to the end.
 * Applied to MANUAL-sorted collections (Home page, All Tattoos, Bestsellers keeps pure "earns the most" order).
 * The previous order is saved once per collection (settings 'merch_backup:<handle>') so it can be put back.
 */
import { gql } from './shopify.orig.js';

const now = () => Math.floor(Date.now() / 1000);
export const TARGETS = [{ handle: 'frontpage', mix: true }, { handle: 'all-tattoos', mix: true }, { handle: 'bestsellers', mix: false }];

/** Pure: the new order. products = [{ id, score, available }]; seed rotates the slow sellers. */
export function arrange(products, { mix = true, every = 4, seed = 0 } = {}) {
  const inStock = products.filter((p) => p.available !== false), out = products.filter((p) => p.available === false);
  const ranked = [...inStock].sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
  if (!mix) return [...ranked, ...out].map((p) => p.id);
  const cut = Math.max(1, Math.ceil(ranked.length * 0.4));                     /* top 40% earn; the rest are "slow" */
  const top = ranked.slice(0, cut), slow = ranked.slice(cut);
  const k = slow.length ? seed % slow.length : 0;
  const slowRot = [...slow.slice(k), ...slow.slice(0, k)];
  const res = [];
  let i = 0, j = 0;
  while (i < top.length || j < slowRot.length) {
    for (let n = 0; n < every - 1 && i < top.length; n++) res.push(top[i++]);
    if (j < slowRot.length) res.push(slowRot[j++]);
    if (i >= top.length) while (j < slowRot.length) res.push(slowRot[j++]);
  }
  return [...res, ...out].map((p) => p.id);
}

/** Revenue per product over the last `days` days (₹), from Shopify orders. */
export async function salesScore(env, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const score = {};
  let after = null;
  for (let page = 0; page < 6; page++) {
    const d = await gql(env, `query($q:String,$a:String){ orders(first:250, after:$a, query:$q){ pageInfo{hasNextPage endCursor}
      nodes{ cancelledAt lineItems(first:20){ nodes{ quantity product{ id } originalUnitPriceSet{ shopMoney{ amount } } } } } } }`, { q: `created_at:>=${since}`, a: after });
    for (const o of d.orders.nodes) {
      if (o.cancelledAt) continue;
      for (const l of o.lineItems.nodes) { const id = l.product?.id; if (!id) continue; score[id] = (score[id] || 0) + Number(l.quantity || 0) * Math.max(1, Number(l.originalUnitPriceSet?.shopMoney?.amount || 0)); }
    }
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  return score;
}

async function collectionProducts(env, handle) {
  const out = [];
  let after = null, col = null;
  for (let page = 0; page < 6; page++) {
    const d = await gql(env, `query($h:String!,$a:String){ collectionByHandle(handle:$h){ id title sortOrder products(first:250, after:$a, sortKey:COLLECTION_DEFAULT){ pageInfo{hasNextPage endCursor} nodes{ id title totalInventory tracksInventory status } } } }`, { h: handle, a: after });
    col = d.collectionByHandle;
    if (!col) return null;
    out.push(...col.products.nodes);
    if (!col.products.pageInfo.hasNextPage) break;
    after = col.products.pageInfo.endCursor;
  }
  return { id: col.id, title: col.title, sortOrder: col.sortOrder, products: out };
}

/** Work out (and with apply=true, write) the new order for each target collection. */
export async function merchandise(env, { apply = false } = {}) {
  const score = await salesScore(env);
  const seed = Math.floor(now() / 86400);
  const out = [];
  for (const t of TARGETS) {
    const c = await collectionProducts(env, t.handle);
    if (!c) { out.push({ handle: t.handle, skipped: 'not found' }); continue; }
    if (c.sortOrder !== 'MANUAL') { out.push({ handle: t.handle, skipped: 'not manually sorted' }); continue; }
    const list = c.products.filter((p) => p.status === 'ACTIVE').map((p) => ({ id: p.id, title: p.title, score: score[p.id] || 0, available: !(p.tracksInventory && p.totalInventory <= 0) }));
    const order = arrange(list, { mix: t.mix, seed });
    const current = c.products.map((p) => p.id);
    const moves = order.map((id, i) => ({ id, newPosition: String(i) })).filter((m, i) => current[i] !== m.id);
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    const r = { handle: t.handle, title: c.title, products: list.length, sold: list.filter((p) => p.score > 0).length, moves: moves.length, first: order.slice(0, 12).map((id) => `${byId[id]?.title || id}${byId[id]?.score ? '' : ' (slow seller)'}`) };
    if (apply && moves.length) {
      const key = 'merch_backup:' + t.handle;
      const had = await env.DB.prepare('SELECT 1 AS x FROM settings WHERE k=?').bind(key).first().catch(() => null);
      if (!had) await env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO NOTHING').bind(key, JSON.stringify({ at: now(), order: current })).run();
      for (let i = 0; i < moves.length; i += 250) {
        const d = await gql(env, `mutation($id:ID!,$m:[MoveInput!]!){ collectionReorderProducts(id:$id, moves:$m){ job{ id } userErrors{ field message } } }`, { id: c.id, m: moves.slice(i, i + 250) });
        const e = d.collectionReorderProducts.userErrors;
        if (e?.length) throw new Error(`${t.handle}: ${e.map((x) => x.message).join('; ')}`);
      }
      r.applied = true;
    }
    out.push(r);
  }
  return { ok: true, scored: Object.keys(score).length, collections: out };
}

/** Put a collection back the way it was before the first reorder. */
export async function restore(env, handle) {
  const row = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind('merch_backup:' + handle).first();
  if (!row) throw new Error('No saved order for ' + handle);
  const { order } = JSON.parse(row.v);
  const c = await collectionProducts(env, handle);
  const ids = new Set(c.products.map((p) => p.id));
  const keep = order.filter((id) => ids.has(id));
  const moves = keep.map((id, i) => ({ id, newPosition: String(i) }));
  for (let i = 0; i < moves.length; i += 250) await gql(env, `mutation($id:ID!,$m:[MoveInput!]!){ collectionReorderProducts(id:$id, moves:$m){ userErrors{ message } } }`, { id: c.id, m: moves.slice(i, i + 250) });
  return { ok: true, restored: moves.length };
}

/** Cron: once a day around 3 am IST, while switched on (settings 'merch_auto'). */
export async function merchCron(env) {
  const on = await env.DB.prepare("SELECT v FROM settings WHERE k='merch_auto'").first().catch(() => null);
  if (!on) {
    /* first run (asked for on 30 Oct): apply once now, then daily at 3 am; 'Restore' in the dashboard switches it off */
    await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('merch_auto', '1') ON CONFLICT (k) DO NOTHING").run();
    await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('merch_at', ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v").bind(String(now())).run();
    const r = await merchandise(env, { apply: true });
    console.log('merch first run', JSON.stringify(r).slice(0, 3000));
    return r;
  }
  if (on.v !== '1') return { skipped: 'off' };
  const h = new Date(Date.now() + 19800000).getUTCHours();
  if (h !== 3) return { skipped: 'not 3 am' };
  const last = await env.DB.prepare("SELECT v FROM settings WHERE k='merch_at'").first().catch(() => null);
  if (last && now() - Number(last.v) < 20 * 3600) return { skipped: 'done today' };
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('merch_at', ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v").bind(String(now())).run();
  return merchandise(env, { apply: true });
}
