/**
 * Dashboard assistant (Home tab). Answers questions about the store from live data and prepares actions:
 *   - ship prepaid orders / ship confirmed COD orders / ship everything ready (Shiprocket, cheapest allowed courier)
 *   - handle open NDRs (re-attempt or return, per the NDR rules' plan)
 *   - ship or cancel specific orders ("#1533 #1577 cancel karo", or "cancel these" right after a list)
 * The conversation is kept in the database (assistant_msgs), so "these orders" / "inko" refer to the last list and
 * the chat is the same on every device.
 * It never does anything by itself: an action comes back as a list with the cost, and only the dashboard's
 * "Confirm" button books it (the same ship_book / ndr_do calls the Orders and Shipments tabs use). It never packs.
 * Questions go to the WhatsApp assistant's AI provider (Settings > WhatsApp AI) with a snapshot of the numbers;
 * the commands above work without any AI key.
 */
import { PROVIDERS, aiCfg, callModel } from './wa-ai.js';

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400, IST = 19800;
const num = (x) => Number(x) || 0;
const inr = (n) => '₹' + Math.round(num(n)).toLocaleString('en-IN');

/* ---------- intent: what does the message ask for ---------- */
const SHIP = /\b(ship|shipping|book|dispatch|bhej|bhejo|bhejdo|bhej ?do|nikal|nikaal|courier|send (?:them |it )?out|awb)\w*/i;
const NDR = /\b(ndr|undeliver|not delivered|failed deliver|delivery fail|re-?attempt|rto)\w*/i;
const SHIP_DO = /\b(ship|book|bhej)\w*\s*(kar ?do|kardo|karo|do)\b/i;
const DOIT = /\b(handle|sambhal|run|kar ?do|kardo|karo|fix|process|clear|do it|take care|solve|resolve|nipta)\w*/i;

