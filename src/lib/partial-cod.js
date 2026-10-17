// src/lib/partial-cod.js — "Pay ₹99 now, rest on delivery" (partial cash on delivery).
//
// Settings (dashboard → Settings → Partial COD), stored as settings.partial:
//   mode      off    → every COD order is full cash on delivery (how it always worked)
//             test   → only the phone numbers in test_phones get partial COD (to try the flow on the live store)
//             risky  → partial COD only when a rule below fires; everyone else keeps full COD
//             all    → every COD order pays the advance online first
//   advance   rupees paid online (default 99); the rest is collected by the courier
//   rules     vague_address  no house / flat / plot / shop number, only a landmark or a lane ("mandir ke paas, gali no 5")
//             rto_pin        PIN codes where too many of our parcels came back (own Shiprocket history) or listed in `pins`
//             history        this phone number had a parcel returned (RTO) or cancelled a COD order before
//             high_value     COD orders at or above this many rupees (0 = off)
//
// How the order looks everywhere:
//   Shopify    created with orderCreate as PARTIALLY_PAID: a ₹99 PayU sale transaction, the balance outstanding,
//              tags cod + partial-cod (draftOrderComplete cannot record part of a payment on a non-Plus store).
//   IK orders  method 'cod', advance_paise = 9900, confirmed_at set (the advance is the commitment, no WhatsApp confirm needed).
//   Shiprocket booked as COD with sub_total = total − advance, so the courier collects only the balance (codDue below).

const now = () => Math.floor(Date.now() / 1000);

export const DEFAULTS = {
  mode: 'off', advance: 99, test_phones: '',
  vague_address: true, rto_pin: true, history: true, high_value: 0,
  pins: '', rto_rate: 35, rto_min: 2,
};

export function cfg(env) {
  const s = { ...DEFAULTS, ...(env.SETTINGS?.partial || {}) };
  s.mode = ['off', 'test', 'risky', 'all'].includes(s.mode) ? s.mode : 'off';
  s.advance = Math.max(1, Math.min(2000, Math.round(Number(s.advance) || 99)));
  return s;
}

/** What the courier must collect for this order, in paise. 0 = prepaid / already paid online. */
export function codDue(row) {
  if (!row || row.method !== 'cod' || row.converted_at || row.status === 'paid') return 0;
  return Math.max(0, Number(row.total_paise || 0) - Number(row.advance_paise || 0));
}

const phones = (s) => String(s || '').split(/[,;\n]+/).map((x) => x.replace(/\D/g, '').slice(-10)).filter((x) => x.length === 10);

/* ---------------- address check ---------------- */

