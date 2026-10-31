/** Read-only business analysis (admin action `insights`): checkout funnel, payment mix, delivery outcomes by segment. */
const now = () => Math.floor(Date.now() / 1000);
const IST = 19800;

/** Pure: group rows into { key: { n, delivered, rto, open, cancelled } } and add rto% over finished (delivered + rto). */
export function outcomeBy(rows, keyOf) {
  const g = {};
  for (const r of rows) {
    const k = keyOf(r); if (k == null) continue;
    const x = g[k] || (g[k] = { n: 0, delivered: 0, rto: 0, open: 0, cancelled: 0 });
    x.n++; x[r.outcome]++;
  }
  for (const x of Object.values(g)) { const f = x.delivered + x.rto; x.rto_pct = f ? Math.round((x.rto / f) * 100) : null; x.finished = f; }
  return g;
}
export function outcomeOf(r) {
  if (r.status === 'cancelled' && !r.awb) return 'cancelled';
  if (r.rto || r.stage === 'rto' || r.stage === 'lost') return 'rto';
  if (r.stage === 'delivered' || r.delivered_at) return 'delivered';
  return 'open';
}
const bucket = (v, cuts) => { for (const [lim, lab] of cuts) if (v < lim) return lab; return cuts[cuts.length - 1][1] + '+'; };

export async function insights(env, { days = 90 } = {}) {
  const t = now(), from = t - days * 86400;
  const q = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results;
  const orders = await q(`SELECT o.order_id, o.order_name, o.method, o.status, o.phone, o.state_code, o.pincode, o.created_at, o.total_paise, o.confirmed_at, o.converted_at,
      o.advance_paise, o.otp_at, o.source_url, o.sid, o.addr_tagged_at, s.awb, s.courier, s.stage, s.rto, s.delivered_at, s.picked_at, s.created_at AS booked_at, se.source, se.device, se.utm_json
    FROM orders o LEFT JOIN shipments s ON s.order_id=o.order_id AND COALESCE(s.status,'')<>'cancelled' LEFT JOIN sessions se ON se.sid=o.sid
    WHERE o.created_at>? AND o.order_id IS NOT NULL AND o.status NOT IN ('pending_payment','failed','completing')`, from);
  /* first order per phone ever, to tell new from repeat */
  const firsts = Object.fromEntries((await q("SELECT phone, MIN(created_at) AS f FROM orders WHERE order_id IS NOT NULL AND status NOT IN ('pending_payment','failed','completing') GROUP BY phone")).map((r) => [r.phone, Number(r.f)]));
  const priorRto = new Set((await q(`SELECT DISTINCT o.phone FROM orders o JOIN shipments s ON s.order_id=o.order_id WHERE (s.rto=TRUE OR s.stage='rto')`)).map((r) => r.phone));
  const rows = orders.map((r) => {
    const h = new Date((Number(r.created_at) + IST) * 1000).getUTCHours();
    const pay = r.method === 'cod' ? (Number(r.advance_paise) > 0 ? 'partial' : r.converted_at ? 'cod->prepaid' : 'cod') : 'prepaid';
    let src = String(r.source || '');
    if (!src) { try { const u = JSON.parse(r.utm_json || '{}'); src = u.utm_source || u.fbclid ? 'meta' : ''; } catch { src = ''; } }
    if (/fb|ig|meta|facebook|instagram/i.test(src)) src = 'meta-ads'; else if (/wa|whatsapp/i.test(src)) src = 'whatsapp'; else if (/google|gclid/i.test(src)) src = 'google'; else src = src || 'direct/organic';
    return { ...r, outcome: outcomeOf(r), pay, hour: h, hourB: h >= 23 || h < 6 ? '23-06 night' : h < 12 ? '06-12 morning' : h < 18 ? '12-18 afternoon' : '18-23 evening',
      value: bucket(Number(r.total_paise) / 100, [[400, '<400'], [600, '400-599'], [900, '600-899'], [1300, '900-1299'], [1300, '1300']]),
      repeat: Number(firsts[r.phone]) < Number(r.created_at) ? 'repeat' : 'new', prior_rto: priorRto.has(r.phone) && Number(firsts[r.phone]) < Number(r.created_at) ? 'had RTO before' : 'no',
      lag: r.picked_at && r.created_at ? bucket((Number(r.picked_at) - Number(r.created_at)) / 86400, [[1, '<1d'], [2, '1-2d'], [4, '2-4d'], [4, '4d']]) : null,
      family: String(r.courier || '').split(/\s+/)[0] || null, src, device: r.device || 'unknown', otp: r.otp_at ? 'otp verified' : 'no otp',
      dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date((Number(r.created_at) + IST) * 1000).getUTCDay()] };
  });
  const cod = rows.filter((r) => r.pay === 'cod');
  const top = (g, min = 8) => Object.fromEntries(Object.entries(g).filter(([, x]) => x.finished >= min).sort((a, b) => b[1].n - a[1].n));
  /* funnel (sessions, last 30 days) */
  const fun = await q(`SELECT COALESCE(source,'') AS source, COALESCE(device,'') AS device, max_step, COUNT(*) AS n FROM sessions WHERE first_seen>? GROUP BY 1,2,3`, t - 30 * 86400);
  const steps = ['cart', 'open', 'phone', 'pin', 'address', 'pay', 'submit', 'done'];
  const reach = (filter) => steps.map((s, i) => fun.filter(filter).filter((f) => Number(f.max_step) >= i).reduce((a, f) => a + Number(f.n), 0));
  const funnel = { all: reach(() => true), mobile: reach((f) => /mob|android|iphone/i.test(f.device)), desktop: reach((f) => /desk/i.test(f.device)) };
  const weekly = {};
  for (const r of rows) { const w = new Date((Number(r.created_at) + IST) * 1000).toISOString().slice(0, 10); const wk = w.slice(0, 8) + String(Math.floor((Number(w.slice(8)) - 1) / 7) * 7 + 1).padStart(2, '0'); const x = weekly[wk] || (weekly[wk] = { orders: 0, prepaid: 0, rev: 0 }); x.orders++; if (r.pay !== 'cod') x.prepaid++; x.rev += Math.round(Number(r.total_paise) / 100); }
  const leads = await q("SELECT COUNT(*) AS n, SUM(CASE WHEN status='ordered' THEN 1 ELSE 0 END) AS ordered FROM leads WHERE updated_at>?", t - 30 * 86400);
  return {
    ok: true, days, orders: rows.length, aov: Math.round(rows.reduce((a, r) => a + Number(r.total_paise), 0) / Math.max(1, rows.length) / 100),
    pay: outcomeBy(rows, (r) => r.pay), all: outcomeBy(rows, () => 'all'),
    cod_by: {
      state: top(outcomeBy(cod, (r) => r.state_code || '?')), hour: outcomeBy(cod, (r) => r.hourB), value: outcomeBy(cod, (r) => r.value), repeat: outcomeBy(cod, (r) => r.repeat),
      prior_rto: outcomeBy(cod, (r) => r.prior_rto), courier: top(outcomeBy(cod, (r) => r.family), 5), lag: outcomeBy(cod, (r) => r.lag), source: outcomeBy(cod, (r) => r.src),
      device: outcomeBy(cod, (r) => r.device), otp: outcomeBy(cod, (r) => r.otp), confirmed: outcomeBy(cod, (r) => (r.confirmed_at ? 'confirmed' : 'not confirmed')), dow: outcomeBy(cod, (r) => r.dow),
    },
    weekly, funnel, leads30: leads[0],
  };
}
