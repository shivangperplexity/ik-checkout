# Theme checkout sources (IK Express sheet)

`src/ikx-js-1..5.liquid` are the theme snippets `snippets/ikx-js-*.liquid` (one inline script split in five
because of snippet size), as uploaded to the Shopify theme. `build039-original/` is Build 039 before partial COD
(byte-identical to Build 038 / live at the time).

Partial COD (Oct 2026) changed parts 3, 4 and 5: COD tile / bill / button show "Pay ₹99 now, rest on delivery"
when `/api/quote` → `partial.mode` is `all`, or `check` and `/api/cod-check` says so for the typed address;
the order goes to `/api/order` with `method: 'partial'`, and the advance is paid through PayU Bolt (desktop)
or the chosen UPI app (phones).

Upload: themeFilesUpsert with body type URL pointing at the raw GitHub file of a commit (works for snippets too, as of
Build 045) or type TEXT, then compare each file's checksumMd5 with `md5sum src/ikx-js-*.liquid`.
Build 045 = Build 044 + `assets/ik-express-4.css`, `snippets/ik-checkout.liquid` (loads it), parts 3 and 4.

## Live reviews (Oct 2026)
`sections/ikl-live-reviews.liquid` ("IK — Live reviews") shows the reviews put "On website" in IK Checkout
(Reviews tab), loaded from `https://ik-checkout.vercel.app/api/review/list`; hidden until there is one to show.
Build 041 (live reviews) = Build 039 + this section on the home page (`ikl_live_reviews`, the old static
`ikl_reviews` kept but disabled) and on the product page (`ikl_pdp_live_reviews`, right under the main product).
To add it to another build: upload the section file, then add the section in the theme editor.
