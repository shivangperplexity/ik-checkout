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
  /* COD -> prepaid conversion */
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS convert_offer_at BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS convert_txnid TEXT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS converted_at BIGINT`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_paise BIGINT`,
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
