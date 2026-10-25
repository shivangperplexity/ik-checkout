import test from 'node:test';
import assert from 'node:assert/strict';
import { sendOtp, checkOtp, otpTemplate, newCode, otpStatus, otpDelivery, OTP_TTL, RESEND_GAP } from './cod-otp.js';

/* a tiny stand-in for the cod_otps table: the four statements cod-otp.js runs */
function fakeDb() {
  const rows = {};
  return {
    rows,
    prepare(sql) {
      return { bind: (...a) => ({
        first: async () => (/FROM cod_otps WHERE phone/.test(sql) ? (rows[a[0]] ? { ...rows[a[0]] } : null) : null),
        run: async () => {
          if (/INSERT INTO cod_otps/.test(sql)) {
            const [phone, hash, t, exp, ws, wamid, cut] = a; const r = rows[phone];
            rows[phone] = r ? { ...r, code_hash: hash, sent_at: t, expires_at: exp, tries: 0, verified_at: null, wamid, dstatus: null, drank: 0, sends: r.window_start < cut ? 1 : r.sends + 1, window_start: r.window_start < cut ? ws : r.window_start }
              : { phone, code_hash: hash, sent_at: t, expires_at: exp, tries: 0, sends: 1, window_start: ws, verified_at: null, wamid, dstatus: null, drank: 0 };
          } else if (/SET tries=tries\+1/.test(sql)) rows[a[0]].tries++;
          else if (/SET verified_at/.test(sql)) rows[a[1]].verified_at = rows[a[1]].verified_at || a[0];
          else if (/SET dstatus/.test(sql)) { for (const r of Object.values(rows)) if (r.wamid === a[2] && (r.drank || 0) < a[3]) { r.dstatus = a[0]; r.drank = a[1]; } }
          return {};
        },
      }) };
    },
  };
}
const env = () => ({ DB: fakeDb(), WA_PHONE_ID: 'p', WA_TOKEN: 't', ADMIN_SECRET: 's' });

test('authentication template with a copy-code button', () => {
  const t = otpTemplate();
  assert.equal(t.category, 'AUTHENTICATION');
  assert.equal(t.components.find((c) => c.type === 'BUTTONS').buttons[0].otp_type, 'COPY_CODE');
  for (let i = 0; i < 50; i++) assert.match(newCode(), /^\d{4}$/);
});

test('send, wrong code, right code, then reuse until it expires', async () => {
  const e = env(); let sent = null;
  const r = await sendOtp(e, '9876543210', { send: async (_, phone, code) => { sent = { phone, code }; return 'wamid.1'; } });
  assert.deepEqual(r, { ok: true, resend_in: RESEND_GAP, ttl: OTP_TTL });
  assert.equal(sent.phone, '9876543210'); assert.match(sent.code, /^\d{4}$/);
  assert.ok(!JSON.stringify(e.DB.rows).includes(`"${sent.code}"`));                  /* only the HMAC is kept */
  const wrong = sent.code === '0000' ? '1111' : '0000';
  assert.equal((await checkOtp(e, '9876543210', wrong)).ok, false);
  assert.equal(e.DB.rows['9876543210'].tries, 1);
  assert.equal((await checkOtp(e, '9876543210', sent.code)).ok, true);
  assert.equal((await checkOtp(e, '9876543210', sent.code)).ok, true);               /* a retry after a network error */
  e.DB.rows['9876543210'].expires_at = 1;
  assert.equal((await checkOtp(e, '9876543210', sent.code)).expired, true);
});

test('resend waits 30 s; WhatsApp failure means fall back to the old flow; bad input', async () => {
  const e = env();
  await sendOtp(e, '9876543210', { send: async () => 'w' });
  const again = await sendOtp(e, '9876543210', { send: async () => 'w' });
  assert.equal(again.ok, false); assert.ok(again.wait > 0 && again.wait <= RESEND_GAP);
  const fail = await sendOtp(env(), '9876543210', { send: async () => { throw new Error('template "ik_cod_otp" not found or not approved'); } });
  assert.equal(fail.fallback, true);
  assert.equal((await sendOtp(env(), '12345', { send: async () => 'w' })).ok, false);
  assert.equal((await sendOtp({ ...env(), WA_TOKEN: '' }, '9876543210', { send: async () => 'w' })).fallback, true);
  assert.equal((await checkOtp(env(), '9876543210', '12')).ok, false);
});

test('five wrong tries lock the code', async () => {
  const e = env(); let code = '';
  await sendOtp(e, '9876543210', { send: async (_, p, c) => { code = c; return 'w'; } });
  const wrong = code === '0000' ? '1111' : '0000';
  for (let i = 0; i < 5; i++) await checkOtp(e, '9876543210', wrong);
  const r = await checkOtp(e, '9876543210', code);
  assert.equal(r.ok, false); assert.match(r.error, /Too many wrong tries/);
});

test('ask for the code only once WhatsApp says delivered; failed means the old flow', async () => {
  const e = env();
  await sendOtp(e, '9876543210', { send: async () => 'wamid.A' });
  assert.equal((await otpDelivery(e, '9876543210')).state, 'pending');
  await otpStatus(e, 'wamid.A', 'sent');
  assert.equal((await otpDelivery(e, '9876543210')).state, 'pending');
  await otpStatus(e, 'wamid.A', 'read');
  await otpStatus(e, 'wamid.A', 'delivered');                                         /* late, out of order */
  assert.equal((await otpDelivery(e, '9876543210')).state, 'delivered');
  const f = env();
  await sendOtp(f, '9999999999', { send: async () => 'wamid.B' });
  await otpStatus(f, 'wamid.B', 'failed');
  assert.equal((await otpDelivery(f, '9999999999')).state, 'failed');
  await otpStatus(f, 'wamid.OTHER', 'delivered');
  assert.equal((await otpDelivery(f, '9999999999')).state, 'failed');
  assert.equal((await otpDelivery(f, '9000000000')).state, 'none');
});
