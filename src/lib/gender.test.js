import test from 'node:test';
import assert from 'node:assert/strict';
import { guessGender } from './gender.js';
import { shipBy, untilText } from './wa-convert.js';

test('gender: common Indian names; unsure -> null', () => {
  for (const n of ['Rahul Sharma', 'Eklavya waghela', 'Aditya', 'Krishna', 'Mohit Mahriya', 'Gaurav', 'Rajesh', 'Arjun', 'Ali Khan']) assert.equal(guessGender(n), 'm', n);
  for (const n of ['Riya', 'Priyanka', 'Ankita', 'Simran Kaur', 'Nandini', 'Shruti', 'Paromita', 'Khushi', 'Gurpreet Kaur']) assert.equal(guessGender(n), 'f', n);
  for (const n of ['', 'X', 'Sai', 'Harmeet', 'Kiran']) assert.equal(guessGender(n), null, n);
});

test('pay-online offer: open until the parcel is due to ship (2 h window, 9 am - 7 pm booking)', () => {
  const ist = (d, hh, mm) => Date.UTC(2026, 10, d, hh, mm) / 1000 - 19800;
  const c = { edit_h: 2, from: 9, to: 19 };
  assert.equal(shipBy({}, ist(2, 11, 0), c), ist(2, 13, 0));
  assert.equal(shipBy({}, ist(2, 5, 30), c), ist(2, 9, 0));
  assert.equal(shipBy({}, ist(2, 18, 0), c), ist(3, 9, 0));
  assert.equal(untilText(ist(2, 13, 5), ist(2, 11, 3)), '1:05 PM today');
  assert.equal(untilText(ist(3, 9, 0), ist(2, 18, 3)), '9:00 AM tomorrow');
});
