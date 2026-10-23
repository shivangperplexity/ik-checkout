/**
 * Reviews: every customer whose parcel was actually DELIVERED gets one WhatsApp message (3 days after delivery) asking
 * how the tattoos turned out, with a link to a review page: overall stars (the store / the tattoos, not per design),
 * quick tags, a few words and up to 4 photos. Reviews land in the dashboard (Reviews tab); the ones you choose show on
 * inkkulture.in (home + product page section, public list /api/review/list).
 *
 * Delivered means the tracking says delivered, never just "fulfilled" (Shopify marks an order fulfilled when it ships):
 *   1. Shopify fulfillment shows DELIVERED (deliveredAt / a DELIVERED event): NimbusPost-era orders, NimbusPost pushed
 *      tracking events into Shopify. NOT_DELIVERED / FAILURE = came back, never asked.
 *   2. Otherwise the order's tracking number is checked: the dashboard's own Shiprocket shipment (shipments.stage /
 *      delivered_at, kept fresh by lib/ship-status.js), else Shiprocket tracking (courier/track/awb) read like the
 *      tracking page (lib/sr-scan.js). RTO = never asked.
 * The list of orders comes from Shopify (all fulfilled orders, both couriers), scanned incrementally by updated_at.
 *
 * Tables: review_asks (one per order: where it is, when delivered, the link token, sent / opened / reviewed),
 *         reviews (one per link), review_photos (JPEG, full 1280 px + thumbnail 480 px, base64; served with a year-long
 *         CDN cache from /api/review/photo).
 * Settings 'reviews': on, delay_days (3), quiet (send 10 am - 8 pm IST only), per_run, auto_publish (4-5 stars with
 *         consent go live by themselves), launched_at, backfill_at (customers delivered before launch are asked only
 *         after "Ask past customers" in the dashboard).
 */
import { gql } from './shopify.js';
import { sr } from './shiprocket.js';
import { summarize } from './sr-scan.js';

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
const WAIT = /not found or not approved|status PENDING|status IN_REVIEW/i;
export const REVIEW_TEMPLATE = 'review_request_v1';
export const DEFAULT_CFG = { on: false, delay_days: 3, quiet: true, per_run: 25, auto_publish: false, launched_at: 0, backfill_at: 0, repeat_days: 45 };
export const TAGS_GOOD = ['Looks real', 'Easy to apply', 'Lasted long', 'Great designs', 'Fast delivery', 'Nice packaging'];
export const TAGS_BAD = ['Faded quickly', 'Hard to apply', 'Wrong design', 'Late delivery', 'Damaged', 'Not like the photos'];

/* ---------------- settings ---------------- */
export async function reviewCfg(env) {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='reviews'").first().catch(() => null);
  let c = {}; try { c = r ? JSON.parse(r.v) : {}; } catch { /* defaults */ }
  return { ...DEFAULT_CFG, ...c };
}
export async function saveReviewCfg(env, patch) {
  const cur = await reviewCfg(env);
  const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d; };
  const c = {
    ...cur,
    on: patch.on !== undefined ? !!patch.on : cur.on,
    delay_days: patch.delay_days !== undefined ? n(patch.delay_days, 0, 30, 3) : cur.delay_days,
    quiet: patch.quiet !== undefined ? !!patch.quiet : cur.quiet,
    per_run: patch.per_run !== undefined ? n(patch.per_run, 1, 100, 25) : cur.per_run,
    auto_publish: patch.auto_publish !== undefined ? !!patch.auto_publish : cur.auto_publish,
    repeat_days: patch.repeat_days !== undefined ? n(patch.repeat_days, 7, 365, 45) : cur.repeat_days,
    launched_at: cur.launched_at || now(),
    backfill_at: patch.backfill_at !== undefined ? Number(patch.backfill_at) || 0 : cur.backfill_at,
  };
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('reviews', ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v").bind(JSON.stringify(c)).run();
  return c;
}

