import test from 'node:test';
import assert from 'node:assert/strict';
import { addressProblem } from './address-check.js';
test('address check: links and map codes are refused, normal addresses pass', () => {
  assert.ok(addressProblem('https://maps.app.goo.gl/DpTb7GD5YZaa1Mpb8?g_st=ac'));
  assert.ok(addressProblem('https://backend.goodfeel.in/api/checkout/redirect/?url=https://imfreshmen.com/'));
  assert.ok(addressProblem('www.google.com/maps'));
  assert.ok(addressProblem('V8GM+R23', 'Raysingpur three rasta'));
  assert.ok(addressProblem('12345'));
  assert.equal(addressProblem('67, 7th Cross Street, Lakshmipuram, Near Kavasa Foundation, Tiruvallur, Tamil Nadu.'), '');
  assert.equal(addressProblem('Shree Ganesh Engg works, Mk industrial estate', 'Near Kamaldeep'), '');
  assert.equal(addressProblem('Gm 1/90 gulmohar colony gate no 14 rajbhawan campus Lucknow'), '');
  assert.equal(addressProblem('Flat 5, Sai Residency, Near Pvt. Ltd office'), '');
});
