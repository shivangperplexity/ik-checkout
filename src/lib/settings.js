import { DEFAULTS as PARTIAL } from './partial-cod.js';
import { META_DEFAULTS } from './meta.js';
import { NDR_DEFAULTS } from './ndr-rules.js';
import { CONVERT_DEFAULTS } from './convert-cfg.js';
import { cameFromAd } from './attribution.js';
// Dashboard-editable settings (stored in the settings table) layered over env vars.
//
// Variable names matter on the Go4WhatsUp path: they are sent as named key/value pairs and must match the
// variable names typed into their template designer, in {{1}}..{{n}} order (Meta maps by position).
// Special names, filled by fireTrigger itself (callers never pass them):
//   confirm  - signed one-tap link to /api/wa/act (confirm / cancel), built from orderId
//   pay      - signed prepaid-conversion link to /api/wa/pay, built from orderId
//   items    - cart summary from the Shopify order, or from the lead's saved cart
//   btnurl   - the confirm link again, for a Call-To-Action button whose URL Type is "Dynamic"
// media:true = the template has an image header: the first item's design, falling back to WA_HEADER_IMAGE.
// media:'video' = a video header: the how-to-apply video (lib/apply-guide.js).
// marketing:true = MARKETING category; never sent to a number that replied STOP.
export const TRIGGERS = {
  cod_confirm: { label: 'COD order confirmation', to: 'Customer', when: 'Right after a COD order is placed', vars: ['name', 'order', 'items', 'total', 'confirm'], buttons: true, media: true, env: 'WA_TEMPLATE', def: 'cod_order_confirm_v2', fallback: 'cod_order_confirm', on: true },
  cod_reminder: { label: 'COD reminder (not confirmed)', to: 'Customer', when: 'COD order still unconfirmed after 20h (checked every cron run)', vars: ['name', 'order', 'total'], buttons: true, def: 'cod_order_reminder', on: false },
  /* Pay-online offer (lib/wa-convert.js, Settings > Pay-online offer). cod_prepaid_offer uses named variables and a
     "Pay online" URL button to https://www.inkkulture.in/pages/pay?k={{1}} (paykey). The older cod_to_prepaid
     (link in the body, {{1}}..{{6}}) is the fallback while the new one is in review. */
  cod_to_prepaid: { label: 'Pay online before shipping (discount offer)', to: 'Customer', when: 'COD order, the moment the customer confirms their delivery address on WhatsApp; open for 30 minutes (Settings > Pay-online offer). Sent as a free in-chat button when the customer wrote in the last 23 h', vars: ['name', 'order', 'pct', 'newtotal', 'total', 'pay', 'hours', 'mins'], media: true, marketing: true, def: 'cod_prepaid_offer_v2', fallback: 'cod_prepaid_offer', replaces: ['cod_prepaid_offer', 'cod_to_prepaid'], urlParam: 'paykey', on: true },
  /* Partial COD (lib/partial-cod.js): by default the same approved "payment received" template, with total = the advance.
     Make a dedicated template (e.g. partial_cod_paid with name, order, total, balance) and select it here to mention the balance. */
  partial_paid: { label: 'Partial COD advance received', to: 'Customer', when: 'Right after the ₹99 (advance) is paid for a partial COD order', vars: ['name', 'order', 'total'], def: 'order_paid', on: true },
  prepaid_paid: { label: 'Prepaid order confirmed', to: 'Customer', when: 'Right after a successful UPI / card payment', vars: ['name', 'order', 'total'], def: 'order_paid', on: true },
  order_shipped: { label: 'Order shipped', to: 'Customer', when: 'When you mark an order shipped in this dashboard', vars: ['name', 'order', 'courier', 'tracking'], def: 'order_shipped', on: false },
  abandoned_cart: { label: 'Abandoned checkout nudge', to: 'Customer (phone captured, no order)', when: '20 minutes after they left the checkout popup', vars: ['name', 'items', 'link'], media: true, marketing: true, def: 'checkout_reminder_offer', fallback: 'checkout_reminder_commitment', on: false,
    /* One of these is picked per phone per day. checkout_reminder_regret and checkout_reminder_overthink are
       approved too but left out (they lean on a how-long-it-lasts joke); add either name back to use them. */
    /* *_offer = tattoo photo + the B1G1 / 10%-prepaid offer line; *_img = photo only; plain = text only. A send walks
       offer -> img -> text while one is in review, or when a cart has no picture. */
    variants: ['checkout_reminder_offer', 'checkout_reminder_commitment_offer', 'checkout_reminder_ghosted_offer', 'checkout_reminder_softlaunch_offer', 'checkout_reminder_talkstage_offer', 'checkout_reminder_redflag_offer', 'checkout_reminder_maincharacter_offer', 'checkout_reminder_horoscope_offer', 'checkout_reminder_bluetick_offer', 'checkout_reminder_khanakhaya_offer', 'checkout_reminder_lostfound_offer', 'checkout_reminder_cliffhanger_offer'] },
  /* Shipment updates from Shiprocket tracking (lib/wa-ship.js, checked on the cron). */
  ship_picked: { label: 'Shipment picked up', to: 'Customer', when: 'Courier picks the parcel up', vars: ['name', 'order', 'courier', 'edd', 'track'], def: 'ship_picked_up', on: true },
  ship_transit: { label: 'Shipment in transit', to: 'Customer', when: 'Moving through the courier network (6h+ after pickup)', vars: ['name', 'order', 'location', 'edd', 'track'], def: 'ship_in_transit', on: true },
  ship_ofd: { label: 'Out for delivery', to: 'Customer', when: 'Courier marks it out for delivery (once a day)', vars: ['name', 'order', 'track'], def: 'ship_out_for_delivery', on: true },
  /* Refused / cancelled at the door (lib/ndr-ask.js): "Do you still want it?" with [Yes, deliver it] [No, cancel order]. */
  ndr_refused: { label: 'Delivery refused: still want it?', to: 'Customer', when: 'Courier says the delivery was refused or cancelled at the door (NDR rule for "Refused" = Ask). Sent as free in-chat buttons when the customer wrote in the last 23 h', vars: ['name', 'order'], buttons: 'ndr', def: 'ndr_refused_check', on: true },
  /* NDR autopilot (lib/ndr-pilot.js). Inside the 24 h window these go as free in-chat messages with reply buttons;
     outside it as these templates (Settings > NDR rules > Submit to Meta). The URL button opens /api/wa/ndr?k={{1}}. */
  ndr_nudge: { label: 'NDR nudge: no answer yet', to: 'Customer', when: 'A failed delivery the customer has not answered after a few hours (NDR rules > Autopilot), 9 am to 9 pm', vars: ['name', 'order', 'items'], buttons: 'ndr', media: true, urlParam: 'ndrkey', def: 'ndr_nudge_v1', on: true },
  ndr_rescheduled: { label: 'NDR: delivery booked again', to: 'Customer', when: 'The NDR rules booked a re-attempt on their own: the day, the amount to pay, and a "Yes, I\'ll receive it" button', vars: ['name', 'order', 'when', 'amount'], buttons: 'ndr', urlParam: 'ndrkey', def: 'ndr_rescheduled_v1', on: true },
  ndr_last_attempt: { label: 'NDR: final delivery attempt', to: 'Customer', when: 'The re-attempt just booked is the last one the courier allows: says the parcel goes back and the order is cancelled if it fails', vars: ['name', 'order', 'when', 'amount'], buttons: 'ndr', urlParam: 'ndrkey', def: 'ndr_last_attempt_v1', on: true },
  ship_failed: { label: 'Delivery attempt failed (re-attempt)', to: 'Customer', when: 'Courier could not deliver; skipped if the customer refused / cancelled with OTP. The link lets the customer pick re-attempt (any day) or return; replying "re-attempt" / "return" works too', vars: ['name', 'order', 'track'], def: 'ship_delivery_failed', on: true },
  ship_delivered: { label: 'How-to-apply video (on delivery)', to: 'Customer', when: 'Right after the courier marks a parcel delivered (Shiprocket tracking), once per order. Steps + a button to the YouTube how-to video (WhatsApp tab > How-to-apply video)', vars: ['name', 'order'], urlParam: 'ytid', def: 'apply_guide_yt_v1', on: true },
  cod_cancel_warning: { label: 'COD not confirmed: cancel warning', to: 'Customer', when: '1 hour after a COD order that is still not confirmed (9 am to 9:30 pm). Says it is cancelled automatically if not confirmed within 48 hours; Yes / Cancel buttons', vars: ['name', 'order', 'total'], buttons: true, def: 'cod_cancel_warning_v1', fallback: 'cod_order_reminder', on: true },
  review_ask: { label: 'Review request', to: 'Customer', when: 'Once per customer, 3 days after the tracking shows the order delivered (Reviews tab), 10 am to 8 pm. The button opens the review page', vars: ['name', 'order'], urlParam: 'rtok', def: 'review_request_v1', on: true, marketing: true },
  /* Refer and earn (lib/referral.js). ref_invite: the customer's own code and link, once, 2+ days after their first
     delivered order (9 am - 9 pm). ref_credit: a friend paid for their order, ₹100 credit added. */
  ref_invite: { label: 'Refer and earn: your code', to: 'Customer', when: 'Once per customer, 2+ days after an order is delivered (9 am to 9 pm): their referral code and link (friends get ₹100 off on online payment, they get ₹100 credit as soon as the friend orders)', vars: ['name', 'code', 'link'], marketing: true, def: 'ik_refer_v2', on: true },
  ref_credit: { label: 'Refer and earn: credit added', to: 'Customer', when: 'A friend they referred paid for their order: ₹100 store credit added, valid 60 days (taken back if that order is cancelled or returned and the credit is unspent)', vars: ['name', 'amount', 'till'], def: 'ik_ref_credit_v2', on: true },
  /* Creator program (lib/creators.js): sent when you approve an application in More > Creators */
  support_reply: { label: 'Support request: receipt and team reply', to: 'Customer', when: 'A support request from the website track page, and your reply in Chats when 24 h have passed since their last WhatsApp', vars: ['name', 'ticket', 'reply'], def: 'ik_support_reply_v1', on: true },
  creator_approved: { label: 'Creator program: approved', to: 'Creator', when: 'You approve their application (More > Creators): their code and the login link', vars: ['name', 'code'], def: 'ik_creator_status_v5', replaces: ['ik_creator_welcome_v1', 'ik_creator_approved_v2', 'ik_creator_approved_v3', 'ik_creator_status_v4'], on: true },
  admin_new_order: { label: 'New order alert', to: 'You (admin WhatsApp number)', when: 'Every new order', vars: ['order', 'total', 'method', 'risk'], def: 'admin_new_order', on: false },
  admin_high_risk: { label: 'High-risk order alert', to: 'You (admin WhatsApp number)', when: 'Order risk score is 65 or more', vars: ['order', 'risk', 'reasons'], def: 'admin_high_risk', on: false },
};
export const VAR_LABELS = { mins: 'Pay-online offer: minutes it stays open', when: 'NDR: day of the next delivery attempt', amount: 'NDR: amount to pay at delivery', hours: 'Pay-online offer: hours it stays open', edd: 'Expected delivery date', location: 'Last scan city', track: 'Tracking link', name: 'Customer first name', order: 'Order number', total: 'Order total (Rs)', courier: 'Courier name', tracking: 'Tracking number', items: 'Items in cart', link: 'Checkout link', method: 'COD / Prepaid', risk: 'Risk score', reasons: 'Risk reasons',
  confirm: 'One-tap confirm link (automatic)', pay: 'Pay-online link (automatic)', pct: 'Prepaid discount %', newtotal: 'Total if paid online (Rs)', btnurl: 'Confirm link for a Dynamic URL button (automatic)', balance: 'Partial COD: amount to pay on delivery (Rs)' };

