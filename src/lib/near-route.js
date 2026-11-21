/**
 * Nearby-area route (owner, 21 Nov 2026): Mumbai, Thane, Navi Mumbai, Panvel, Raigad, Pune and the PINs around them
 * go with Shiprocket Xpressbees DS for bulk and automatic booking. If Shiprocket can't book it (courier not offered,
 * wallet, API error), the order is booked with ShipPrime Delhivery Air instead.
 * Settings shipping.near_route { on (true), prefixes ([...NEAR_PREFIX]), courier (regex on the Shiprocket courier
 * name), fallback (ShipPrime courier code, 'DELHIVERY_AIR') }.
 */
/* 400 Mumbai / Navi Mumbai, 401 Thane-Palghar-Vasai, 402 Raigad, 410 Panvel / Raigad / Lonavala, 411-412 Pune,
   421 Kalyan-Dombivli-Bhiwandi-Ulhasnagar */
export const NEAR_PREFIX = ['400', '401', '402', '410', '411', '412', '421'];

export function nearCfg(env) {
  const c = env.SETTINGS?.shipping?.near_route || {};
  let re;
  try { re = new RegExp(c.courier || '^xpressbees\\b.*\\bds\\b', 'i'); } catch { re = /^xpressbees\b.*\bds\b/i; }
  return {
    on: c.on !== false,
    prefixes: Array.isArray(c.prefixes) && c.prefixes.length ? c.prefixes.map(String) : NEAR_PREFIX,
    courier: re,
    fallback: String(c.fallback || 'DELHIVERY_AIR').toUpperCase(),
  };
}

export const isNear = (cfg, pin) => !!cfg.on && /^\d{6}$/.test(String(pin || '').trim()) && cfg.prefixes.some((p) => String(pin).trim().startsWith(p));
