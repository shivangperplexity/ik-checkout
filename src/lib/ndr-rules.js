/**
 * Automatic NDR handling (failed delivery attempts), run on the cron after the WhatsApp shipment updates.
 *
 * Every open NDR in Shiprocket that belongs to a parcel booked here is sorted into a category from the courier's
 * reason, and the rule for that category decides what happens:
 *
 *   first = 'ask'        the customer gets the ship_failed WhatsApp (lib/wa-ship.js) with a link where they pick
 *                        "deliver again" (any day), fix the address / give another number, or return it. If they
 *                        have not answered after `wait` hours, `then` is applied: reattempt | return | manual.
 *   first = 'reattempt'  ask the courier to try again straight away (still tells the customer when `notify` is on).
 *   first = 'return'     start the return (RTO) straight away.
 *   first = 'manual'     leave it to the team (NDR card on the Shipments tab).
 *
 * Guards: after `max_attempts` failed attempts the parcel is not re-attempted again (after_max: return | manual);
 * prepaid and partial-COD orders are never returned automatically (protect_paid); every automatic action is logged
 * (ndr_auto) and written to the shipment like a team choice, so the NDR card shows it as handled.
 */
import { ndrList, ndrAction } from './shiprocket.js';
import { logMsg, sendText } from './whatsapp.js';

const now = () => Math.floor(Date.now() / 1000);

export const CATEGORIES = {
  not_available: { label: 'Customer not available / door locked', re: /not\s*avail|unavail|door\s*lock|premises?\s*(closed|lock)|office\s*closed|shop\s*closed|house\s*lock|out\s*of\s*station|not\s*at\s*home|nobody|no\s*one|consignee\s*absent/i },
  phone: { label: 'Phone not reachable / no answer', re: /phone|mobile|contact|reach|switch(ed)?\s*off|not\s*respond|no\s*respon|not\s*answer|did\s*not\s*pick|didn'?t\s*pick|call\s*not|wrong\s*(no|number)|invalid\s*(no|number)|busy/i },
  address: { label: 'Address incomplete / wrong', re: /address|landmark|locat|shifted|incomplete|wrong\s*(add|area)|not\s*found|untrace|insufficient/i },
  cash: { label: 'Cash not ready', re: /cash|cod\s*amount|amount\s*not\s*ready|money|payment\s*not\s*ready|no\s*change|exact\s*change/i },
  future: { label: 'Asked for a later date', re: /future|reschedul|later|next\s*(day|week)|another\s*day|postpone|deliver\s*on|requested\s*(for\s*)?delivery\s*on|tomorrow/i },
  refused: { label: 'Refused / cancelled by customer', re: /refus|reject|code\s*verified|otp|cancel|not\s*interested|don'?t\s*want|do\s*not\s*want|denied|open\s*(box|delivery)|wants?\s*to\s*open/i },
  courier: { label: 'Courier side (area, entry, holiday)', re: /oda\b|out\s*of\s*delivery\s*area|restricted|entry\s*not|no\s*entry|security|holiday|disaster|weather|strike|curfew|vehicle|misroute|shortage|late\s*arrival|capacity/i },
  other: { label: 'Other reason', re: /.^/ },
};
/* checked in this order: "cancelled order - customer refused" is refused, not cash; "customer not available at the
   address" is not_available, not address */
const ORDER = ['refused', 'future', 'cash', 'courier', 'not_available', 'address', 'phone'];

export function classifyNdr(reason) {
  const r = String(reason || '');
  for (const k of ORDER) if (CATEGORIES[k].re.test(r)) return k;
  return 'other';
}

export const NDR_DEFAULTS = {
  v: 2,                  // 2 = autopilot defaults (nothing ends at "leave to me"); older saved rules are upgraded in ndrCfg
  mode: 'on',            // on | off (off = nothing automatic; the WhatsApp link still works)
  max_attempts: 3,       // failed attempts after which no more re-attempts are asked for
  after_max: 'return',   // manual | return
  protect_paid: true,    // never return prepaid / partial-COD parcels automatically
  rules: {
    not_available: { first: 'ask', wait: 6, then: 'reattempt' },
    phone: { first: 'ask', wait: 6, then: 'reattempt' },
    address: { first: 'ask', wait: 8, then: 'reattempt' },
    cash: { first: 'ask', wait: 6, then: 'reattempt' },
    future: { first: 'ask', wait: 6, then: 'reattempt' },
    /* refused + no answer: one more try (couriers often mark "refused" without reaching anyone); refused again -> return */
    refused: { first: 'ask', wait: 12, then: 'reattempt' },
    courier: { first: 'reattempt', wait: 0, then: 'reattempt' },
    other: { first: 'ask', wait: 8, then: 'reattempt' },
  },
  /* WhatsApp autopilot (lib/ndr-pilot.js): reads replies, nudges, books re-attempts, one save before a cancel */
  pilot: { on: true, nudge_h: 3, save: true, quiet: true },
};
const FIRST = ['ask', 'reattempt', 'return', 'manual'];
const THEN = ['reattempt', 'return', 'manual'];

export function ndrCfg(env) {
  const s = env.SETTINGS?.ndr || {};
  /* rules saved before the autopilot (v < 2) ended in "leave to me": those steps now run themselves */
  const old = Number(s.v || 0) < 2;
  const rules = {};
  for (const k of Object.keys(CATEGORIES)) {
    const d = NDR_DEFAULTS.rules[k], r = { ...d, ...(s.rules?.[k] || {}) };
    if (old && r.first === 'manual') r.first = d.first;
    if (old && r.then === 'manual') r.then = d.then;
    rules[k] = { first: FIRST.includes(r.first) ? r.first : d.first, wait: Math.max(0, Math.min(72, Number(r.wait) || 0)), then: THEN.includes(r.then) ? r.then : d.then };
  }
  const p = { ...NDR_DEFAULTS.pilot, ...(s.pilot || {}) };
  return {
    v: 2,
    mode: s.mode === 'off' ? 'off' : 'on',
    max_attempts: Math.max(1, Math.min(5, Number(s.max_attempts) || NDR_DEFAULTS.max_attempts)),
    after_max: old ? 'return' : s.after_max === 'manual' ? 'manual' : 'return',
    protect_paid: s.protect_paid !== false,
    rules,
    pilot: { on: p.on !== false, nudge_h: Math.max(1, Math.min(24, Number(p.nudge_h) || 3)), save: p.save !== false, quiet: p.quiet !== false },
  };
}

/** Should the customer get the "delivery failed" WhatsApp for this reason? (everything except a category set to manual / return straight away) */
export function shouldNotify(env, reason) {
  const c = ndrCfg(env);
  if (c.mode === 'off') return null;          /* not decided here: the old behaviour applies */
  const r = c.rules[classifyNdr(reason)];
  return r.first === 'ask' || r.first === 'reattempt';
}

/** The next working day (IST) after `from`, skipping Sundays: YYYY-MM-DD */
export function nextWorkingDay(from = Date.now(), plus = 1) {
  const d = new Date(from + 19800000);
  let n = 0;
  while (n < plus) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() !== 0) n++; }
  return d.toISOString().slice(0, 10);
}

