import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTemplate, applyVideo, APPLY_TEXT } from './apply-guide.js';

test('apply guide template: video header, honest lasting line, under the WhatsApp limit', () => {
  const t = applyTemplate();
  assert.equal(t.components[0].format, 'VIDEO');
  assert.ok(APPLY_TEXT.length < 1024);
  assert.match(APPLY_TEXT, /semi-permanent/);
  assert.match(APPLY_TEXT, /1-2 weeks/);
  assert.doesNotMatch(APPLY_TEXT, /permanent tattoo|baby oil/i);
});

test('video link: settings link, else the bundled file only when marked present', () => {
  assert.equal(applyVideo({ SETTINGS: { apply: { video: '' } } }), '');
  assert.equal(applyVideo({ SETTINGS: { apply: { video: 'http://x/v.mp4' } } }), '');
  assert.equal(applyVideo({ SETTINGS: { apply: { video: 'https://x/v.mp4' } } }), 'https://x/v.mp4');
  assert.equal(applyVideo({ WORKER_URL: 'https://a.app/', SETTINGS: { apply: { bundled: true } } }), 'https://a.app/media/how-to-apply.mp4');
});
