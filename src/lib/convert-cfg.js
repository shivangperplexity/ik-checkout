/* Pay-online offer settings (lib/wa-convert.js). Kept apart so settings.js can import the defaults without a cycle. */
/* minutes: how long the offer stays open. It goes out the moment the customer confirms their delivery address on
   WhatsApp (lib/wa-address.js); delay_min / hours only drive the old env (legacy) mode. */
/* Nov 2026: `on` sends the offer `delay_min` (3) minutes after every plain COD order and keeps it open until the parcel
   is due to ship (auto-booking: the editing window, inside booking hours). `match`: the saving equals what paying
   online at checkout would have saved (the COD fee back + max(10%, ₹50) off the tattoos) instead of `pct`. */
export const CONVERT_DEFAULTS = { mode: 'off', pct: 20, minutes: 30, delay_min: 3, hours: 12, match: true, template: 'cod_prepaid_offer_v3' };
export function convertCfg(env) {
  const s = { ...CONVERT_DEFAULTS, ...(env.SETTINGS?.convert || {}) };
  /* the old env switch (unconfirmed COD only, after COD_CONVERT_HOURS) still works while the dashboard setting is off */
  const legacy = s.mode !== 'on' && Number(env.COD_CONVERT_HOURS || 0) > 0;
  return {
    mode: s.mode === 'on' ? 'on' : legacy ? 'legacy' : 'off',
    pct: Math.min(50, Math.max(1, Math.round(Number(s.mode === 'on' ? s.pct : env.COD_CONVERT_DISCOUNT || s.pct) || 20))),
    delay_min: legacy ? Number(env.COD_CONVERT_HOURS) * 60 : Math.max(1, Math.min(24 * 60, Number(s.delay_min) || 3)),
    hours: Math.max(1, Math.min(72, Number(s.hours) || 12)),
    minutes: legacy ? Math.max(1, Math.min(72, Number(s.hours) || 12)) * 60 : Math.max(5, Math.min(72 * 60, Math.round(Number(s.minutes) || CONVERT_DEFAULTS.minutes))),
    template: String(s.template || CONVERT_DEFAULTS.template),
    match: s.match !== false,
  };
}
