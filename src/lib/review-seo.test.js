import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStats, norm } from './review-seo.js';

test('review stats: a review counts for every product in the order; only consented published text is shown', () => {
  const products = [{ id: 'P1', title: 'Scorpion Tattoo' }, { id: 'P2', title: 'Samurai & Cherry Blossom Tattoo' }, { id: 'P3', title: 'Other' }];
  const reviews = [
    { rating: 5, items: 'Scorpion Tattoo · Samurai & Cherry Blossom Tattoo', status: 'published', consent: true, body: 'Great', name: 'A', created_at: 1793000000 },
    { rating: 3, items: 'scorpion tattoo', status: 'new', consent: true, body: 'ok', name: 'B', created_at: 1793100000 },
    { rating: 1, items: 'Scorpion Tattoo', status: 'published', consent: false, body: 'bad', name: 'C', created_at: 1793200000 },
  ];
  const s = buildStats(reviews, products);
  assert.equal(s.get('P1').n, 3); assert.equal(s.get('P1').avg, 3);
  assert.deepEqual(s.get('P1').shown.map((r) => r.n), ['A']);
  assert.equal(s.get('P2').n, 1); assert.equal(s.has('P3'), false);
  assert.equal(norm('Samurai & Cherry Blossom Tattoo'), 'samurai and cherry blossom tattoo');
});
