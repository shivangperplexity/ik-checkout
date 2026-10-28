import test from 'node:test';
import assert from 'node:assert/strict';
import { wantsLink, linkFor, fill, commentsOf, DEFAULTS, handleComment } from './ig-dm.js';
import { sourceOf } from './attribution.js';

test('keywords: whole words, Hinglish, every-comment mode', () => {
  const c = { ...DEFAULTS };
  assert.equal(wantsLink('LINK please 😍', c), true);
  assert.equal(wantsLink('kitne ka hai?', c), true);
  assert.equal(wantsLink('how much is this', c), true);
  assert.equal(wantsLink('beautiful 🔥', c), false);
  assert.equal(wantsLink('linking park', c), false);
  assert.equal(wantsLink('beautiful 🔥', { ...c, mode: 'all' }), true);
});

test('link per post, tagged for the reports', () => {
  const c = { ...DEFAULTS, media: { m1: 'https://www.inkkulture.in/products/dragon?variant=1' } };
  const u = new URL(linkFor(c, 'm1'));
  assert.equal(u.pathname, '/products/dragon'); assert.equal(u.searchParams.get('variant'), '1');
  assert.equal(u.searchParams.get('utm_medium'), 'dm'); assert.equal(u.searchParams.get('utm_content'), 'm1');
  assert.equal(new URL(linkFor(c, 'other')).origin + new URL(linkFor(c, 'other')).pathname, 'https://www.inkkulture.in/');
  assert.equal(sourceOf({ landing: linkFor(c, 'm1') }).key, 'ig_dm');
  assert.equal(fill('Hi {name}: {link}', { name: '@a', link: 'L' }), 'Hi @a: L');
});

test('webhook payload -> comments; own comments, duplicates and repeat askers are skipped', async () => {
  const p = { entry: [{ id: 'ME', changes: [{ field: 'comments', value: { id: 'c1', text: 'link', from: { id: 'u1', username: 'riya' }, media: { id: 'm1' } } }, { field: 'mentions', value: {} }] }] };
  const cs = commentsOf(p);
  assert.equal(cs.length, 1); assert.equal(cs[0].media_id, 'm1');
  const rows = {}, sent = [];
  const env = { DB: { prepare: (q) => ({ bind: (...a) => ({
    first: async () => {
      if (/INSERT INTO ig_dm/.test(q)) { if (rows[a[0]]) return null; rows[a[0]] = { media: a[1], from: a[2], status: 'new' }; return { comment_id: a[0] }; }
      if (/AND status='sent' AND comment_id<>/.test(q)) return Object.entries(rows).some(([k, r]) => r.media === a[0] && r.from === a[1] && r.status === 'sent' && k !== a[2]) ? { x: 1 } : null;
      if (/COUNT\(\*\)/.test(q)) return { n: 0 };
      return null;
    },
    run: async () => { if (/UPDATE ig_dm/.test(q)) rows[a[3]].status = a[0]; return {}; } }) }) } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { sent.push([String(url).split('?')[0], JSON.parse(o?.body || '{}')]); return new Response('{"message_id":"x"}'); };
  try {
    const c = { ...DEFAULTS, on: true, token: 'T', user_id: 'ME' };
    assert.equal(await handleComment(env, c, cs[0]), 'sent');
    assert.equal(sent[0][1].recipient.comment_id, 'c1');
    assert.match(sent[0][1].message.text, /utm_medium=dm/);
    assert.equal(sent[1][0].endsWith('/c1/replies'), true);
    assert.equal(await handleComment(env, c, cs[0]), 'dup');
    assert.equal(await handleComment(env, c, { ...cs[0], id: 'c2' }), 'skip');           /* same person, same post */
    assert.equal(await handleComment(env, c, { ...cs[0], id: 'c3', from_id: 'ME' }), 'own');
    assert.equal(await handleComment(env, { ...c, on: false }, { ...cs[0], id: 'c4' }), 'off');
  } finally { globalThis.fetch = realFetch; }
});