/**
 * What to do with one open NDR now. Pure: everything it needs is passed in.
 *   nd    { awb, reason, attempts, date }           from Shiprocket's NDR list
 *   st    { first_seen, action, action_at }         this NDR's row in ndr_auto (undefined the first time)
 *   ship  { ndr_choice, ndr_choice_at }             the shipment row (a customer / team choice)
 *   paid  true for prepaid / partial COD / converted orders
 * Returns { act: 'reattempt'|'return'|'none'|'wait'|'manual', why, category, due? }
 */
/** When the courier raised this NDR (Shiprocket gives IST without a zone); `t` when unknown or implausible. */
export function raisedAt(nd, t = now()) {
  const d = String(nd?.date || '');
  const raised = Math.floor(Date.parse(d.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(d) ? '' : '+05:30')) / 1000);
  return Number.isFinite(raised) && raised > t - 7 * 86400 && raised <= t ? raised : t;
}

export function planNdr(cfg, nd, st, ship, paid, t = now()) {
  const category = classifyNdr(nd.reason);
  const rule = cfg.rules[category];
  const firstSeen = Number(st?.first_seen) || raisedAt(nd, t);
  if (cfg.mode === 'off') return { act: 'none', why: 'automation off', category };
  if (st?.action === 'manual') return { act: 'manual', why: st.note || 'left to you', category };
  if (st?.action) return { act: 'none', why: 'already handled automatically', category };
  /* a choice made after this NDR appeared (customer link / reply, or the team) wins */
  if (ship?.ndr_choice && Number(ship.ndr_choice_at) >= firstSeen - 3600) return { act: 'none', why: `${ship.ndr_by || 'someone'} chose ${ship.ndr_choice}`, category };
  const noReturn = (a) => (a === 'return' && paid && cfg.protect_paid ? 'manual' : a);
  if (nd.attempts && nd.attempts >= cfg.max_attempts) {
    const a = noReturn(cfg.after_max);
    return { act: a, why: `${nd.attempts} failed attempts (limit ${cfg.max_attempts})`, category };
  }
  if (rule.first === 'reattempt') return { act: 'reattempt', why: CATEGORIES[category].label, category };
  if (rule.first === 'return') return { act: noReturn('return'), why: CATEGORIES[category].label, category };
  if (rule.first === 'manual') return { act: 'manual', why: CATEGORIES[category].label, category };
  /* refused at the door a second time and still no "yes" from the customer: stop and bring it back */
  const then = category === 'refused' && rule.then === 'reattempt' && Number(nd.attempts) >= 2 ? 'return' : rule.then;
  const due = firstSeen + rule.wait * 3600;
  if (t < due) return { act: 'wait', why: 'waiting for the customer', category, due, then: noReturn(then) };
  return { act: noReturn(then), why: then === rule.then ? `no answer from the customer in ${rule.wait} h` : `refused again (attempt ${nd.attempts}) and no answer in ${rule.wait} h`, category };
}

