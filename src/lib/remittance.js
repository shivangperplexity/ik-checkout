/**
 * COD remittance: how much cash the couriers collected, how much came back to us, and when the rest is due.
 *
 * Ours (database): every delivered COD parcel and the cash due on it (shipments.cod_paise, else the order's COD due),
 * by carrier and delivery day. Expected payout day:
 *   Shiprocket  delivery + 8 days (its stated cycle: 8-9 days after delivery, paid on remittance days)
 *   ShipPrime   the dashboard's own "upcoming payment" (COD lands in the ShipPrime wallet; Withdraw sends it to the bank)
 * Theirs:
 *   ShipPrime dashboard API (lib/sp-ndr.js token): GET /balance?shop_id  -> balance, upcoming_payment,
 *     amount_withdrawn_till_date, withdrawable_balance;  GET /transactions?shop_id&limit&offset -> wallet ledger
 *     (RECHARGE, daily SELF_SHIP_ORDER_PAYMENT with cod_collected and a per-parcel CSV link).
 *   Shiprocket: the remittance endpoint set in Settings (found with the sr_remit_probe action), when there is one.
 */
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;
const IST = 19800;
const dstr = (ts) => new Date((ts + IST) * 1000).toISOString().slice(0, 10);
const r2 = (n) => Math.round(n * 100) / 100;

/** Delivered COD parcels in the last `days` with the cash due on each. */
export async function deliveredCod(env, { days = 60 } = {}) {
  const rows = (await env.DB.prepare(`SELECT s.order_id, s.order_name, s.awb, COALESCE(s.provider, 'shiprocket') AS provider, s.courier, s.delivered_at, s.cod_paise,
        o.method, o.total_paise, o.advance_paise, o.converted_at, o.status
      FROM shipments s JOIN orders o ON o.order_id = s.order_id
      WHERE s.delivered_at IS NOT NULL AND s.delivered_at > ? AND COALESCE(s.rto, false) = false`).bind(now() - days * DAY).all()).results;
  return rows.map((r) => {
    const due = r.cod_paise != null ? Number(r.cod_paise) : (r.method === 'cod' && !r.converted_at && r.status !== 'paid' ? Math.max(0, Number(r.total_paise || 0) - Number(r.advance_paise || 0)) : 0);
    return { order: r.order_name, awb: r.awb, provider: r.provider, courier: r.courier, delivered_at: Number(r.delivered_at), cod: due / 100 };
  }).filter((r) => r.cod > 0);
}

export function expectedOn(row, cycleDays = 8) {
  return row.provider === 'shiprocket' ? dstr(row.delivered_at + cycleDays * DAY) : null;
}

/** ShipPrime wallet numbers (needs the dashboard token). */
export async function shipprimeWallet(env) {
  const { dash, dashCfg } = await import('./sp-ndr.js');
  const c = dashCfg(env);
  if (!c.token) return { connected: false };
  const [b, t] = await Promise.all([
    dash(env, 'GET', `/balance?shop_id=${c.shop}`),
    dash(env, 'GET', `/transactions?shop_id=${c.shop}&limit=30&offset=0`).catch(() => ({ transactions: [] })),
  ]);
  return {
    connected: true,
    balance: Number(b.balance || 0), upcoming: Number(b.upcoming_payment || 0), withdrawn: Number(b.amount_withdrawn_till_date || 0),
    withdrawable: Number(b.withdrawable_balance || 0), last7_avg: Number(b.shop_last_7_days_avg || 0),
    ledger: (t.transactions || []).map((x) => ({ at: x.created_at, type: x.transaction_type, ref: x.reference_type, amount: Number(x.amount || 0), cod: Number(x.cod_collected || 0), status: x.status, csv: x.payment_data_link || '' })),
  };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Shiprocket wants dates like 2026-Oct-03 */
export const srDate = (ts) => { const d = new Date((ts + IST) * 1000); return `${d.getUTCFullYear()}-${MON[d.getUTCMonth()]}-${String(d.getUTCDate()).padStart(2, '0')}`; };

/**
 * Shiprocket COD remittances (CRFs): GET /v1/external/account/details/remittance?from=2026-Oct-03&to=2026-Nov-01
 * -> [{ created_at, crf_id, utr, cod_payble, remitted_value, deduction_value, recharge_value, status, remarks, remittance_type }]
 * (found Nov 2026; other date formats answer 500 "Trailing data").
 */
export async function shiprocketRemit(env, { days = 60 } = {}) {
  const { srGetUrl } = await import('./shiprocket.js');
  const t = now();
  const r = await srGetUrl(env, `https://apiv2.shiprocket.in/v1/external/account/details/remittance?from=${srDate(t - days * DAY)}&to=${srDate(t)}`);
  if (r.status !== 200) return { connected: false, error: `HTTP ${r.status} ${String(r.body?.message || '').slice(0, 80)}` };
  const list = (Array.isArray(r.body?.data) ? r.body.data : []).map((x) => ({
    at: Number(x.created_at) || 0, day: dstr(Number(x.created_at) || 0), crf: x.crf_id, utr: x.utr || '', status: x.status || '',
    cod: Number(x.cod_payble || 0), paid: Number(x.remitted_value || 0), deducted: Number(x.deduction_value || 0), to_wallet: Number(x.recharge_value || 0),
  })).sort((a, b) => b.at - a.at);
  const sum = (k, f = () => true) => r2(list.filter(f).reduce((s2, x) => s2 + x[k], 0));
  const done = (x) => /success|remitted/i.test(x.status);
  return {
    connected: true, count: list.length, cod: sum('cod'), paid: sum('paid', done), deducted: sum('deducted'), to_wallet: sum('to_wallet'),
    in_process: sum('cod', (x) => !done(x)), last: list[0] || null, list: list.slice(0, 20),
  };
}

/** The money view: collected by couriers, paid to us, pending and when. */
export async function remittance(env, { days = 60 } = {}) {
  const t = now();
  const rows = await deliveredCod(env, { days });
  const by = {};
  for (const r of rows) {
    const p = (by[r.provider] ||= { parcels: 0, cod: 0, due_soon: {}, overdue: 0, overdue_parcels: 0 });
    p.parcels++; p.cod += r.cod;
    const on = expectedOn(r);
    if (on) {
      if (on < dstr(t)) { p.overdue += r.cod; p.overdue_parcels++; }
      else p.due_soon[on] = r2((p.due_soon[on] || 0) + r.cod);
    }
  }
  for (const p of Object.values(by)) { p.cod = r2(p.cod); p.overdue = r2(p.overdue); }
  const [sp, sr] = await Promise.all([shipprimeWallet(env).catch((e) => ({ connected: false, error: e.message })), shiprocketRemit(env, { days }).catch((e) => ({ connected: false, error: e.message }))]);
  /* Shiprocket: what it should still pay = delivered COD (window) - COD it has already put in a remittance (window) */
  if (sr.connected && by.shiprocket) by.shiprocket.pending_est = r2(Math.max(0, by.shiprocket.cod - sr.cod));
  return { days, today: dstr(t), delivered: by, shipprime: sp, shiprocket: sr, note: 'Shiprocket pays about 8 days after delivery (due dates are estimates from delivery day); pending = delivered COD in the window minus COD Shiprocket has already remitted in the window.' };
}
