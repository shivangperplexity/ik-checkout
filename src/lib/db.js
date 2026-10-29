// Tiny adapter so the app code keeps its prepare().bind().run()/first()/all() calls.
// Backed by Postgres (Neon via the Vercel Marketplace). Tables are created on first use.
import { neon } from '@neondatabase/serverless';

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (
    phone TEXT PRIMARY KEY, name TEXT, pincode TEXT, cart_json TEXT, utm_json TEXT, fbp TEXT, fbc TEXT, step TEXT,
    status TEXT DEFAULT 'open', created_at BIGINT, updated_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS orders (
    idem TEXT PRIMARY KEY, txnid TEXT UNIQUE, event_id TEXT, draft_id TEXT, order_id TEXT, order_gid TEXT, order_name TEXT,
    status_url TEXT, method TEXT, total_paise BIGINT, phone TEXT, email TEXT, first_name TEXT, last_name TEXT, city TEXT,
    state_code TEXT, pincode TEXT, fbp TEXT, fbc TEXT, source_url TEXT, contents_json TEXT, status TEXT,
    confirmed_at BIGINT, flagged_at BIGINT, created_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders (order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_cod_open ON orders (method, status, confirmed_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY, phone TEXT, name TEXT, device TEXT, cart_json TEXT, cart_value BIGINT DEFAULT 0, step TEXT, max_step INTEGER DEFAULT 0,
    method TEXT, source TEXT, utm_json TEXT, page TEXT, first_seen BIGINT, last_seen BIGINT, ordered INTEGER DEFAULT 0, order_name TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_seen ON sessions (last_seen)`,
  `CREATE TABLE IF NOT EXISTS events (id BIGSERIAL PRIMARY KEY, sid TEXT, ts BIGINT, type TEXT, data TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts)`,
  `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS messages (id BIGSERIAL PRIMARY KEY, ts BIGINT, direction TEXT, phone TEXT, trigger TEXT, template TEXT, status TEXT, order_name TEXT, wamid TEXT, error TEXT, preview TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_wamid ON messages (wamid)`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS nudged_at BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS sid TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS packed_at BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS reminded_at BIGINT`,
  `CREATE TABLE IF NOT EXISTS rl (ip TEXT, hr BIGINT, n INTEGER, PRIMARY KEY (ip, hr))`,
  /* WhatsApp via Go4WhatsUp. Their API drops quick-reply payloads, so a button tap arrives as label + phone
     only; wa_pending remembers which order we last asked that phone to confirm. */
  `CREATE TABLE IF NOT EXISTS wa_pending (phone TEXT PRIMARY KEY, order_id TEXT, order_name TEXT, sent_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS idx_wa_pending_order ON wa_pending (order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders (phone, created_at)`,
  /* Numbers that replied STOP: no more marketing templates (order confirmations still go out). */
  `CREATE TABLE IF NOT EXISTS wa_optout (phone TEXT PRIMARY KEY, at BIGINT)`,
  /* Inbound WhatsApp message ids already handled: Meta can deliver the same webhook more than once. */
  `CREATE TABLE IF NOT EXISTS wa_seen (id TEXT PRIMARY KEY, at BIGINT)`,
  /* WhatsApp shipment updates: one row per shipped order. sent = JSON of which updates went out. No address data. */
  `CREATE TABLE IF NOT EXISTS ship_track (order_id TEXT PRIMARY KEY, awb TEXT, courier TEXT, url TEXT, status TEXT, sent TEXT, checked_at BIGINT, done BOOLEAN DEFAULT FALSE, updated_at BIGINT)`,
  /* Shiprocket bookings made from the dashboard (one row per Shopify order; no addresses stored) */
  `CREATE TABLE IF NOT EXISTS shipments (order_id TEXT PRIMARY KEY, order_name TEXT, sr_order_id TEXT, sr_shipment_id TEXT, awb TEXT, courier TEXT, courier_id TEXT, charge_paise BIGINT DEFAULT 0, pack TEXT, label_url TEXT, pickup TEXT, status TEXT, rto BOOLEAN DEFAULT FALSE, created_at BIGINT, updated_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS idx_shipments_awb ON shipments (awb)`,
  /* why the Shopify fulfilment step failed after a booking (empty = fine); the cron retries until it works */
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS fulfil_error TEXT`,
  /* order cancelled while the parcel was booked: 'cancelled' (pickup stopped), 'picked' (too late, needs RTO), 'error' (retrying) */
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS cancel_state TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS cancel_note TEXT`,
  /* Shipments tab: Shiprocket's own status text, our stage (lib/ship-status.js) and when it was last checked */
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS stage TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS sr_status TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracked_at BIGINT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS picked_at BIGINT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS delivered_at BIGINT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS edd TEXT`,
  /* 15 Oct 2026: the first status reader counted courier hub scans ("Manifested - Out for Pickup") as picked up. Re-check those. */
  `UPDATE shipments SET tracked_at=NULL, picked_at=NULL, delivered_at=NULL WHERE tracked_at IS NOT NULL AND tracked_at < 1792005497`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS verified_at BIGINT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ndr_choice TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ndr_choice_at BIGINT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ndr_date TEXT`,
  /* AWBs of cancelled bookings (a rebook replaces the shipments row): the label scanner recognises an old label */
  `CREATE TABLE IF NOT EXISTS ship_old_awbs (awb TEXT PRIMARY KEY, order_id TEXT, order_name TEXT, courier TEXT, cancelled_at BIGINT)`,
  /* parcels imported from Shopify fulfilments that were never booked with Shiprocket (old NimbusPost AWBs): not ours to track */
  /* ShipPrime bookings (lib/shipprime.js) have no Shiprocket ids: the column must exist before the cleanup below */
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS provider TEXT`,
  `DELETE FROM shipments WHERE sr_shipment_id IS NULL AND sr_order_id IS NULL AND COALESCE(status,'')<>'booking' AND COALESCE(provider,'')<>'shipprime'`,
  /* WhatsApp assistant: phones waiting for an answer (rate limit hit, or picked from the backlog) */
  `CREATE TABLE IF NOT EXISTS ai_queue (phone TEXT PRIMARY KEY, via TEXT, phone_id TEXT, queued_at BIGINT, tries INT DEFAULT 0, note TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_phone_id ON messages (phone, id)`,
  `CREATE TABLE IF NOT EXISTS ship_issues (order_id TEXT, kind TEXT, order_name TEXT, detail TEXT, first_seen BIGINT, last_seen BIGINT, resolved_at BIGINT, dismissed_at BIGINT, PRIMARY KEY (order_id, kind))`,
  /* COD -> prepaid conversion */
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS convert_offer_at BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS convert_txnid TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS converted_at BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_paise BIGINT`,
  /* Partial COD (lib/partial-cod.js): advance paid online; the courier collects total_paise - advance_paise */
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS advance_paise BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS partial_reason TEXT`,
  /* COD amount we told Shiprocket to collect at booking, and the order total Shiprocket itself shows (reconciliation) */
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS cod_paise BIGINT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS sr_total_paise BIGINT`,
  /* NDR: who chose (customer link / WhatsApp reply / team in the dashboard) and at which failed attempt, so a handled
     parcel stops asking for action until the courier fails again */
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ndr_by TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ndr_attempt INT`,
  /* Meta Conversions API: what Meta answered for this order's Purchase (lib/meta.js), so the dashboard can compare
     Meta's numbers with real orders. capi_pixel = dataset it went to; capi_test = sent with a test_event_code. */
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS capi_at BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS capi_ok BOOLEAN`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS capi_pixel TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS capi_test BOOLEAN`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS capi_error TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS capi_tries INT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_ip TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_ua TEXT`,
  /* Automatic NDR handling (lib/ndr-rules.js): one row per failed attempt (k = attempt number, or the day it was raised) */
  `CREATE TABLE IF NOT EXISTS ndr_auto (awb TEXT, k TEXT, order_id TEXT, order_name TEXT, attempt INT, category TEXT, reason TEXT, first_seen BIGINT, action TEXT, action_at BIGINT, note TEXT, error TEXT, PRIMARY KEY (awb, k))`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ndr_reason TEXT`,
  /* when the refused-delivery question went out (lib/ndr-ask.js); a yes / no after it answers it */
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ndr_asked_at BIGINT`,
  /* NDR autopilot (lib/ndr-pilot.js): nudge sent / re-attempt announced per failed attempt; the one "before you cancel" message */
  `ALTER TABLE ndr_auto ADD COLUMN IF NOT EXISTS nudged_at BIGINT`,
  `ALTER TABLE ndr_auto ADD COLUMN IF NOT EXISTS told_at BIGINT`,
  `ALTER TABLE ndr_auto ADD COLUMN IF NOT EXISTS pilot_note TEXT`,
  `ALTER TABLE ndr_auto ADD COLUMN IF NOT EXISTS tries INT`,
  `ALTER TABLE ndr_auto ADD COLUMN IF NOT EXISTS err_at BIGINT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS sp_ref TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS sp_order_id TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS sp_status TEXT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS sp_event_at BIGINT`,
  /* Refer and earn (lib/referral.js) */
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS retried_at BIGINT`,
  /* support requests from the storefront track page (lib/site.js) */
  `CREATE TABLE IF NOT EXISTS tickets (id SERIAL PRIMARY KEY, phone TEXT, order_name TEXT, topic TEXT, message TEXT, status TEXT, created_at BIGINT, replied_at BIGINT, closed_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS tickets_phone ON tickets (phone, status)`,
  /* delivery date + serviceability per PIN (lib/edd.js) */
  `CREATE TABLE IF NOT EXISTS edd_cache (k TEXT PRIMARY KEY, body TEXT, at BIGINT)`,
  /* Instagram comment -> DM (lib/ig-dm.js) */
  `CREATE TABLE IF NOT EXISTS ig_dm (comment_id TEXT PRIMARY KEY, media_id TEXT, from_id TEXT, username TEXT, text TEXT, status TEXT, error TEXT, created_at BIGINT, sent_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS ig_dm_media ON ig_dm (media_id, from_id)`,
  `CREATE TABLE IF NOT EXISTS ref_codes (phone TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT, created_at BIGINT, invited_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS referrals (idem TEXT PRIMARY KEY, code TEXT, referrer_phone TEXT, friend_phone TEXT, order_id TEXT, order_name TEXT, amount BIGINT, status TEXT, note TEXT, created_at BIGINT, placed_at BIGINT, credited_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS referrals_status ON referrals (status)`,
  `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS told_at BIGINT`,
  /* Creator program (lib/creators.js) */
  `CREATE TABLE IF NOT EXISTS creators (id SERIAL PRIMARY KEY, phone TEXT UNIQUE, name TEXT, handle TEXT, platform TEXT, profile_url TEXT, followers INT, city TEXT, email TEXT, about TEXT, status TEXT, code TEXT UNIQUE, payout TEXT, upi TEXT, pan TEXT, payout_at BIGINT, note TEXT, created_at BIGINT, approved_at BIGINT, rejected_at BIGINT, told_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS creator_clicks (code TEXT, day TEXT, n INT DEFAULT 0, uniq INT DEFAULT 0, PRIMARY KEY (code, day))`,
  `CREATE TABLE IF NOT EXISTS creator_seen (k TEXT PRIMARY KEY, at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS creator_orders (idem TEXT PRIMARY KEY, code TEXT, creator_id INT, phone TEXT, method TEXT, total BIGINT, discount BIGINT, status TEXT, order_id TEXT, order_name TEXT, earned BIGINT, reward_type TEXT, earned_at BIGINT, created_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS creator_orders_creator ON creator_orders (creator_id)`,
  `CREATE TABLE IF NOT EXISTS creator_payouts (id SERIAL PRIMARY KEY, creator_id INT, amount BIGINT, upi TEXT, ref TEXT, created_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS creator_vouchers (code TEXT PRIMARY KEY, creator_id INT, amount BIGINT, status TEXT, idem TEXT, held_at BIGINT, used_at BIGINT, created_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS credits (id SERIAL PRIMARY KEY, phone TEXT, amount_paise BIGINT, left_paise BIGINT, reason TEXT, ref_idem TEXT, created_at BIGINT, expires_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS credits_phone ON credits (phone)`,
  `CREATE TABLE IF NOT EXISTS credit_uses (idem TEXT PRIMARY KEY, phone TEXT, amount BIGINT, took TEXT, status TEXT, order_id TEXT, created_at BIGINT, used_at BIGINT)`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ndr_save_at BIGINT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ndr_commit_at BIGINT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS ndr_fake INT`,
  /* label printing on the packing Mac (lib/print-agent.js) */
  `CREATE TABLE IF NOT EXISTS print_jobs (id SERIAL PRIMARY KEY, order_id TEXT, order_name TEXT, reason TEXT, created_at BIGINT, taken_at BIGINT, done_at BIGINT, ok BOOLEAN, error TEXT, tries INT DEFAULT 0)`,
  /* WhatsApp chats a person has to answer (assistant handed off, or the team took over) */
  `CREATE TABLE IF NOT EXISTS wa_handoff (phone TEXT PRIMARY KEY, state TEXT, reason TEXT, opened_at BIGINT, replied_at BIGINT, resolved_at BIGINT, ai_paused_until BIGINT, seen_at BIGINT)`,
  `ALTER TABLE wa_handoff ADD COLUMN IF NOT EXISTS seen_id BIGINT`,
  /* Pay-online offer (lib/wa-convert.js): the window, and the exact amount / % quoted when the payment started */
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS convert_expires_at BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS convert_pct INT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS convert_payable_paise BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS convert_started_at BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS addr_tagged_at BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS warned_at BIGINT`,
  /* WhatsApp OTP for COD (lib/cod-otp.js): one row per phone, the code only as an HMAC */
  `CREATE TABLE IF NOT EXISTS cod_otps (phone TEXT PRIMARY KEY, code_hash TEXT, sent_at BIGINT, expires_at BIGINT, tries INT DEFAULT 0, sends INT DEFAULT 0, window_start BIGINT, verified_at BIGINT)`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS otp_at BIGINT`,
  /* which WhatsApp message carried the code, and how far it got (webhook: sent 1, delivered 2, read 3, failed 9) */
  `ALTER TABLE cod_otps ADD COLUMN IF NOT EXISTS wamid TEXT`,
  `ALTER TABLE cod_otps ADD COLUMN IF NOT EXISTS dstatus TEXT`,
  `ALTER TABLE cod_otps ADD COLUMN IF NOT EXISTS drank INT`,
  /* "Nudge again" (lib/cod-nudge.js) */
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS nudged_at BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS nudge_count INT`,
  /* Real revenue (lib/revenue.js): every Shopify order and how it ended */
  `CREATE TABLE IF NOT EXISTS rev_orders (order_id TEXT PRIMARY KEY, name TEXT, created_at BIGINT, total_paise BIGINT, refunded_paise BIGINT, pay TEXT, state TEXT, delivered_at BIGINT, shipped_at BIGINT, carrier TEXT, awb TEXT, units INT, tags TEXT, scanned_at BIGINT)`,
  `ALTER TABLE rev_orders ADD COLUMN IF NOT EXISTS picked_at BIGINT`,
  `ALTER TABLE rev_orders ADD COLUMN IF NOT EXISTS courier TEXT`,
  `ALTER TABLE rev_orders ADD COLUMN IF NOT EXISTS region TEXT`,
  `ALTER TABLE rev_orders ADD COLUMN IF NOT EXISTS src TEXT`,
  `ALTER TABLE rev_orders ADD COLUMN IF NOT EXISTS src_label TEXT`,
  `ALTER TABLE rev_orders ADD COLUMN IF NOT EXISTS src_detail TEXT`,
  /* delivery attempts before RTO, from the courier's scans (lib/sr-scan.js attemptsOf) */
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS attempts INT`,
  `ALTER TABLE shipments ADD COLUMN IF NOT EXISTS attempt_notes TEXT`,
  /* Dashboard assistant conversation (lib/assistant.js) */
  `CREATE TABLE IF NOT EXISTS assistant_msgs (id SERIAL PRIMARY KEY, ts BIGINT, role TEXT, content TEXT)`,
  /* Reviews (lib/reviews.js): one ask per delivered order, the reviews, their photos (JPEG base64) */
  `CREATE TABLE IF NOT EXISTS review_asks (order_id TEXT PRIMARY KEY, order_name TEXT, phone TEXT, first_name TEXT, last_name TEXT, city TEXT, items TEXT, state TEXT, delivered_at BIGINT, fulfilled_at BIGINT, awb TEXT, track_url TEXT, note TEXT, token TEXT UNIQUE, sent_at BIGINT, opened_at BIGINT, reviewed_at BIGINT, checked_at BIGINT, hold_until BIGINT, tries INT DEFAULT 0, created_at BIGINT, updated_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS review_asks_state ON review_asks (state, delivered_at)`,
  `CREATE INDEX IF NOT EXISTS review_asks_phone ON review_asks (phone)`,
  `CREATE TABLE IF NOT EXISTS reviews (id SERIAL PRIMARY KEY, ask_token TEXT UNIQUE, order_id TEXT, order_name TEXT, phone TEXT, city TEXT, items TEXT, name TEXT, rating INT, tags TEXT, body TEXT, consent BOOLEAN DEFAULT TRUE, status TEXT, pinned BOOLEAN DEFAULT FALSE, test BOOLEAN DEFAULT FALSE, reply TEXT, created_at BIGINT, updated_at BIGINT, published_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS review_photos (id SERIAL PRIMARY KEY, review_id INT, idx INT, w INT, h INT, full_b64 TEXT, thumb_b64 TEXT, created_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS review_photos_review ON review_photos (review_id)`,
];

let ready;
let sqlClient;

export function makeDb(env) {
  const url = env.DATABASE_URL || env.POSTGRES_URL;
  if (!url) return null;
  sqlClient ||= neon(url);
  const sql = sqlClient;
  const run = async (text, params) => {
    ready ||= (async () => { for (const s of SCHEMA) await sql.query(s); })().catch((e) => { ready = null; throw e; });
    await ready;
    let i = 0;
    return sql.query(text.replace(/\?/g, () => '$' + ++i), params);
  };
  return {
    prepare(text) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async run() { await run(text, args); return { success: true }; },
        async first() { const r = await run(text, args); return r[0] || null; },
        async all() { return { results: await run(text, args) }; },
      };
      return stmt;
    },
  };
}