/** Run the rules over Shiprocket's open NDRs. Returns a summary for the cron log. */
export async function autoNdr(env, { dry = false } = {}) {
  if (!env.DB) return { skipped: 'no db' };
  const cfg = ndrCfg(env);
  if (cfg.mode === 'off') return { skipped: 'off' };
  let list;
  try { list = await ndrList(env); } catch (e) { return { error: String(e.message || e) }; }
  if (!list.length) return dry ? { open: 0 } : { open: 0, pilot: await sweep(env, cfg) };
  const awbs = list.map((x) => x.awb);
  const ships = Object.fromEntries((await env.DB.prepare(`SELECT s.awb, s.order_id, s.order_name, s.ndr_choice, s.ndr_choice_at, s.ndr_by, s.stage,
      s.ndr_asked_at, o.method, o.phone, o.first_name, o.advance_paise, o.converted_at, o.status AS order_status
      FROM shipments s JOIN orders o ON o.order_id = s.order_id WHERE s.awb IN (${awbs.map(() => '?').join(',')})`).bind(...awbs).all()).results.map((r) => [String(r.awb), r]));
  const out = { open: list.length, mine: 0, reattempt: 0, return: 0, manual: 0, waiting: 0, failed: 0, actions: [] };
  const t = now();
  for (const nd of list) {
    const s = ships[nd.awb];
    if (!s || s.order_status === 'cancelled') continue;
    out.mine++;
    const k = nd.attempts ? 'a' + nd.attempts : 'd' + String(nd.date || '').slice(0, 10);
    let st = await env.DB.prepare('SELECT * FROM ndr_auto WHERE awb=? AND k=?').bind(nd.awb, k).first();
    if (!st) {
      /* the wait runs from when the courier raised it (Shiprocket's time, IST), not from when this cron first saw it */
      st = { first_seen: raisedAt(nd, t) };
      if (!dry) await env.DB.prepare('INSERT INTO ndr_auto (awb, k, order_id, order_name, attempt, category, reason, first_seen) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING')
        .bind(nd.awb, k, String(s.order_id), s.order_name, nd.attempts || null, classifyNdr(nd.reason), String(nd.reason || '').slice(0, 300), st.first_seen).run();
      if (!dry && nd.reason) await env.DB.prepare("UPDATE shipments SET ndr_reason=? WHERE awb=? AND COALESCE(ndr_reason,'')=''").bind(String(nd.reason).slice(0, 300), nd.awb).run().catch(() => {});
    }
    const paid = s.method !== 'cod' || Number(s.advance_paise) > 0 || !!s.converted_at;
    /* refused at the door and the rule says ask: make sure the "still want it?" question went out for this attempt
       (the tracking poll usually sends it first; this covers NDRs it did not see) */
    if (!dry && classifyNdr(nd.reason) === 'refused' && cfg.rules.refused.first === 'ask' && !st.action && Number(s.ndr_asked_at || 0) < Number(st.first_seen) - 3600 && !(Number(s.ndr_choice_at) >= Number(st.first_seen) - 3600)) {
      try { const { askRefused } = await import('./ndr-ask.js'); const a = await askRefused(env, { order_id: s.order_id, order_name: s.order_name, phone: s.phone, first_name: s.first_name }); if (a.ok) out.asked = (out.asked || 0) + 1; } catch (e) { console.error('ndr ask', e.message); }
    }
    const p = planNdr(cfg, nd, st, s, paid, t);
    if (p.act === 'wait') { out.waiting++; continue; }
    if (p.act === 'none') continue;
    if (p.act === 'manual') {
      if (!st.action && !dry) await env.DB.prepare("UPDATE ndr_auto SET action='manual', action_at=?, note=? WHERE awb=? AND k=?").bind(t, p.why, nd.awb, k).run();
      if (!st.action) out.manual++;
      continue;
    }
    out.actions.push({ order: s.order_name, act: p.act, why: p.why });
    if (dry) continue;
    const date = p.act === 'reattempt' && p.category === 'future' ? nextWorkingDay(Date.now(), 1) : '';
    try {
      await ndrAction(env, { awb: nd.awb, action: p.act === 'return' ? 'return' : 're-attempt', deferred_date: date,
        comments: p.act === 'return' ? `Auto: ${p.why}` : `Auto re-attempt (${p.why}). Please call the customer before delivery.` });
      await env.DB.prepare('UPDATE ndr_auto SET action=?, action_at=?, note=?, error=NULL WHERE awb=? AND k=?').bind(p.act, t, p.why, nd.awb, k).run();
      await env.DB.prepare('UPDATE shipments SET ndr_choice=?, ndr_choice_at=?, ndr_date=?, ndr_by=?, ndr_attempt=?, updated_at=? WHERE awb=?')
        .bind(p.act, t, date || null, 'auto', nd.attempts || null, t, nd.awb).run();
      out[p.act]++;
      /* a re-attempt is announced by the autopilot sweep below (WhatsApp template, daytime only); a return only in-chat */
      if (p.act === 'return') await tellCustomer(env, s, p.act, date).catch(() => {});
    } catch (e) {
      out.failed++;
      await env.DB.prepare('UPDATE ndr_auto SET error=? WHERE awb=? AND k=?').bind(String(e.message || e).slice(0, 300), nd.awb, k).run().catch(() => {});
      await logMsg(env, { direction: 'out', phone: s.phone, trigger: 'ndr-auto', template: p.act, status: 'failed', orderName: s.order_name, error: String(e.message || e) });
    }
  }
  if (!dry) out.pilot = await sweep(env, cfg);
  return out;
}

