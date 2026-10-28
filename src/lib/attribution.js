/**
 * Where an order came from, read from what the custom checkout stores on every Shopify order (custom attributes:
 * utm_source / utm_medium / utm_content / utm_campaign / fbclid / landing). Pure.
 *
 * The Meta ad links carry utm_source=facebook even for Instagram placements, so the platform comes from the fbclid:
 * Meta packs the id of the app the click came from into it ("app_id" = Instagram or Facebook).
 */
const IG_APPS = new Set(['124024574287414', '567067343352427']);           /* Instagram (iOS / Android) */
const FB_APPS = new Set(['350685531728', '6628568379', '256002347743983']); /* Facebook Android / iOS, Messenger */

/** The Meta app id inside an fbclid, or '' */
export function fbclidApp(fbclid) {
  const b = String(fbclid || '').split('_aem_')[0];
  const i = b.indexOf('YXBwX2lk');                                   /* base64 of "app_id" */
  if (i < 0) return '';
  try {
    const s = Buffer.from(b.slice(i, i + 48).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
    return (/app_id.(\d{6,20})/.exec(s) || [])[1] || '';
  } catch { return ''; }
}
const metaPlatform = (fbclid, utmSource) => {
  const app = fbclidApp(fbclid);
  if (IG_APPS.has(app)) return 'Instagram';
  if (FB_APPS.has(app)) return 'Facebook';
  if (/^(ig|instagram)$/i.test(utmSource || '')) return 'Instagram';
  /* utm_source=facebook alone proves nothing: the store's Meta ad links say "facebook" for Instagram placements too */
  return 'Meta';
};

/**
 * attrs: { utm_source, utm_medium, utm_content, utm_campaign, fbclid, landing } (any may be missing)
 * Returns { key, label, detail }: key groups orders for the RTO table (e.g. 'ig_ad', 'ig_bio', 'direct').
 */
export function sourceOf(attrs = {}) {
  const a = Object.fromEntries(Object.entries(attrs || {}).map(([k, v]) => [String(k).toLowerCase(), String(v || '').trim()]));
  const landing = a.landing || '';
  const q = (k) => a[k] || (new RegExp('[?&]' + k + '=([^&#]*)', 'i').exec(landing) || [])[1] || '';
  const src = decodeURIComponent(q('utm_source')).toLowerCase(), med = decodeURIComponent(q('utm_medium')).toLowerCase(), content = decodeURIComponent(q('utm_content'));
  const fbclid = q('fbclid'), gclid = q('gclid') || q('gbraid') || q('wbraid');
  const campaign = q('utm_campaign');
  const paid = /paid|cpc|ppc|ads?$|^ad_|sponsored/.test(med);
  const detail = [src && `${src}${med ? '/' + med : ''}`, content, campaign && /^\d{6,}$/.test(campaign) ? 'campaign ' + campaign : campaign].filter(Boolean).join(' · ').slice(0, 160);

  if (/link_in_bio|bio/i.test(content) || (/^(ig|instagram)$/.test(src) && /bio/.test(med))) return { key: 'ig_bio', label: 'Instagram bio link', detail };
  if (/^(ig|instagram)$/.test(src) && med === 'dm') return { key: 'ig_dm', label: 'Instagram comment DM', detail };
  if (/^(ig|instagram|fb|facebook|meta|an|msg|messenger)$/.test(src) || (!src && fbclid)) {
    const p = metaPlatform(fbclid, src);
    if (paid || (/^\d{6,}$/.test(campaign) && !/social|organic/.test(med))) return { key: p.toLowerCase().slice(0, 2) + '_ad', label: p + ' ad', detail };
    return { key: p.toLowerCase().slice(0, 2) + '_organic', label: p + (src ? ' (organic)' : ' link'), detail };
  }
  if (/google/.test(src) || gclid) return paid || gclid ? { key: 'google_ad', label: 'Google ad', detail } : { key: 'google', label: 'Google search', detail };
  if (/whatsapp|^wa$/.test(src)) return /nudge|remind|cart|abandon/.test(med) ? { key: 'wa_reminder', label: 'WhatsApp cart reminder', detail } : { key: 'whatsapp', label: 'WhatsApp', detail };
  if (/youtube|^yt$/.test(src)) return { key: 'youtube', label: 'YouTube', detail };
  if (src) return { key: 'other_' + src.replace(/[^a-z0-9]/g, '').slice(0, 20), label: src.charAt(0).toUpperCase() + src.slice(1), detail };
  if (landing) return { key: 'direct', label: 'Direct (no link data)', detail: '' };
  return { key: 'unknown', label: 'Not recorded', detail: '' };
}

/** Shopify customAttributes [{key,value}] -> attrs object */
export const attrsOf = (list) => Object.fromEntries((list || []).map((x) => [String(x.key || '').toLowerCase(), String(x.value || '')]));

/** true when an fbclid was minted for an ad click: Meta packs the ad id ("adid") into it; organic links have none. */
export function fbclidIsAd(fbclid) {
  const b = String(fbclid || '').split('_aem_')[0].replace(/-/g, '+').replace(/_/g, '/');
  if (b.length < 12) return false;
  for (let off = 0; off < 4; off++) {
    try { if (/adid/.test(Buffer.from(b.slice(off), 'base64').toString('latin1'))) return true; } catch { /* next */ }
  }
  return false;
}

const AD_WINDOW = 30 * 864e5;
const isAdAttrs = (a) => /_ad$/.test(sourceOf(a).key) || fbclidIsAd(a.fbclid || (new RegExp('[?&]fbclid=([^&#]*)', 'i').exec(a.landing || '') || [])[1]) || /^facebook_ua$/i.test(String(a.utm_content || ''));
const hasClick = (a) => ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'fbclid', 'gclid'].some((k) => a[k]) || /[?&](utm_source|fbclid|gclid)=/i.test(a.landing || '');

/**
 * Did this shopper come from an ad? attrs = the checkout's attribution: this visit's utm_* / fbclid / landing, plus
 * `click` (the last link click the browser remembers, { utm_*, fbclid, gclid, at }) and `fbc` (Meta's _fbc cookie).
 * This visit decides when it came through a link; a direct visit (no link data) inherits the last click from the
 * past 30 days, so someone who clicked an ad and comes back by typing the address still counts as ad traffic.
 */
export function cameFromAd(attrs = {}, now = Date.now()) {
  const a = attrs || {};
  if (hasClick(a)) return isAdAttrs(a);
  const c = a.click && typeof a.click === 'object' ? a.click : null;
  if (c && hasClick(c) && now - Number(c.at || 0) < AD_WINDOW) return isAdAttrs(c);
  const m = /^fb\.\d\.(\d{10,13})\.(.+)$/.exec(String(a.fbc || ''));
  if (m && now - Number(m[1]) < AD_WINDOW && fbclidIsAd(m[2])) return true;
  return false;
}
