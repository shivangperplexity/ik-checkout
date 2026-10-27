import test from 'node:test';
import assert from 'node:assert/strict';
import { stageLabel, cleanApplication, codeBase, makeToken, readToken, rewardFor, creatorTemplates, storeLink, DEFAULTS } from './creators.js';

test('what the creator sees for each order state', () => {
  assert.equal(stageLabel({ stage: 'delivered' }).label, 'Delivered');
  assert.equal(stageLabel({ stage: 'rto' }).label, 'Delivery refused');
  assert.equal(stageLabel({ stage: 'transit', rto: true }).label, 'Delivery refused');
  assert.equal(stageLabel({ stage: 'ofd' }).label, 'Out for delivery');
  assert.equal(stageLabel({ stage: 'pickup_pending' }).label, 'Packed');
  assert.equal(stageLabel({ order_status: 'cancelled', stage: 'transit' }).label, 'Cancelled');
  assert.equal(stageLabel({}).label, 'Order placed');
});

test('application: cleaned, platform and handle from the link, required fields', () => {
  const a = cleanApplication({ name: ' Riya <b>', phone: '+91 98765 43210', link: 'https://www.instagram.com/riya.inks/', followers: '4,500', agree: true });
  assert.equal(a.name, 'Riya b'); assert.equal(a.phone, '9876543210'); assert.equal(a.handle, 'riya.inks'); assert.equal(a.platform, 'Instagram'); assert.equal(a.followers, 4500);
  assert.equal(cleanApplication({ name: 'A', phone: '9876543210', link: 'https://youtube.com/@a', agree: true }).platform, 'YouTube');
  assert.throws(() => cleanApplication({ name: 'A', phone: '123', link: 'x', agree: true }), /WhatsApp number/);
  assert.throws(() => cleanApplication({ name: 'A', phone: '9876543210', link: 'x' }), /terms/);
  assert.throws(() => cleanApplication({ name: 'A', phone: '9876543210', agree: true }), /profile link/);
});

test('code from the handle', () => {
  assert.equal(codeBase({ handle: 'riya.inks' }), 'RIYAINKS');
  assert.equal(codeBase({ handle: '', name: 'Al' }), 'ALINK');
  assert.equal(codeBase({ handle: 'the_very_long_handle_name' }), 'THEVERYLON');
});

test('login token: signed, tied to the number, expires', async () => {
  const env = { ADMIN_SECRET: 's' };
  const t = await makeToken(env, '9876543210');
  assert.equal(await readToken(env, t), '9876543210');
  assert.equal(await readToken(env, t.replace('9876543210', '9876543211')), null);
  assert.equal(await readToken({ ADMIN_SECRET: 'other' }, t), null);
  assert.equal(await readToken(env, await makeToken(env, '9876543210', -10)), null);
});

test('reward follows the one-time choice; none before it', () => {
  assert.deepEqual(rewardFor({ payout: 'cash' }, DEFAULTS), { type: 'cash', amount: 6000 });
  assert.deepEqual(rewardFor({ payout: 'credit' }, DEFAULTS), { type: 'credit', amount: 12000 });
  assert.equal(rewardFor({}, DEFAULTS), null);
});

test('link and welcome template', () => {
  assert.match(storeLink('RIYA'), /^https:\/\/www\.inkkulture\.in\/\?ref=RIYA&utm_source=creator/);
  const [t] = creatorTemplates('https://x.app');
  assert.match(t.components[0].text, /\{\{2\}\}[\s\S]*\{\{3\}\}[\s\S]*Welcome/);
  assert.doesNotMatch(t.components[0].text, /\{\{\d\}\}\s*$/);
});