/* ---------------- small helpers ---------------- */
export function cleanPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  const m = /^(?:0|91)?([6-9]\d{9})$/.exec(d);
  return m ? m[1] : '';
}
const B62 = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export function newToken(n = 10) { return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => B62[b % B62.length]).join(''); }
const istTs = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(v || '')); return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000) - 19800 : 0; };
const isoTs = (v) => { const t = Date.parse(String(v || '')); return Number.isNaN(t) ? 0 : Math.floor(t / 1000); };
/** "Riya Sharma" -> "Riya S." */
export function displayName(first, last) {
  const f = String(first || '').trim().split(/\s+/)[0] || '';
  const l = String(last || '').trim();
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
  return f ? cap(f) + (l ? ' ' + l.charAt(0).toUpperCase() + '.' : '') : 'Ink Kulture customer';
}
export function istHour(t = now()) { return new Date((t + 19800) * 1000).getUTCHours(); }

/* ---------------- 1. which orders were delivered (Shopify + tracking) ---------------- */

/** Where one Shopify order is, for reviews: { state, delivered_at, fulfilled_at, awb, url, note }. Pure. */
export function shopifyDelivery(o) {
  if (o.cancelledAt) return { state: 'skipped', note: 'order cancelled' };
  if (/refunded/i.test(String(o.displayFinancialStatus || ''))) return { state: 'skipped', note: 'refunded' };
  const ff = (o.fulfillments || []).filter((f) => String(f.displayStatus || '').toUpperCase() !== 'CANCELED' && String(f.status || '').toUpperCase() !== 'CANCELLED');
  if (!ff.length) return { state: 'skipped', note: 'no live shipment' };
  let delivered = 0, returned = false, fulfilled = 0, awb = '', url = '';
  for (const f of ff) {
    const ds = String(f.displayStatus || '').toUpperCase();
    const evs = (f.events?.nodes || []).filter((e) => String(e.status).toUpperCase() === 'DELIVERED').map((e) => isoTs(e.happenedAt)).filter(Boolean);
    const d = isoTs(f.deliveredAt) || (evs.length ? Math.min(...evs) : 0) || (ds === 'DELIVERED' ? isoTs(f.updatedAt) || isoTs(f.createdAt) : 0);
    if (d) delivered = delivered ? Math.min(delivered, d) : d;
    if (ds === 'NOT_DELIVERED' || ds === 'FAILURE') returned = true;
    fulfilled = fulfilled ? Math.min(fulfilled, isoTs(f.createdAt) || fulfilled) : isoTs(f.createdAt);
    const ti = (f.trackingInfo || [])[0] || {};
    if (!awb && ti.number) { awb = String(ti.number); url = String(ti.url || ''); }
  }
  if (delivered) return { state: 'delivered', delivered_at: delivered, fulfilled_at: fulfilled, awb, url };
  if (returned) return { state: 'returned', fulfilled_at: fulfilled, awb, url, note: 'not delivered (returned)' };
  return { state: 'shipped', fulfilled_at: fulfilled, awb, url };
}

const ORDERS_Q = `query($q:String!,$after:String){ orders(first:50, after:$after, sortKey:UPDATED_AT, query:$q){
  pageInfo{ hasNextPage endCursor }
  nodes{ legacyResourceId name updatedAt cancelledAt displayFinancialStatus tags phone email
    shippingAddress{ firstName lastName phone city }
    billingAddress{ firstName lastName phone }
    lineItems(first:6){ nodes{ title quantity } }
    fulfillments(first:5){ status displayStatus createdAt updatedAt deliveredAt trackingInfo{ number url company }
      events(first:20, sortKey:HAPPENED_AT){ nodes{ status happenedAt } } } } } }`;

