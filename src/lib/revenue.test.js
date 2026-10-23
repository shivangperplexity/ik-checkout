import test from 'node:test';
import assert from 'node:assert/strict';
import { rowOf, carrierOf } from './revenue.js';

const ff = (x) => ({ status: 'SUCCESS', displayStatus: 'DELIVERED', createdAt: '2026-09-27T10:00:00Z', updatedAt: '2026-09-30T10:00:00Z', deliveredAt: '2026-09-30T08:28:59Z', trackingInfo: [{ company: 'Xpressbees Air', url: 'https://app.nimbuspost.com/track/1' }], events: { nodes: [] }, ...x });
const o = (x) => ({ legacyResourceId: 1, name: '#1002', createdAt: '2026-09-25T13:07:52Z', cancelledAt: null, paymentGatewayNames: ['Cash on Delivery (COD)', 'manual'], currentTotalPriceSet: { shopMoney: { amount: '449.0' } }, totalRefundedSet: { shopMoney: { amount: '0.0' } }, lineItems: { nodes: [{ currentQuantity: 2 }] }, fulfillments: [ff()], tags: [], ...x });

test('NimbusPost-era orders: delivered / returned / cancelled read from Shopify tracking', () => {
  const d = rowOf(o());
  assert.equal(d.state, 'delivered'); assert.equal(d.pay, 'cod'); assert.equal(d.carrier, 'nimbuspost'); assert.equal(d.total_paise, 44900); assert.equal(d.units, 2);
  assert.equal(rowOf(o({ fulfillments: [ff({ displayStatus: 'NOT_DELIVERED', deliveredAt: null })] })).state, 'returned');
  assert.equal(rowOf(o({ cancelledAt: '2026-09-28T11:04:11Z', fulfillments: [ff({ status: 'CANCELLED', displayStatus: 'CANCELED' })] })).state, 'cancelled');
  assert.equal(rowOf(o({ fulfillments: [ff({ displayStatus: 'IN_TRANSIT', deliveredAt: null })] })).state, 'shipped');
  assert.equal(rowOf(o({ fulfillments: [] })).state, 'unshipped');
  assert.equal(rowOf(o({ paymentGatewayNames: ['Cards, UPI, NB by PayU India'] })).pay, 'prepaid');
  /* a refunded but delivered order still counts as delivered; its value is Shopify's current total */
  assert.equal(rowOf(o({ displayFinancialStatus: 'REFUNDED' })).state, 'delivered');
  assert.equal(carrierOf({ fulfillments: [{ trackingInfo: [{ company: 'Delhivery', url: 'https://shiprocket.co/tracking/77' }] }] }), 'shiprocket');
});
