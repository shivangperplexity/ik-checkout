// Shopify rejects emojis in address fields ("First name in shipping address cannot
// contain emojis"), which made /api/order fail. This strips emojis from every
// shipping/billing address sent to the Shopify Admin API before it leaves the app.
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️︎⃣]|[\u{E0020}-\u{E007F}]/gu;

export function stripEmoji(s) {
  return typeof s === 'string' ? s.replace(EMOJI, '').replace(/\s+/g, ' ').trim() : s;
}

function cleanAddress(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return a;
  const out = {};
  for (const [k, v] of Object.entries(a)) out[k] = stripEmoji(v);
  if ('firstName' in a && !out.firstName) out.firstName = out.lastName ? out.lastName : 'Customer';
  if ('first_name' in a && !out.first_name) out.first_name = out.last_name ? out.last_name : 'Customer';
  return out;
}

export function cleanAddresses(v) {
  if (Array.isArray(v)) return v.map(cleanAddresses);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = /^(shipping|billing)_?address$/i.test(k) ? cleanAddress(val) : cleanAddresses(val);
  }
  return out;
}

const realFetch = globalThis.fetch;
if (realFetch && !realFetch.__ikAddressGuard) {
  const guarded = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.includes('/admin/api/') && init && typeof init.body === 'string' && /address/i.test(init.body)) {
        const body = JSON.parse(init.body);
        init = { ...init, body: JSON.stringify(cleanAddresses(body)) };
      }
    } catch {
      // leave the request untouched if anything unexpected happens
    }
    return realFetch.call(this, input, init);
  };
  guarded.__ikAddressGuard = true;
  globalThis.fetch = guarded;
}
