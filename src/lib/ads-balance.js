/**
 * Meta ad account money alert (Nov 2026): WhatsApp the owner (Settings → WhatsApp → admin phone) when what is left
 * to spend drops below `below` rupees (default ₹100). "Left" is the smaller of
 *   - the prepaid available balance (funding_source_details.display_string, e.g. "उपलब्ध शिल्लक (₹५९३.९६ INR)")
 *   - the room under the account spend cap (spend_cap - amount_spent; ads stop at the cap too).
 * One alert per drop: it re-arms once the money is back above the line. State: settings 'ads_balance'.
 */
const DEV = '०१२३४५६७८९';
const toAscii = (s) => String(s || '').replace(/[०-९]/g, (d) => String(DEV.indexOf(d)));
/** Rupees from a display string like "Available balance (₹1,234.56 INR)" in any Indian digits; null if none. */
export function parseAvailable(display) {
  const m = toAscii(display).replace(/,/g, '').match(/₹\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
}

export async function check(env, { below } = {}) {
  const { graph, adsCfg } = await import('./meta-ads.js');
  const c = adsCfg(env);
  if (!c.token) return { skipped: 'no ads token' };
  const limit = Number(below ?? env.SETTINGS?.meta?.balance_alert) || 100;
  const a = await graph(env, 'GET', c.account, { fields: 'is_prepay_account,funding_source_details,spend_cap,amount_spent,currency' });
  const prepaid = a.is_prepay_account ? parseAvailable(a.funding_source_details?.display_string) : null;
  const cap = Number(a.spend_cap) > 0 ? Math.max(0, (Number(a.spend_cap) - Number(a.amount_spent || 0)) / 100) : null;
  const vals = [prepaid, cap].filter((x) => x !== null && Number.isFinite(x));
  if (!vals.length) return { skipped: 'balance unknown', display: a.funding_source_details?.display_string || '' };
  const left = Math.min(...vals), why = left === prepaid ? 'prepaid balance' : 'account spend limit';
  const r = await env.DB.prepare("SELECT v FROM settings WHERE k='ads_balance'").first().catch(() => null);
  let st = {}; try { st = r ? JSON.parse(r.v) : {}; } catch { st = {}; }
  const save = (v) => env.DB.prepare("INSERT INTO settings (k, v) VALUES ('ads_balance', ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v").bind(JSON.stringify(v)).run();
  const out = { left: Math.round(left * 100) / 100, prepaid, cap_left: cap, why, limit, alerted: false };
  if (left >= limit) { if (st.low) await save({ low: false, at: Date.now() }); return out; }
  if (st.low) return { ...out, already: true };
  const admin = String(env.SETTINGS?.wa?.admin_phone || '').replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(admin)) return { ...out, err: 'no admin phone in Settings → WhatsApp' };
  const { sendText } = await import('./whatsapp.js');
  const msg = `⚠️ Meta ads: only ₹${out.left.toFixed(0)} left (${why}). Ads will stop soon. Add money: https://business.facebook.com/billing_hub/payment_settings?asset_id=${c.account.replace('act_', '')}`
    + (cap !== null && prepaid !== null ? `\nPrepaid ₹${prepaid.toFixed(0)} · spend limit room ₹${cap.toFixed(0)}` : '');
  try { await sendText(env, '91' + admin, msg); out.alerted = true; await save({ low: true, at: Date.now(), left: out.left }); }
  catch (e) { out.err = String(e.message || e).slice(0, 200); }
  return out;
}
