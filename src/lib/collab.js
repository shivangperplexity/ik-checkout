/**
 * Barter collabs: creators order through their own collection page (inkkulture.in/collections/creator-collab-…),
 * so an order whose attribution landing page is one of those is a barter collab, not a paid-ads customer.
 * The order is tagged barter-collab in Shopify and shows as "Barter collab" on the dashboard (no CAC in its profit).
 */
export const COLLAB_TAG = 'barter-collab';
const COLLAB_PATH = /\/collections\/creator-collab/i;

export function isCollab(landing) {
  return COLLAB_PATH.test(String(landing || ''));
}
