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

## Build 047: product page fits Android phones (Oct 2026)
`assets/ikl-fit.css` (loaded from `snippets/ik-checkout.liquid`, which is on every page). On 360px Android phones the product
page was 48px wider than the screen (up to 131px with a larger phone font, which Instagram / Facebook in-app browsers apply),
because `.ikl-pdp` / `.ikl-gallery` / `.ikl-buy` used `1fr` columns that cannot shrink below their content. All columns are
now `minmax(0, 1fr)` and long words wrap. Checked in headless Chrome at 360 / 393 / 412px with text at 100 / 115 / 130%:
before, every product page overflowed; after, none do.

## Build 048: State field (Oct 2026)
Part 2: the empty "State" option is now `disabled selected`. It was only `disabled`, so browsers picked the first state
(Andaman and Nicobar), showed it under the floating "State" label (overlapping text) and could submit it unpicked.

## Build 049: quick links bar on the home page (Oct 2026)
`sections/ikl-quick-links.liquid` ("IK — Quick links bar"): black strip with All Tattoos · Best Sellers · New Arrivals
(blocks, editable in the theme editor), phones only, placed first on the home page above the banner
(`templates/index.json` = build042/index.json + `ikl_quick_links`). There is no New Arrivals collection, so that link is
all-tattoos sorted newest first. Fits one line from 360px; narrower phones scroll it sideways.

## Build 050: refer and earn (Oct 2026)
Parts 1-4. `?ref=CODE` on any page is kept 30 days (`localStorage.ik_ref`) and sent as `attribution.ref` with every
quote and order; the quote cache key includes it. `/api/quote` returns `prepaid.ref` (₹100 off online payment only)
and `ref: { code, name }`. Once a valid number is in the form (typed or remembered), `/api/ref/me` says whether the
code applies (first order only) and the number's store credit; `refApply` (part 2) folds both into the online-payment
price. The bill shows "Referral (name)" / "Store credit" rows; the COD tile says how much paying online saves.
The server (`lib/referral.js`) re-checks everything at `/api/order`.