/* Numbers that belong to the locality, not to the door: "gali no 5", "sector 15", "ward 7", "5th cross", "phase 2". */
const LOCALITY = /\b(gali|galli|gully|lane|ln|street|st|road|rd|marg|path|sector|sec|ward|phase|ph|block|blk|stage|zone|cross|main|chowk|km|nh|sh|highway|pin|pincode|post|po|vtc|tehsil|dist|district|village|vill|gaon|mohalla|colony|nagar|basti|camp)\b\.?\s*(no\.?|number|num|nbr|#)?\s*[-:.]?\s*\d+\s*[a-z]?\b/g;
const LOCALITY_REV = /\b\d+\s*[a-z]?\s*(no\.?|number|nbr|num)?\s*(gali|galli|gully|lane|sector|ward|block|phase|road|street|cross|main|stage|mohalla|colony)\b/g;
const ORDINAL = /\b\d+\s*(st|nd|rd|th)\s+(cross|main|road|lane|street|block|phase|sector|stage|gali|avenue)\b/g;
/* Landmark phrases are about what is nearby, so what they name never identifies the door. */
const NEAR_EN = /\b(near|nr|opp|opposite|behind|beside|besides|next\s+to|in\s+front\s+of|infront\s+of|close\s+to|adjacent\s+to|nearby)\b\.?(\s+[a-z0-9.'-]+){1,3}/g;
const NEAR_HI = /([a-z0-9.'-]+\s+){1,3}(ke|ki|k|ka)\s+(paas|pass|pas|samne|saamne|samane|piche|peeche|pichhe|bagal|nazdeek|najdik|nikat|aage|age|upar|niche)\b/g;
const DOOR_WORD = /\b(h\.?\s*no|hno|house\s*no|flat|flt|plot|room|rm|shop|door|d\.?\s*no|qtr|quarter|unit|khasra|khata|survey|apt|floor|flr)\b/;
/* A place that is itself the destination: a business, or a named house. */
const PLACE_WORD = /\b(shop|store|stores|dukan|office|clinic|hospital|school|college|bank|hotel|hostel|pg|company|pvt|ltd|llp|mall|showroom|salon|parlour|parlor|restaurant|cafe|factory|godown|warehouse|agency|traders|enterprises|medical|pharmacy|kirana|bhavan|bhawan|niwas|nivas|kothi|haveli|bungalow|bunglow|villa|mansion|sadan|kunj)\b/;
const BLOCK_WORD = /\b(apartment|apartments|appt|society|soc|chs|residency|heights|tower|towers|enclave|complex|building|bldg|wing)\b/;
const LANDMARK_WORD = /\b(near|nr|opp|opposite|behind|beside|paas|pass|samne|saamne|piche|peeche|bagal|nazdeek|mandir|masjid|church|gurudwara|temple|chowk|chauraha|tiraha)\b/;

/**
 * Is the delivery address missing the thing a courier needs at the door: a house / flat / plot / shop number,
 * or the name of the shop / office / house itself? Returns { vague, why, hint }.
 */
export function addressCheck(address1, address2 = '') {
  const raw = `${address1 || ''} ${address2 || ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
  const letters = raw.replace(/[^a-z]/g, '').length;
  if (letters + raw.replace(/\D/g, '').length < 8) return { vague: true, why: 'too_short', hint: 'Add your house / flat number, building and street' };
  let t = ` ${raw} `.replace(/\b\d{6}\b/g, ' ').replace(/\b[6-9]\d{9}\b/g, ' ');
  t = t.replace(NEAR_EN, ' ').replace(NEAR_HI, ' ');
  t = t.replace(ORDINAL, ' ').replace(LOCALITY_REV, ' ').replace(LOCALITY, ' ').replace(LOCALITY, ' ');
  if (/\d/.test(t)) return { vague: false, why: '' };
  if (PLACE_WORD.test(t)) return { vague: false, why: '' };
  if (DOOR_WORD.test(t)) return { vague: true, why: 'no_number', hint: 'Add the house / flat / shop number' };
  if (BLOCK_WORD.test(t)) return { vague: true, why: 'flat_missing', hint: 'Add your flat number and floor' };
  return { vague: true, why: LANDMARK_WORD.test(raw) ? 'landmark_only' : 'no_number', hint: 'Add your house / flat / shop number' };
}

/* ---------------- PIN code return rate (own Shiprocket history) ---------------- */

let pinCache = { at: 0, map: null };
/** { pin: { rto, delivered } } over the last 180 days of our own bookings. Cached 10 min per warm instance. */
export async function pinStats(env, fresh = false) {
  if (!fresh && pinCache.map && Date.now() - pinCache.at < 600000) return pinCache.map;
  const rows = (await env.DB.prepare(`SELECT o.pincode AS pin,
      SUM(CASE WHEN COALESCE(s.rto,FALSE) OR COALESCE(s.stage,'')='rto' THEN 1 ELSE 0 END) AS rto,
      SUM(CASE WHEN COALESCE(s.stage,'')='delivered' AND NOT COALESCE(s.rto,FALSE) THEN 1 ELSE 0 END) AS delivered
    FROM shipments s JOIN orders o ON o.order_id = s.order_id
    WHERE s.created_at > ? AND COALESCE(s.status,'') <> 'cancelled' AND o.pincode IS NOT NULL GROUP BY o.pincode`).bind(now() - 180 * 86400).all()).results;
  const map = {};
  for (const r of rows) map[String(r.pin)] = { rto: Number(r.rto) || 0, delivered: Number(r.delivered) || 0 };
  pinCache = { at: Date.now(), map };
  return map;
}

/** Why this PIN is risky, or ''. A listed PIN can be a full 6-digit code or a prefix (e.g. 8 or 845 = a whole region). */
export function pinRisk(c, pin, stats) {
  pin = String(pin || '');
  const listed = String(c.pins || '').split(/[\s,;]+/).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 1 && x.length <= 6);
  if (listed.some((p) => pin.startsWith(p))) return 'listed';
  const s = stats?.[pin];
  if (!s) return '';
  const done = s.rto + s.delivered;
  return s.rto >= Number(c.rto_min || 2) && done > 0 && (s.rto * 100) / done >= Number(c.rto_rate || 35) ? `rto ${s.rto}/${done}` : '';
}

/** High-return PIN codes for the dashboard: worst first. */
export async function riskyPins(env, c = cfg(env)) {
  const st = await pinStats(env, true);
  return Object.entries(st).map(([pin, s]) => ({ pin, ...s, rate: s.rto + s.delivered ? Math.round((s.rto * 100) / (s.rto + s.delivered)) : 0, flagged: !!pinRisk({ ...c, pins: '' }, pin, st) }))
    .filter((x) => x.rto > 0).sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.rto - a.rto || b.rate - a.rate).slice(0, 40);
}

async function phoneHistory(env, phone) {
  if (!/^\d{10}$/.test(String(phone || ''))) return '';
  const r = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM shipments s JOIN orders o ON o.order_id = s.order_id WHERE o.phone=? AND (COALESCE(s.rto,FALSE) OR COALESCE(s.stage,'')='rto')) AS rto,
      (SELECT COUNT(*) FROM orders WHERE phone=? AND method='cod' AND status='cancelled') AS cancelled`).bind(phone, phone).first();
  if (Number(r?.rto) > 0) return 'past_rto';
  if (Number(r?.cancelled) > 0) return 'past_cancel';
  return '';
}

const REASON_TEXT = {
  test: 'test number', all: 'partial COD is on for every order', vague_address: 'address has no house / flat / shop number',
  rto_pin: 'PIN code with many returns', past_rto: 'a parcel to this number was returned before', past_cancel: 'this number cancelled a COD order before',
  high_value: 'high COD value',
};
export const reasonText = (k) => REASON_TEXT[String(k).split(':')[0]] || k;

/**
 * Should this COD order pay the advance first? buyer: { phone, pincode, address1, address2 }, totalPaise: the COD total.
 * Returns { partial, advance (paise), balance (paise), reasons: [...], hint } — hint is shown to the shopper when
 * adding a door number to the address would be enough to drop the advance.
 */
export async function decide(env, buyer = {}, totalPaise = 0) {
  const c = cfg(env);
  const advance = c.advance * 100;
  const out = (reasons, hint = '') => {
    const partial = reasons.length > 0 && totalPaise > advance;
    return { partial, mode: c.mode, advance, balance: partial ? totalPaise - advance : 0, reasons: partial ? reasons : [], hint: partial ? hint : '' };
  };
  if (c.mode === 'off') return out([]);
  if (c.mode === 'all') return out(['all']);
  const phone = String(buyer.phone || '').replace(/\D/g, '').slice(-10);
  if (c.mode === 'test') return out(phones(c.test_phones).includes(phone) ? ['test'] : []);
  const reasons = [];
  let hint = '';
  if (c.vague_address && (buyer.address1 || buyer.address2)) {
    const a = addressCheck(buyer.address1, buyer.address2);
    if (a.vague) { reasons.push('vague_address:' + a.why); hint = a.hint; }
  }
  if (c.rto_pin && /^\d{6}$/.test(String(buyer.pincode || ''))) {
    const r = pinRisk(c, buyer.pincode, env.DB ? await pinStats(env).catch(() => ({})) : {});
    if (r) reasons.push('rto_pin:' + r);
  }
  if (c.history && env.DB) { const h = await phoneHistory(env, phone).catch(() => ''); if (h) reasons.push(h); }
  if (Number(c.high_value) > 0 && totalPaise >= Number(c.high_value) * 100) reasons.push('high_value');
  /* Only the address can be fixed by the shopper; with any other reason the hint would not lift the advance. */
  return out(reasons, reasons.length === 1 && reasons[0].startsWith('vague_address') ? hint : '');
}

/** What /api/quote tells the checkout: 'off' (never), 'all' (always) or 'check' (ask /api/cod-check with the address). */
export function quoteFlag(env) {
  const c = cfg(env);
  return { mode: c.mode === 'off' ? 'off' : c.mode === 'all' ? 'all' : 'check', advance: c.advance * 100 };
}
