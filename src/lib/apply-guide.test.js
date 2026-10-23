import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTemplate, applyVideo, APPLY_TEXT, ytId, DEFAULT_VIDEO } from './apply-guide.js';

test('apply guide template: steps, honest lasting line, YouTube button, under the WhatsApp limit', () => {
  const t = applyTemplate();
  assert.equal(t.components[1].buttons[0].url, 'https://youtu.be/{{1}}');
  assert.ok(APPLY_TEXT.length < 1024);
  assert.match(APPLY_TEXT, /semi-permanent/); assert.match(APPLY_TEXT, /1-2 weeks/);
  assert.doesNotMatch(APPLY_TEXT, /permanent tattoo|baby oil/i);
});

test('video link: a YouTube link from settings, else the Ink Kulture video', () => {
  assert.equal(ytId('https://youtu.be/0GMHG7WmaL8?si=5huTzsF-HePgApkv'), '0GMHG7WmaL8');
  assert.equal(ytId('https://www.youtube.com/watch?v=0GMHG7WmaL8&t=3'), '0GMHG7WmaL8');
  assert.equal(ytId('https://youtube.com/shorts/0GMHG7WmaL8'), '0GMHG7WmaL8');
  assert.equal(ytId('https://x/v.mp4'), '');
  assert.equal(applyVideo({ SETTINGS: { apply: { video: '' } } }), DEFAULT_VIDEO);
  assert.equal(applyVideo({ SETTINGS: { apply: { video: 'https://youtu.be/abcdefghijk' } } }), 'https://youtu.be/abcdefghijk');
});