/** Upsert one order into review_asks without undoing anything already sent / reviewed. */
async function upsertAsk(env, o, cfg) {
  const id = String(o.legacyResourceId);
  const d = shopifyDelivery(o);
  const tags = (o.tags || []).map((x) => String(x).toLowerCase());
  if (tags.some((x) => /collab|barter|creator|test/.test(x))) { d.state = 'skipped'; d.note = 'collab / test order'; }
  const phone = cleanPhone(o.shippingAddress?.phone) || cleanPhone(o.phone) || cleanPhone(o.billingAddress?.phone);
  if (!phone && d.state !== 'skipped') { d.state = 'skipped'; d.note = 'no phone number'; }
  const first = o.shippingAddress?.firstName || o.billingAddress?.firstName || '';
  const last = o.shippingAddress?.lastName || o.billingAddress?.lastName || '';
  const items = (o.lineItems?.nodes || []).map((l) => String(l.title || '').replace(/\s*[-|]\s*(small|medium|large|\d+\s*(x|×)\s*\d+.*)$/i, '').trim()).filter(Boolean).slice(0, 6).join(' · ').slice(0, 300);
  const cur = await env.DB.prepare('SELECT state, delivered_at, checked_at FROM review_asks WHERE order_id=?').bind(id).first();
  const t = now();
  if (!cur) {
    await env.DB.prepare(`INSERT INTO review_asks (order_id, order_name, phone, first_name, last_name, city, items, state, delivered_at, fulfilled_at, awb, track_url, note, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, o.name, phone, first, last, o.shippingAddress?.city || '', items, d.state, d.delivered_at || null, d.fulfilled_at || null, d.awb || '', d.url || '', d.note || '', t, t).run();
    return d.state;
  }
  /* sent / reviewed / failed / held rows keep their state; only the delivery facts move forward */
  if (!['shipped', 'delivered', 'returned', 'skipped'].includes(cur.state)) return cur.state;
  let state = d.state, delivered = d.delivered_at || null;
  if (cur.state === 'delivered' && d.state === 'shipped') { state = 'delivered'; delivered = cur.delivered_at; }   /* tracking already said delivered */
  if (cur.state === 'returned' && d.state === 'shipped') state = 'returned';
  await env.DB.prepare(`UPDATE review_asks SET order_name=?, phone=?, first_name=?, last_name=?, city=?, items=?, state=?, delivered_at=COALESCE(?::bigint, delivered_at),
      fulfilled_at=COALESCE(?::bigint, fulfilled_at), awb=CASE WHEN ?::text<>'' THEN ?::text ELSE awb END, track_url=CASE WHEN ?::text<>'' THEN ?::text ELSE track_url END, note=?, updated_at=? WHERE order_id=?`)
    .bind(o.name, phone, first, last, o.shippingAddress?.city || '', items, state, delivered, d.fulfilled_at || null, d.awb || '', d.awb || '', d.url || '', d.url || '', d.note || '', t, id).run();
  return state;
}

/** Incremental scan of Shopify's fulfilled orders (by updated_at). Up to `pages` x 50 orders per call. */
export async function scanShopify(env, { pages = 3 } = {}) {
  const cfg = await reviewCfg(env);
  const row = await env.DB.prepare("SELECT v FROM settings WHERE k='reviews_scan'").first().catch(() => null);
  let st = {}; try { st = row ? JSON.parse(row.v) : {}; } catch { /* fresh */ }
  const since = st.since || '2020-01-01T00:00:00Z';
  let after = st.cursor || null, maxUpd = st.max_upd || since, seen = 0, done = false;
  const q = `fulfillment_status:shipped updated_at:>='${since}'`;
  for (let p = 0; p < pages; p++) {
    const d = await gql(env, ORDERS_Q, { q, after });
    const page = d.orders || d.data?.orders;
    for (const o of page.nodes) { await upsertAsk(env, o, cfg); seen++; if (o.updatedAt > maxUpd) maxUpd = o.updatedAt; }
    if (!page.pageInfo.hasNextPage) { done = true; break; }
    after = page.pageInfo.endCursor;
  }
  /* a finished pass starts the next one from the newest change seen (1 h overlap); otherwise carry on from the cursor */
  const next = done
    ? { since: new Date(Date.parse(maxUpd) - 3600 * 1000).toISOString(), cursor: null, max_upd: null, full_at: now(), passes: (st.passes || 0) + 1 }
    : { ...st, since, cursor: after, max_upd: maxUpd };
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('reviews_scan', ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v").bind(JSON.stringify(next)).run();
  return { seen, done };
}

/** Orders shipped but not yet seen delivered in Shopify: ask the tracking. At most `max` per call, each every 6 h. */
export async function checkTracking(env, { max = 30, track } = {}) {
  const t = now();
  const rows = (await env.DB.prepare(`SELECT order_id, awb, track_url, fulfilled_at FROM review_asks WHERE state='shipped' AND COALESCE(checked_at,0)<?
      ORDER BY COALESCE(checked_at,0), fulfilled_at LIMIT ?`).bind(t - 6 * 3600, max).all()).results;
  const out = { checked: 0, delivered: 0, returned: 0, gave_up: 0 };
  for (const r of rows) {
    out.checked++;
    let stage = '', at = 0;
    const sh = await env.DB.prepare('SELECT stage, delivered_at, rto, awb FROM shipments WHERE order_id=?').bind(String(r.order_id)).first().catch(() => null);
    if (sh && (!r.awb || !sh.awb || sh.awb === r.awb)) {
      if (sh.stage === 'delivered') { stage = 'delivered'; at = Number(sh.delivered_at) || 0; }
      else if (sh.stage === 'rto' || sh.rto) stage = 'rto';
    }
    if (!stage && r.awb && !/nimbuspost/i.test(r.track_url || '')) {
      try {
        const s = summarize(track ? await track(r.awb) : await sr(env, 'GET', `courier/track/awb/${encodeURIComponent(r.awb)}`));
        if (s.stage === 'delivered') { stage = 'delivered'; at = istTs(s.newestAt) || 0; }
        else if (s.stage === 'rto') stage = 'rto';
      } catch { /* not trackable right now */ }
    }
    if (stage === 'delivered') {
      await env.DB.prepare("UPDATE review_asks SET state='delivered', delivered_at=?, checked_at=?, note='delivered (tracking)', updated_at=? WHERE order_id=? AND state='shipped'").bind(at || t, t, t, r.order_id).run();
      out.delivered++;
    } else if (stage === 'rto') {
      await env.DB.prepare("UPDATE review_asks SET state='returned', checked_at=?, note='returned to origin (tracking)', updated_at=? WHERE order_id=? AND state='shipped'").bind(t, t, r.order_id).run();
      out.returned++;
    } else if (Number(r.fulfilled_at || t) < t - 35 * DAY) {
      await env.DB.prepare("UPDATE review_asks SET state='skipped', checked_at=?, note='no delivery scan within 35 days', updated_at=? WHERE order_id=? AND state='shipped'").bind(t, t, r.order_id).run();
      out.gave_up++;
    } else {
      await env.DB.prepare('UPDATE review_asks SET checked_at=? WHERE order_id=?').bind(t, r.order_id).run();
    }
  }
  return out;
}

/* ---------------- 2. the WhatsApp ask ---------------- */

/** The template, ready for Meta (button opens /review/<token>). */
export function reviewTemplate(base) {
  const b = String(base || '').replace(/\/$/, '');
  return {
    name: REVIEW_TEMPLATE, language: 'en', category: 'UTILITY', allow_category_change: true,
    components: [
      { type: 'BODY', text: 'Hi {{1}}, your Ink Kulture order {{2}} was delivered a few days ago. How do the tattoos look on you?\n\nTap below to rate us and add a photo or two. It takes less than a minute and really helps a small Indian brand.',
        example: { body_text: [['Riya', '#1663']] } },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Rate & review', url: `${b}/review/{{1}}`, example: [`${b}/review/Ab3dEf7hJk`] }] },
    ],
  };
}

/** Rows whose ask is due now (delivered + delay passed; customers delivered before launch only after backfill). */
async function dueRows(env, cfg, limit) {
  const t = now(), delay = cfg.delay_days * DAY;
  const pastCut = (cfg.launched_at || t) - delay;
  return (await env.DB.prepare(`SELECT * FROM review_asks WHERE state='delivered' AND order_id NOT LIKE 'test-%' AND delivered_at<=?
      AND (delivered_at>=? OR ?::bigint>0) AND COALESCE(hold_until,0)<? ORDER BY delivered_at DESC LIMIT ?`)
    .bind(t - delay, pastCut, cfg.backfill_at || 0, t, limit).all()).results;
}
export async function countDue(env, cfg) {
  const t = now(), delay = cfg.delay_days * DAY, pastCut = (cfg.launched_at || t) - delay;
  const r = await env.DB.prepare(`SELECT
      SUM(CASE WHEN state='delivered' AND delivered_at<=? AND delivered_at>=? THEN 1 ELSE 0 END) AS due,
      SUM(CASE WHEN state='delivered' AND delivered_at<? THEN 1 ELSE 0 END) AS past,
      SUM(CASE WHEN state='delivered' AND delivered_at>? THEN 1 ELSE 0 END) AS waiting
      FROM review_asks WHERE order_id NOT LIKE 'test-%'`).bind(t - delay, pastCut, pastCut, t - delay).first();
  return { due: Number(r?.due || 0), past: Number(r?.past || 0), waiting: Number(r?.waiting || 0) };
}

/** One customer, one ask: another order of theirs asked recently or reviewed means skip. */
async function askedRecently(env, cfg, row) {
  const r = await env.DB.prepare(`SELECT order_name FROM review_asks WHERE phone=? AND order_id<>? AND (state='reviewed' OR COALESCE(sent_at,0)>?) LIMIT 1`)
    .bind(row.phone, row.order_id, now() - cfg.repeat_days * DAY).first();
  return r ? r.order_name : '';
}

/** Send the ask for one row. send = fireTrigger-like (tests). Returns { ok } | { held } | { skipped } | { error }. */
export async function askOne(env, row, { send, force = false } = {}) {
  const t = now();
  const token = row.token || newToken();
  if (!row.token) await env.DB.prepare('UPDATE review_asks SET token=? WHERE order_id=?').bind(token, row.order_id).run();
  const fire = send || (async (...a) => (await import('./whatsapp.js')).fireTrigger(...a));
  const r = await fire(env, 'review_ask', { to: row.phone, vars: { name: displayName(row.first_name).replace(/ .*/, '') || 'there', order: row.order_name, rtok: token }, orderId: String(row.order_id).startsWith('test-') ? '0' : String(row.order_id), orderName: row.order_name, force });
  if (r && r.ok) {
    await env.DB.prepare("UPDATE review_asks SET state=CASE WHEN order_id LIKE 'test-%' THEN 'test' ELSE 'sent' END, sent_at=?, note=?, updated_at=? WHERE order_id=?").bind(t, 'sent: ' + (r.template || REVIEW_TEMPLATE), t, row.order_id).run();
    return { ok: true, token };
  }
  if (r && r.skipped) {
    await env.DB.prepare("UPDATE review_asks SET state='skipped', note=?, updated_at=? WHERE order_id=?").bind('not sent: ' + r.skipped, t, row.order_id).run();
    return { skipped: r.skipped };
  }
  const err = String(r?.error || 'not sent');
  if (WAIT.test(err)) {   /* template still in review at Meta: try again in an hour */
    await env.DB.prepare('UPDATE review_asks SET hold_until=?, note=?, updated_at=? WHERE order_id=?').bind(t + 3600, 'waiting for the WhatsApp template to be approved', t, row.order_id).run();
    return { held: true, error: err };
  }
  const tries = Number(row.tries || 0) + 1;
  await env.DB.prepare(`UPDATE review_asks SET tries=?, hold_until=?, note=?, state=CASE WHEN ?::int>=3 THEN 'failed' ELSE state END, updated_at=? WHERE order_id=?`)
    .bind(tries, t + 3 * 3600, 'send failed: ' + err.slice(0, 160), tries, t, row.order_id).run();
  return { error: err };
}

/** Cron: send the asks that are due (10 am - 8 pm IST), one per customer. */
export async function sendDue(env, { send, cfg: cfg0 } = {}) {
  const cfg = cfg0 || await reviewCfg(env);
  const out = { sent: 0, skipped: 0, held: 0, failed: 0 };
  if (!cfg.on) return { ...out, off: true };
  const h = istHour();
  if (cfg.quiet && (h < 10 || h >= 20)) return { ...out, quiet: true };
  const rows = await dueRows(env, cfg, cfg.per_run * 3);
  const phones = new Set();
  for (const row of rows) {
    if (out.sent >= cfg.per_run) break;
    const t = now();
    const dup = phones.has(row.phone) ? 'this run' : await askedRecently(env, cfg, row);
    if (dup) {
      await env.DB.prepare("UPDATE review_asks SET state='skipped', note=?, updated_at=? WHERE order_id=?").bind(`same customer already asked (${dup})`, t, row.order_id).run();
      out.skipped++; continue;
    }
    phones.add(row.phone);
    const r = await askOne(env, row, { send });
    if (r.ok) out.sent++; else if (r.held) { out.held++; break; } else if (r.skipped) out.skipped++; else out.failed++;
  }
  return out;
}

/** Everything the cron does for reviews, within a few seconds. */
export async function reviewsTick(env, { send, track } = {}) {
  const cfg = await reviewCfg(env);
  if (!cfg.launched_at) await saveReviewCfg(env, {});
  await env.DB.prepare("UPDATE review_asks SET state='test' WHERE order_id LIKE 'test-%' AND state<>'test'").run().catch(() => {});
  const out = {};
  try { out.scan = await scanShopify(env, { pages: 3 }); } catch (e) { out.scan = { error: String(e.message || e).slice(0, 160) }; }
  try { out.track = await checkTracking(env, { max: 25, track }); } catch (e) { out.track = { error: String(e.message || e).slice(0, 160) }; }
  try { out.send = await sendDue(env, { send }); } catch (e) { out.send = { error: String(e.message || e).slice(0, 160) }; }
  return out;
}

/* ---------------- 3. reviews ---------------- */

export async function askByToken(env, token) {
  if (!/^[A-Za-z0-9]{6,16}$/.test(String(token || ''))) return null;
  return env.DB.prepare('SELECT * FROM review_asks WHERE token=?').bind(String(token)).first();
}
async function photosOf(env, ids) {
  if (!ids.length) return {};
  const rows = (await env.DB.prepare(`SELECT id, review_id, w, h FROM review_photos WHERE review_id IN (${ids.map(() => '?').join(',')}) ORDER BY review_id, idx, id`).bind(...ids).all()).results;
  const by = {};
  for (const p of rows) (by[p.review_id] ||= []).push({ id: p.id, w: p.w, h: p.h });
  return by;
}

const JPEG = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/;
/** Save (or update) the review for one link. body: { rating, tags[], text, name, consent, keep[], photos:[{full, thumb, w, h}] } */
export async function submitReview(env, token, b, cfg0) {
  const ask = await askByToken(env, token);
  if (!ask) return { ok: false, error: 'This review link is not valid.' };
  const cfg = cfg0 || await reviewCfg(env);
  const rating = Math.round(Number(b.rating));
  if (!(rating >= 1 && rating <= 5)) return { ok: false, error: 'Please pick 1 to 5 stars.' };
  const allowed = new Set([...TAGS_GOOD, ...TAGS_BAD]);
  const tags = (Array.isArray(b.tags) ? b.tags : []).map(String).filter((x) => allowed.has(x)).slice(0, 8);
  const text = String(b.text || '').replace(/\s+\n/g, '\n').trim().slice(0, 1500);
  const name = String(b.name || '').replace(/[<>]/g, '').trim().slice(0, 40) || displayName(ask.first_name, ask.last_name);
  const consent = b.consent !== false;
  const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 4);
  for (const p of photos) {
    const f = JPEG.exec(String(p.full || '')), th = JPEG.exec(String(p.thumb || ''));
    if (!f || !th) return { ok: false, error: 'A photo could not be read. Please try another one.' };
    if (f[1].length > 1400000 || th[1].length > 200000) return { ok: false, error: 'A photo is too large.' };
  }
  const t = now(), test = String(ask.order_id).startsWith('test-');
  const live = cfg.auto_publish && consent && rating >= 4 && !test;
  let rev = await env.DB.prepare('SELECT id, status FROM reviews WHERE ask_token=?').bind(token).first();
  if (rev) {
    await env.DB.prepare(`UPDATE reviews SET rating=?, tags=?, body=?, name=?, consent=?, updated_at=?,
        status=CASE WHEN NOT ?::boolean THEN 'hidden' WHEN status='published' THEN 'published' WHEN ?::boolean THEN 'published' ELSE 'new' END WHERE id=?`)
      .bind(rating, JSON.stringify(tags), text, name, consent, t, consent, live, rev.id).run();
    const keep = (Array.isArray(b.keep) ? b.keep : []).map(Number).filter(Boolean);
    const old = (await env.DB.prepare('SELECT id FROM review_photos WHERE review_id=?').bind(rev.id).all()).results;
    for (const p of old) if (!keep.includes(Number(p.id))) await env.DB.prepare('DELETE FROM review_photos WHERE id=?').bind(p.id).run();
  } else {
    rev = await env.DB.prepare(`INSERT INTO reviews (ask_token, order_id, order_name, phone, city, items, name, rating, tags, body, consent, status, pinned, test, created_at, updated_at, published_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,FALSE,?,?,?,?) RETURNING id`)
      .bind(token, ask.order_id, ask.order_name, ask.phone, ask.city || '', ask.items || '', name, rating, JSON.stringify(tags), text, consent, live ? 'published' : 'new', test, t, t, live ? t : null).first();
  }
  const have = Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM review_photos WHERE review_id=?').bind(rev.id).first())?.n || 0);
  let idx = have;
  for (const p of photos.slice(0, Math.max(0, 4 - have))) {
    await env.DB.prepare('INSERT INTO review_photos (review_id, idx, w, h, full_b64, thumb_b64, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(rev.id, idx++, Math.round(Number(p.w) || 0), Math.round(Number(p.h) || 0), JPEG.exec(p.full)[1], JPEG.exec(p.thumb)[1], t).run();
  }
  await env.DB.prepare("UPDATE review_asks SET state=CASE WHEN order_id LIKE 'test-%' THEN 'test' ELSE 'reviewed' END, reviewed_at=COALESCE(reviewed_at, ?), updated_at=? WHERE token=?").bind(t, t, token).run();
  return { ok: true, id: rev.id, rating };
}

/** The review already left with this link (to edit it). */
export async function reviewForToken(env, token) {
  const r = await env.DB.prepare('SELECT id, rating, tags, body, name, consent FROM reviews WHERE ask_token=?').bind(token).first();
  if (!r) return null;
  const ph = (await photosOf(env, [r.id]))[r.id] || [];
  let tags = []; try { tags = JSON.parse(r.tags || '[]'); } catch { /* none */ }
  return { rating: r.rating, tags, text: r.body || '', name: r.name, consent: !!r.consent, photos: ph.map((p) => p.id) };
}

/** Public: published reviews for the website + the overall rating (all real reviews, shown or not). */
export async function publicList(env, { limit = 12, offset = 0, photos = false } = {}) {
  const lim = Math.min(48, Math.max(1, Number(limit) || 12)), off = Math.max(0, Number(offset) || 0);
  const sum = await env.DB.prepare('SELECT COUNT(*) AS n, AVG(rating) AS avg, SUM(CASE WHEN rating>=4 THEN 1 ELSE 0 END) AS good FROM reviews WHERE NOT test').first();
  const where = `status='published' AND consent AND NOT test${photos ? ' AND EXISTS (SELECT 1 FROM review_photos p WHERE p.review_id=reviews.id)' : ''}`;
  const shown = Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE ${where}`).first())?.n || 0);
  const rows = (await env.DB.prepare(`SELECT id, name, city, rating, tags, body, created_at, pinned FROM reviews WHERE ${where}
      ORDER BY pinned DESC, published_at DESC NULLS LAST, created_at DESC LIMIT ? OFFSET ?`).bind(lim, off).all()).results;
  const ph = await photosOf(env, rows.map((r) => r.id));
  return {
    ok: true,
    summary: { count: Number(sum?.n || 0), avg: sum?.n ? Math.round(Number(sum.avg) * 10) / 10 : 0, recommend: sum?.n ? Math.round((Number(sum.good) / Number(sum.n)) * 100) : 0, shown },
    reviews: rows.map((r) => {
      let tags = []; try { tags = JSON.parse(r.tags || '[]'); } catch { /* none */ }
      return { id: r.id, name: r.name, city: r.city || '', rating: r.rating, tags, text: r.body || '', date: r.created_at, pinned: !!r.pinned, photos: (ph[r.id] || []).map((p) => ({ id: p.id, w: p.w, h: p.h })) };
    }),
    more: off + rows.length < shown,
  };
}

