/**
 * How-to-apply video on delivery. Most "it came out patchy" complaints are a skipped step, so the moment the courier
 * marks a dashboard-booked parcel delivered (lib/wa-ship.js), the customer gets a WhatsApp template with the video
 * as its header and the steps in the text. Once per order; parcels delivered more than 2 days before we noticed
 * are skipped (no late, confusing messages).
 *
 * The video: Settings > How-to-apply video (a public https link to an .mp4 under 16 MB), else the file shipped
 * with this app at /media/how-to-apply.mp4 when present.
 */
export const APPLY_TEMPLATE = 'apply_guide_v1';
const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

export const APPLY_TEXT = 'Hi {{1}}, your Ink Kulture order {{2}} has been delivered. Before you apply, watch this short video: most patchy tattoos come from a skipped step.\n\n'
  + '1. Wipe the spot with the skin wipe and let it dry fully.\n2. Remove the clear film and place the tattoo face down.\n3. Dip the tissue magic coin in water and press it firmly over the paper for 30 seconds.\n4. Peel the paper off slowly from one corner.\n\n'
  + 'It is semi-permanent: it lasts 1-2 weeks depending on your skin type, and may last fewer days on sensitive skin. Reply here if you need any help.';

export function applyTemplate() {
  return {
    name: APPLY_TEMPLATE, language: 'en', category: 'UTILITY', allow_category_change: true,
    components: [
      { type: 'HEADER', format: 'VIDEO' },
      { type: 'BODY', text: APPLY_TEXT, example: { body_text: [['Riya', '#1663']] } },
    ],
  };
}

/** The video link to send, or '' when none is set up yet. */
export function applyVideo(env) {
  const s = env.SETTINGS || {};
  const v = String(s.apply?.video || '').trim();
  if (/^https:\/\//.test(v)) return v;
  if (s.apply?.bundled) return String(env.WORKER_URL || '').replace(/\/$/, '') + '/media/how-to-apply.mp4';
  return '';
}

/** wa-ship.js: called when a tracking check shows delivered. Returns the updated `sent` map and whether to check again. */
export async function maybeSendApplyGuide(env, r, tr, sent) {
  if (sent.guide) return { sent, retry: false };
  const { triggerConfig } = await import('./settings.js');
  if (!triggerConfig(env, 'ship_delivered').enabled) return { sent, retry: false };
  const video = applyVideo(env);
  if (!video) return { sent, retry: false }; /* set up later: parcels delivered meanwhile are not chased */
  const at = Date.parse(String(tr?.delivered_date || '').replace(' ', 'T') + (/[zZ+]/.test(String(tr?.delivered_date || '')) ? '' : '+05:30'));
  if (Number.isFinite(at) && at / 1000 < now() - 2 * DAY) return { sent: { ...sent, guide: -now() }, retry: false };
  const { fireTrigger } = await import('./whatsapp.js');
  const res = await fireTrigger(env, 'ship_delivered', { to: r.phone, vars: { name: r.first_name || 'there', order: r.order_name, video }, orderName: r.order_name });
  if (!res.ok && !res.skipped) return { sent: { ...sent, guide_fail: (sent.guide_fail || 0) + 1 }, retry: (sent.guide_fail || 0) < 3, failed: true };
  return { sent: { ...sent, guide: res.ok ? now() : -now() }, retry: false, ok: !!res.ok };
}
