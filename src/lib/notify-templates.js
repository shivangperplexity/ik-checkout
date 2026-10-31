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
/* OTP already proved the phone, so no "confirm order" again: just the address and phone to check. */
export const COD_PLACED_V2 = {
  name: 'cod_order_placed_v2', language: 'en', category: 'UTILITY', parameter_format: 'NAMED',
  components: [
    { type: 'BODY', text: 'Hi {{name}}, your Ink Kulture order {{order}} is placed ✅\n\nDesign: {{items}}\nTotal: ₹{{total}} (Cash on Delivery)\nExpected delivery: {{edd}}\n\nDelivering to: {{address}}\nPhone: {{phone}}\n\nPlease check the address and phone number. If anything is wrong, tap Edit address.',
      example: named([['name', 'Riya'], ['order', '#1663'], ['items', 'Snake x 1'], ['total', '399'], ['edd', 'by Thu, 5 Nov'], ['address', 'Flat 5, Sai Residency, Sector 18, Ulwe, Navi Mumbai 410206'], ['phone', '98XXXXXX10']]) },
    FOOT,
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Address is correct' }, { type: 'QUICK_REPLY', text: 'Edit address' }] },
  ],
};
export const ADDRESS_FIX_V1 = {
  name: 'address_fix_v1', language: 'en', category: 'UTILITY', parameter_format: 'NAMED',
  components: [
    { type: 'BODY', text: 'Hi {{name}}, your Ink Kulture order {{order}} is packed and ready to ship, but the delivery address on it is a link or map code instead of a written address, so the courier cannot deliver it.\n\nPlease tap Edit address and type your full address (house no, street, area, landmark). We will send it out as soon as it is updated.',
      example: named([['name', 'Riya'], ['order', '#1663']]) },
    FOOT,
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Edit address' }] },
  ],
};
/* Nov 2026: every order message carries a "Track or cancel order" button to the inkkulture.in track page
   (lib/self-cancel.js trackLink: the button's {{1}} is the signed order key) */
const TRACK_BTN = { type: 'URL', text: 'Track or cancel order', url: 'https://www.inkkulture.in/pages/track?k={{1}}', example: ['https://www.inkkulture.in/pages/track?k=18983563919595.a1b2c3d4e5f6'] };
const withTrack = (t, name) => ({ ...t, name, components: t.components.map((c) => (c.type === 'BUTTONS' ? { ...c, buttons: [...c.buttons, TRACK_BTN] } : c)).concat(t.components.some((c) => c.type === 'BUTTONS') ? [] : [{ type: 'BUTTONS', buttons: [TRACK_BTN] }]) });
export const COD_CONFIRM_V4 = withTrack(COD_CONFIRM_V3, 'cod_order_confirm_v4');
export const COD_PLACED_V3 = withTrack(COD_PLACED_V2, 'cod_order_placed_v3');
export const ORDER_PAID_V2 = {
  name: 'order_paid_v2', language: 'en', category: 'UTILITY', parameter_format: 'NAMED',
  components: [
    { type: 'BODY', text: 'Hi {{name}}, payment received ✅ Your Ink Kulture order {{order}} is confirmed.\n\nDesign: {{items}}\nPaid: ₹{{total}}\nExpected delivery: {{edd}}\n\nWe will send the tracking link as soon as it ships. You can track or cancel the order (before it ships) from the button below.',
      example: named([['name', 'Riya'], ['order', '#1663'], ['items', 'Snake x 1'], ['total', '349'], ['edd', 'by Thu, 5 Nov']]) },
    FOOT,
    { type: 'BUTTONS', buttons: [TRACK_BTN] },
  ],
};
export const ALL = [COD_CONFIRM_V3, COD_PLACED_V1, SHIP_BOOKED_V1, COD_PLACED_V2, ADDRESS_FIX_V1, COD_CONFIRM_V4, COD_PLACED_V3, ORDER_PAID_V2];
