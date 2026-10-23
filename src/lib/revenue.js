/**
 * Real revenue: money from orders that actually reached the customer, not orders received.
 *
 * Every Shopify order is kept in rev_orders (a full pass over Shopify every ~30 minutes, a few pages per cron run).
 * Its outcome comes from:
 *   - Shiprocket bookings made from this dashboard: our own shipments table (stage delivered / rto, the real freight)
 *   - everything else (NimbusPost era, manual): Shopify's fulfilment tracking (DELIVERED / NOT_DELIVERED events),
 *     the same reading the review requests use (reviews.js shopifyDelivery)
 *
 * Real revenue  = order value of delivered orders (after refunds), split COD collected / prepaid.
 * RTO loss      = freight out + freight back + the ad cost of winning that order, minus any advance kept.
 *                 Freight back is not reported by either courier here, so it is taken as equal to freight out;
 *                 NimbusPost freight is not known at all, so its average is a setting (default: our Shiprocket average).
 */
import { gql } from './shopify.js';
import { shopifyDelivery } from './reviews.js';

const now = () => Math.floor(Date.now() / 1000);
const num = (x) => Number(x) || 0;
const iso = (s) => (s ? Math.floor(Date.parse(s) / 1000) || 0 : 0);
const PAGES_PER_RUN = 4, PASS_EVERY = 30 * 60;

const Q = `query($after:String){ orders(first:50, after:$after, sortKey:CREATED_AT){
  pageInfo{ hasNextPage endCursor }
  nodes{ legacyResourceId name createdAt updatedAt cancelledAt displayFinancialStatus tags paymentGatewayNames
    currentTotalPriceSet{ shopMoney{ amount } } totalRefundedSet{ shopMoney{ amount } }
    lineItems(first:20){ nodes{ currentQuantity } }
    fulfillments(first:5){ status displayStatus createdAt updatedAt deliveredAt trackingInfo{ number url company }
      events(first:20, sortKey:HAPPENED_AT){ nodes{ status happenedAt } } } } } }`;

export function carrierOf(o) {
  const t = (o.fulfillments || []).flatMap((f) => f.trackingInfo || []).map((x) => `${x.company || ''} ${x.url || ''}`).join(' ').toLowerCase();
  if (/nimbus/.test(t)) return 'nimbuspost';
  if (/shiprocket/.test(t)) return 'shiprocket';
  return t.trim() ? 'other' : '';
}

/** One Shopify order -> a rev_orders row (pure). */
export function rowOf(o) {
  const d = shopifyDelivery({ ...o, displayFinancialStatus: '' });   /* refunds are handled by the amount, not as "skipped" */
  const state = o.cancelledAt ? 'cancelled' : d.state === 'delivered' ? 'delivered' : d.state === 'returned' ? 'returned' : d.state === 'shipped' ? 'shipped' : 'unshipped';
  const gw = (o.paymentGatewayNames || []).join(' ');
  return {
    order_id: String(o.legacyResourceId), name: o.name, created_at: iso(o.createdAt),
    total_paise: Math.round(num(o.currentTotalPriceSet?.shopMoney?.amount) * 100), refunded_paise: Math.round(num(o.totalRefundedSet?.shopMoney?.amount) * 100),
    pay: /cash on delivery|\bcod\b/i.test(gw) ? 'cod' : 'prepaid', state, delivered_at: d.delivered_at || null, shipped_at: d.fulfilled_at || null,
    carrier: carrierOf(o), awb: d.awb || '', units: (o.lineItems?.nodes || []).reduce((s, l) => s + num(l.currentQuantity), 0) || 1,
    tags: (o.tags || []).join(',').slice(0, 300),
  };
}

async function save(env, r) {
  const k = Object.keys(r);
  await env.DB.prepare(`INSERT INTO rev_orders (${k.join(',')}, scanned_at) VALUES (${k.map(() => '?').join(',')}, ?)
    ON CONFLICT (order_id) DO UPDATE SET ${k.filter((x) => x !== 'order_id').map((x) => `${x}=EXCLUDED.${x}`).join(', ')}, scanned_at=EXCLUDED.scanned_at`).bind(...Object.values(r), now()).run();
}

/** Cron / button: carry the full pass on (up to `pages` pages, or until `budgetMs` is used). force: start a new pass
 *  now, unless one is already under way (then it carries on: restarting would only ever re-read the first pages). */
