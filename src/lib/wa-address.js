/**
 * Address check after a COD order is confirmed on WhatsApp.
 *
 *  1. Customer taps "Yes, confirm" (or types yes).  -> sendAddressCheck(): the delivery address, read live from
 *     Shopify, with two reply buttons: "Address is correct" (ADDR_OK:<id>) and "Edit address" (ADDR_EDIT:<id>).
 *     The customer has just written to us, so this is a free service-window reply and needs no template.
 *  2. ADDR_OK   -> tag the Shopify order address-confirmed, say thanks, then the pay-online offer (30 min,
 *                  lib/wa-convert.js offerAfterAddress). A typed "correct" / "yes" / "sahi hai" right after the
 *                  question counts as ADDR_OK (Go4WhatsUp has no buttons; some people just type).
 *     ADDR_EDIT -> send a signed link to /api/wa/addr, a short prefilled form.
 *  3. The form writes the new address straight to the Shopify order (orderUpdate). Editing stops once the order
 *     is fulfilled or cancelled.
 *
 * The full address is only ever read from and written to Shopify. It is not stored in this app's database and
 * never goes into the message log (only city / state / PIN, which the orders table already keeps).
 */
import { orderDetail, addTags, gql } from './shopify.js';
import { withSettings } from './settings.js';
import { logMsg, sendText, viaG4w } from './whatsapp.js';
import { verifyAddr, linkShapeOk, addrLink } from './wa-token.js';
import { STATE_CODES, stateCode } from './util.js';
import { page, esc } from './wa-g4w.js';

const GRAPH = 'https://graph.facebook.com/v21.0';
const gidOf = (id) => `gid://shopify/Order/${id}`;

export const fmtAddress = (a) => [
  a.name,
  [a.address1, a.address2].filter(Boolean).join(', '),
  [a.city, [a.province, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
].filter(Boolean).join('\n');

/** Shopify still lets us change it: not cancelled, nothing shipped yet. */
export const editable = (o) => !!o && !o.cancelledAt && (!o.displayFulfillmentStatus || o.displayFulfillmentStatus === 'UNFULFILLED');

async function sendInteractive(env, phone91, interactive) {
  const res = await fetch(`${GRAPH}/${env.WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.WA_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone91, type: 'interactive', interactive }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error?.message || 'HTTP ' + res.status);
  return j.messages?.[0]?.id || '';
}

/** Step 1. Never throws; a failure is logged and the order stays confirmed. */
export async function sendAddressCheck(env, row) {
  try {
    const o = await orderDetail(env, row.order_id);
    const a = o?.shippingAddress;
    if (!a || !editable(o)) return { skipped: true };
    const text = `Delivery address for order ${row.order_name}:\n\n${fmtAddress(a)}\n\nIs this correct?`;
    let wamid = '';
    if (viaG4w(env)) {
      const link = await addrLink(env, row.order_id);
      await sendText(env, '91' + row.phone, text + `\n\nReply YES if it is correct.` + (link ? `\nNeed to change it? Open: ${link}` : ''));
    } else {
      wamid = await sendInteractive(env, '91' + row.phone, {
        type: 'button',
        body: { text: text.slice(0, 1024) },
        footer: { text: 'Ink Kulture' },
        action: { buttons: [
          { type: 'reply', reply: { id: `ADDR_OK:${row.order_id}`, title: 'Address is correct' } },
          { type: 'reply', reply: { id: `ADDR_EDIT:${row.order_id}`, title: 'Edit address' } },
        ] },
      });
    }
    await logMsg(env, { direction: 'out', phone: row.phone, trigger: 'address_check', template: 'address buttons', status: 'sent', orderName: row.order_name, wamid, preview: 'Asked the customer to confirm the delivery address' });
    return { ok: true };
  } catch (e) {
    await logMsg(env, { direction: 'out', phone: row.phone, trigger: 'address_check', status: 'failed', orderName: row.order_name, error: String(e.message || e) }).catch(() => {});
    return { ok: false };
  }
}

/** ADDR_OK:<id> / ADDR_EDIT:<id> from Meta's webhook payload. */
export function parseAddrReplies(payload) {
  const out = [];
  for (const e of payload.entry || []) for (const c of e.changes || []) for (const m of c.value?.messages || []) {
    const id = m.interactive?.button_reply?.id || m.button?.payload || '';
    const hit = /^ADDR_(OK|EDIT):(\d{1,25})$/.exec(id);
    if (hit) out.push({ action: hit[1], orderId: hit[2], from: String(m.from || '') });
  }
  return out;
}

/** Step 2. */
export async function handleAddressReply(env, rep) {
  const row = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(rep.orderId).first();
  if (!row || rep.from !== '91' + row.phone) return;
  const to = '91' + row.phone;
  try {
    if (rep.action === 'OK') {
      await addTags(env, gidOf(row.order_id), ['address-confirmed']).catch(() => {});
      await sendText(env, to, `Perfect, order ${row.order_name} will be delivered to this address. We'll message you when it ships.`);
      await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'address', template: 'ADDR_OK', status: 'address-confirmed', orderName: row.order_name });
      const { offerAfterAddress } = await import('./wa-convert.js');
      await offerAfterAddress(env, row.order_id);
      return;
    }
    const o = await orderDetail(env, row.order_id);
    if (!editable(o)) {
      await sendText(env, to, `Order ${row.order_name} has already been ${o?.cancelledAt ? 'cancelled' : 'packed for shipping'}, so the address can't be changed here. Reply with the correct address and our team will help.`);
      await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'address', template: 'ADDR_EDIT', status: 'too-late', orderName: row.order_name });
      return;
    }
    const link = await addrLink(env, row.order_id);
    await sendText(env, to, `Update the delivery address for order ${row.order_name} here:\n${link}\n\nIt takes 30 seconds. The link only works for this order.`);
    await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'address', template: 'ADDR_EDIT', status: 'link-sent', orderName: row.order_name });
  } catch (e) {
    await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'address', template: 'ADDR_' + rep.action, status: 'failed', orderName: row.order_name, error: String(e.message || e) }).catch(() => {});
  }
}

