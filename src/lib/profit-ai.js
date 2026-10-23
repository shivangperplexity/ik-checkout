/**
 * "What should we do to be profitable?" for the Real revenue page.
 *
 * First the hard numbers, worked out here (so they are right even when the AI is not): what one delivered order
 * earns, what one RTO costs, the RTO rate at which an order stops paying, the most we can pay in ads per order,
 * where RTOs come from (state, COD vs prepaid, order value), and the checkout funnel. Then the configured AI
 * provider (Settings > WhatsApp AI) turns them into a short, ranked plan with the money each step is worth.
 */
import { PROVIDERS, aiCfg, callModel } from './wa-ai.js';
import { revenueReport } from './revenue.js';

const num = (x) => Number(x) || 0;
const r0 = (x) => Math.round(num(x));
const pct = (a, b) => (b ? Math.round((a * 1000) / b) / 10 : 0);

export async function profitFacts(env, A) {
  const all = await revenueReport(env, { range: 'all' });
  const last30 = await revenueReport(env, { range: '30d' });
  const pf = env.SETTINGS?.profit || {};
  const cac = num(pf.cac), unit = num(pf.unit_cost);

  /* one finished order, from all-time averages */
  const dN = all.delivered.cod.n + all.delivered.prepaid.n, rN = all.rto.n;
  const aov = dN ? all.real_revenue / dN : 0;
  const shipped = dN + rN + all.in_transit.n + all.unknown.n;
  const freightAvg = shipped ? all.costs.freight / shipped : 0;
  const unitsPer = dN ? all.costs.product / Math.max(1, unit) / Math.max(1, dN + all.in_transit.n + all.unknown.n) : 1;
  const earnDelivered = aov - unitsPer * unit - freightAvg - cac;        /* what a delivered order leaves after its own costs */
  const lossRto = 2 * freightAvg + cac;                                     /* what a returned one costs */
  const breakEvenRto = earnDelivered + lossRto > 0 ? pct(earnDelivered, earnDelivered + lossRto) : 0;
  const rtoRate = all.rto.rate_pct;
  const rr = rtoRate / 100;
  const maxCac = (1 - rr) * (aov - unitsPer * unit - freightAvg) - rr * 2 * freightAvg;   /* ads per shipped order at which profit is zero */

  /* where RTOs come from (orders placed through this checkout carry the state and PIN) */
  const rows = (await env.DB.prepare(`SELECT r.state, r.pay, r.total_paise, o.state_code, o.method, o.converted_at, o.advance_paise, s.stage AS sr_stage, s.rto AS sr_rto
      FROM rev_orders r LEFT JOIN orders o ON o.order_id = r.order_id LEFT JOIN shipments s ON s.order_id = r.order_id AND COALESCE(s.status,'')<>'cancelled'`).all()).results;
  const outcome = (r) => (r.sr_stage === 'delivered' ? 'delivered' : r.sr_stage === 'rto' || r.sr_rto ? 'returned' : r.state);
  const group = (key) => {
    const g = {};
    for (const r of rows) {
      const o = outcome(r); if (o !== 'delivered' && o !== 'returned') continue;
      const k = key(r); if (!k) continue;
      const x = g[k] = g[k] || { delivered: 0, returned: 0 };
      x[o]++;
    }
    return Object.entries(g).map(([k, x]) => ({ k, n: x.delivered + x.returned, rto_pct: pct(x.returned, x.delivered + x.returned) })).filter((x) => x.n >= 5).sort((a, b) => b.rto_pct - a.rto_pct);
  };
  const payOf = (r) => (r.method ? (r.method === 'cod' && !r.converted_at ? (num(r.advance_paise) > 0 ? 'part-paid COD' : 'COD') : 'prepaid') : (r.pay === 'cod' ? 'COD' : 'prepaid'));
  const band = (r) => { const v = num(r.total_paise) / 100; return v < 400 ? 'under ₹400' : v < 700 ? '₹400-699' : v < 1000 ? '₹700-999' : '₹1000+'; };

  let funnel = null;
  try { const a = await A.analytics(env, { days: 30 }); funnel = { sessions: a.kpi.sessions, orders: a.kpi.orders, conversion_pct: Math.round(a.kpi.conv * 100) / 100, steps: a.funnel.map((f) => `${f.label}: ${f.n}`).join(' > '), left_at: a.left.filter((x) => x.n).map((x) => `${x.label}: ${x.n}`).join('; '), cod_orders: a.kpi.cod, prepaid_orders: a.kpi.prepaid, cancelled: a.kpi.cancelled }; } catch { /* optional */ }

  return {
    settings: { product_cost_per_item: unit, ads_per_order: cac },
    all_time: { real_revenue: r0(all.real_revenue), real_profit: r0(all.profit.total), margin_pct: all.profit.margin_pct, delivered: dN, returned: rN, rto_rate_pct: rtoRate,
      in_transit: all.in_transit.n, not_shipped: all.unshipped.n, cancelled: all.cancelled.n, orders_placed: all.profit.orders_received,
      costs: { stock: r0(all.profit.product), freight_out: r0(all.profit.freight_out), freight_back: r0(all.profit.freight_back), ads: r0(all.profit.ads) },
      by_courier: Object.fromEntries(Object.entries(all.carriers).map(([k, x]) => [k, { delivered: x.delivered, returned: x.returned, rto_pct: pct(x.returned, x.delivered + x.returned) }])) },
    last_30_days: { real_revenue: r0(last30.real_revenue), real_profit: r0(last30.profit.total), delivered: last30.delivered.cod.n + last30.delivered.prepaid.n, returned: last30.rto.n, rto_rate_pct: last30.rto.rate_pct },
    unit_economics: { avg_delivered_order: r0(aov), freight_per_parcel: r0(freightAvg), items_per_order: Math.round(unitsPer * 10) / 10,
      earned_per_delivered_order: r0(earnDelivered), lost_per_rto: r0(lossRto), break_even_rto_pct: breakEvenRto, max_ads_per_order_to_break_even: r0(maxCac),
      cancelled_or_unconfirmed_share_pct: pct(all.cancelled.n + all.unshipped.n, all.profit.orders_received) },
    rto_by_payment: group(payOf), rto_by_order_value: group(band), rto_by_state_worst: group((r) => r.state_code).slice(0, 8),
    funnel_30d: funnel,
  };
}

