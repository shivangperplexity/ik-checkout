import test from 'node:test';
import assert from 'node:assert/strict';
import { arrange } from './merch.js';

test('earners lead, every 4th is a slow seller (rotating), sold out last', () => {
  const p = (id, score, available = true) => ({ id, score, available });
  const list = [p('a', 900), p('b', 800), p('c', 700), p('d', 600), p('e', 0), p('f', 0), p('g', 0), p('h', 0), p('i', 0), p('x', 999, false)];
  const r = arrange(list, { seed: 0 });
  assert.deepEqual(r.slice(0, 4), ['a', 'b', 'c', 'e']);
  assert.equal(r[r.length - 1], 'x');
  assert.equal(r.length, list.length);
  assert.notDeepEqual(arrange(list, { seed: 1 }).slice(0, 4), r.slice(0, 4));     /* a different slow seller tomorrow */
  assert.deepEqual(arrange(list, { mix: false }).slice(0, 4), ['a', 'b', 'c', 'd']);
});
