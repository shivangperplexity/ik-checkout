/**
 * Packing alerts for the team on WhatsApp (Nov 2026, owner's ask).
 *
 * The courier picks up every day between 12:30 pm and 6 pm. Parcels that are booked (shipped in Shopify, AWB made)
 * but not marked packed in the dashboard are "to pack". Reminders go to the packing team at fixed times of the day,
 * only when something is waiting:
 *   10:00  plan for the day     12:00  pickup starts 12:30     14:30  still waiting     16:45  last call before 6 pm
 * Each reminder also says how many orders will be booked later today (ready, editing window running).
 * Packed digest: orders marked packed since the last digest go to the "packed" number, at most every 15 minutes
 * (or at once when the last one is packed), 9 am - 8 pm.
 *
 * Settings shipping.pack_alert = { on, to: [phones], packed_to: [phones], pickup: '12:30-18:00' }.
 * Templates: ik_pack_pending_v1, ik_pack_done_v1 (lib/notify-templates.js); triggers pack_pending / pack_done.
 */
const now = () => Math.floor(Date.now() / 1000);
const IST = 19800;
export const PACK_DEFAULTS = { on: true, to: ['9987453483', '7039128567'], packed_to: ['9987453483'], pickup: '12:30-18:00' };
export const SLOTS = [
  { id: 'am', at: '10:00', label: 'Morning plan' },
  { id: 'noon', at: '12:00', label: 'Pickup starts at 12:30' },
  { id: 'mid', at: '14:30', label: 'Afternoon check' },
  { id: 'last', at: '16:45', label: 'Last call, pickup ends at 6 pm' },
];

const p10 = (x) => String(x || '').replace(/\D/g, '').slice(-10);
export function packCfg(env) {
  const c = { ...PACK_DEFAULTS, ...(env.SETTINGS?.shipping?.pack_alert || {}) };
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]+/)).map(p10).filter((x) => /^[6-9]\d{9}$/.test(x));
  return { on: c.on !== false, to: list(c.to), packed_to: list(c.packed_to), pickup: /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(String(c.pickup)) ? String(c.pickup) : PACK_DEFAULTS.pickup };
}
const mins = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const istMin = (ts = now()) => { const d = new Date((ts + IST) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const istDay = (ts = now()) => new Date((ts + IST) * 1000).toISOString().slice(0, 10);
const fmt = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'am' : 'pm'}`; };
export const pickupText = (c) => c.pickup.split('-').map(fmt).join(' – ');

/** The slot due now (within 30 minutes of its time), or null. */
export function dueSlot(ts = now()) {
  const m = istMin(ts);
  return SLOTS.find((s) => m >= mins(s.at) && m < mins(s.at) + 30) || null;
}

/** Booked, courier not here yet, not packed. Oldest first. */
export async function toPack(env) {
  return (await env.DB.prepare(`SELECT s.order_id, COALESCE(s.order_name, o.order_name) AS name, s.courier, s.created_at, o.city
      FROM shipments s JOIN orders o ON o.order_id = s.order_id
      WHERE s.awb IS NOT NULL AND s.awb <> '' AND COALESCE(s.status, '') <> 'cancelled' AND COALESCE(o.status, '') <> 'cancelled'
        AND o.packed_at IS NULL AND COALESCE(s.stage, 'pickup_pending') IN ('pickup_pending', 'pickup_failed') AND s.created_at > ?
      ORDER BY s.created_at`).bind(now() - 15 * 86400).all()).results;
}

/** WhatsApp template variables cannot hold new lines: "#1951, #1952 … +4 more". */
export function orderList(rows, max = 25) {
  const names = rows.map((r) => r.name || '#' + r.order_id);
  return names.slice(0, max).join(', ') + (names.length > max ? ` +${names.length - max} more` : '');
}

async function state(env) {
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='pack_alert_state'").first().catch(() => null);
  try { return r ? JSON.parse(r.v) || {} : {}; } catch { return {}; }
}
const saveState = (env, v) => env.DB.prepare("INSERT INTO settings (k, v) VALUES ('pack_alert_state', ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v").bind(JSON.stringify(v)).run().catch(() => {});

/** Cron (every 5 minutes). */
export async function packAlerts(env, { force } = {}) {
  const c = packCfg(env);
  if (!c.on || !env.DB) return { skipped: 'off' };
  const { fireTrigger } = await import('./whatsapp.js');
  const { claim } = await import('./once.js');
  const out = {};
  const t = now(), day = istDay(t), m = istMin(t);

  /* 1. reminders at the slot times */
  const slot = force ? { id: 'manual', label: 'Packing check' } : dueSlot(t);
  if (slot && c.to.length) {
    const rows = await toPack(env);
    if (rows.length && (force || (await claim(env, `pack:${day}:${slot.id}`, 20 * 3600)))) {
      let later = 0;
      try { const { readyOrders } = await import('./auto-book.js'); later = (await readyOrders(env, { limit: 60 })).length; } catch { /* count is a nice-to-have */ }
      const vars = { when: slot.label, count: String(rows.length), orders: orderList(rows) + (later ? ` (and ${later} more being booked today)` : ''), pickup: pickupText(c) };
      out.pending = { slot: slot.id, count: rows.length, sent: [] };
      for (const to of c.to) {
        const r = await fireTrigger(env, 'pack_pending', { to, vars, orderName: `pack-${day}-${slot.id}`, force: true }).catch((e) => ({ error: e.message }));
        out.pending.sent.push({ to: to.slice(-4), ok: !!r?.ok, error: r?.error || r?.skipped || '' });
      }
      /* nothing went out (template in review, WhatsApp paused): free the slot so the next run inside its 30 minutes tries again */
      if (!force && !out.pending.sent.some((x) => x.ok)) { const { release } = await import('./once.js'); await release(env, `pack:${day}:${slot.id}`); }
    }
  }

  /* 2. packed digest, 9 am - 8 pm */
  if (c.packed_to.length && m >= 9 * 60 && m < 20 * 60) {
    const st = await state(env);
    const since = Math.max(Number(st.packed_upto) || 0, t - 12 * 3600);
    const fresh = (await env.DB.prepare(`SELECT order_id, order_name AS name, packed_at FROM orders WHERE packed_at > ? AND COALESCE(status, '') <> 'cancelled' ORDER BY packed_at`).bind(since).all()).results;
    if (fresh.length) {
      const left = await toPack(env);
      const quiet = t - (Number(st.digest_at) || 0) >= 15 * 60;
      if (quiet || !left.length) {
        const upto = Math.max(...fresh.map((r) => Number(r.packed_at)));
        const today0 = t - (m * 60) - (t % 60);
        const doneToday = (await env.DB.prepare('SELECT COUNT(*) AS n FROM orders WHERE packed_at >= ?').bind(today0).first())?.n || 0;
        const vars = { orders: orderList(fresh), today: String(doneToday), left: left.length ? `${left.length} (${orderList(left, 10)})` : '0, all packed' };
        out.packed = { count: fresh.length, sent: [] };
        for (const to of c.packed_to) {
          const r = await fireTrigger(env, 'pack_done', { to, vars, orderName: `packed-${upto}`, force: true }).catch((e) => ({ error: e.message }));
          out.packed.sent.push({ to: to.slice(-4), ok: !!r?.ok, error: r?.error || r?.skipped || '' });
        }
        /* a failed send (template still in review, no WhatsApp) keeps the orders for the next digest */
        await saveState(env, { ...st, packed_upto: out.packed.sent.some((x) => x.ok) ? upto : st.packed_upto, digest_at: t });
      }
    }
  }
  return out;
}