const DEFAULTS = {
  wa: { phone_id: '', token: '', waba_id: '', verify_token: '', app_secret: '', admin_phone: '', lang: 'en' },
  templates: {},
  upsells: [],
  upi_logos: { gpay: '', phonepe: '', paytm: '', any: '' },
  /* Checkout switches (Settings > Cash on delivery). cod: false hides Cash on delivery (and partial COD) for everyone.
     cod_mode 'organic' = COD only for shoppers who did not come from an ad (lib/attribution.js cameFromAd). */
  checkout: { cod: true, cod_mode: 'all' },
  /* Shiprocket login (API user) for booking, tracking and the "Express shipping" delivery estimate (lib/rates.js) */
  shipping: { origin_pin: '410206', weight_g: 50,
    shiprocket_email: '', shiprocket_password: '', shiprocket_couriers: '',
    /* couriers never used, whatever their price (names separated by | ; spaces ignored) */
    shiprocket_block: 'Blue Dart',
    policy: 'cheapest', tolerance_days: 2 },
  /* Expected-profit column on Orders > Shipped: product cost per item and customer acquisition cost per order (₹) */
  profit: { unit_cost: 40, cac: 80 },
  /* WhatsApp assistant (lib/wa-ai.js): answers plain-text customer messages. Provider groq (free) by default; key falls back to GROQ_API_KEY etc. */
  ai: { enabled: false, provider: 'groq', key: '', model: '', knowledge: '', rpm: 20, rpd: 800 },
  /* Partial COD: ₹99 online now, the rest on delivery (lib/partial-cod.js). mode off = full COD as before. */
  partial: { ...PARTIAL },
  /* Meta pixel for the Purchase events (lib/meta.js) */
  meta: { ...META_DEFAULTS },
  /* Automatic NDR rules (lib/ndr-rules.js) */
  ndr: structuredClone(NDR_DEFAULTS),
  /* Pay-online offer before shipping (lib/wa-convert.js) */
  convert: { ...CONVERT_DEFAULTS },
  /* How-to-apply video sent on delivery (lib/apply-guide.js) */
  apply: { video: '', bundled: false },
};