/* WhatsApp autopilot: nudges for customers who have not answered, "delivery booked again" / final-attempt messages */
async function sweep(env, cfg) {
  if (!cfg.pilot?.on) return { skipped: 'pilot off' };
  try { const { pilotSweep } = await import('./ndr-pilot.js'); return await pilotSweep(env, cfg); } catch (e) { console.error('pilotSweep', e); return { error: String(e.message || e) }; }
}

/* A short WhatsApp note after an automatic action, only inside the 24 h window (free text needs the customer to have written). */
async function tellCustomer(env, s, act, date) {
  const last = await env.DB.prepare("SELECT ts FROM messages WHERE phone=? AND direction='in' ORDER BY ts DESC LIMIT 1").bind(String(s.phone)).first();
  if (!last || Number(last.ts) < now() - 23 * 3600) return;
  const when = date ? `on ${new Date(date + 'T06:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}` : 'on the next working day';
  const text = act === 'return' ? `Order ${s.order_name} could not be delivered and is being returned to us. Reply here if you still want it.`
    : `Hi ${s.first_name || ''}, we've asked the courier to deliver order ${s.order_name} again ${when}. Please keep your phone reachable.`;
  const r = await sendText(env, '91' + s.phone, text);
  await logMsg(env, { direction: 'out', phone: s.phone, trigger: 'ndr-auto', template: act, status: r.ok ? 'accepted' : 'failed', wamid: r.id || '', orderName: s.order_name, error: r.ok ? '' : r.error, preview: text });
}