export async function revenueScan(env, { pages = PAGES_PER_RUN, force = false, budgetMs = 0 } = {}) {
  const st = JSON.parse((await env.DB.prepare("SELECT v FROM settings WHERE k='rev_scan'").first().catch(() => null))?.v || '{}');
  if (!st.cursor && !force && st.full_at && now() - st.full_at < PASS_EVERY) return { skipped: 'fresh' };
  const t0 = Date.now();
  let after = st.cursor || null, seen = 0, done = false;
  for (let p = 0; p < pages && (!budgetMs || Date.now() - t0 < budgetMs); p++) {
    const d = await gql(env, Q, { after });
    const page = d.orders || d.data?.orders;
    for (const o of page.nodes) { await save(env, rowOf(o)); seen++; }
    if (!page.pageInfo.hasNextPage) { done = true; break; }
    after = page.pageInfo.endCursor;
  }
  const next = done ? { cursor: null, full_at: now(), started_at: st.started_at || now(), read: (st.cursor ? num(st.read) : 0) + seen } : { ...st, cursor: after, started_at: st.cursor ? st.started_at : now(), read: (st.cursor ? num(st.read) : 0) + seen };
  await env.DB.prepare("INSERT INTO settings (k, v) VALUES ('rev_scan', ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v").bind(JSON.stringify(next)).run();
  return { seen, done };
}

