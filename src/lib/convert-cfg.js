/* Pay-online offer settings (lib/wa-convert.js). Kept apart so settings.js can import the defaults without a cycle. */
/* minutes: how long the offer stays open. It goes out the moment the customer confirms their delivery address on
   WhatsApp (lib/wa-address.js); delay_min / hours only drive the old env (legacy) mode. */
export const CONVERT_DEFAULTS = { mode: 'off', pct: 20, minutes: 30, delay_min: 15, hours: 12, template: 'cod_prepaid_offer_v2' };
export function convertCfg(env) {
  const s = { ...CONVERT_DEFAULTS, ...(env.SETTINGS?.convert || {}) };
  /* the old env switch (unconfirmed COD only, after COD_CONVERT_HOURS) still works while the dashboard setting is off */
  const legacy = s.mode !== 'on' && Number(env.COD_CONVERT_HOURS || 0) > 0;
  return {
    mode: s.mode === 'on' ? 'on' : legacy ? 'legacy' : 'off',
    pct: Math.min(50, Math.max(1, Math.round(Number(s.mode === 'on' ? s.pct : env.COD_CONVERT_DISCOUNT || s.pct) || 20))),
    delay_min: legacy ? Number(env.COD_CONVERT_HOURS) * 60 : Math.max(0, Math.min(24 * 60, Number(s.delay_min) || 0)),
    hours: Math.max(1, Math.min(72, Number(s.hours) || 12)),
    minutes: legacy ? Math.max(1, Math.min(72, Number(s.hours) || 12)) * 60 : Math.max(5, Math.min(72 * 60, Math.round(Number(s.minutes) || CONVERT_DEFAULTS.minutes))),
    template: String(s.template || CONVERT_DEFAULTS.template),
  };
}
