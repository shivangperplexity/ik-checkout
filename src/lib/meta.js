import { sha256hex, stateCode } from './util.js';
import { rupees } from './pricing.js';

const norm = (s) => String(s || '').trim().toLowerCase();
const GRAPH = 'https://graph.facebook.com/v21.0';

/* Meta pixel / dataset settings (dashboard > Settings > Meta tracking), layered over env.
   pixel_id: the dataset the ad account reports on (blank = META_PIXEL_ID).
   test_code: only while testing in Events Manager > Test events. The META_TEST_EVENT_CODE env var is
   deliberately ignored: it sat in production and tagged every live purchase as a test event. */
export const META_DEFAULTS = { pixel_id: '', test_code: '', browser: true };
export function metaCfg(env) {
  const s = { ...META_DEFAULTS, ...(env.SETTINGS?.meta || {}) };
  return { pixelId: String(s.pixel_id || env.META_PIXEL_ID || '').trim(), testCode: String(s.test_code || '').trim(), browser: s.browser !== false, token: env.META_CAPI_TOKEN || '' };
}

/** fbc from a click id: fb.1.<ms of the click>.<fbclid> */
export function fbcOf(fbc, fbclid, clickMs) {
  if (fbc) return fbc;
  return fbclid ? `fb.1.${clickMs || Date.now()}.${fbclid}` : '';
}

/** One deduplicated server-side Purchase. event_id must match the browser pixel's eventID.
    Returns { ok, status, pixel, received, error, fbtrace } — never throws for a Meta-side rejection. */
export async function sendPurchase(env, o) {
  const c = metaCfg(env);
  if (!c.pixelId || !c.token) return { ok: false, skipped: true, pixel: c.pixelId, error: !c.pixelId ? 'No Meta pixel ID set' : 'META_CAPI_TOKEN missing' };
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
        event_time: o.eventTime || Math.floor(Date.now() / 1000),
        event_id: o.eventId,
        /* Meta requires the shopper's browser (user agent) for website events; an old order without one goes as 'other' */
        action_source: o.ua ? 'website' : 'other',
        event_source_url: o.sourceUrl || undefined,
        user_data: user,
        custom_data: { currency: 'INR', value: Number(rupees(o.valuePaise)), order_id: o.orderName, num_items: o.numItems, content_type: 'product', contents: o.contents },
      },
    ],
  };
  if (c.testCode) body.test_event_code = c.testCode;
  let res, j = {};
  try {
    res = await fetch(`${GRAPH}/${c.pixelId}/events?access_token=${encodeURIComponent(c.token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    j = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, status: 0, pixel: c.pixelId, error: 'Network: ' + String(e.message || e).slice(0, 150) };
  }
  const ok = res.ok && Number(j.events_received) >= 1;
  return { ok, status: res.status, pixel: c.pixelId, test: !!c.testCode, received: Number(j.events_received) || 0, fbtrace: j.fbtrace_id || j.error?.fbtrace_id || '',
    error: ok ? '' : String(j.error?.error_user_msg || j.error?.message || `HTTP ${res.status}`).slice(0, 300) };
}

/** What Meta says about the dataset the token sends to (name, last activity) — for the dashboard check. */
export async function pixelInfo(env, pixelId) {
  const c = metaCfg(env);
  const id = pixelId || c.pixelId;
  if (!id || !c.token) return { ok: false, error: !id ? 'No pixel ID' : 'META_CAPI_TOKEN missing' };
  try {
    const r = await fetch(`${GRAPH}/${id}?fields=name,last_fired_time,is_unavailable,creation_time&access_token=${encodeURIComponent(c.token)}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { ok: false, id, error: String(j.error?.error_user_msg || j.error?.message || `HTTP ${r.status}`).slice(0, 300) };
    return { ok: true, id, name: j.name || '', last_fired: j.last_fired_time || '', unavailable: !!j.is_unavailable };
  } catch (e) {
    return { ok: false, id, error: String(e.message || e).slice(0, 200) };
  }
}

/** Save Meta's answer on the order row (dashboard > Meta tracking). */
export async function recordCapi(env, eventId, res) {
  if (!env.DB || !eventId) return;
  await env.DB.prepare('UPDATE orders SET capi_at=?, capi_ok=?, capi_pixel=?, capi_test=?, capi_error=?, capi_tries=COALESCE(capi_tries,0)+1 WHERE event_id=?')
    .bind(Math.floor(Date.now() / 1000), !!res.ok, res.pixel || null, !!res.test, res.ok ? null : (res.error || 'failed'), eventId).run().catch((e) => console.error('capi record', e.message));
}

