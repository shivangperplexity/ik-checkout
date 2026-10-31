/**
 * Order-update templates with a delivery estimate (named variables, so adding one never shifts the others).
 *   cod_order_confirm_v3  COD placed, not yet confirmed: items, total, expected delivery + Yes / Cancel buttons
 *   cod_order_placed_v1   COD placed and already confirmed by OTP: items, total, expected delivery
 *   ship_booked_apply_v1  parcel booked: courier, pickup day, expected delivery, tracking link, how-to-apply steps
 *                         + "Watch how to apply" button (youtu.be/<id>)
 */
const STEPS = '1. Wipe the spot with the skin wipe and let it dry fully.\n2. Remove the clear film and place the tattoo face down.\n3. Dip the tissue magic coin in water and press it firmly over the paper for 30 seconds.\n4. Peel the paper off slowly from one corner.';
const named = (pairs) => ({ body_text_named_params: pairs.map(([param_name, example]) => ({ param_name, example })) });
const FOOT = { type: 'FOOTER', text: 'Ink Kulture · inkkulture.in' };

export const COD_CONFIRM_V3 = {
  name: 'cod_order_confirm_v3', language: 'en', category: 'UTILITY', parameter_format: 'NAMED',
  components: [
    { type: 'BODY', text: 'Hi {{name}}, thanks for ordering from Ink Kulture.\n\nOrder {{order}}\nDesign: {{items}}\nTotal: ₹{{total}} (Cash on Delivery)\nExpected delivery: {{edd}}\n\nPlease confirm your order so we can pack and ship it. Just tap a button below.\n\nUnconfirmed COD orders are cancelled automatically.',
      example: named([['name', 'Riya'], ['order', '#1663'], ['items', 'Snake x 1'], ['total', '399'], ['edd', 'Thu, 5 Nov']]) },
    FOOT,
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes, confirm' }, { type: 'QUICK_REPLY', text: 'No, cancel' }] },
  ],
};
export const COD_PLACED_V1 = {
  name: 'cod_order_placed_v1', language: 'en', category: 'UTILITY', parameter_format: 'NAMED',
  components: [
    { type: 'BODY', text: 'Hi {{name}}, your Ink Kulture order {{order}} is confirmed ✅\n\nDesign: {{items}}\nTotal: ₹{{total}} (Cash on Delivery)\nExpected delivery: {{edd}}\n\nWe will send you the tracking link as soon as it ships. Reply here if you need any help.',
      example: named([['name', 'Riya'], ['order', '#1663'], ['items', 'Snake x 1'], ['total', '399'], ['edd', 'Thu, 5 Nov']]) },
    FOOT,
  ],
};
export const SHIP_BOOKED_V1 = {
  name: 'ship_booked_apply_v1', language: 'en', category: 'UTILITY', parameter_format: 'NAMED',
  components: [
    { type: 'BODY', text: 'Hi {{name}}, your Ink Kulture order {{order}} is packed and booked with {{courier}} 📦\n\nPickup: {{pickup}}\nExpected delivery: {{edd}}\nTrack your parcel: {{track}}\n\nWhen it arrives, here is how to apply:\n' + STEPS + '\n\nTap below for the 1-minute how-to video.',
      example: named([['name', 'Riya'], ['order', '#1663'], ['courier', 'Delhivery'], ['pickup', 'Mon, 2 Nov'], ['edd', 'Fri, 6 Nov – Mon, 9 Nov'], ['track', 'https://www.shipprime.live/track-order?awb=42873516657070']]) },
    FOOT,
    { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Watch how to apply', url: 'https://youtu.be/{{1}}', example: ['https://youtu.be/0GMHG7WmaL8'] }] },
  ],
};
export const ALL = [COD_CONFIRM_V3, COD_PLACED_V1, SHIP_BOOKED_V1];
