// Emoji fix (8 Oct 2026): load the address guard before the Shopify client so
// customer names/addresses with emojis no longer make draftOrderCreate fail.
// The original Shopify code is unchanged in ./shopify.orig.js.
import './address-guard.js';
export * from './shopify.orig.js';