/** The report. range: 'all' | '30d' | 'month' | '7d' (by delivery / return / order date). */
export async function revenueReport(env, { range = 'all' } = {}) {
  const t = now(), IST = 19800, DAY = 86400;
  const today0 = Math.floor((t + IST) / DAY) * DAY - IST;
  const d = new Date((t + IST) * 1000), month0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 - IST;
  const from = { all: 0, '7d': today0 - 6 * DAY, '30d': today0 - 29 * DAY, month: month0 }[range] ?? 0;

  const rows = (await env.DB.prepare(`SELECT r.*, s.stage AS sr_stage, s.charge_paise AS sr_charge, s.delivered_at AS sr_delivered_at, s.rto AS sr_rto, s.status AS sr_status, s.updated_at AS sr_updated,
      o.method AS ik_method, o.advance_paise, o.converted_at
    FROM rev_orders r LEFT JOIN shipments s ON s.order_id = r.order_id AND COALESCE(s.status,'') <> 'cancelled' LEFT JOIN orders o ON o.order_id = r.order_id`).all()).results;
  const pf = (env.SETTINGS?.profit) || {};
  const srCharges = rows.filter((r) => num(r.sr_charge) > 0).map((r) => num(r.sr_charge) / 100);
  const srAvg = srCharges.length ? srCharges.reduce((a, b) => a + b, 0) / srCharges.length : 0;
  const nimbusFreight = num(pf.nimbus_freight) || Math.round(srAvg) || num(pf.ship_estimate) || 65;
  const cac = num(pf.cac), unitCost = num(pf.unit_cost);

  const out = { range, nimbus_freight: nimbusFreight, nimbus_freight_set: !!num(pf.nimbus_freight), sr_avg_freight: Math.round(srAvg * 100) / 100, cac, unit_cost: unitCost };
  const blank = () => ({ n: 0, value: 0 });
  const by = { delivered: { cod: blank(), prepaid: blank() }, returned: { cod: blank(), prepaid: blank() }, transit: blank(), unknown: blank(), unshipped: blank(), cancelled: blank() };
  const carriers = {};
  const rto = { n: 0, freight_out: 0, freight_back: 0, ads: 0, advance_kept: 0, est_n: 0, value_lost: 0, list: [] };
  let freightAll = 0, freightEst = 0, productCost = 0, refunds = 0, received = 0;
  const STALE = 15 * DAY;   /* a NimbusPost / manual parcel with no tracking update for 15 days: outcome unknown */

  for (const r of rows) {
    /* ad spend: every order placed in the range cost ads to win, whatever happened to it (collab / test orders did not) */
    if (num(r.created_at) >= from && !/collab|barter|creator|test/i.test(r.tags || '')) received++;
    /* outcome: our Shiprocket record first, Shopify tracking otherwise */
    let state = r.state, at = r.delivered_at, carrier = r.carrier || 'other';
    if (r.sr_stage || r.sr_status) {
      carrier = 'shiprocket';
      if (r.sr_stage === 'delivered') { state = 'delivered'; at = num(r.sr_delivered_at) || at || num(r.sr_updated); }
      else if (r.sr_stage === 'rto' || r.sr_rto) { state = 'returned'; }
      else if (state !== 'cancelled' && state !== 'delivered') state = 'shipped';
    }
    const pay = r.ik_method ? (r.ik_method === 'cod' && !r.converted_at ? 'cod' : 'prepaid') : r.pay;
    const value = num(r.total_paise) / 100, adv = num(r.advance_paise) / 100;
    const when = state === 'delivered' ? num(at) || num(r.shipped_at) || num(r.created_at) : state === 'returned' ? num(r.shipped_at) || num(r.created_at) : num(r.created_at);
    if (when < from) continue;
    const freight = r.sr_charge != null && num(r.sr_charge) > 0 ? num(r.sr_charge) / 100 : null;
    const shippedAny = ['delivered', 'returned', 'shipped'].includes(state);
    const C = () => (carriers[carrier] = carriers[carrier] || { delivered: 0, returned: 0, transit: 0, value: 0 });

    if (state === 'delivered') {
      by.delivered[pay].n++; by.delivered[pay].value += value; C().delivered++; C().value += value;
      productCost += num(r.units) * unitCost; refunds += num(r.refunded_paise) / 100;
    } else if (state === 'returned') {
      by.returned[pay].n++; by.returned[pay].value += value; C().returned++;
      const out1 = freight ?? nimbusFreight;
      rto.n++; rto.freight_out += out1; rto.freight_back += out1; rto.ads += cac; rto.advance_kept += adv; rto.value_lost += pay === 'cod' ? value - adv : 0;
      if (freight == null) rto.est_n++;
      rto.list.push({ name: r.name, carrier, pay, value, freight: out1, est: freight == null, at: when });
    } else if (state === 'shipped') {
      const stale = carrier !== 'shiprocket' && num(r.shipped_at) && t - num(r.shipped_at) > STALE;
      if (stale) by.unknown.n++, by.unknown.value += value; else { by.transit.n++; by.transit.value += value; C().transit++; }
      productCost += num(r.units) * unitCost;   /* out of stock and on its way (or lost) */
    } else if (state === 'cancelled') { by.cancelled.n++; by.cancelled.value += value; }
    else { by.unshipped.n++; by.unshipped.value += value; }
    if (shippedAny) { const f = freight ?? nimbusFreight; freightAll += f; if (freight == null) freightEst += f; }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  const real = by.delivered.cod.value + by.delivered.prepaid.value;
  rto.total = rto.freight_out + rto.freight_back + rto.ads - rto.advance_kept;
  rto.list = rto.list.sort((a, b) => b.at - a.at).slice(0, 100);
  const shippedN = by.delivered.cod.n + by.delivered.prepaid.n + by.returned.cod.n + by.returned.prepaid.n;
  Object.assign(out, {
    real_revenue: r2(real), delivered: by.delivered, returned: by.returned, in_transit: by.transit, unknown: by.unknown, unshipped: by.unshipped, cancelled: by.cancelled,
    rto: { ...rto, freight_out: r2(rto.freight_out), freight_back: r2(rto.freight_back), ads: r2(rto.ads), advance_kept: r2(rto.advance_kept), total: r2(rto.total), value_lost: r2(rto.value_lost),
      rate_pct: shippedN ? Math.round((rto.n * 1000) / shippedN) / 10 : 0 },
    carriers,
    costs: { freight: r2(freightAll), freight_est: r2(freightEst), product: r2(productCost), ads: r2(received * cac), refunds: r2(refunds) },
  });
  /* Real profit, cash basis: money in from delivered orders minus everything already spent (stock sent out, freight
     both ways, ads for every order placed). Parcels still on the way add their revenue when delivered. */
  const profit = {
    revenue: r2(real), product: r2(productCost), freight_out: r2(freightAll), freight_back: r2(rto.freight_back), ads: r2(received * cac), orders_received: received,
    advances_kept: r2(rto.advance_kept), freight_est: r2(freightEst + (rto.est_n ? rto.freight_back * (rto.est_n / Math.max(1, rto.n)) : 0)),
  };
  profit.total = r2(profit.revenue - profit.product - profit.freight_out - profit.freight_back - profit.ads + profit.advances_kept);
  profit.margin_pct = real ? Math.round((profit.total * 1000) / real) / 10 : 0;
  out.profit = profit;
  out.net_est = profit.total;
  const st = JSON.parse((await env.DB.prepare("SELECT v FROM settings WHERE k='rev_scan'").first().catch(() => null))?.v || '{}');
  out.scan = { full_at: st.full_at || null, running: !!st.cursor, orders: rows.length, read: num(st.read) };
  return out;
}
