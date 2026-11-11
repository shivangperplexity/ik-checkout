import { test } from 'node:test';
import assert from 'node:assert/strict';
import { altFor } from './seo-fix.js';
test('alt text names the product', () => {
  assert.equal(altFor('Vampire Fangs Tattoo', "Vampire's Grin design", 0), 'Vampire Fangs Tattoo – semi-permanent tattoo design');
  assert.equal(altFor('Vampire Fangs Tattoo', "Vampire's Grin on skin", 1), 'Vampire Fangs Tattoo – semi-permanent tattoo on skin');
  assert.equal(altFor('Vampire Fangs Tattoo', '', 2), 'Vampire Fangs Tattoo – semi-permanent tattoo, photo 3');
  assert.equal(altFor('Vampire Fangs Tattoo', 'Vampire Fangs Tattoo: first applied', 2), null);
});
import { extraCopy } from './seo-fix.js';
test('extra product copy names the design, sizes, placement and style', () => {
  const h = extraCopy({ title: 'Lotus & Vine Tattoo', variants: { nodes: [{ title: 'Small 5.5 x 5.5 cm' }] }, collections: { nodes: [{ handle: 'wrist-tattoos' }, { handle: 'flower-tattoos' }] } });
  assert.match(h, /Lotus &amp; Vine Tattoo comes in Small 5.5 x 5.5 cm/);
  assert.match(h, /the wrist/); assert.match(h, /collections\/flower-tattoos/); assert.match(h, /ik-more/);
});
