import { sha256hex } from './util.js';
import { rupees } from './pricing.js';

const norm = (s) => String(s || '').trim().toLowerCase();

/** One deduplicated server-side Purchase. event_id must match the browser pixel's eventID. */
export async function sendPurchase(env, o) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return { skipped: true };
  const user = {
    ph: o.phone ? [await sha256hex('91' + o.phone)] : undefined,
    em: o.email ? [await sha256hex(norm(o.email))] : undefined,
    fn: o.firstName ? [await sha256hex(norm(o.firstName))] : undefined,
    ln: o.lastName ? [await sha256hex(norm(o.lastName))] : undefined,
    ct: o.city ? [await sha256hex(norm(o.city).replace(/\s/g, ''))] : undefined,
    st: o.stateCode ? [await sha256hex(norm(o.stateCode))] : undefined,
    zp: o.pincode ? [await sha256hex(o.pincode)] : undefined,
    country: [await sha256hex('in')],
    external_id: o.phone ? [await sha256hex(o.phone)] : undefined,
    fbp: o.fbp || undefined,
    fbc: o.fbc || undefined,
    client_ip_address: o.ip || undefined,
    client_user_agent: o.ua || undefined,
  };
  Object.keys(user).forEach((k) => user[k] === undefined && delete user[k]);
  const body = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: o.eventId,
        action_source: 'website',
        event_source_url: o.sourceUrl,
        user_data: user,
        custom_data: { currency: 'INR', value: Number(rupees(o.valuePaise)), order_id: o.orderName, num_items: o.numItems, content_type: 'product', contents: o.contents },
      },
    ],
  };
  if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;
  const res = await fetch(`https://graph.facebook.com/v21.0/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
}
