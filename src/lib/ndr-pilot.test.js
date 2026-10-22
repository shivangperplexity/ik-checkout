import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDay, parseReply, parseAddress, splitAddr, saveText, istDate } from './ndr-pilot.js';

/* Thu 22 Oct 2026, 15:50 IST */
const MS = Date.UTC(2026, 9, 22, 10, 20);

test('days in English and Hindi, never today, max a week, no Sundays', () => {
  assert.equal(istDate(0, MS), '2026-10-22');
  assert.equal(parseDay('kal bhej do', MS).date, '2026-10-23');
  assert.equal(parseDay('tomorrow evening please', MS).date, '2026-10-23');
  assert.equal(parseDay('parso aana', MS).date, '2026-10-24');
  assert.equal(parseDay('saturday ko', MS).date, '2026-10-24');
  assert.equal(parseDay('Shanivar', MS).date, '2026-10-24');
  assert.equal(parseDay('monday', MS).date, '2026-10-26');
  assert.equal(parseDay('wednesday', MS).date, '2026-10-28');
  assert.equal(parseDay('thursday', MS).date, '2026-10-29', 'same weekday = next week');
  const sun = parseDay('sunday ko', MS); assert.equal(sun.date, '2026-10-26'); assert.equal(sun.sunday, true);
  assert.equal(parseDay('25 oct', MS).date, '2026-10-26', '25 Oct is a Sunday');
  assert.equal(parseDay('deliver on 27th october', MS).date, '2026-10-27');
  assert.equal(parseDay('28/10', MS).date, '2026-10-28');
  const far = parseDay('15 nov', MS); assert.equal(far.date, '2026-10-29'); assert.equal(far.clamped, true);
  assert.equal(parseDay('kal koi aaya tha', MS), null, '"kal ... aaya tha" is yesterday');
  assert.equal(parseDay('today', MS), null);
  assert.equal(parseDay('pay 399 now', MS), null);
});

test('addresses and numbers are picked out, "address is correct" is not an address', () => {
  assert.equal(parseAddress('Flat 302, Sai Krupa building, near Shiv mandir, Kharghar 410210'), 'Flat 302, Sai Krupa building, near Shiv mandir, Kharghar 410210');
  assert.equal(parseAddress('new address: H.No 23, gali no 5, Laxmi Nagar'), 'H.No 23, gali no 5, Laxmi Nagar');
  assert.equal(parseAddress('mera address sahi hai bhai, koi aaya hi nahi'), '');
  assert.equal(parseAddress('please deliver tomorrow I will be home'), '');
  const r = parseReply('call my brother on 98765 43210, he will take it', { ownPhone: '9123456789', ms: MS });
  assert.equal(r.phone, '9876543210'); assert.equal(r.intent, 'deliver');
  assert.equal(parseReply('my number is 9123456789', { ownPhone: '9123456789', ms: MS }).phone, '', 'their own number is not a new one');
  const [a1, a2] = splitAddr('Flat 1204, Tower B, Lodha Palava City Phase 2, Casa Rio Gold, near Xperia mall, Dombivli East, Thane, Maharashtra 421204');
  assert.ok(a1.length <= 100 && a2.length > 0 && !a2.startsWith(','));
});

test('intent: deliver, return, unclear; courier never came; objection', () => {
  const o = { ownPhone: '9123456789', ms: MS };
  assert.equal(parseReply('haan bhej do', o).intent, 'deliver');
  assert.equal(parseReply('Deliver it to me', o).intent, 'deliver');
  assert.equal(parseReply("Yes, I'll receive it", o).intent, 'deliver');
  const f = parseReply('koi aaya hi nahi, main ghar pe hi thi', o); assert.equal(f.intent, 'deliver'); assert.equal(f.fake, true);
  assert.equal(parseReply('nobody called me', o).fake, true);
  assert.equal(parseReply('main ghar pe nahi tha', o).fake, false);
  assert.equal(parseReply('nahi chahiye, cancel kar do', o).intent, 'return');
  const n = parseReply('nahi chahiye cancel karo', o); assert.equal(n.intent, 'return'); assert.equal(n.objection, 'changed_mind');
  assert.equal(parseReply('cash nahi hai abhi, cancel', o).objection, 'cash');
  assert.equal(parseReply('bahut late ho gaya, return kar do', o).objection, 'late');
  assert.equal(parseReply('maine order nahi kiya, cancel', o).objection, 'wrong_order');
  assert.equal(parseReply('cancel mat karna, kal bhejo', o).intent, 'deliver');
  assert.equal(parseReply("please don't cancel, deliver on saturday", o).date, '2026-10-24');
  assert.equal(parseReply("please don't cancel, deliver on saturday", o).intent, 'deliver');
  assert.equal(parseReply('wapas bhej do', o).intent, 'return');
  assert.equal(parseReply('ok cancel it', o).intent, 'unclear', 'mixed: left to the model');
  assert.equal(parseReply('what is this about?', o).intent, 'unclear');
});

test('the save message is true for the order and always offers an easy cancel', () => {
  const ctx = { order_name: '#1700', method: 'cod', total_paise: 49900, advance_paise: 0, order_status: 'placed', contents_json: JSON.stringify([{ title: 'Phoenix Wings' }, { title: 'Koi Fish - Large' }]) };
  const env = { SETTINGS: { partial: { mode: 'off' } } };
  const t = saveText(env, ctx, 'changed_mind');
  assert.match(t, /Phoenix Wings \+ Koi Fish/); assert.match(t, /reply CANCEL once more/); assert.match(t, /Reply YES/);
  assert.doesNotMatch(t, /advance/);
  assert.match(saveText(env, ctx, 'cash'), /keep ₹499 ready/);
  assert.match(saveText({ SETTINGS: { partial: { mode: 'risky', history: true } } }, ctx, 'late'), /small online advance/, 'only when that rule is really on');
  assert.doesNotMatch(saveText({ SETTINGS: { partial: { mode: 'risky', history: true } } }, { ...ctx, method: 'upi' }, 'late'), /advance/, 'not for prepaid');
  assert.match(saveText(env, ctx, 'wrong_order'), /reply CANCEL again/);
});
