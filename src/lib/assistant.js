/**
 * Dashboard assistant (Home tab). Answers questions about the store from live data and prepares actions:
 *   - ship prepaid orders / ship confirmed COD orders / ship everything ready (Shiprocket, cheapest allowed courier)
 *   - handle open NDRs (re-attempt or return, per the NDR rules' plan)
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
const DOIT = /\b(handle|sambhal|run|kar ?do|kardo|karo|fix|process|clear|do it|take care|solve|resolve|nipta)\w*/i;

export function intent(text) {
  const t = String(text || '').toLowerCase();
  const pack = /\bpack/.test(t);
  if (SHIP.test(t) && !/\?\s*$/.test(t) && !/\b(how many|kitne|kitna|status|kab)\b/.test(t)) {
    const pre = /\b(pre-?paid|paid|online)\b/.test(t), conf = /\b(address|confirm|confirmed|cod)\w*/.test(t), all = /\b(all|sab|saare|sare|ready|everything|baaki|bache)\b/.test(t);
    const which = pre && conf ? 'ready' : pre ? 'prepaid' : conf ? 'confirmed' : all ? 'ready' : '';
    if (which) return { kind: 'ship', which, pack };
  }
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
  const priced = rows.slice(0, 20);
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
  const ok = rows.filter((r) => !r.error);
  return {
    kind: 'ship', which, title: SHIP_TITLE[which], rows,
    total_charge: Math.round(ok.reduce((s, r) => s + num(r.charge), 0) * 100) / 100,
    unpriced: Math.max(0, rows.length - priced.length),
    skipped_unconfirmed: w.unconfirmed.length,
  };
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
  const todayOrders = await q(`SELECT method, COUNT(*) n, COALESCE(SUM(total_paise),0) v FROM orders WHERE created_at>? AND status NOT IN ('pending_payment','failed','completing','cancelled') GROUP BY 1`, today0).catch(() => []);
  const st = Object.fromEntries(ship.map((r) => [r.stage, num(r.n)]));
  const shipped30 = ship.reduce((s, r) => s + num(r.n), 0), rto30 = ship.reduce((s, r) => s + num(r.rto), 0);
  const k = (a) => a ? { orders: a.kpi.orders, revenue: Math.round(a.kpi.revenue), aov: Math.round(a.kpi.aov), cod: a.kpi.cod, prepaid: a.kpi.prepaid, cancelled: a.kpi.cancelled, sessions: a.kpi.sessions, conversion_pct: Math.round(a.kpi.conv * 100) / 100,
    checkout_funnel: a.funnel.map((f) => `${f.label}: ${f.n}`).join(' > '), left_at_step: a.left.filter((x) => x.n).map((x) => `${x.label}: ${x.n} (${inr(x.value)})`).join('; '),
    sources: (a.sources || []).map((s) => `${s.s}: ${s.sessions} sessions, ${s.orders} orders`).join('; '), devices: (a.devices || []).map((d) => `${d.d}: ${d.sessions}/${d.orders}`).join('; ') } : null;
  return {
    now_ist: new Date((t + IST) * 1000).toISOString().slice(0, 16).replace('T', ' '),
    today: { orders: todayOrders.reduce((s, r) => s + num(r.n), 0), revenue: Math.round(todayOrders.reduce((s, r) => s + num(r.v), 0) / 100), cod: num(todayOrders.find((r) => r.method === 'cod')?.n) },
    to_ship: w ? { prepaid: w.prepaid.length, confirmed_cod: w.confirmed.length, waiting_cod_confirmation: w.unconfirmed.length, oldest_waiting_hours: Math.max(0, ...[...w.prepaid, ...w.confirmed].map((o) => Math.round((t - o.created_at) / 3600))) } : null,
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
Only add an ACTION line when the owner asks for that action. Never claim something was shipped, booked or changed: you only prepare it.
You never pack orders (the owner packs himself) and never ship COD orders that were not confirmed.

Use only the numbers in STORE DATA. If something is not in it, say you can't see it here. When asked for improvements to the store or checkout, give 3 to 5 specific, prioritised suggestions tied to these numbers (for example where the checkout funnel drops, COD share and RTO, conversion by device or source), each with the expected effect. Be honest: the tattoos are semi-permanent and last 1-2 weeks; never suggest claiming otherwise.

STORE DATA (live):
${JSON.stringify(snap)}`;

/** POST rpc assistant { text, history: [{role:'user'|'assistant', content}] } */
export async function assistant(env, A, b) {
  const text = String(b.text || '').trim().slice(0, 1500);
  if (!text) throw new Error('Type a message');
  const it = intent(text);
  const packNote = it.pack ? 'I don\'t pack orders, that stays with you. ' : '';
  if (it.kind === 'ship') {
    const p = await shipProposal(env, A, it.which);
    if (!p.rows.length) return { reply: `${packNote}Nothing to ship in "${p.title}" right now.${p.skipped_unconfirmed ? ` ${p.skipped_unconfirmed} COD order${p.skipped_unconfirmed > 1 ? 's are' : ' is'} still waiting for the customer to confirm, so I left ${p.skipped_unconfirmed > 1 ? 'them' : 'it'} out.` : ''}` };
    const bad = p.rows.filter((r) => r.error).length;
    return { reply: `${packNote}${p.rows.length} order${p.rows.length > 1 ? 's' : ''} ready: ${p.title.toLowerCase()}. Shiprocket estimate ${inr(p.total_charge)}${p.unpriced ? ` for the first 20 (${p.unpriced} more at the cheapest courier)` : ''}.${bad ? ` ${bad} can't be booked as is (see the list).` : ''}${p.skipped_unconfirmed && it.which !== 'prepaid' ? ` ${p.skipped_unconfirmed} unconfirmed COD order${p.skipped_unconfirmed > 1 ? 's' : ''} left out.` : ''} Untick any you want to hold, then tap Confirm to book.`, proposal: p };
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
  const hist = (Array.isArray(b.history) ? b.history : []).slice(-8).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) })).filter((m) => m.content);
  const merged = [];
  for (const m of [...hist, { role: 'user', content: text }]) { if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += '\n' + m.content; else merged.push({ ...m }); }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  const { r, j, out } = await callModel(c, P, SYSTEM(snap), merged, { max_tokens: 900, timeout: 30000 });
  if (!r || !r.ok) throw new Error('AI provider error: ' + (j?.error?.message || j?.error || r?.status || 'no answer'));
  let reply = String(out || '').trim();
  const m = reply.match(/\n?\s*ACTION:\s*(ship_prepaid|ship_confirmed|ship_ready|ndr)\s*$/i);
  if (m) {
    reply = reply.slice(0, m.index).trim();
    const a = m[1].toLowerCase();
    const p = a === 'ndr' ? await ndrProposal(env, A) : await shipProposal(env, A, a.replace('ship_', ''));
    if (p.rows.length) return { reply: (reply ? reply + '\n\n' : '') + 'Here is the list. Nothing is booked until you tap Confirm.', proposal: p };
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
