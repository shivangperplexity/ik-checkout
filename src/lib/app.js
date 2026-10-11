import { corsHeaders, allowedOrigins, json, cleanPhone, stateCode } from './util.js';
import { loadLines, createDraft, completeDraft, addTags, removeTags, cancelOrder } from './shopify.js';
import { priceCart, quoteBoth, rupees } from './pricing.js';
import { buildPayuForm, verifyResponse, upiIntent, verifyPayment } from './payu.js';
import { sendPurchase } from './meta.js';
import { sendText, verifySignature, parseReplies, parseStatuses, fireTrigger, logMsg } from './whatsapp.js';
import { withSettings } from './settings.js';
import { handleLogin, handleRpc, handleTrack, markSessionOrdered, afterOrderRisk, runAutomations } from './admin.js';
import { shippingEstimate } from './shipping.js';

const now = () => Math.floor(Date.now() / 1000);
const rand = () => Math.random().toString(36).slice(2, 8);

function clientOk(req, env) {
  return allowedOrigins(env).includes(req.headers.get('Origin') || '');
}

async function rateLimit(env, ip, max) {
  if (!env.DB) return true;
  const hr = Math.floor(Date.now() / 3600000);
  const r = await env.DB.prepare('INSERT INTO rl (ip,hr,n) VALUES (?,?,1) ON CONFLICT(ip,hr) DO UPDATE SET n=rl.n+1 RETURNING n').bind(ip, hr).first();
  return (r?.n || 1) <= max;
}

function cartLines(body) {
  const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 30).filter((l) => /^\d+$/.test(String(l.variant_id)));
  if (!lines.length) throw new Error('empty cart');
  return lines;
}

function applyUpsells(env, raw, lines) {
  const ups = env.SETTINGS?.upsells || [];
  lines.forEach((l, i) => {
    if (!raw[i].upsell) return;
    const u = ups.find((x) => x.enabled && String(x.variantId) === String(raw[i].variant_id));
    if (u) { l.upsellPct = u.pct || 0; l.isUpsell = true; }
  });
}

async function handleQuote(req, env) {
  const body = await req.json();
  const raw = cartLines(body);
  const lines = await loadLines(env, raw);
  applyUpsells(env, raw, lines);
  const q = quoteBoth(lines, {});
  const inCart = new Set(raw.map((l) => String(l.variant_id)));
  const upsells = (env.SETTINGS?.upsells || []).filter((u) => u.enabled && !inCart.has(String(u.variantId)) && q.cod.subtotal >= (u.minCart || 0) * 100)
    .map((u) => ({ variantId: u.variantId, title: u.title, image: u.image, price: Math.round(u.price * 100), pct: u.pct, headline: u.headline }));
  return json({ ok: true, lines: lines.map((l) => ({ title: l.title, qty: l.qty, unit: l.unit, upsell: !!l.isUpsell })), upsells, upi_logos: env.SETTINGS?.upi_logos || {}, ...q });
}

async function handleLead(req, env) {
  if (!env.DB) return json({ ok: true, db: !!env.DB });
  const b = await req.json();
  const phone = cleanPhone(b.phone);
  if (!phone) return json({ ok: false }, 400);
  const t = now();
  await env.DB.prepare(
    `INSERT INTO leads (phone,name,pincode,cart_json,utm_json,fbp,fbc,step,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'open',?,?)
     ON CONFLICT(phone) DO UPDATE SET name=excluded.name,pincode=excluded.pincode,cart_json=excluded.cart_json,utm_json=excluded.utm_json,
     fbp=excluded.fbp,fbc=excluded.fbc,step=excluded.step,status=CASE WHEN leads.status='ordered' AND ?<leads.updated_at+86400 THEN 'ordered' ELSE 'open' END,updated_at=excluded.updated_at`,
  )
    .bind(phone, String(b.name || '').slice(0, 80), String(b.pincode || '').slice(0, 6), JSON.stringify(b.lines || []).slice(0, 4000), JSON.stringify(b.utm || {}).slice(0, 1500), b.fbp || null, b.fbc || null, String(b.step || '').slice(0, 20), t, t, t)
    .run();
  return json({ ok: true, db: !!env.DB });
}

