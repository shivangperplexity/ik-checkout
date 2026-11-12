/**
 * Hidden chats for the dashboard's Chats tab (Build 066).
 *
 * A chat can be hidden behind a lock code: it disappears from every chat list, search, the "chats to answer" count
 * and the message log, and opens only after the code is entered (🔒 in the Chats tab). The code is kept as a salted
 * PBKDF2 hash in settings ('inbox_hidden'), never in plain text or in code; five wrong tries lock it for 15 minutes.
 * Hiding changes only what the dashboard shows: messages, the assistant and automations carry on as before.
 */
const KEY = 'inbox_hidden';
const now = () => Math.floor(Date.now() / 1000);
const clean = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const MAX_FAILS = 5, LOCKOUT = 15 * 60;

async function load(env) {
  try { return JSON.parse((await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(KEY).first())?.v || 'null') || {}; } catch { return {}; }
}
async function save(env, v) {
  await env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v').bind(KEY, JSON.stringify(v)).run();
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function hashPin(pin, salt) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 120000 }, k, 256));
}
const validPin = (pin) => /^\d{4,8}$/.test(String(pin || ''));

/** Phones hidden right now (10 digits), as a Set. */
export async function hiddenSet(env) {
  return new Set(((await load(env)).phones || []).map(String));
}
export async function hasPin(env) { return !!(await load(env)).pin; }

/** Checks the code; counts wrong tries and locks for 15 min after five. Returns { ok } or { ok:false, error }. */
export async function checkPin(env, pin) {
  const v = await load(env);
  if (!v.pin) return { ok: false, error: 'No lock code set yet' };
  if (Number(v.lock_until) > now()) return { ok: false, error: `Too many wrong tries. Try again in ${Math.ceil((v.lock_until - now()) / 60)} min.` };
  if (validPin(pin) && (await hashPin(pin, v.pin.salt)) === v.pin.hash) {
    if (v.fails) { v.fails = 0; v.lock_until = 0; await save(env, v); }
    return { ok: true };
  }
  v.fails = (Number(v.fails) || 0) + 1;
  if (v.fails >= MAX_FAILS) { v.lock_until = now() + LOCKOUT; v.fails = 0; }
  await save(env, v);
  return { ok: false, error: 'Wrong lock code' };
}

/** Throws unless this phone is visible or the code is right. */
export async function assertVisible(env, phone, pin) {
  if (!(await hiddenSet(env)).has(clean(phone))) return;
  const c = await checkPin(env, pin);
  if (!c.ok) throw new Error(c.error === 'Wrong lock code' ? 'This chat is locked' : c.error);
}

/** Hide or unhide one number. The first hide sets the lock code (new_pin); after that the code is needed for both. */
export async function setHidden(env, { phone, hide, pin, new_pin }) {
  const p = clean(phone);
  if (!/^[6-9]\d{9}$/.test(p)) throw new Error('Enter a valid 10-digit mobile number');
  const v = await load(env);
  if (!v.pin) {
    if (!hide) throw new Error('Nothing is hidden');
    if (!validPin(new_pin)) throw new Error('Set a lock code of 4 to 8 digits');
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    v.pin = { salt, hash: await hashPin(new_pin, salt), set_at: now() };
  } else {
    const c = await checkPin(env, pin);
    if (!c.ok) throw new Error(c.error);
    Object.assign(v, await load(env));            /* checkPin may have reset the counters */
  }
  const s = new Set((v.phones || []).map(String));
  if (hide) s.add(p); else s.delete(p);
  v.phones = [...s];
  await save(env, v);
  return { ok: true, hidden: !!hide, count: v.phones.length };
}
