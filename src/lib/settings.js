// Dashboard-editable settings (stored in the settings table) layered over env vars.
export const TRIGGERS = {
  cod_confirm: { label: 'COD order confirmation', to: 'Customer', when: 'Right after a COD order is placed', vars: ['name', 'order', 'total'], buttons: true, env: 'WA_TEMPLATE', def: 'cod_order_confirm', on: true },
  cod_reminder: { label: 'COD reminder (not confirmed)', to: 'Customer', when: 'COD order still unconfirmed after 24h (checked every cron run)', vars: ['name', 'order', 'total'], buttons: true, def: 'cod_order_reminder', on: false },
  prepaid_paid: { label: 'Prepaid payment received', to: 'Customer', when: 'After a successful UPI / card payment', vars: ['name', 'order', 'total'], def: 'order_paid', on: false },
  order_shipped: { label: 'Order shipped', to: 'Customer', when: 'When you mark an order shipped in this dashboard', vars: ['name', 'order', 'courier', 'tracking'], def: 'order_shipped', on: false },
  abandoned_cart: { label: 'Abandoned checkout nudge', to: 'Customer (phone captured, no order)', when: '45 minutes after they left the checkout popup', vars: ['name', 'items', 'link'], def: 'checkout_reminder', on: false },
  admin_new_order: { label: 'New order alert', to: 'You (admin WhatsApp number)', when: 'Every new order', vars: ['order', 'total', 'method', 'risk'], def: 'admin_new_order', on: false },
  admin_high_risk: { label: 'High-risk order alert', to: 'You (admin WhatsApp number)', when: 'Order risk score is 65 or more', vars: ['order', 'risk', 'reasons'], def: 'admin_high_risk', on: false },
};
export const VAR_LABELS = { name: 'Customer first name', order: 'Order number', total: 'Order total (Rs)', courier: 'Courier name', tracking: 'Tracking number', items: 'Items in cart', link: 'Checkout link', method: 'COD / Prepaid', risk: 'Risk score', reasons: 'Risk reasons' };

const DEFAULTS = {
  wa: { phone_id: '', token: '', waba_id: '', verify_token: '', app_secret: '', admin_phone: '', lang: 'en' },
  templates: {},
  upsells: [],
  upi_logos: { gpay: '', phonepe: '', paytm: '', any: '' },
  /* NimbusPost login for the "Express shipping" delivery estimate (Delhivery / Xpressbees from the pickup PIN). */
  shipping: { nimbus_email: '', nimbus_password: '', origin_pin: '410206', weight_g: 50 },
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
    vars: Array.isArray(c.vars) && c.vars.length ? c.vars : t.vars,
  };
}