const SYSTEM = (f) => `You are a profitability analyst for Ink Kulture, a small Indian D2C brand selling semi-permanent tattoos (₹249-1199, Buy 1 Get 1 free on every design, COD and prepaid, Shiprocket shipping, WhatsApp COD confirmation, Meta ads). The owner wants to know exactly what to do to become (more) profitable.

Use ONLY the numbers in DATA. They are real; "earned_per_delivered_order" and "lost_per_rto" are already computed for you. Do not invent numbers; when you estimate the effect of an action, show the simple arithmetic from DATA (for example "RTO 18% -> 12% on ~300 parcels a month = 18 fewer RTOs x ₹244 = ~₹4,400/month").

Write in simple English (the owner also reads Hinglish fine). Format:
1. One line: the honest state of the business right now (profit, margin, the single biggest leak).
2. "Do this first" - the 5 highest-value actions, ranked by money impact, each with: what to do concretely in this store (checkout, COD rules, prices/bundles, couriers, WhatsApp, ads), why (the numbers), and the expected monthly effect in ₹.
3. "Stop doing" - 1-3 things that lose money, if any.
4. "Watch" - 2-3 numbers to check weekly, with the target value.
Keep it under 350 words. Be direct; no generic advice that ignores the data. Be honest: never suggest misleading customers (the tattoos last 1-2 weeks; never claim longer).

DATA:
${JSON.stringify(f)}`;

export async function profitAdvice(env, A) {
  const facts = await profitFacts(env, A);
  const c = aiCfg(env), P = PROVIDERS[c.provider];
  if (!c.key) return { facts, advice: '', error: 'Add a free AI key in Settings > WhatsApp AI (Groq is free) to get the written plan. The numbers above are worked out without AI.' };
  const { r, j, out } = await callModel(c, P, SYSTEM(facts), [{ role: 'user', content: 'What exactly should we do to be profitable? Give me the plan.' }], { max_tokens: 1400, timeout: 45000 });
  if (!r || !r.ok) return { facts, advice: '', error: 'AI provider error: ' + (j?.error?.message || j?.error || r?.status || 'no answer') };
  return { facts, advice: String(out || '').trim() };
}
