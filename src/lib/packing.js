// src/lib/packing.js — works out the parcel (length x breadth x height cm, weight) for an order, automatically.
//
// Ink Kulture ships flat tattoos in envelopes and big (sleeve) designs in a roll:
//   Envelope A  6 x 4 inch    holds 2 tattoos   (any design that fits inside 15.24 x 10.16 cm)
//   Envelope B  7 x 12 inch   holds 3 tattoos   (any design that fits inside 17.78 x 30.48 cm)
//   Roll        15 x 15 x 10 cm, used when the order has a sleeve (or any design too big for envelope B)
// Parcel size = the biggest envelope + 2 cm on each side; height starts at 1 cm and grows 1 cm per extra envelope.
// More tattoos than one envelope holds -> the fewest envelopes, then the smallest total area.
//
// A design's size comes from the Shopify variant ("5.5 × 5.5 cm") and falls back to the size tag ("5.5x5.5cm").
// Nothing is stored per product: change the sizes in the dashboard and every order follows.

export const PACK_DEFAULTS = {
  env_a: [15.24, 10.16], cap_a: 2,          // 6 x 4 inch
  env_b: [17.78, 30.48], cap_b: 3,          // 7 x 12 inch
  pad_cm: 2, base_h_cm: 1, step_h_cm: 1,
  roll: [15, 15, 10],
  env_weight_g: 10, tattoo_weight_g: 15,
};

const IN = 2.54;
export function packCfg(s = {}) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  const d = PACK_DEFAULTS;
  return {
    env_a: [num(s.env_a_l, d.env_a[0]), num(s.env_a_b, d.env_a[1])], cap_a: Math.round(num(s.cap_a, d.cap_a)),
    env_b: [num(s.env_b_l, d.env_b[0]), num(s.env_b_b, d.env_b[1])], cap_b: Math.round(num(s.cap_b, d.cap_b)),
    pad_cm: Number.isFinite(Number(s.pad_cm)) && s.pad_cm !== '' && s.pad_cm != null ? Number(s.pad_cm) : d.pad_cm,
    base_h_cm: num(s.base_h_cm, d.base_h_cm), step_h_cm: num(s.step_h_cm, d.step_h_cm),
    roll: [num(s.roll_l, d.roll[0]), num(s.roll_b, d.roll[1]), num(s.roll_h, d.roll[2])],
    env_weight_g: Number.isFinite(Number(s.env_weight_g)) && s.env_weight_g !== '' && s.env_weight_g != null ? Number(s.env_weight_g) : d.env_weight_g,
    tattoo_weight_g: num(s.tattoo_weight_g, d.tattoo_weight_g),
  };
}
export { IN };

/** "5.5 × 5.5 cm" / "6x10cm" / "3 x 2 in" -> [w, h] in cm, or null */
export function parseSizeCm(...texts) {
  for (const t of texts) {
    const m = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(cm|mm|in|inch|inches|")?/i.exec(String(t || ''));
    if (!m) continue;
    let w = Number(m[1]), h = Number(m[2]);
    const u = (m[3] || 'cm').toLowerCase();
    if (u === 'mm') { w /= 10; h /= 10; } else if (u !== 'cm') { w *= IN; h *= IN; }
    if (w > 0 && h > 0) return [w, h];
  }
  return null;
}

const fits = (size, env) => {
  const [a, b] = [Math.max(...size), Math.min(...size)], [E, e] = [Math.max(...env), Math.min(...env)];
  return a <= E + 1e-9 && b <= e + 1e-9;
};

/**
 * items: [{ title, quantity, variantTitle, tags: [], weightG, sleeve? }]
 * -> { kind: 'envelope'|'roll', length, breadth, height, weight_g, weight_kg, envelopes: { a, b }, units, label }
 */
export function packOrder(items, cfgIn = {}) {
  const c = cfgIn.env_a && cfgIn.roll ? cfgIn : packCfg(cfgIn);
  let a = 0, b = 0, roll = false, grams = 0, units = 0;
  for (const it of items || []) {
    const q = Math.max(1, Math.round(Number(it.quantity) || 1));
    const size = parseSizeCm(it.variantTitle, ...(it.tags || []));
    const sleeve = it.sleeve || /sleeve/i.test(`${it.title || ''} ${(it.tags || []).join(' ')}`);
    const w = Number(it.weightG) > 0 ? Number(it.weightG) : c.tattoo_weight_g;
    units += q; grams += w * q;
    if (sleeve) { roll = true; continue; }
    if (!size || fits(size, c.env_a)) a += q;           // unknown size: assume the small envelope
    else if (fits(size, c.env_b)) b += q;
    else roll = true;                                    // too big for any envelope: it goes in a roll
  }
  if (roll) {
    const [l, br, h] = c.roll;
    return { kind: 'roll', length: l, breadth: br, height: h, weight_g: Math.round(grams), weight_kg: Math.max(0.01, Math.round(grams) / 1000), envelopes: { a: 0, b: 0 }, units, label: `Roll ${l} x ${br} x ${h} cm (sleeve in the order)` };
  }
  if (!a && !b) a = 1;                                   // empty/unknown: one small envelope
  /* fewest envelopes, then smallest total area. B-only designs need B slots; small designs can use any slot. */
  const total = a + b, areaA = c.env_a[0] * c.env_a[1], areaB = c.env_b[0] * c.env_b[1];
  let best = null;
  for (let nb = 0; nb <= total; nb++) for (let na = 0; na <= total; na++) {
    if (c.cap_b * nb < b || c.cap_a * na + c.cap_b * nb < total) continue;
    const key = [na + nb, na * areaA + nb * areaB];
    if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1] - 1e-9)) best = { na, nb, key };
  }
  const n = best.na + best.nb, big = best.nb > 0 ? c.env_b : c.env_a;
  const length = Math.round((Math.max(...big) + c.pad_cm) * 10) / 10, breadth = Math.round((Math.min(...big) + c.pad_cm) * 10) / 10;
  const height = Math.round((c.base_h_cm + (n - 1) * c.step_h_cm) * 10) / 10;
  const wt = Math.round(grams + n * c.env_weight_g);
  const parts = [best.nb ? `${best.nb} x 7x12 in` : '', best.na ? `${best.na} x 6x4 in` : ''].filter(Boolean).join(' + ');
  return { kind: 'envelope', length, breadth, height, weight_g: wt, weight_kg: Math.max(0.01, wt / 1000), envelopes: { a: best.na, b: best.nb }, units, label: `${parts} envelope${n > 1 ? 's' : ''} · ${length} x ${breadth} x ${height} cm` };
}
