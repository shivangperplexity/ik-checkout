import test from 'node:test';
import assert from 'node:assert/strict';
import { rankOrder, sizeOf, rankCollection } from './ranking.js';

test('size from tags', () => {
  assert.equal(sizeOf(['size-a', '5.5x5.5cm']), 'small');
  assert.equal(sizeOf(['size-c']), 'medium');
  assert.equal(sizeOf(['10x4cm']), 'medium');
  assert.equal(sizeOf(['size-large', 'size-f']), 'large');
});

test('sold out last, a few bigger designs in the first 24, rest best-selling', () => {
  const list = Array.from({ length: 60 }, (_, i) => ({ id: 'p' + i, available: i !== 0 && i !== 7, size: i % 10 === 9 ? 'large' : i % 10 === 4 ? 'medium' : 'small' }));
  const o = rankOrder(list);
  assert.equal(o.length, 60);
  assert.deepEqual(o.slice(-2), ['p0', 'p7']);
  const size = (id) => list.find((x) => x.id === id).size;
  assert.equal(size(o[3]), 'medium'); assert.equal(size(o[5]), 'large'); assert.equal(size(o[11]), 'large');
  assert.equal(o[0], 'p1');                                                   // best seller still first
  assert.equal(new Set(o).size, 60);
  assert.ok(o.slice(0, 24).filter((id) => size(id) === 'large').length <= 6);  // a few, not all
});

test('rankCollection switches to manual and moves products', async () => {
  const calls = [];
  const nodes = [{ id: 'a', tags: [], variants: { nodes: [{ availableForSale: false }] } }, { id: 'b', tags: ['size-large'], variants: { nodes: [{ availableForSale: true }] } }, { id: 'c', tags: [], variants: { nodes: [{ availableForSale: true }] } }];
  const gql = async (q, v) => {
    calls.push(q.slice(0, 40));
    if (/collectionByHandle/.test(q)) return { collectionByHandle: { id: 'C', sortOrder: 'BEST_SELLING', products: { nodes, pageInfo: { hasNextPage: false } } } };
    if (/collectionUpdate/.test(q)) return { collectionUpdate: { userErrors: [] } };
    if (/collectionReorderProducts/.test(q)) { calls.push(JSON.stringify(v.m)); return { collectionReorderProducts: { userErrors: [] } }; }
  };
  const r = await rankCollection(gql, 'bestsellers');
  assert.deepEqual(r, { handle: 'bestsellers', products: 3, moved: 3, sold_out: 1 });
  assert.ok(calls.some((c) => /collectionUpdate/.test(c)));
  assert.match(calls.find((c) => c.startsWith('[')), /"id":"c","newPosition":"0".*"id":"b","newPosition":"1".*"id":"a","newPosition":"2"/);
});