export function purchasePayload(row, orderName, ip, ua) {
  return ({
    eventId: row.eventId || row.event_id, orderName, valuePaise: row.total ?? row.total_paise,
    phone: row.buyer?.phone ?? row.phone, email: row.buyer?.email ?? row.email, firstName: row.buyer?.firstName ?? row.first_name, lastName: row.buyer?.lastName ?? row.last_name,
    city: row.buyer?.city ?? row.city, stateCode: row.buyer ? stateCode(row.buyer.state) : row.state_code, pincode: row.buyer?.pincode ?? row.pincode,
    fbp: row.a?.fbp ?? row.fbp, fbc: row.a?.fbc ?? row.fbc, ip: row.ip || row.client_ip || ip, ua: row.ua || row.client_ua || ua, sourceUrl: row.sourceUrl ?? row.source_url,
    contents: row.contents ?? JSON.parse(row.contents_json || '[]'),
    numItems: (row.contents ?? JSON.parse(row.contents_json || '[]')).reduce((s, c) => s + c.quantity, 0),
  });
}


/* Orders that told Meta about a purchase: COD placed, prepaid paid, partial COD placed (advance paid). */
const LIVE = "order_name IS NOT NULL AND status IN ('placed','paid','cancelled')";
const WEEK = 7 * 86400 - 3600; /* Meta takes events up to 7 days old; keep an hour of margin */

/**
 * Purchases that should still reach the current pixel, newest first:
 *  - failed: Meta rejected it, or it was never sent (network / no token), and it is under 7 days old;
 *  - moved: it went to a different pixel than the current one (pixel ID changed in the dashboard).
 * Orders sent before this tracking existed (capi_pixel NULL) are assumed sent to META_PIXEL_ID, so they are only
 * re-sent when the pixel changes — never twice to the same pixel (Meta would count it again after 48 h).
 */
export async function resendDue(env, opts = {}) {
  const { limit = 300, includeCancelled = false } = opts;
  const c = metaCfg(env);
  if (!env.DB || !c.pixelId) return [];
  const base = String(env.META_PIXEL_ID || '');
  const since = Math.floor(Date.now() / 1000) - WEEK;
  const { results } = await env.DB.prepare(`SELECT * FROM orders WHERE ${LIVE} AND created_at>? ORDER BY created_at DESC LIMIT 2000`).bind(since).all();
  return results.filter((r) => {
    if (!includeCancelled && r.status === 'cancelled') return false;
    const sentTo = r.capi_pixel || (r.capi_at ? '' : base);
    if (sentTo !== c.pixelId) return true;
    return r.capi_at && r.capi_ok === false && (opts.anyTries || Number(r.capi_tries || 0) < 4);
  }).slice(0, limit);
}

/** Send those again with their original event_id and time (Meta keeps one per event_id within 48 h). */
export async function resendPurchases(env, opts = {}) {
  const due = await resendDue(env, opts);
  const out = { tried: due.length, ok: 0, failed: 0, errors: [] };
  for (const r of due) {
    const res = await sendPurchase(env, { ...purchasePayload(r, r.order_name), eventTime: Math.max(Number(r.created_at) || 0, Math.floor(Date.now() / 1000) - WEEK) });
    await recordCapi(env, r.event_id, res);
    if (res.ok) out.ok++; else { out.failed++; if (out.errors.length < 5 && !out.errors.includes(res.error)) out.errors.push(res.error); }
    if (res.skipped) break;
  }
  return out;
}

/** Day-by-day: real orders vs what Meta accepted (dashboard > Meta tracking). Days in IST. */
export async function capiStats(env, days = 14) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const { results } = await env.DB.prepare(`SELECT created_at, status, method, capi_at, capi_ok, capi_pixel, capi_test, capi_error, fbp, fbc, client_ua FROM orders WHERE ${LIVE} AND created_at>?`).bind(since).all();
  const c = metaCfg(env);
  const byDay = {};
  const errs = {};
  for (const r of results) {
    const d = new Date((Number(r.created_at) + 19800) * 1000).toISOString().slice(0, 10);
    const x = (byDay[d] ||= { day: d, orders: 0, cancelled: 0, accepted: 0, rejected: 0, unknown: 0, test: 0, other_pixel: 0, fbc: 0, fbp: 0 });
    x.orders++;
    if (r.status === 'cancelled') x.cancelled++;
    if (r.fbc) x.fbc++;
    if (r.fbp) x.fbp++;
    if (!r.capi_at) x.unknown++;
    else if (r.capi_ok === false) { x.rejected++; if (r.capi_error) errs[r.capi_error] = (errs[r.capi_error] || 0) + 1; }
    else if (r.capi_pixel && r.capi_pixel !== c.pixelId) x.other_pixel++;
    else { x.accepted++; if (r.capi_test) x.test++; }
  }
  return { days: Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1)), errors: Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([error, n]) => ({ error, n })) };
}