let cache = { at: 0, s: null };
export async function getSettings(env, fresh) {
  if (!env.DB) return structuredClone(DEFAULTS);
  if (!fresh && cache.s && Date.now() - cache.at < 15000) return cache.s;
  const rows = (await env.DB.prepare('SELECT k,v FROM settings').all()).results;
  const s = structuredClone(DEFAULTS);
  for (const r of rows) { try { s[r.k] = JSON.parse(r.v); } catch { /* ignore */ } }
  s.wa = { ...DEFAULTS.wa, ...s.wa };
  s.shipping = { ...DEFAULTS.shipping, ...(s.shipping || {}) };
  s.profit = { ...DEFAULTS.profit, ...(s.profit || {}) };
  s.ai = { ...DEFAULTS.ai, ...(s.ai || {}) };
  s.partial = { ...DEFAULTS.partial, ...(s.partial || {}) };
  s.meta = { ...DEFAULTS.meta, ...(s.meta || {}) };
  s.convert = { ...DEFAULTS.convert, ...(s.convert || {}) };
  s.apply = { ...DEFAULTS.apply, ...(s.apply || {}) };
  s.checkout = { ...DEFAULTS.checkout, ...(s.checkout || {}) };
  cache = { at: Date.now(), s };
  return s;
}
export async function putSetting(env, k, v) {
  await env.DB.prepare('INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, JSON.stringify(v)).run();
  cache = { at: 0, s: null };
}

/** env with WA_* filled from dashboard settings (dashboard wins when set). */
export async function withSettings(env) {
  const s = await getSettings(env);
  const w = s.wa;
  return Object.assign(Object.create(null), env, {
    WA_PHONE_ID: w.phone_id || env.WA_PHONE_ID, WA_TOKEN: w.token || env.WA_TOKEN, WA_VERIFY_TOKEN: w.verify_token || env.WA_VERIFY_TOKEN,
    WA_APP_SECRET: w.app_secret || env.WA_APP_SECRET, WA_LANG: w.lang || env.WA_LANG, WA_WABA_ID: w.waba_id || env.WA_WABA_ID, WA_ADMIN_PHONE: w.admin_phone || env.WA_ADMIN_PHONE,
    SETTINGS: s,
  });
}

export function triggerConfig(env, key) {
  const t = TRIGGERS[key];
  const c = (env.SETTINGS?.templates || {})[key] || {};
  const envName = t.env && env[t.env];
  return {
    enabled: c.enabled !== undefined ? !!c.enabled : (key === 'cod_confirm' ? !!(envName || c.name || true) : t.on),
    /* a saved older template this trigger has a newer version of moves to the new one (the old stays the fallback) */
    name: (c.name && !(t.replaces || []).includes(c.name) ? c.name : '') || envName || t.def,
    lang: c.lang || env.WA_LANG || 'en',
    /* A saved list from before a template gained variables (e.g. cod_confirm without items/confirm) would
       send the wrong set, so a saved list is only used when it still covers every variable the template has. */
    vars: Array.isArray(c.vars) && c.vars.length && t.vars.every((v) => c.vars.includes(v)) ? c.vars : t.vars,
    /* Several approved templates saying the same thing in different voices; one is picked per recipient
       per day so a repeat abandoner is not sent the same line twice. */
    variants: Array.isArray(c.variants) && c.variants.length ? c.variants : (t.variants || []),
  };
}

/** 'all' (everyone), 'organic' (not for ad traffic) or 'off' */
export function codMode(env) {
  const c = env.SETTINGS?.checkout || {};
  if (c.cod === false) return 'off';
  return c.cod_mode === 'organic' ? 'organic' : 'all';
}
/**
 * Cash on delivery offered to this shopper? attrs = the checkout's attribution, when the request carries it.
 * In 'organic' mode a request without attribution (older theme) is let through here; /api/order always has it.
 */
export function codOn(env, attrs) {
  const m = codMode(env);
  if (m === 'off') return false;
  if (m === 'organic' && attrs && cameFromAd(attrs)) return false;
  return true;
}