const CANCEL = /\b(cancel|cancle|cancal|radd|rad kar|rad karo|rad kardo)\w*/i;
const REFER = /\b(these|them|those|this list|above|in sab|inko|inhe|inhein|ye orders|yeh orders|ye sab|yeh sab|upar|list wale|ye wale|isko|unko|in orders|in ko|sabko|saare orders)\b/i;
export const orderRefs = (text) => [...new Set((String(text || '').match(/#\s?\d{3,6}\b/g) || []).map((x) => '#' + x.replace(/\D/g, '')))];
/** Order numbers the message means: written in it, or ("these", "inko") the newest earlier message that listed some. */
export function refsFor(text, history = []) {
  const own = orderRefs(text);
  if (own.length || !REFER.test(String(text || '').toLowerCase())) return own;
  for (let i = history.length - 1; i >= 0; i--) { const r = orderRefs(history[i].content); if (r.length) return r; }
  return [];
}

export function intent(text, history = []) {
  const t = String(text || '').toLowerCase();
  const pack = /\bpack/.test(t);
  const question = /\?\s*$/.test(t) || /\b(how many|kitne|kitna|kyu|kyon|why|kya hoga)\b/.test(t);
  const refs = refsFor(text, history);
  const dmc = t.match(/(\d+)\s*(?:\+\s*)?(?:din|dino|days?|d)\b/);
  if (CANCEL.test(t) && !question) {
    if (refs.length) return { kind: 'cancel', refs };
    if (dmc && /(unconfirm|confirm nahi|confirm nhi|not confirmed|without confirm|no reply|reply nahi)/.test(t)) return { kind: 'cancel', staleDays: Math.min(90, Number(dmc[1])) };
  }
  if (SHIP.test(t) && !question && refs.length) return { kind: 'ship_list', refs, pack };
  if (SHIP.test(t) && !question && !/\b(status|kab)\b/.test(t)) {
    const pre = /\b(pre-?paid|paid|online)\b/.test(t), conf = /\b(address|confirm|confirmed|cod)\w*/.test(t), all = /\b(all|sab|saare|sare|ready|everything|baaki|bache)\b/.test(t);
    const which = pre && conf ? 'ready' : pre ? 'prepaid' : conf ? 'confirmed' : all ? 'ready' : '';
    if (which) return { kind: 'ship', which, pack };
  }
  const dm = t.match(/(\d+)\s*(?:\+\s*)?(?:din|dino|days?|d)\b/);
  if (dm && /(pending|unship|not ship|ship nahi|ship nhi|nahi gay|nhi gay|nahi hu|nhi hu|shipped nahi|waiting|ruk|pade|pada|stuck|delay|purane)/.test(t) && !SHIP_DO.test(t))
    return { kind: 'stale', days: Math.min(90, Number(dm[1])), all: /(unconfirm|all|sab|saare|sare|including|bhi)/.test(t) };
  if (NDR.test(t) && (DOIT.test(t) || /\b(ndr)\b/.test(t) && t.split(/\s+/).length <= 3)) return { kind: 'ndr' };
  return { kind: 'ask', pack };
}

/* ---------- what is waiting ---------- */
async function waiting(env, A) {
  const j = await A.orders(env, { filter: 'unshipped' });
  const live = (j.orders || []).filter((o) => o.status !== 'cancelled' && !o.shipped);
  const prepaid = live.filter((o) => o.method !== 'cod' || o.converted);
  const confirmed = live.filter((o) => o.method === 'cod' && !o.converted && o.confirmed_at);
  const unconfirmed = live.filter((o) => o.method === 'cod' && !o.converted && !o.confirmed_at);
  return { prepaid, confirmed, unconfirmed };
}

const SHIP_TITLE = { prepaid: 'Prepaid orders', confirmed: 'Confirmed COD orders (address confirmed)', ready: 'All orders ready to ship' };

/** The list to book, with Shiprocket's courier and charge for each (first 20 priced; the rest are booked at the cheapest anyway). */
async function shipProposal(env, A, which) {
  const w = await waiting(env, A);
  const list = which === 'prepaid' ? w.prepaid : which === 'confirmed' ? w.confirmed : [...w.prepaid, ...w.confirmed];
  list.sort((a, b) => a.created_at - b.created_at);
  const rows = list.map((o) => ({ id: String(o.id), name: o.name, customer: o.customer, city: o.city || '', pincode: o.pincode || '', total: o.total,
    pay: o.method !== 'cod' ? 'Prepaid' : o.converted ? 'Paid online' : o.advance ? `COD (₹${o.advance} paid)` : 'COD', age_h: Math.round((now() - o.created_at) / 3600), packed: !!o.packed_at }));
  await priceRows(env, A, rows);
  const ok = rows.filter((r) => !r.error);
  return {
    kind: 'ship', which, title: SHIP_TITLE[which], rows,
    total_charge: Math.round(ok.reduce((s, r) => s + num(r.charge), 0) * 100) / 100,
    unpriced: Math.max(0, rows.length - 20),
    skipped_unconfirmed: w.unconfirmed.length,
  };
}

const rowOf = (o, kind) => ({ id: String(o.id), name: o.name, customer: o.customer, city: o.city || '', pincode: o.pincode || '', total: o.total, kind,
  pay: o.method !== 'cod' ? 'Prepaid' : o.converted ? 'Paid online' : o.advance ? `COD (₹${o.advance} paid)` : 'COD', age_h: Math.round((now() - o.created_at) / 3600), packed: !!o.packed_at });

async function priceRows(env, A, rows) {
  const priced = rows.filter((r) => !r.error).slice(0, 20);
  for (let i = 0; i < priced.length; i += 4) {
    await Promise.all(priced.slice(i, i + 4).map(async (r) => {
      try {
        const p = await Promise.race([A.ship_plan(env, { id: r.id }), new Promise((_, no) => setTimeout(() => no(new Error('Shiprocket did not answer in time')), 12000))]);
        if (p.shipment && p.shipment.awb) { r.error = `already booked (AWB ${p.shipment.awb})`; return; }
        const pick = (p.options || []).find((o) => o.key === p.pick) || (p.options || []).find((o) => !o.excluded);
        if (!pick) { r.error = p.why || 'no courier for this PIN'; return; }
        r.courier = pick.courier; r.charge = num(pick.charge); r.edd = pick.edd || '';
      } catch (e) { r.error = String(e.message || e).slice(0, 140); }
    }));
  }
}

/** Orders by number (#1533): the not-shipped ones from the live list, the rest from the database. */
async function findOrders(env, A, refs) {
  const w = await waiting(env, A);
  const live = new Map();
  for (const [list, kind] of [[w.prepaid, 'Prepaid'], [w.confirmed, 'COD confirmed'], [w.unconfirmed, 'COD not confirmed']]) for (const o of list) live.set(o.name, rowOf(o, kind));
  const missing = refs.filter((r) => !live.has(r));
  const db = missing.length ? (await env.DB.prepare(`SELECT o.order_id, o.order_name, o.status, o.shipped_at, o.method, o.total_paise, o.first_name, o.last_name, o.city, o.pincode, o.created_at, s.awb
      FROM orders o LEFT JOIN shipments s ON s.order_id=o.order_id AND COALESCE(s.status,'')<>'cancelled' WHERE o.order_name IN (${missing.map(() => '?').join(',')})`).bind(...missing).all()).results : [];
  return refs.slice(0, 100).map((ref) => {
    if (live.has(ref)) return live.get(ref);
    const o = db.find((x) => x.order_name === ref);
    if (!o) return { id: '', name: ref, error: 'not found' };
    const r = { id: String(o.order_id), name: ref, customer: `${o.first_name || ''} ${o.last_name || ''}`.trim(), city: o.city || '', pincode: o.pincode || '', total: num(o.total_paise) / 100, pay: o.method === 'cod' ? 'COD' : 'Prepaid', age_h: Math.round((now() - num(o.created_at)) / 3600) };
    if (o.status === 'cancelled') r.error = 'already cancelled';
    else if (o.awb || o.shipped_at) { r.kind = 'Shipped'; r.shipped = true; r.awb = o.awb || ''; }
    return r;
  });
}

async function shipListProposal(env, A, refs) {
  const rows = await findOrders(env, A, refs);
  for (const r of rows) if (!r.error) { if (r.shipped) r.error = 'already shipped' + (r.awb ? ` (AWB ${r.awb})` : ''); else if (r.kind === 'COD not confirmed') r.error = 'COD not confirmed by the customer'; }
  await priceRows(env, A, rows);
  const ok = rows.filter((r) => !r.error);
  return { kind: 'ship', which: 'list', title: 'These orders', rows, total_charge: Math.round(ok.reduce((s, r) => s + num(r.charge), 0) * 100) / 100, unpriced: Math.max(0, ok.length - 20), skipped_unconfirmed: 0 };
}

async function cancelProposal(env, A, { refs, staleDays }) {
  let rows;
  if (refs) rows = await findOrders(env, A, refs);
  else {
    const w = await waiting(env, A), lim = now() - staleDays * DAY;
    rows = w.unconfirmed.filter((o) => o.created_at <= lim).sort((a, b) => a.created_at - b.created_at).map((o) => rowOf(o, 'COD not confirmed'));
  }
  for (const r of rows) {
    if (r.error) continue;
    r.warn = r.shipped ? 'already booked: the Shiprocket pickup is cancelled first (not possible once picked up)' : r.kind === 'COD confirmed' ? 'customer confirmed this COD order' : /Prepaid|Paid online/.test(r.pay) || /paid/.test(r.pay) ? 'paid online: refund it yourself' : '';
  }
  return { kind: 'cancel', title: refs ? 'Cancel these orders' : `Unconfirmed COD orders older than ${staleDays} days`, rows };
}

async function ndrProposal(env, A) {
  const j = await A.ndr_list(env);
  const open = (j.ndr || []).filter((x) => !x.done);
  const rows = open.map((x) => {
    const act = x.plan && ['return', 'rto'].includes(x.plan.act) ? 'return' : x.plan && /attempt/.test(x.plan.act) ? 'reattempt' : x.category === 'refused' ? 'return' : 'reattempt';
    return { awb: String(x.awb), name: x.order_name, reason: String(x.reason || '').slice(0, 120), attempts: num(x.attempts), category: x.category_label || x.category || '', paid: !!x.paid,
      act, why: x.plan ? x.plan.why : '', preselect: !!(x.plan && ['return', 'rto', 'reattempt', 're-attempt'].includes(x.plan.act)), choice: x.choice || '' };
  });
  return { kind: 'ndr', title: 'Open failed deliveries (NDR)', rows, auto: j.auto };
}

/* ---------- numbers for questions ---------- */
async function snapshot(env, A) {
  const t = now(), today0 = Math.floor((t + IST) / DAY) * DAY - IST;
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  const [w, a7, a30, ship, ndr] = await Promise.all([
    waiting(env, A).catch(() => null),
    A.analytics(env, { days: 7 }).catch(() => null),
    A.analytics(env, { days: 30 }).catch(() => null),
    q(`SELECT COALESCE(stage,'booked') stage, COUNT(*) n, SUM(CASE WHEN rto THEN 1 ELSE 0 END) rto FROM shipments WHERE created_at>? AND COALESCE(status,'')<>'cancelled' GROUP BY 1`, t - 30 * DAY).catch(() => []),
    A.ndr_list(env).then((x) => (x.ndr || []).filter((y) => !y.done)).catch(() => []),
  ]);
  /* shipped by payment type (dashboard bookings), and orders shipped any way; grouped here (a few hundred rows) */
  const isPre = (r) => r.method !== 'cod' || r.converted_at != null;
  const sRows = await q(`SELECT o.method, o.converted_at, s.stage, s.created_at FROM shipments s LEFT JOIN orders o ON o.order_id=s.order_id WHERE s.created_at>? AND COALESCE(s.status,'')<>'cancelled'`, t - 30 * DAY).catch(() => []);
  const oRows = await q(`SELECT o.method, o.converted_at, o.status, o.shipped_at, s.order_id AS booked FROM orders o LEFT JOIN shipments s ON s.order_id=o.order_id AND COALESCE(s.status,'')<>'cancelled'
      WHERE o.created_at>? AND o.status NOT IN ('pending_payment','failed','completing')`, t - 30 * DAY).catch(() => []);
  const shipByPay = {};
  for (const r of sRows) {
    const x = shipByPay[isPre(r) ? 'prepaid' : 'cod'] = shipByPay[isPre(r) ? 'prepaid' : 'cod'] || { total: 0, booked_today: 0, booked_yesterday: 0, booked_last_7_days: 0 };
    const at = num(r.created_at), stg = r.stage || 'booked';
    x.total++; x[stg] = (x[stg] || 0) + 1;
    if (at >= today0) x.booked_today++; else if (at >= today0 - DAY) x.booked_yesterday++;
    if (at >= today0 - 6 * DAY) x.booked_last_7_days++;
  }
  const ord30 = {};
  for (const r of oRows) {
    const x = ord30[isPre(r) ? 'prepaid' : 'cod'] = ord30[isPre(r) ? 'prepaid' : 'cod'] || { orders: 0, shipped: 0, cancelled: 0 };
    x.orders++; if (r.status === 'cancelled') x.cancelled++; else if (r.shipped_at != null || r.booked) x.shipped++;
  }
  /* every order not shipped yet, oldest first: "#1801 | COD confirmed | 3.2 days | Pune 411001 | ₹499 | packed" */
  const unshipped = w ? [...w.prepaid.map((o) => [o, 'prepaid']), ...w.confirmed.map((o) => [o, 'COD confirmed']), ...w.unconfirmed.map((o) => [o, 'COD NOT confirmed'])]
    .sort((a, b) => a[0].created_at - b[0].created_at)
    .map(([o, kind]) => `${o.name} | ${kind} | ${((t - o.created_at) / DAY).toFixed(1)} days | ${o.customer || ''} | ${o.city || ''} ${o.pincode || ''} | ₹${Math.round(o.total)}${o.packed_at ? ' | packed' : ''}`) : [];
  const age = (list, lo, hi) => list.filter((o) => t - o.created_at >= lo * DAY && t - o.created_at < hi * DAY).length;
  const buckets = (list) => ({ under_1_day: age(list, 0, 1), '1_to_3_days': age(list, 1, 3), '3_to_7_days': age(list, 3, 7), over_7_days: age(list, 7, 1e4) });
  const todayOrders = await q(`SELECT method, COUNT(*) n, COALESCE(SUM(total_paise),0) v FROM orders WHERE created_at>? AND status NOT IN ('pending_payment','failed','completing','cancelled') GROUP BY 1`, today0).catch(() => []);
  const st = Object.fromEntries(ship.map((r) => [r.stage, num(r.n)]));
  const shipped30 = ship.reduce((s, r) => s + num(r.n), 0), rto30 = ship.reduce((s, r) => s + num(r.rto), 0);
  const k = (a) => a ? { orders: a.kpi.orders, revenue: Math.round(a.kpi.revenue), aov: Math.round(a.kpi.aov), cod: a.kpi.cod, prepaid: a.kpi.prepaid, cancelled: a.kpi.cancelled, sessions: a.kpi.sessions, conversion_pct: Math.round(a.kpi.conv * 100) / 100,
    checkout_funnel: a.funnel.map((f) => `${f.label}: ${f.n}`).join(' > '), left_at_step: a.left.filter((x) => x.n).map((x) => `${x.label}: ${x.n} (${inr(x.value)})`).join('; '),
    sources: (a.sources || []).map((s) => `${s.s}: ${s.sessions} sessions, ${s.orders} orders`).join('; '), devices: (a.devices || []).map((d) => `${d.d}: ${d.sessions}/${d.orders}`).join('; ') } : null;
  return {
    now_ist: new Date((t + IST) * 1000).toISOString().slice(0, 16).replace('T', ' '),
    today: { orders: todayOrders.reduce((s, r) => s + num(r.n), 0), revenue: Math.round(todayOrders.reduce((s, r) => s + num(r.v), 0) / 100), cod: num(todayOrders.find((r) => r.method === 'cod')?.n) },
    not_shipped_yet: w ? { prepaid: w.prepaid.length, confirmed_cod: w.confirmed.length, cod_not_confirmed: w.unconfirmed.length,
      ready_by_age: buckets([...w.prepaid, ...w.confirmed]), unconfirmed_by_age: buckets(w.unconfirmed) } : null,
    not_shipped_orders_oldest_first: unshipped.slice(0, 120),
    orders_last_30_days_by_payment: ord30,
    dashboard_bookings_by_payment_30d: shipByPay,
    last_7_days: k(a7), last_30_days: k(a30),
    shipments_30d: { booked: shipped30, by_stage: st, rto: rto30, rto_pct: shipped30 ? Math.round((rto30 * 1000) / shipped30) / 10 : 0 },
    open_ndr: ndr.map((x) => `${x.order_name || x.awb}: ${String(x.reason || '').slice(0, 60)} (attempt ${x.attempts || 1})`).slice(0, 15),
  };
}

const SYSTEM = (snap) => `You are the operations assistant inside the Ink Kulture checkout dashboard (Indian semi-permanent tattoo brand, inkkulture.in; Shopify store with its own COD/prepaid checkout, WhatsApp confirmations, Shiprocket shipping). The owner talks to you in English, Hindi or Hinglish; answer in the same language, short and practical, plain text (simple "-" lists are fine, no markdown headings, no tables).

You can PREPARE these actions; the dashboard shows the list and the owner taps Confirm. To prepare one, put exactly one of these lines at the very end of your reply:
ACTION: ship_prepaid    (book all prepaid orders waiting to ship)
ACTION: ship_confirmed  (book COD orders the customer confirmed on WhatsApp, "address confirmed")
ACTION: ship_ready      (both of the above)
ACTION: ndr             (open failed deliveries: re-attempt or return)
ACTION: ship #1533 #1577   (book these specific orders)
ACTION: cancel #1453 #1547 (cancel these specific orders in Shopify)
You remember this conversation: when the owner says "these", "inko", "ye orders", use the order numbers from the earlier messages.
Only add an ACTION line when the owner asks for that action. Never claim something was shipped, booked or changed: you only prepare it.
You never pack orders (the owner packs himself) and never ship COD orders that were not confirmed.

Reply in the owner's language; for Hindi or Hinglish always use Latin script (Roman Hinglish), never Devanagari.
Use only STORE DATA, but work it out from there: count, add up and filter the lists yourself (for example orders not shipped for more than N days come from not_shipped_orders_oldest_first, whose third column is the age; prepaid vs COD shipped counts come from dashboard_bookings_by_payment_30d and orders_last_30_days_by_payment). When asked for a list, give the order numbers with their details, one per line. Say you can't see something only when it truly is not in the data. When asked for improvements to the store or checkout, give 3 to 5 specific, prioritised suggestions tied to these numbers (for example where the checkout funnel drops, COD share and RTO, conversion by device or source), each with the expected effect. Be honest: the tattoos are semi-permanent and last 1-2 weeks; never suggest claiming otherwise.

STORE DATA (live):
${JSON.stringify(snap)}`;

/* ---------- memory: the conversation lives in the database ---------- */
export async function history(env, n = 40) {
  return (await env.DB.prepare('SELECT id, ts, role, content FROM assistant_msgs ORDER BY id DESC LIMIT ?').bind(n).all()).results.reverse();
}
export const remember = (env, role, content) => env.DB.prepare('INSERT INTO assistant_msgs (ts, role, content) VALUES (?,?,?)').bind(now(), role, String(content || '').slice(0, 8000)).run()
  .then(() => env.DB.prepare('DELETE FROM assistant_msgs WHERE id < (SELECT COALESCE(MAX(id),0) - 300 FROM assistant_msgs)').run()).catch((e) => console.error('assistant memory', e.message));
export const forget = (env) => env.DB.prepare('DELETE FROM assistant_msgs').run();

/** POST rpc assistant { text }. The earlier messages come from the database. */
export async function assistant(env, A, b) {
  const text = String(b.text || '').trim().slice(0, 6000);
  if (!text) throw new Error('Type a message');
  const past = await history(env, 30).catch(() => []);
  await remember(env, 'user', text);
  const r = await answer(env, A, text, past);
  /* what is remembered for the assistant's turn: its words plus the orders in any list it prepared */
  const listed = r.proposal ? '\n[' + r.proposal.title + ': ' + r.proposal.rows.map((x) => x.name).join(' ') + ']' : '';
  await remember(env, 'assistant', (r.reply || '') + listed);
  return r;
}

async function answer(env, A, text, past) {
  const it = intent(text, past);
  const packNote = it.pack ? 'I don\'t pack orders, that stays with you. ' : '';
  if (it.kind === 'cancel') {
    const p = await cancelProposal(env, A, it);
    if (!p.rows.length) return { reply: it.refs ? 'I could not find those orders.' : `No unconfirmed COD order is older than ${it.staleDays} days.` };
    p.rows.forEach((r) => { r.preselect = !r.error; });
    const bad = p.rows.filter((r) => r.error).length, warn = p.rows.filter((r) => r.warn && !r.error).length;
    return { reply: `${p.rows.length - bad} order${p.rows.length - bad === 1 ? '' : 's'} to cancel in Shopify (stock goes back, no refund is issued from here).${warn ? ` ${warn} need a second look (marked).` : ''}${bad ? ` ${bad} can't be cancelled (see the list).` : ''} Untick any to keep, then tap Confirm.`, proposal: p };
  }
  if (it.kind === 'ship_list') {
    const p = await shipListProposal(env, A, it.refs);
    const bad = p.rows.filter((r) => r.error).length;
    if (bad === p.rows.length) return { reply: `${packNote}None of these can be booked: ` + p.rows.map((r) => `${r.name} (${r.error})`).join(', ') + '.' };
    return { reply: `${packNote}${p.rows.length - bad} of these can be booked, Shiprocket estimate ${inr(p.total_charge)}.${bad ? ` ${bad} can't (see the list).` : ''} Tap Confirm to book.`, proposal: p };
  }
  if (it.kind === 'ship') {
    const p = await shipProposal(env, A, it.which);
    if (!p.rows.length) return { reply: `${packNote}Nothing to ship in "${p.title}" right now.${p.skipped_unconfirmed ? ` ${p.skipped_unconfirmed} COD order${p.skipped_unconfirmed > 1 ? 's are' : ' is'} still waiting for the customer to confirm, so I left ${p.skipped_unconfirmed > 1 ? 'them' : 'it'} out.` : ''}` };
    const bad = p.rows.filter((r) => r.error).length;
    return { reply: `${packNote}${p.rows.length} order${p.rows.length > 1 ? 's' : ''} ready: ${p.title.toLowerCase()}. Shiprocket estimate ${inr(p.total_charge)}${p.unpriced ? ` for the first 20 (${p.unpriced} more at the cheapest courier)` : ''}.${bad ? ` ${bad} can't be booked as is (see the list).` : ''}${p.skipped_unconfirmed && it.which !== 'prepaid' ? ` ${p.skipped_unconfirmed} unconfirmed COD order${p.skipped_unconfirmed > 1 ? 's' : ''} left out.` : ''} Untick any you want to hold, then tap Confirm to book.`, proposal: p };
  }
  if (it.kind === 'stale') {
    const w = await waiting(env, A), t = now(), lim = it.days * DAY;
    const rows = [...w.prepaid.map((o) => [o, 'Prepaid']), ...w.confirmed.map((o) => [o, 'COD confirmed']), ...(it.all ? w.unconfirmed.map((o) => [o, 'COD not confirmed']) : [])]
      .filter(([o]) => t - o.created_at >= lim).sort((a, b) => a[0].created_at - b[0].created_at);
    const unc = it.all ? 0 : w.unconfirmed.filter((o) => t - o.created_at >= lim).length;
    if (!rows.length) return { reply: `No order ready to ship has been waiting ${it.days}+ days.${unc ? ` (${unc} unconfirmed COD order${unc > 1 ? 's are' : ' is'} that old; ask "including unconfirmed" to see them.)` : ''}` };
    return { reply: `${rows.length} order${rows.length > 1 ? 's' : ''} not shipped for ${it.days}+ days (oldest first):\n` + rows.slice(0, 60).map(([o, k]) => `${o.name} · ${k} · ${((t - o.created_at) / DAY).toFixed(1)} days · ${o.customer || ''} · ${o.city || ''} ${o.pincode || ''} · ₹${Math.round(o.total)}${o.packed_at ? ' · packed' : ''}`).join('\n')
      + (rows.length > 60 ? `\n…and ${rows.length - 60} more` : '') + (unc ? `\n\nNot counted: ${unc} COD order${unc > 1 ? 's' : ''} the customer never confirmed (ask "including unconfirmed" to list them).` : '') };
  }
  if (it.kind === 'ndr') {
    const p = await ndrProposal(env, A);
    if (!p.rows.length) return { reply: 'No open failed deliveries right now.' };
    return { reply: `${p.rows.length} open failed deliver${p.rows.length > 1 ? 'ies' : 'y'}. I've picked re-attempt or return for each from your NDR rules and the courier's reason; change any, then tap Confirm to send them to Shiprocket.`, proposal: p };
  }

  /* a question: the AI with live numbers */
  const c = aiCfg(env), P = PROVIDERS[c.provider];
  if (!c.key) return { reply: 'I can ship prepaid orders, ship confirmed COD orders and handle NDRs without AI. For questions and suggestions, add a free AI key in Settings > WhatsApp AI (Groq is free).', help: true };
  const snap = await snapshot(env, A);
  /* memory: the newest messages that fit in ~12k characters */
  const hist = [];
  let room = 12000;
  for (let i = past.length - 1; i >= 0 && room > 0; i--) { const c = String(past[i].content || '').slice(0, 3000); room -= c.length; hist.unshift({ role: past[i].role === 'assistant' ? 'assistant' : 'user', content: c }); }
  const merged = [];
  for (const m of [...hist, { role: 'user', content: text }]) { if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += '\n' + m.content; else merged.push({ ...m }); }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  const { r, j, out } = await callModel(c, P, SYSTEM(snap), merged, { max_tokens: 900, timeout: 30000 });
  if (!r || !r.ok) throw new Error('AI provider error: ' + (j?.error?.message || j?.error || r?.status || 'no answer'));
  let reply = String(out || '').trim();
  const m = reply.match(/\n?\s*ACTION:\s*(ship_prepaid|ship_confirmed|ship_ready|ndr|cancel|ship)\b([^\n]*)\s*$/i);
  if (m) {
    reply = reply.slice(0, m.index).trim();
    const a = m[1].toLowerCase(), refs = orderRefs(m[2]);
    if ((a === 'cancel' || a === 'ship') && !refs.length) return { reply: reply || 'Which orders? Give me the order numbers.' };
    const p = a === 'ndr' ? await ndrProposal(env, A) : a === 'cancel' ? await cancelProposal(env, A, { refs }) : a === 'ship' ? await shipListProposal(env, A, refs) : await shipProposal(env, A, a.replace('ship_', ''));
    if (a === 'cancel') p.rows.forEach((r) => { r.preselect = !r.error; });
    if (p.rows.length) return { reply: (reply ? reply + '\n\n' : '') + 'Here is the list. Nothing happens until you tap Confirm.', proposal: p };
    return { reply: (reply ? reply + '\n\n' : '') + 'Nothing is waiting for that right now.' };
  }
  return { reply: reply || 'No answer from the AI, try again.' };
}

/** Home tab numbers (cheap: database only). */
export async function homeStats(env, A) {
  const t = now(), today0 = Math.floor((t + IST) / DAY) * DAY - IST;
  const q = async (sql, ...a) => (await env.DB.prepare(sql).bind(...a).all()).results;
  const [w, today, ndr, unread, reviews, live] = await Promise.all([
    waiting(env, A),
    q(`SELECT COUNT(*) n, COALESCE(SUM(total_paise),0) v FROM orders WHERE created_at>? AND status NOT IN ('pending_payment','failed','completing','cancelled')`, today0),
    q(`SELECT COUNT(*) n FROM shipments WHERE stage='ndr' AND COALESCE(status,'')<>'cancelled' AND (ndr_choice_at IS NULL OR ndr_choice_at < ?)`, t - 2 * DAY).catch(() => [{ n: 0 }]),
    A.inbox_count(env, {}).catch(() => ({ needs: 0 })),
    q(`SELECT COUNT(*) n FROM reviews WHERE status='new' AND COALESCE(test,false)=false`).catch(() => [{ n: 0 }]),
    q('SELECT COUNT(*) n FROM sessions WHERE last_seen>?', t - 90).catch(() => [{ n: 0 }]),
  ]);
  return {
    today: { orders: num(today[0]?.n), revenue: num(today[0]?.v) / 100 },
    prepaid: w.prepaid.length, confirmed: w.confirmed.length, unconfirmed: w.unconfirmed.length,
    packed_waiting: [...w.prepaid, ...w.confirmed].filter((o) => o.packed_at).length,
    ndr: num(ndr[0]?.n), chats: num(unread.needs), reviews: num(reviews[0]?.n), live: num(live[0]?.n),
  };
}
