/** ShipPrime-only P&L inputs: every order shipped through ShipPrime, its outcome, value, units and forward charge. */
export async function spPnl(env) {
  const rows = (await env.DB.prepare(`SELECT CASE WHEN s.rto OR s.stage='rto' THEN 'rto' WHEN s.stage='delivered' THEN 'delivered' WHEN s.stage IN ('pickup_pending','pickup_failed') OR s.stage IS NULL OR s.stage='' THEN 'not_picked' ELSE 'transit' END AS state,
      CASE WHEN COALESCE(s.cod_paise,0) > 0 THEN 'cod' ELSE 'prepaid' END AS pay, COUNT(*) n, SUM(r.total_paise - COALESCE(r.refunded_paise,0)) v, SUM(COALESCE(r.units,1)) u,
      SUM(COALESCE(s.charge_paise,0)) ch, SUM(CASE WHEN COALESCE(s.charge_paise,0) > 0 THEN 1 ELSE 0 END) ch_n, MIN(s.created_at) first, MAX(s.created_at) last
    FROM shipments s JOIN rev_orders r ON r.order_id = s.order_id
    WHERE s.provider = 'shipprime' AND COALESCE(s.status,'') <> 'cancelled' AND r.state <> 'cancelled'
    GROUP BY 1, 2`).all()).results;
  const first = Math.min(...rows.map((r) => Number(r.first)).filter(Boolean));
  const all = (await env.DB.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN s.provider='shipprime' THEN 1 ELSE 0 END) sp,
      SUM(CASE WHEN s.order_id IS NOT NULL AND COALESCE(s.provider,'')<>'shipprime' THEN 1 ELSE 0 END) other, SUM(CASE WHEN r.state='cancelled' THEN 1 ELSE 0 END) cancelled
    FROM rev_orders r LEFT JOIN shipments s ON s.order_id = r.order_id AND COALESCE(s.status,'')<>'cancelled' WHERE r.created_at >= ?`).bind(first).first());
  const fix = (r) => ({ state: r.state, pay: r.pay, n: Number(r.n), value: Math.round(Number(r.v) / 100), units: Number(r.u), charge: Math.round(Number(r.ch) / 100), charged_n: Number(r.ch_n) });
  const st = (await env.DB.prepare(`SELECT COALESCE(o.state_code,'?') st, CASE WHEN COALESCE(s.cod_paise,0) > 0 THEN 'cod' ELSE 'prepaid' END AS pay,
      SUM(CASE WHEN s.stage='delivered' AND NOT COALESCE(s.rto,false) THEN 1 ELSE 0 END) d, SUM(CASE WHEN COALESCE(s.rto,false) OR s.stage='rto' THEN 1 ELSE 0 END) r,
      SUM(CASE WHEN NOT (COALESCE(s.rto,false) OR COALESCE(s.stage,'') IN ('rto','delivered')) THEN 1 ELSE 0 END) t
    FROM shipments s LEFT JOIN orders o ON o.order_id = s.order_id WHERE s.provider='shipprime' AND COALESCE(s.status,'') <> 'cancelled'
    GROUP BY 1, 2 ORDER BY (d + r) DESC`).all()).results.map((x) => ({ state: x.st, pay: x.pay, delivered: Number(x.d), rto: Number(x.r), open: Number(x.t), rto_pct: Number(x.d) + Number(x.r) ? Math.round((Number(x.r) / (Number(x.d) + Number(x.r))) * 100) : null }));
  return { by_state: st, first_booking: new Date(first * 1000).toISOString().slice(0, 10), rows: rows.map(fix), orders_since: { total: Number(all.n), shipprime: Number(all.sp), other_carrier: Number(all.other), cancelled: Number(all.cancelled) } };
}
