/**
 * Is this a real delivery address? Some customers paste a Google Maps link, a Plus Code or a URL their browser
 * autofilled; couriers cannot deliver to those (they come back as RTO). Used by the checkout, the WhatsApp
 * address form and the pre-pickup check. Returns the message to show, or '' when it looks like an address.
 */
const URLISH = /(https?:\/\/|www\.|maps\.app|goo\.gl|wa\.me|bit\.ly|\b[a-z0-9-]{2,}\.(?:com|net|org|app|io|ly|gl|link|me|in)(?:\/\S*)?(?=\s|,|$))/i;
const PLUS_CODE = /(^|[\s,])[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}(?=[\s,]|$)/i;
export function addressProblem(...parts) {
  const t = parts.filter(Boolean).map(String).join(' ').trim();
  if (URLISH.test(t)) return 'Please type your full address (house no, street, area, landmark). Links are not accepted, the courier needs the written address.';
  if (PLUS_CODE.test(t)) return 'Please type your full address (house no, street, area, landmark) instead of a map code.';
  if ((t.match(/\p{L}/gu) || []).length < 6) return 'Enter your full address (house no, street, area)';
  return '';
}
