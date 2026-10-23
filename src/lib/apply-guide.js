/**
 * How-to-apply video on delivery. Most "it came out patchy" complaints are a skipped step, so the moment the courier
 * marks a dashboard-booked parcel delivered (lib/wa-ship.js), the customer gets a WhatsApp template with the video
 * as its header and the steps in the text. Once per order; parcels delivered more than 2 days before we noticed
 * are skipped (no late, confusing messages).
 *
 * The video is on YouTube (WhatsApp template headers need an uploaded .mp4, so the message carries the steps and a
 * "Watch how to apply" button to the video instead): Settings > How-to-apply video, else DEFAULT_VIDEO.
 */
export const APPLY_TEMPLATE = 'apply_guide_yt_v1';
export const DEFAULT_VIDEO = 'https://youtu.be/0GMHG7WmaL8';
const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

export const APPLY_TEXT = 'Hi {{1}}, your Ink Kulture order {{2}} has been delivered. Before you apply, tap below to watch the 1-minute how-to video: most patchy tattoos come from a skipped step.\n\n'
  + '1. Wipe the spot with the skin wipe and let it dry fully.\n2. Remove the clear film and place the tattoo face down.\n3. Dip the tissue magic coin in water and press it firmly over the paper for 30 seconds.\n4. Peel the paper off slowly from one corner.\n\n'
  + 'It is semi-permanent: it lasts 1-2 weeks depending on your skin type, and may last fewer days on sensitive skin. Reply here if you need any help.';

/** YouTube video id from any YouTube link (youtu.be/ID, watch?v=ID, shorts/ID, embed/ID). */
export function ytId(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([A-Za-z0-9_-]{11})/);
  return m ? m[1] : '';
}

/** Body with the steps, and a "Watch how to apply" button that opens youtu.be/<id> (the id is the button variable). */
export function applyTemplate() {
  return {
    name: APPLY_TEMPLATE, language: 'en', category: 'UTILITY', allow_category_change: true,
    components: [
      { type: 'BODY', text: APPLY_TEXT, example: { body_text: [['Riya', '#1663']] } },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Watch how to apply', url: 'https://youtu.be/{{1}}', example: ['https://youtu.be/0GMHG7WmaL8'] }] },
    ],
  };
}

/** The how-to video link (Settings > How-to-apply video, a YouTube link), else the Ink Kulture video. */
export function applyVideo(env) {
  const v = String(env.SETTINGS?.apply?.video || '').trim();
  return ytId(v) ? v : DEFAULT_VIDEO;
}

/** wa-ship.js: called when a tracking check shows delivered. Returns the updated `sent` map and whether to check again. */
export async function maybeSendApplyGuide(env, r, tr, sent) {
  if (sent.guide) return { sent, retry: false };
  const { triggerConfig } = await import('./settings.js');
  if (!triggerConfig(env, 'ship_delivered').enabled) return { sent, retry: false };
  const video = applyVideo(env);
  const at = Date.parse(String(tr?.delivered_date || '').replace(' ', 'T') + (/[zZ+]/.test(String(tr?.delivered_date || '')) ? '' : '+05:30'));
  if (Number.isFinite(at) && at / 1000 < now() - 2 * DAY) return { sent: { ...sent, guide: -now() }, retry: false };
  const { fireTrigger } = await import('./whatsapp.js');
  const res = await fireTrigger(env, 'ship_delivered', { to: r.phone, vars: { name: r.first_name || 'there', order: r.order_name, ytid: ytId(video) }, orderName: r.order_name });
  if (!res.ok && !res.skipped) return { sent: { ...sent, guide_fail: (sent.guide_fail || 0) + 1 }, retry: (sent.guide_fail || 0) < 3, failed: true };
  return { sent: { ...sent, guide: res.ok ? now() : -now() }, retry: false, ok: !!res.ok };
}
