export const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function sha256hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
export async function sha512hex(s) {
  return hex(await crypto.subtle.digest('SHA-512', enc.encode(s)));
}
export async function hmacSha256hex(secret, body) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function allowedOrigins(env) {
  return (env.STORE_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}
export function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const ok = allowedOrigins(env).includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...extra } });
}

export function cleanPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

export const STATE_CODES = {
  'andaman and nicobar islands': 'AN', 'andhra pradesh': 'AP', 'arunachal pradesh': 'AR', assam: 'AS', bihar: 'BR',
  chandigarh: 'CH', chhattisgarh: 'CG', 'dadra and nagar haveli': 'DN', 'dadra and nagar haveli and daman and diu': 'DN',
  'daman and diu': 'DD', delhi: 'DL', goa: 'GA', gujarat: 'GJ', haryana: 'HR', 'himachal pradesh': 'HP',
  'jammu and kashmir': 'JK', jharkhand: 'JH', karnataka: 'KA', kerala: 'KL', ladakh: 'LA', lakshadweep: 'LD',
  'madhya pradesh': 'MP', maharashtra: 'MH', manipur: 'MN', meghalaya: 'ML', mizoram: 'MZ', nagaland: 'NL',
  odisha: 'OR', orissa: 'OR', puducherry: 'PY', punjab: 'PB', rajasthan: 'RJ', sikkim: 'SK', 'tamil nadu': 'TN',
  telangana: 'TS', tripura: 'TR', 'uttar pradesh': 'UP', uttarakhand: 'UK', 'west bengal': 'WB',
};
export function stateCode(name) {
  return STATE_CODES[String(name || '').trim().toLowerCase()] || null;
}
