import test from 'node:test';
import assert from 'node:assert/strict';
import { courierBlocked, cfg } from './shipping.js';
import { isCollab } from './collab.js';

test('Blue Dart is never used, however Shiprocket spells it', () => {
  const block = cfg({}).shiprocketBlock;
  for (const n of ['Blue Dart', 'Bluedart Surface 500g', 'BLUE DART AIR', 'Blue-Dart Express']) assert.equal(courierBlocked(n, block), true, n);
  for (const n of ['Delhivery Surface', 'Xpressbees 0.5 K.G', 'Ekart', 'DTDC']) assert.equal(courierBlocked(n, block), false, n);
  assert.equal(courierBlocked('DTDC Surface', 'Blue Dart | DTDC'), true);
  assert.equal(courierBlocked('Blue Dart', ''), false, 'an emptied list blocks nothing');
  assert.equal(cfg({ SETTINGS: { shipping: { shiprocket_block: '' } } }).shiprocketBlock, '');
});

test('barter collab = landing on a creator-collab collection', () => {
  assert.equal(isCollab('https://www.inkkulture.in/collections/creator-collab-ik26x'), true);
  assert.equal(isCollab('https://www.inkkulture.in/collections/creator-collab-ik26x?utm_source=ig'), true);
  assert.equal(isCollab('https://www.inkkulture.in/collections/all'), false);
  assert.equal(isCollab(null), false);
});