const TYPED_OK = /^\s*(?:yes|yess|yeah|ha+n?|haa?n ji|ji|ok|okay|okk|correct|right|sahi|sahi hai|haan sahi hai|bilkul|theek|thik|theek hai|thik hai|ye sahi hai|yes correct|yes it is|yes its correct|address (?:is )?(?:correct|right|ok|sahi|sahi hai|theek|thik)|correct address|yes address is correct)\s*[.!👍✅]*\s*$/i;

/**
 * A typed answer to the address question ("yes", "correct", "sahi hai") within 6 h of it, with no newer COD question
 * for another order and no answer yet: handled like the "Address is correct" button. Returns true when handled.
 */
export async function typedAddressOk(env, phone, text) {
  if (!TYPED_OK.test(String(text || ''))) return false;
  const now = Math.floor(Date.now() / 1000);
  const q = await env.DB.prepare("SELECT ts, order_name FROM messages WHERE phone=? AND trigger='address_check' AND status='sent' AND ts>? ORDER BY id DESC LIMIT 1").bind(String(phone), now - 6 * 3600).first().catch(() => null);
  if (!q) return false;
  const answered = await env.DB.prepare("SELECT 1 AS x FROM messages WHERE phone=? AND trigger='address' AND ts>=? LIMIT 1").bind(String(phone), Number(q.ts)).first().catch(() => null);
  if (answered) return false;
  const row = await env.DB.prepare('SELECT * FROM orders WHERE phone=? AND order_name=?').bind(String(phone), q.order_name).first();
  if (!row) return false;
  const newer = await env.DB.prepare('SELECT p.sent_at FROM wa_pending p JOIN orders o ON o.order_id = p.order_id WHERE p.phone=? AND p.order_id<>? AND o.confirmed_at IS NULL AND p.sent_at>?').bind(String(phone), String(row.order_id), Number(q.ts)).first().catch(() => null);
  if (newer) return false;
  await handleAddressReply(env, { action: 'OK', orderId: String(row.order_id), from: '91' + phone });
  return true;
}