/* ---------------- 4. dashboard ---------------- */
export async function adminList(env, b = {}) {
  const cfg = await reviewCfg(env);
  const st = ['new', 'published', 'hidden'].includes(b.status) ? b.status : '';
  const q = String(b.q || '').trim();
  const where = [];
  const args = [];
  if (st) { where.push('status=?'); args.push(st); }
  if (b.stars) { where.push('rating=?'); args.push(Number(b.stars)); }
  if (q) { where.push("(order_name ILIKE ? OR name ILIKE ? OR body ILIKE ? OR phone LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q.replace(/\D/g, '') || q}%`); }
  const rows = (await env.DB.prepare(`SELECT * FROM reviews ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 60 OFFSET ?`).bind(...args, Math.max(0, Number(b.offset) || 0)).all()).results;
  const ph = await photosOf(env, rows.map((r) => r.id));
  const stats = await env.DB.prepare(`SELECT COUNT(*) AS n, AVG(rating) AS avg,
      SUM(CASE WHEN status='new' THEN 1 ELSE 0 END) AS fresh, SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS live,
      SUM(CASE WHEN status='hidden' THEN 1 ELSE 0 END) AS hidden,
      SUM(CASE WHEN rating=5 THEN 1 ELSE 0 END) AS s5, SUM(CASE WHEN rating=4 THEN 1 ELSE 0 END) AS s4, SUM(CASE WHEN rating=3 THEN 1 ELSE 0 END) AS s3,
      SUM(CASE WHEN rating=2 THEN 1 ELSE 0 END) AS s2, SUM(CASE WHEN rating=1 THEN 1 ELSE 0 END) AS s1 FROM reviews WHERE NOT test`).first();
  const asks = (await env.DB.prepare("SELECT state, COUNT(*) AS n FROM review_asks WHERE order_id NOT LIKE 'test-%' GROUP BY state").all()).results;
  const opened = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM review_asks WHERE opened_at IS NOT NULL AND order_id NOT LIKE 'test-%'").first())?.n || 0);
  const scan = await env.DB.prepare("SELECT v FROM settings WHERE k='reviews_scan'").first().catch(() => null);
  return {
    ok: true, cfg,
    reviews: rows.map((r) => { let tags = []; try { tags = JSON.parse(r.tags || '[]'); } catch { /* none */ } return { ...r, tags, photos: (ph[r.id] || []).map((p) => p.id) }; }),
    stats: { ...Object.fromEntries(Object.entries(stats || {}).map(([k, v]) => [k, Number(v) || 0])), avg: stats?.n ? Math.round(Number(stats.avg) * 10) / 10 : 0 },
    asks: Object.fromEntries(asks.map((a) => [a.state, Number(a.n)])), opened,
    due: await countDue(env, cfg),
    scan: (() => { try { return JSON.parse(scan?.v || '{}'); } catch { return {}; } })(),
    tags: { good: TAGS_GOOD, bad: TAGS_BAD },
  };
}
export async function adminSet(env, b) {
  const id = Number(b.id); if (!id) throw new Error('no review');
  const t = now();
  if (b.status && ['new', 'published', 'hidden'].includes(b.status)) {
    const r = await env.DB.prepare('SELECT consent FROM reviews WHERE id=?').bind(id).first();
    if (b.status === 'published' && r && !r.consent) throw new Error('This customer did not allow showing the review on the website');
    await env.DB.prepare('UPDATE reviews SET status=?, published_at=CASE WHEN ?::text=\'published\' THEN COALESCE(published_at, ?::bigint) ELSE published_at END, updated_at=? WHERE id=?').bind(b.status, b.status, t, t, id).run();
  }
  if (b.pinned !== undefined) await env.DB.prepare('UPDATE reviews SET pinned=?, updated_at=? WHERE id=?').bind(!!b.pinned, t, id).run();
  if (b.reply !== undefined) await env.DB.prepare('UPDATE reviews SET reply=?, updated_at=? WHERE id=?').bind(String(b.reply || '').slice(0, 600), t, id).run();
  return { ok: true };
}
export async function adminDelete(env, b) {
  const id = Number(b.id); if (!id) throw new Error('no review');
  const r = await env.DB.prepare('SELECT ask_token FROM reviews WHERE id=?').bind(id).first();
  await env.DB.prepare('DELETE FROM review_photos WHERE review_id=?').bind(id).run();
  await env.DB.prepare('DELETE FROM reviews WHERE id=?').bind(id).run();
  if (r?.ask_token) await env.DB.prepare("UPDATE review_asks SET state='sent' WHERE token=? AND state='reviewed' AND order_id NOT LIKE 'test-%'").bind(r.ask_token).run();
  return { ok: true };
}
/** A test ask to any number: a real link and the real WhatsApp message (marked test, never shown on the website). */
export async function adminTest(env, b, { send } = {}) {
  const phone = cleanPhone(b.phone);
  if (!phone) throw new Error('Enter a 10-digit Indian mobile number');
  const t = now(), id = 'test-' + t, token = newToken();
  await env.DB.prepare(`INSERT INTO review_asks (order_id, order_name, phone, first_name, last_name, city, items, state, delivered_at, token, note, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,'test',?,?,?,?,?)`).bind(id, '#TEST', phone, String(b.name || 'there').slice(0, 30), '', '', 'Test order · sample designs', t, token, 'test message', t, t).run();
  const base = String(env.WORKER_URL || '').replace(/\/$/, '');
  const link = `${base}/review/${token}`;
  if (b.whatsapp === false) return { ok: true, link };
  const row = await env.DB.prepare('SELECT * FROM review_asks WHERE order_id=?').bind(id).first();
  const r = await askOne(env, row, { send, force: true });
  return { ok: true, link, sent: !!r.ok, error: r.error || r.skipped || '' };
}
