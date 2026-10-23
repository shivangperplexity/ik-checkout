import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyDelivery, displayName, cleanPhone, reviewTemplate } from './reviews.js';

const f = (x) => ({ status: 'SUCCESS', displayStatus: 'FULFILLED', createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', deliveredAt: null, trackingInfo: [{ number: 'A1', url: 'https://shiprocket.co/tracking/A1' }], events: { nodes: [] }, ...x });

test('delivered only when the tracking says so, never just fulfilled', () => {
  assert.equal(shopifyDelivery({ fulfillments: [f()] }).state, 'shipped');
  const d = shopifyDelivery({ fulfillments: [f({ displayStatus: 'DELIVERED', deliveredAt: '2026-10-13T08:00:00Z' })] });
  assert.equal(d.state, 'delivered');
  assert.equal(d.delivered_at, Date.parse('2026-10-13T08:00:00Z') / 1000);
  assert.equal(shopifyDelivery({ fulfillments: [f({ events: { nodes: [{ status: 'IN_TRANSIT', happenedAt: '2026-10-11T00:00:00Z' }, { status: 'DELIVERED', happenedAt: '2026-10-12T00:00:00Z' }] } })] }).state, 'delivered');
  assert.equal(shopifyDelivery({ fulfillments: [f({ displayStatus: 'NOT_DELIVERED' })] }).state, 'returned');
  assert.equal(shopifyDelivery({ cancelledAt: '2026-10-11T00:00:00Z', fulfillments: [f({ displayStatus: 'DELIVERED', deliveredAt: '2026-10-13T08:00:00Z' })] }).state, 'skipped');
  assert.equal(shopifyDelivery({ fulfillments: [f({ displayStatus: 'CANCELED' })] }).state, 'skipped');
  /* a cancelled first shipment and a delivered re-shipment */
  assert.equal(shopifyDelivery({ fulfillments: [f({ displayStatus: 'CANCELED' }), f({ displayStatus: 'DELIVERED', deliveredAt: '2026-10-14T08:00:00Z' })] }).state, 'delivered');
});

test('names and phones', () => {
  assert.equal(displayName('riya', 'sharma'), 'Riya S.');
  assert.equal(displayName('', ''), 'Ink Kulture customer');
  assert.equal(cleanPhone('+91 98200 00001'), '9820000001');
  assert.equal(cleanPhone('09820000001'), '9820000001');
  assert.equal(cleanPhone('12345'), '');
});

test('template button opens the review page', () => {
  const t = reviewTemplate('https://ik-checkout.vercel.app/');
  assert.equal(t.name, 'review_request_v1');
  assert.equal(t.components[1].buttons[0].url, 'https://ik-checkout.vercel.app/review/{{1}}');
});