/* ---------------- step 3: the form ---------------- */

const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bAnd\b/g, 'and');
/* One entry per state code; the longest name wins (e.g. "Dadra and Nagar Haveli and Daman and Diu"). */
const STATES = Object.entries(STATE_CODES).reduce((m, [n, c]) => { if (!m[c] || n.length > m[c].length) m[c] = n; return m; }, {});
const STATE_LIST = Object.entries(STATES).map(([code, n]) => ({ code, name: titleCase(n) })).sort((x, y) => x.name.localeCompare(y.name));

function form(orderId, sig, row, v, err = '') {
  const opt = STATE_LIST.map((s) => `<option value="${esc(s.name)}"${stateCode(v.state) === s.code ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  const f = (n, label, val, attrs = '') => `<label>${label}<input name="${n}" value="${esc(val || '')}" ${attrs}></label>`;
  return `<style>
  .card{text-align:left}form.addr{display:grid;gap:12px;margin-top:4px}
  form.addr label{display:grid;gap:5px;font-size:13px;font-weight:600}
  form.addr input,form.addr select{font:inherit;font-weight:400;padding:12px 14px;border:1px solid #cfc9c1;border-radius:12px;background:transparent;color:inherit;width:100%;box-sizing:border-box}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.err{color:#b42318;font-weight:600;margin:0 0 4px}
  @media(prefers-color-scheme:dark){form.addr input,form.addr select{border-color:#4a4642}form.addr select option{background:#1d1b19}}
</style>
${err ? `<p class="err">${esc(err)}</p>` : ''}
<form class="addr" method="POST" action="/api/wa/addr?o=${orderId}&s=${sig}">
  ${f('name', 'Full name', v.name, 'autocomplete="name" required minlength="2" maxlength="80"')}
  ${f('address1', 'House / flat, building, street', v.address1, 'autocomplete="address-line1" required minlength="5" maxlength="120"')}
  ${f('address2', 'Area, landmark (optional)', v.address2, 'autocomplete="address-line2" maxlength="120"')}
  <div class="two">${f('pincode', 'PIN code', v.pincode, 'inputmode="numeric" autocomplete="postal-code" required pattern="[0-9]{6}" maxlength="6" id="pin"')}${f('city', 'City', v.city, 'autocomplete="address-level2" required maxlength="60" id="city"')}</div>
  <label>State<select name="state" id="state" required><option value="">Select state</option>${opt}</select></label>
  <button class="y" type="submit">Save address</button>
</form>
<p style="margin:14px 0 0;font-size:13px;opacity:.6">Order ${esc(row.order_name)} · delivering to +91 ${esc(row.phone)}</p>
<script>
(function(){var pin=document.getElementById('pin'),city=document.getElementById('city'),st=document.getElementById('state');
pin.addEventListener('input',function(){var p=pin.value.replace(/\\D/g,'');if(p.length!==6)return;
fetch('/api/pincode/'+p).then(function(r){return r.json()}).then(function(d){if(!d||!d.ok)return;city.value=d.city||city.value;
var want=String(d.state||'').toLowerCase();for(var i=0;i<st.options.length;i++){if(st.options[i].value.toLowerCase()===want){st.selectedIndex=i;break}}}).catch(function(){})});})();
</script>`;
}

function readForm(raw) {
  const p = new URLSearchParams(raw);
  const g = (k, n) => String(p.get(k) || '').replace(/\s+/g, ' ').trim().slice(0, n);
  return { name: g('name', 80), address1: g('address1', 120), address2: g('address2', 120), pincode: g('pincode', 6), city: g('city', 60), state: g('state', 60) };
}
function validate(v) {
  return v.name.length < 2 ? 'Enter your full name'
    : v.address1.length < 5 ? 'Enter your house / flat and street'
    : !/^\d{6}$/.test(v.pincode) ? 'Enter a valid 6-digit PIN code'
    : !v.city ? 'Enter your city'
    : !stateCode(v.state) ? 'Select your state'
    : '';
}

export async function handleAddr(req, env0) {
  const url = new URL(req.url);
  const orderId = String(url.searchParams.get('o') || '');
  const sig = String(url.searchParams.get('s') || '');
  if (!linkShapeOk(orderId, sig) || !(await verifyAddr(env0, orderId, sig))) return page('Link not valid', 'Please use the link from your WhatsApp message.');
  const env = await withSettings(env0);
  const row = await env.DB.prepare('SELECT * FROM orders WHERE order_id=?').bind(orderId).first();
  if (!row) return page('Order not found', 'We could not find that order.');
  const name = esc(row.order_name);
  let o;
  try { o = await orderDetail(env, orderId); } catch (e) {
    console.error('addr detail', orderId, e.message);
    return page(`Order ${name}`, 'We could not load this order right now. Please try again in a minute.');
  }
  if (!editable(o)) return page(`Order ${name}`, o?.cancelledAt ? 'This order was cancelled.' : 'This order has already been packed for shipping, so the address can no longer be changed here. Reply on WhatsApp and our team will help.');
  const a = o.shippingAddress || {};
  const current = { name: a.name || [row.first_name, row.last_name].filter(Boolean).join(' '), address1: a.address1, address2: a.address2, pincode: a.zip, city: a.city, state: a.province };

  if (req.method !== 'POST') return page('Delivery address', `Check or update where order ${name} should be delivered.`, form(orderId, sig, row, current));

  const v = readForm(await req.text());
  const err = validate(v);
  if (err) return page('Delivery address', `Check or update where order ${name} should be delivered.`, form(orderId, sig, row, v, err));
  const [firstName, ...rest] = v.name.split(' ');
  const addr = { firstName, lastName: rest.join(' '), address1: v.address1, address2: v.address2, city: v.city, provinceCode: stateCode(v.state), zip: v.pincode, countryCode: 'IN', phone: a.phone || '+91' + row.phone };
  let saved;
  try {
    const d = await gql(env, 'mutation($input:OrderInput!){ orderUpdate(input:$input){ order{ id shippingAddress{ name address1 address2 city province zip } } userErrors{ field message } } }', { input: { id: gidOf(orderId), shippingAddress: addr } });
    const ue = d.orderUpdate?.userErrors || [];
    if (ue.length) throw Object.assign(new Error(ue.map((x) => x.message).join('; ')), { user: true });
    saved = d.orderUpdate.order.shippingAddress;
  } catch (e) {
    console.error('addr save', orderId, e.message);
    return page('Delivery address', `Check or update where order ${name} should be delivered.`, form(orderId, sig, row, v, e.user ? e.message : 'Could not save right now. Please try again.'));
  }
  await addTags(env, gidOf(orderId), ['address-edited-by-customer']).catch(() => {});
  await env.DB.prepare('UPDATE orders SET city=?, state_code=?, pincode=? WHERE order_id=?').bind(v.city, stateCode(v.state), v.pincode, orderId).run().catch(() => {});
  await sendText(env, '91' + row.phone, `Address updated for order ${row.order_name}. We'll deliver to:\n\n${fmtAddress(saved)}`).catch(() => {});
  await logMsg(env, { direction: 'in', phone: row.phone, trigger: 'address', template: 'form', status: 'address-updated', orderName: row.order_name, preview: `Address changed (PIN ${v.pincode})` }).catch(() => {});
  /* a corrected address is a confirmed address: the pay-online offer follows */
  try { const { offerAfterAddress } = await import('./wa-convert.js'); await offerAfterAddress(env, orderId); } catch (e) { console.error('addr offer', e.message); }
  return page('Address updated', `Order ${name} will be delivered to:<br><br>${esc(fmtAddress(saved)).replace(/\n/g, '<br>')}`, `<a class="btn n" href="/api/wa/addr?o=${orderId}&s=${sig}">Change again</a>`);
}