async function handlePincode(pin) {
  if (!/^\d{6}$/.test(pin)) return json({ ok: false }, 400);
  const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { cf: { cacheTtl: 86400, cacheEverything: true } });
  const d = await res.json().catch(() => null);
  const po = d?.[0]?.Status === 'Success' ? d[0].PostOffice?.[0] : null;
  if (!po) return json({ ok: false });
  return json({ ok: true, city: po.District, state: po.State });
}

function validateBuyer(b) {
  const phone = cleanPhone(b.phone);
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const pincode = String(b.pincode || '').trim();
  const address1 = String(b.address1 || '').trim();
  const city = String(b.city || '').trim();
  const state = String(b.state || '').trim();
  const email = String(b.email || '').trim();
  const err = !phone ? 'Enter a valid 10-digit mobile number'
    : name.length < 2 ? 'Enter your name'
    : !/^\d{6}$/.test(pincode) ? 'Enter a valid 6-digit PIN code'
    : address1.length < 5 ? 'Enter your full address'
    : !city ? 'Enter your city'
    : !stateCode(state) ? 'Select your state'
    : email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? 'Email looks wrong'
    : null;
  if (err) throw Object.assign(new Error(err), { user: true });
  /* Build 036 theme sends first_name / last_name (Shopify's field set) as well as the joined name. */
  let firstName = String(b.first_name || '').trim(), lastName = String(b.last_name || '').trim();
  if (!firstName) { const [f, ...rest] = name.split(' '); firstName = f; lastName = rest.join(' '); }
  return { phone, firstName, lastName, pincode, address1, address2: String(b.address2 || '').trim().slice(0, 120), city, state, email: email || null,
    edd: String(b.edd || '').trim().slice(0, 40), newsOptIn: !!b.news };
}

async function handleOrder(req, env, ctx) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
  if (!(await rateLimit(env, ip, 20))) return json({ ok: false, error: 'Too many attempts, please try again later' }, 429);
  const b = await req.json();
  const method = b.method === 'prepaid' ? 'prepaid' : 'cod';
  const idem = String(b.idem || '').slice(0, 64);
  if (!idem) return json({ ok: false, error: 'bad request' }, 400);

  const prior = env.DB && (await env.DB.prepare('SELECT * FROM orders WHERE idem=?').bind(idem).first());
  if (prior && prior.status !== 'failed') return json(await replayResponse(env, prior));

  let buyer;
  try { buyer = validateBuyer(b.buyer || {}); } catch (e) { return json({ ok: false, error: e.message }, 400); }

  const raw = cartLines(b);
  const lines = await loadLines(env, raw);
  applyUpsells(env, raw, lines);
  const price = priceCart(lines, method, {});
  const txnid = `IK${Date.now().toString(36)}${rand()}`.toUpperCase();
  const eventId = `ik_${txnid}`;
  const a = b.attribution || {};
  const attributes = [
    { key: 'Checkout', value: 'Ink Kulture custom' },
    { key: 'Payment choice', value: method === 'cod' ? 'COD' : 'Prepaid' },
    ...(method === 'prepaid' ? [{ key: 'PayU txn id', value: txnid }] : []),
    ...(buyer.edd ? [{ key: 'Promised delivery', value: buyer.edd }] : []),
    ...(a.sid ? [{ key: 'Session', value: String(a.sid).slice(0, 40) }] : []),
    ...['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'landing'].filter((k) => a[k]).map((k) => ({ key: k, value: String(a[k]).slice(0, 250) })),
  ];
  const tags = ['ik-checkout', method, ...(method === 'cod' ? ['cod-unconfirmed'] : [])];
  const draft = await createDraft(env, { lines, price, method, buyer, tags, attributes });
  if (Math.abs(draft.total - price.total) > 100) {
    console.error('total mismatch', { ours: price.total, shopify: draft.total, draft: draft.id });
    return json({ ok: false, error: 'Price changed, please reload your cart' }, 409);
  }

  const contents = lines.map((l) => ({ id: l.variantId.split('/').pop(), quantity: l.qty, item_price: Number(rupees(l.unit)) }));
  const row = {
    sid: String(a.sid || '').slice(0, 40), idem, txnid, eventId, draftId: draft.id, method, total: draft.total, buyer, a, contents,
    sourceUrl: String(a.landing || env.STORE_URL),
  };

  if (method === 'prepaid') {
    await saveOrder(env, row, null, 'pending_payment');
    const payu = await buildPayuForm(env, {
      txnid, amount: rupees(draft.total), productinfo: `Ink Kulture ${draft.name}`.slice(0, 100), firstname: buyer.firstName.slice(0, 60),
      email: buyer.email || `orders+${buyer.phone}@inkkulture.in`, phone: buyer.phone,
      surl: `${env.WORKER_URL}/api/payu/return`, furl: `${env.WORKER_URL}/api/payu/return`, udf1: draft.id.split('/').pop(),
    });
    let upi = null;
    if (b.upi) {
      try {
        const f = payu.fields;
        upi = await upiIntent(env, f, ip === 'unknown' ? '' : ip, req.headers.get('User-Agent'));
      } catch (e) { console.error('upi intent', e); }
    }
    return json({ ok: true, method, payu, upi, txnid });
  }

  const order = await completeDraft(env, draft.id, true);
  await saveOrder(env, row, order, 'placed');
  ctx.waitUntil(afterCod(env, req, row, order));
  return json({ ok: true, method, orderName: order.name, statusUrl: order.statusPageUrl, eventId, value: Number(rupees(draft.total)) });
}

