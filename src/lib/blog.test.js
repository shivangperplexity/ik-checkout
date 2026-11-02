import test from 'node:test';
import assert from 'node:assert/strict';
import { shingles, overlap, TOPICS } from './blog.js';

const para = (seed) => { let x = seed * 2654435761 >>> 0; return Array.from({ length: 400 }, () => { x = (x * 1103515245 + 12345) >>> 0; return 'w' + (x % 5000); }).join(' '); };
test('duplicate check: same text 100%, different text near 0', () => {
  const a = shingles('<p>' + para(1) + '</p>'), b = shingles('<p>' + para(1) + '</p>'), c = shingles('<p>' + para(5) + '</p>');
  assert.ok(a.length > 20);
  assert.equal(overlap(a, b), 1);
  assert.ok(overlap(a, c) < 0.3);
});
test('topic list is long and unique', () => { assert.ok(TOPICS.length >= 40); assert.equal(new Set(TOPICS).size, TOPICS.length); });
