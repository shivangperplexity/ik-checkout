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
// marketing:true = MARKETING category; never sent to a number that replied STOP.
export const TRIGGERS = {
  cod_confirm: { label: 'COD order confirmation', to: 'Customer', when: 'Right after a COD order is placed', vars: ['name', 'order', 'items', 'total', 'confirm'], buttons: true, media: true, env: 'WA_TEMPLATE', def: 'cod_order_confirm_v2', fallback: 'cod_order_confirm', on: true },
  cod_reminder: { label: 'COD reminder (not confirmed)', to: 'Customer', when: 'COD order still unconfirmed after 20h (checked every cron run)', vars: ['name', 'order', 'total'], buttons: true, def: 'cod_order_reminder', on: false },
  cod_to_prepaid: { label: 'Convert COD to prepaid (discount offer)', to: 'Customer', when: 'COD order still unconfirmed after COD_CONVERT_HOURS (off unless that env var is set)', vars: ['name', 'order', 'pct', 'newtotal', 'total', 'pay'], media: true, marketing: true, def: 'cod_to_prepaid', on: true },
  prepaid_paid: { label: 'Prepaid order confirmed', to: 'Customer', when: 'Right after a successful UPI / card payment', vars: ['name', 'order', 'total'], def: 'order_paid', on: true },
  order_shipped: { label: 'Order shipped', to: 'Customer', when: 'When you mark an order shipped in this dashboard', vars: ['name', 'order', 'courier', 'tracking'], def: 'order_shipped', on: false },
  abandoned_cart: { label: 'Abandoned checkout nudge', to: 'Customer (phone captured, no order)', when: '20 minutes after they left the checkout popup', vars: ['name', 'items', 'link'], media: true, marketing: true, def: 'checkout_reminder_offer', fallback: 'checkout_reminder_commitment', on: false,
    /* One of these is picked per phone per day. checkout_reminder_regret and checkout_reminder_overthink are
       approved too but left out (they lean on a how-long-it-lasts joke); add either name back to use them. */
    /* *_offer = tattoo photo + the B1G1 / 10%-prepaid offer line; *_img = photo only; plain = text only. A send walks
       offer -> img -> text while one is in review, or when a cart has no picture. */
    variants: ['checkout_reminder_offer', 'checkout_reminder_commitment_offer', 'checkout_reminder_ghosted_offer', 'checkout_reminder_softlaunch_offer', 'checkout_reminder_talkstage_offer', 'checkout_reminder_redflag_offer', 'checkout_reminder_maincharacter_offer', 'checkout_reminder_horoscope_offer', 'checkout_reminder_bluetick_offer', 'checkout_reminder_khanakhaya_offer', 'checkout_reminder_lostfound_offer', 'checkout_reminder_cliffhanger_offer'] },
  /* Shipment updates from NimbusPost tracking (lib/wa-ship.js, checked on the cron). */
  ship_picked: { label: 'Shipment picked up', to: 'Customer', when: 'Courier picks the parcel up (NimbusPost "Pickup Done")', vars: ['name', 'order', 'courier', 'edd', 'track'], def: 'ship_picked_up', on: true },
  ship_transit: { label: 'Shipment in transit', to: 'Customer', when: 'Moving through the courier network (6h+ after pickup)', vars: ['name', 'order', 'location', 'edd', 'track'], def: 'ship_in_transit', on: true },
  ship_ofd: { label: 'Out for delivery', to: 'Customer', when: 'Courier marks it out for delivery (once a day)', vars: ['name', 'order', 'track'], def: 'ship_out_for_delivery', on: true },
  ship_failed: { label: 'Delivery attempt failed (re-attempt)', to: 'Customer', when: 'Courier could not deliver; skipped if the customer refused / cancelled with OTP', vars: ['name', 'order', 'track'], def: 'ship_delivery_failed', on: true },
  admin_new_order: { label: 'New order alert', to: 'You (admin WhatsApp number)', when: 'Every new order', vars: ['order', 'total', 'method', 'risk'], def: 'admin_new_order', on: false },
  admin_high_risk: { label: 'High-risk order alert', to: 'You (admin WhatsApp number)', when: 'Order risk score is 65 or more', vars: ['order', 'risk', 'reasons'], def: 'admin_high_risk', on: false },
};
export const VAR_LABELS = { edd: 'Expected delivery date', location: 'Last scan city', track: 'Tracking link', name: 'Customer first name', order: 'Order number', total: 'Order total (Rs)', courier: 'Courier name', tracking: 'Tracking number', items: 'Items in cart', link: 'Checkout link', method: 'COD / Prepaid', risk: 'Risk score', reasons: 'Risk reasons',
  confirm: 'One-tap confirm link (automatic)', pay: 'Pay-online link (automatic)', pct: 'Prepaid discount %', newtotal: 'Total if paid online (Rs)', btnurl: 'Confirm link for a Dynamic URL button (automatic)' };

const DEFAULTS = {
  wa: { phone_id: '', token: '', waba_id: '', verify_token: '', app_secret: '', admin_phone: '', lang: 'en' },
  templates: {},
  upsells: [],
  upi_logos: { gpay: '', phonepe: '', paytm: '', any: '' },
  /* NimbusPost login for the "Express shipping" delivery estimate (Delhivery / Xpressbees from the pickup PIN). */
  shipping: { nimbus_email: '', nimbus_password: '', origin_pin: '410206', weight_g: 50,
    /* Rate comparison across carrier accounts (lib/rates.js) */
    shiprocket_email: '', shiprocket_password: '', nimbus_couriers: 'delhivery|xpress\\s*bees|xpressbees', shiprocket_couriers: '',
    policy: 'cheapest', tolerance_days: 2 },
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
    name: c.name || envName || t.def,
    lang: c.lang || env.WA_LANG || 'en',
    /* A saved list from before a template gained variables (e.g. cod_confirm without items/confirm) would
       send the wrong set, so a saved list is only used when it still covers every variable the template has. */
    vars: Array.isArray(c.vars) && c.vars.length && t.vars.every((v) => c.vars.includes(v)) ? c.vars : t.vars,
    /* Several approved templates saying the same thing in different voices; one is picked per recipient
       per day so a repeat abandoner is not sent the same line twice. */
    variants: Array.isArray(c.variants) && c.variants.length ? c.variants : (t.variants || []),
  };
}
