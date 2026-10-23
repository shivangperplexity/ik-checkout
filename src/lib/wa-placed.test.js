import test from 'node:test';
import assert from 'node:assert/strict';
import { placedReply } from './wa-placed.js';

test('thank-you screen WhatsApp message: COD asks to confirm, prepaid just thanks', () => {
  const b = { order_name: '#1758', first_name: 'riya sharma', total_paise: 49900, status: 'placed' };
  assert.match(placedReply({ ...b, method: 'cod' }), /reply YES/);
  assert.match(placedReply({ ...b, method: 'cod', confirmed_at: 1 }), /is confirmed/);
  assert.match(placedReply({ ...b, method: 'prepaid', status: 'paid' }), /^Thank you for placing order #1758, Riya!/);
  assert.match(placedReply({ ...b, method: 'cod', converted_at: 1 }), /^Thank you for placing/);
  assert.match(placedReply({ ...b, method: 'cod', advance_paise: 9900 }), /Pay ₹400/);
  assert.equal(placedReply({ ...b, method: 'cod', status: 'cancelled' }), '');
});
