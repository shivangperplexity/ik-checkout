import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceOf, fbclidApp } from './attribution.js';
import { normState } from './revenue.js';

const IG = 'PAZXh0bgNhZW0BMABwZG9mAmZkaWQWUQFbEPOpMsoDQGk-nXc9D1q6Mo4f9WFkaWQBqzhY-dG_InNydGMGYXBwX2lkDzEyNDAyNDU3NDI4NzQxNAABpzaItHSa56lqMaIqhwI2qmiRM_AdnlCGjCmoCTV_qXVKS9xyhBM6PxahtrcT_aem_n1HAVDTnWtlJnqdgK9OuWA';
const IG2 = 'PAZXh0bgNhZW0BMABwZG9mAmFkaWQBqzhY-dG_InNydGMGYXBwX2lkDzU2NzA2NzM0MzM1MjQyNwABpysxWGiPh-gdfdnLciQX3zxOuGwfN-uTrqhF7roNrR3Q_gthrh8AXHUJpzu5_aem_ze-z-nkpqj5nMiizsubu2Q';

test('the app inside an fbclid', () => {
  assert.equal(fbclidApp(IG), '124024574287414');
  assert.equal(fbclidApp(IG2), '567067343352427');
  assert.equal(fbclidApp('IwAR0abc'), '');
});
test('orders sorted by where they came from', () => {
  assert.equal(sourceOf({ utm_source: 'facebook', utm_medium: 'paid', utm_campaign: '120251631825560354', fbclid: IG }).label, 'Instagram ad');
  assert.equal(sourceOf({ utm_source: 'facebook', utm_medium: 'paid', fbclid: 'x' }).label, 'Meta ad');
  assert.equal(sourceOf({ utm_source: 'ig', utm_medium: 'social', utm_content: 'link_in_bio', utm_campaign: '120251631825560354', fbclid: IG2 }).label, 'Instagram bio link');
  assert.equal(sourceOf({ utm_source: 'whatsapp', utm_medium: 'nudge' }).label, 'WhatsApp cart reminder');
  assert.equal(sourceOf({ landing: 'https://www.inkkulture.in/?gclid=abc' }).label, 'Google ad');
  assert.equal(sourceOf({ utm_source: 'google', utm_medium: 'organic' }).label, 'Google search');
  assert.equal(sourceOf({ landing: 'https://www.inkkulture.in/products/x' }).label, 'Direct (no link data)');
  assert.equal(sourceOf({}).label, 'Not recorded');
  assert.equal(sourceOf({ fbclid: IG2 }).label, 'Instagram link');
});
test('state names', () => {
  assert.equal(normState('MAHARASHTRA'), 'Maharashtra');
  assert.equal(normState('', 'UP'), 'Uttar Pradesh');
  assert.equal(normState('Jammu and Kashmir'), 'Jammu and Kashmir');
});