async function saveOrder(env, r, order, status) {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO orders (idem,txnid,event_id,draft_id,order_id,order_gid,order_name,status_url,method,total_paise,phone,email,first_name,last_name,city,state_code,pincode,fbp,fbc,source_url,contents_json,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(idem) DO UPDATE SET txnid=excluded.txnid,event_id=excluded.event_id,draft_id=excluded.draft_id,order_id=excluded.order_id,order_gid=excluded.order_gid,order_name=excluded.order_name,status_url=excluded.status_url,total_paise=excluded.total_paise,status=excluded.status`,
  )
    .bind(r.idem, r.txnid, r.eventId, r.draftId, order?.legacyResourceId || null, order?.id || null, order?.name || null, order?.statusPageUrl || null, r.method, r.total, r.buyer.phone, r.buyer.email, r.buyer.firstName, r.buyer.lastName, r.buyer.city, stateCode(r.buyer.state), r.buyer.pincode, r.a.fbp || null, r.a.fbc || null, r.sourceUrl, JSON.stringify(r.contents), status, now())
    .run();
  await env.DB.prepare("UPDATE leads SET status='ordered', updated_at=? WHERE phone=?").bind(now(), r.buyer.phone).run();
  if (r.sid) await env.DB.prepare('UPDATE orders SET sid=? WHERE idem=?').bind(r.sid, r.idem).run();
}

async function replayResponse(env, p) {
  if (p.method === 'cod') return { ok: true, method: 'cod', orderName: p.order_name, statusUrl: p.status_url, eventId: p.event_id, value: p.total_paise / 100 };
  return { ok: false, error: 'This payment attempt is already in progress. Please reload and try again.' };
}

async function purchaseEvent(env, row, orderName, ip, ua) {
  return sendPurchase(env, {
    eventId: row.eventId || row.event_id, orderName, valuePaise: row.total ?? row.total_paise,
    phone: row.buyer?.phone ?? row.phone, email: row.buyer?.email ?? row.email, firstName: row.buyer?.firstName ?? row.first_name, lastName: row.buyer?.lastName ?? row.last_name,
    city: row.buyer?.city ?? row.city, stateCode: row.buyer ? stateCode(row.buyer.state) : row.state_code, pincode: row.buyer?.pincode ?? row.pincode,
    fbp: row.a?.fbp ?? row.fbp, fbc: row.a?.fbc ?? row.fbc, ip, ua, sourceUrl: row.sourceUrl ?? row.source_url,
    contents: row.contents ?? JSON.parse(row.contents_json || '[]'),
    numItems: (row.contents ?? JSON.parse(row.contents_json || '[]')).reduce((s, c) => s + c.quantity, 0),
  });
}

async function afterCod(env, req, row, order) {
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;
  const ua = req.headers.get('User-Agent');
  const results = await Promise.allSettled([
    purchaseEvent(env, row, order.name, ip, ua),
    fireTrigger(env, 'cod_confirm', { to: row.buyer.phone, vars: { name: row.buyer.firstName, order: order.name, total: rupees(row.total) }, orderId: order.legacyResourceId, orderName: order.name }),
    markSessionOrdered(env, row.sid, order.name),
  ]);
  results.forEach((r, i) => r.status === 'rejected' && console.error(['capi', 'whatsapp', 'session'][i], r.reason));
  await afterOrderRisk(env, { ...row, txnid: row.txnid }, order);
}

/** Shared by the PayU return and the status poll. `row` is the orders row; returns { ok, order_name, status_url } or { ok:false, why }. */
async function completePaid(env, ctx, req, row) {
  if (row.status === 'paid') return { ok: true, order_name: row.order_name, status_url: row.status_url };
  /* claim atomically so duplicate callbacks (browser, PayU server, poll) can't complete the draft twice */
  const claim = await env.DB.prepare("UPDATE orders SET status='completing' WHERE txnid=? AND status IN ('pending_payment','failed') RETURNING txnid").bind(row.txnid).first();
  if (!claim) {
    for (let i = 0; i < 8; i++) {
      await new Promise((res) => setTimeout(res, 800));
      const cur = await env.DB.prepare('SELECT * FROM orders WHERE txnid=?').bind(row.txnid).first();
      if (cur && cur.status === 'paid') return { ok: true, order_name: cur.order_name, status_url: cur.status_url };
    }
    return { ok: false, why: 'review' };
  }
  try {
    const order = await completeDraft(env, row.draft_id, false);
    await env.DB.prepare("UPDATE orders SET status='paid', order_id=?, order_gid=?, order_name=?, status_url=? WHERE txnid=?").bind(order.legacyResourceId, order.id, order.name, order.statusPageUrl, row.txnid).run();
    ctx.waitUntil(purchaseEvent(env, row, order.name, (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null, req.headers.get('User-Agent')).catch((e) => console.error('capi', e)));
    ctx.waitUntil(Promise.all([
      markSessionOrdered(env, row.sid, order.name),
      fireTrigger(env, 'prepaid_paid', { to: row.phone, vars: { name: row.first_name, order: order.name, total: rupees(row.total_paise) }, orderName: order.name }),
      afterOrderRisk(env, row, order),
    ]).catch((e) => console.error('post-paid', e)));
    return { ok: true, order_name: order.name, status_url: order.statusPageUrl };
  } catch (e) {
    console.error('PAID BUT ORDER NOT COMPLETED', row.txnid, row.draft_id, e);
    await env.DB.prepare("UPDATE orders SET status='paid_needs_attention' WHERE txnid=?").bind(row.txnid).run();
    return { ok: false, why: 'review' };
  }
}

async function handlePayuReturn(req, env, ctx) {
  const wantJson = new URL(req.url).searchParams.get('json') === '1'; /* in-page (PayU Bolt) flow */
  const form = await req.formData();
  const r = await verifyResponse(env, form);
  const fail = (why) => (wantJson ? json({ ok: false, why }) : Response.redirect(`${env.STORE_URL}/?ik_pay=${why}`, 303));
  if (!r) return fail('failed');
  const row = env.DB && (await env.DB.prepare('SELECT * FROM orders WHERE txnid=?').bind(r.txnid).first());
  if (!row) return fail('failed');
  const ok = (st) => (wantJson
    ? json({ ok: true, orderName: st.order_name, eventId: row.event_id, value: row.total_paise / 100, statusUrl: st.status_url || '' })
    : Response.redirect(`${env.STORE_URL}/?ik_paid=1&o=${encodeURIComponent(st.order_name)}&e=${encodeURIComponent(row.event_id)}&v=${row.total_paise / 100}&u=${encodeURIComponent(st.status_url || '')}`, 303));
  if (row.status === 'paid') return ok(row);
  if (r.status !== 'success' || r.amount !== rupees(row.total_paise)) {
    await env.DB.prepare("UPDATE orders SET status='failed' WHERE txnid=? AND status='pending_payment'").bind(r.txnid).run();
    return fail('failed');
  }
  const done = await completePaid(env, ctx, req, row);
  return done.ok ? ok(done) : fail(done.why);
}

/** Polled by the popup while the shopper pays in their UPI app. Trusts only PayU's own verify_payment answer. */
async function handlePayuStatus(req, env, ctx) {
  const b = await req.json().catch(() => ({}));
  const txnid = String(b.txnid || '').slice(0, 40);
  const row = txnid && env.DB && (await env.DB.prepare('SELECT * FROM orders WHERE txnid=?').bind(txnid).first());
  if (!row || row.method !== 'prepaid') return json({ ok: false, state: 'failed' });
  const reply = (st) => json({ ok: true, state: 'paid', orderName: st.order_name, eventId: row.event_id, value: row.total_paise / 100, statusUrl: st.status_url || '' });
  if (row.status === 'paid') return reply(row);
  const v = await verifyPayment(env, txnid).catch(() => null);
  if (!v || !['success', 'failure', 'failed', 'bounced', 'usercancelled', 'dropped'].includes(v.status)) return json({ ok: true, state: 'pending' });
  if (v.status !== 'success' || v.amount !== rupees(row.total_paise)) {
    await env.DB.prepare("UPDATE orders SET status='failed' WHERE txnid=? AND status='pending_payment'").bind(txnid).run();
    return json({ ok: true, state: 'failed' });
  }
  const done = await completePaid(env, ctx, req, row);
  return done.ok ? reply(done) : json({ ok: true, state: 'review' });
}

async function handleWa(req, env, ctx) {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    return url.searchParams.get('hub.verify_token') === env.WA_VERIFY_TOKEN ? new Response(url.searchParams.get('hub.challenge')) : new Response('forbidden', { status: 403 });
  }
  const raw = await req.text();
  if (!(await verifySignature(env, req, raw))) return new Response('bad signature', { status: 401 });
  const payload = JSON.parse(raw);
  const replies = parseReplies(payload);
  ctx.waitUntil(
    (async () => {
      for (const st of parseStatuses(payload)) await env.DB.prepare('UPDATE messages SET status=?, error=CASE WHEN ?<>\'\' THEN ? ELSE error END WHERE wamid=?').bind(st.status, st.error, st.error, st.id).run();
      /* Typed replies ("yes", "cancel", STOP) and buttons whose payload was lost go through the same safe rules as
         Go4WhatsUp: whole-message match only, applied to the order we last asked that number about. */
      const others = [];
      for (const e of payload.entry || []) for (const c of e.changes || []) for (const m of c.value?.messages || []) {
        const p = m.button?.payload || m.interactive?.button_reply?.id || '';
        if (/^(CONFIRM|CANCEL):/.test(p)) continue;
        const text = m.button?.text || m.interactive?.button_reply?.title || m.text?.body || '';
        const from = String(m.from || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
        if (text && /^\d{10}$/.test(from)) others.push({ from, text: String(text).slice(0, 300) });
      }
      if (others.length) { const { processInbound } = await import('./wa-g4w.js'); await processInbound(env, others); }
      const { applyAction } = await import('./wa-g4w.js');
      for (const rep of replies) {
        const row = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(rep.orderId).first();
        if (!row || row.method !== 'cod' || rep.from !== '91' + row.phone) continue;
        let result;
        try { result = await applyAction(env, row, rep.action); } catch (e) {
          await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'reply', template: rep.action, status: 'failed', orderName: row.order_name, error: String(e.message || e) });
          await sendText(env, rep.from, `We could not update order ${row.order_name} automatically. Our team will message you shortly.`);
          continue;
        }
        await env.DB.prepare('DELETE FROM wa_pending WHERE order_id=?').bind(String(rep.orderId)).run();
        await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'reply', template: rep.action, status: result, orderName: row.order_name });
        if (result === 'confirmed') await sendText(env, rep.from, `Thanks ${row.first_name}! Order ${row.order_name} is confirmed. We'll pack and ship it soon.`);
        else if (result === 'cancelled') await sendText(env, rep.from, `Order ${row.order_name} has been cancelled. You can order again anytime at inkkulture.in`);
        else if (result === 'already-confirmed') await sendText(env, rep.from, `Order ${row.order_name} is already confirmed. We'll ship it soon.`);
        else if (result === 'already-cancelled') await sendText(env, rep.from, `Order ${row.order_name} was already cancelled.`);
      }
    })().catch((e) => console.error('wa', e)),
  );
  return new Response('ok');
}

