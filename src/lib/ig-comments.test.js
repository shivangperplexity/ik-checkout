import test from 'node:test';
import assert from 'node:assert/strict';
import { emojiOnly, worthShowing } from './ig-comments.js';
import { DEFAULTS } from './ig-dm.js';

const c = { ...DEFAULTS, username: 'inkkulture.in' };
const cm = (text, username = 'someone') => ({ text, username });

test('emoji-only comments', () => {
  assert.equal(emojiOnly('🔥🔥🔥'), true);
  assert.equal(emojiOnly('😍 ❤️ !!'), true);
  assert.equal(emojiOnly(''), true);
  assert.equal(emojiOnly('nice 🔥'), false);
  assert.equal(emojiOnly('बहुत बढ़िया'), false);
  assert.equal(emojiOnly('10/10'), false);
});

test('shows real comments, hides link asks, tags and our own', () => {
  assert.equal(worthShowing(cm('This looks so real, does it smudge?'), c), true);
  assert.equal(worthShowing(cm('@friend dekh ye 😂 nice design'), c), true);
  assert.equal(worthShowing(cm('🔥🔥'), c), false);
  assert.equal(worthShowing(cm('@friend'), c), false);
  assert.equal(worthShowing(cm('@friend 😍'), c), false);
  assert.equal(worthShowing(cm('link'), c), false);
  assert.equal(worthShowing(cm('Linkkk pls'), c), false);
  assert.equal(worthShowing(cm('price?'), c), false);
  assert.equal(worthShowing(cm('Lonk'), c), false);
  assert.equal(worthShowing(cm('lnk pls'), c), false);
  assert.equal(worthShowing(cm('Like'), c), true);
  assert.equal(worthShowing(cm('0'), c), false);
  assert.equal(worthShowing(cm('How to remove this ??'), c), true);
  assert.equal(worthShowing(cm('Thank you!', 'inkkulture.in'), c), false);
});
