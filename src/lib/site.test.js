import test from 'node:test';
import assert from 'node:assert/strict';
import { customerStatus } from './site.js';

test('customer-facing status and step', () => {
  assert.equal(customerStatus({ method: 'cod', status: 'placed' }).key, 'confirm');
  assert.equal(customerStatus({ method: 'prepaid', status: 'placed' }).step, 1);
  assert.equal(customerStatus({ awb: 'A', stage: 'pickup_pending' }).key, 'packed');
  assert.equal(customerStatus({ awb: 'A', stage: 'transit' }).step, 3);
  assert.equal(customerStatus({ awb: 'A', stage: 'ofd' }).step, 4);
  assert.equal(customerStatus({ awb: 'A', stage: 'delivered', delivered_at: 1793180000 }).step, 5);
  assert.equal(customerStatus({ awb: 'A', stage: 'rto' }).key, 'returned');
  assert.equal(customerStatus({ status: 'cancelled' }).key, 'cancelled');
});

import { autoTicket } from './site.js';
import { usualWindow } from './wa-ai.js';

const T = Math.floor(Date.UTC(2026, 10, 11, 6) / 1000);   /* Wed 11 Nov, 11:30 IST */
const envOf = (rows) => ({ ADMIN_SECRET: 'x', DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }), first: async () => null, run: async () => ({}) }) }) } });

test('usual delivery window: 3 to 6 days after pickup, next working day when not picked up, none when finished', () => {
  assert.match(usualWindow({ stage: 'transit', picked_at: T - 86400 }, T), /usually delivers 13 Nov to 16 Nov$/);
  assert.match(usualWindow({ stage: 'pickup_pending' }, T), /15 Nov to 18 Nov \(3 to 6 days after the courier picks it up\)/);
  assert.match(usualWindow({ stage: 'transit', picked_at: T - 7 * 86400 }, T), /any day now/);
  assert.match(usualWindow({ stage: 'transit', picked_at: T - 9 * 86400 }, T), /delayed with the courier/);
  assert.equal(usualWindow({ stage: 'delivered' }, T), '');
  assert.equal(usualWindow({ status: 'cancelled' }, T), '');
});

test('ticket "Where is my order": answered from the order with its track link, no hand-off', async () => {
  const rows = [{ order_id: '11', order_name: '#2219', status: 'placed', method: 'cod', confirmed_at: 1, awb: 'A1', stage: 'transit', courier: 'Xpressbees', edd: '2026-11-14' }];
  const a = await autoTicket(envOf(rows), '9999999999', 'Where is my order', '');
  assert.equal(a.order, '#2219');
  assert.match(a.reply, /On the way with Xpressbees\. Expected delivery: Sat, 14 Nov\. Live tracking: https:\/\/www\.inkkulture\.in\/pages\/track\?k=/);
  assert.equal(a.handoff, false);
  assert.equal(await autoTicket(envOf(rows), '9999999999', 'Where is my order', '#1234'), null);   /* not their order: team */
  assert.equal(await autoTicket(envOf(rows), '9999999999', 'Payment or refund', ''), null);
  assert.equal(await autoTicket(envOf([]), '9999999999', 'Where is my order', ''), null);
});

test('ticket "Cancel my order": paid online / picked up / several open orders are explained, not cancelled', async () => {
  const paid = await autoTicket(envOf([{ order_id: '1', order_name: '#1', status: 'paid', method: 'prepaid', awb: '', stage: '' }]), '9', 'Cancel my order', '');
  assert.match(paid.reply, /paid online, so it can't be cancelled/); assert.ok(!paid.cancelled);
  const picked = await autoTicket(envOf([{ order_id: '2', order_name: '#2', status: 'placed', method: 'cod', awb: 'A', stage: 'transit', picked_at: T }]), '9', 'Cancel my order', '');
  assert.match(picked.reply, /picked up by the courier.*refuse it at the door/); assert.equal(picked.handoff, false);
  const two = await autoTicket(envOf([{ order_id: '3', order_name: '#3', status: 'placed', method: 'cod' }, { order_id: '4', order_name: '#4', status: 'placed', method: 'cod' }]), '9', 'Cancel my order', '');
  assert.match(two.reply, /more than one order.*#3, #4/); assert.equal(two.handoff, true); assert.ok(!two.cancelled);
  const gone = await autoTicket(envOf([{ order_id: '5', order_name: '#5', status: 'cancelled', method: 'cod' }]), '9', 'Cancel my order', '#5');
  assert.match(gone.reply, /already cancelled/);
});