async function handleAdminLeads(req, env) {
  if (!env.ADMIN_TOKEN || req.headers.get('Authorization') !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: 'unauthorized' }, 401);
  const since = now() - 3 * 86400;
  const { results } = await env.DB.prepare("SELECT phone,name,pincode,cart_json,utm_json,step,updated_at FROM leads WHERE status='open' AND updated_at>? ORDER BY updated_at DESC LIMIT 500").bind(since).all();
  return json({ count: results.length, leads: results });
}

export async function handle(req, env0, ctx) {
  const url = new URL(req.url);
  let env = env0;
  if (env0.DB && url.pathname !== '/api/health') { try { env = await withSettings(env0); } catch (e) { console.error('settings', e); } }
  const path = url.pathname;
  const cors = corsHeaders(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  try {
    if (path === '/api/payu/return' && req.method === 'POST') {
      const pr = await handlePayuReturn(req, env, ctx);
      if (url.searchParams.get('json') === '1') Object.entries(cors).forEach(([k, v]) => pr.headers.set(k, v));
      return pr;
    }
    if (path === '/api/wa/webhook') return await handleWa(req, env, ctx);
    if (path === '/api/admin/leads') return await handleAdminLeads(req, env);
    if (path === '/api/admin/login' && req.method === 'POST') return await handleLogin(req, env);
    if (path === '/api/admin/rpc' && req.method === 'POST') return await handleRpc(req, env);
    if (path === '/api/health') return json({ ok: true, db: !!env.DB });
    if (path === '/api/cron') {
      if (!env.CRON_SECRET || req.headers.get('Authorization') !== `Bearer ${env.CRON_SECRET}`) return json({ error: 'unauthorized' }, 401);
      return json({ ok: true, ...(await runCron(env)) });
    }

    if (path.startsWith('/api/')) {
      if (!clientOk(req, env)) return json({ ok: false, error: 'forbidden' }, 403);
      let res;
      if (path === '/api/quote' && req.method === 'POST') res = await handleQuote(req, env);
      else if (path === '/api/lead' && req.method === 'POST') res = await handleLead(req, env);
      else if (path === '/api/track' && req.method === 'POST') res = await handleTrack(req, env);
      else if (path === '/api/order' && req.method === 'POST') res = await handleOrder(req, env, ctx);
      else if (path === '/api/payu/status' && req.method === 'POST') res = await handlePayuStatus(req, env, ctx);
      else if (path.startsWith('/api/pincode/')) res = await handlePincode(path.split('/').pop());
      else if (path === '/api/shipping' && req.method === 'GET') res = await shippingEstimate(req, env);
      else res = json({ error: 'not found' }, 404);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }
    return new Response('Not found', { status: 404 });
  } catch (e) {
    console.error('unhandled', path, e);
    return json({ ok: false, error: 'Something went wrong. Please try again.' }, 500, cors);
  }
}

export async function runCron(env0) {
  const env = await withSettings(env0);
  const cutoff = now() - 24 * 3600;
  const { results } = await env.DB.prepare("SELECT order_id FROM orders WHERE method='cod' AND status='placed' AND confirmed_at IS NULL AND flagged_at IS NULL AND created_at<?").bind(cutoff).all();
  for (const r of results) {
    await addTags(env, `gid://shopify/Order/${r.order_id}`, ['cod-unconfirmed-24h']);
    await env.DB.prepare('UPDATE orders SET flagged_at=? WHERE order_id=?').bind(now(), r.order_id).run();
  }
  await env.DB.prepare('DELETE FROM leads WHERE updated_at<?').bind(now() - 30 * 86400).run();
  await env.DB.prepare('DELETE FROM rl WHERE hr<?').bind(Math.floor(Date.now() / 3600000) - 24).run();
  const auto = await runAutomations(env);
  return { flagged: results.length, ...auto };
}