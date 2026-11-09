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
Part 4 also has the code box under the bill ("Have a creator or referral code?"): it sets REF (creator code, a
friend's referral code or a creator credit voucher V…), re-quotes, and says "This code is not valid" when the API
gives it no value. Creator program: `src/lib/creators.js`, page `src/public/creator.html` (built from
`src/tools/creator.tpl.html` by `node src/tools/build-creator.mjs`).

## Build 051: track page, help chat, delivery date (Oct 2026)
`snippets/ik-site.liquid` (rendered at the end of `snippets/ik-checkout.liquid`, so on every page), talks to `/api/site/*`:
floating help chat (the WhatsApp assistant's knowledge, WhatsApp hand-off) + Instagram button that rise above the cart pill /
sticky add-to-cart; product page "Get it by <date> to <city>" from the visitor's IP location, with a PIN check (ShipPrime
date + one pickup day, lib/edd.js); `/pages/track` (page body `<div id="ik-track"></div>`): WhatsApp-code login, orders
with live courier scans, support requests (into the Chats tab, replies on WhatsApp), how-to-apply video and steps;
"Follow @inkkulture.in" strip above the footer. Parts 2 and 4: a PIN code neither ShipPrime nor Shiprocket delivers to is
shown in red and the order can't be placed (the server refuses it too).

## Build 053: pricing v2, landmark, track page cancel + FAQs (Nov 2026)
Parts 1-4: quotes and orders send `pv: 2` (server `pricingCfg`: online payment ₹50 or 10% off, whichever is more; ₹29 COD
fee; amounts from Settings > checkout `prepaid_flat` / `cod_fee`); quote cache key `ikx_qc2`; bill rows "Online payment
discount" / "COD fee"; COD tile "Incl. ₹29 COD fee · pay online, save ₹X". Address line 1 "House / flat no., street, area",
line 2 "Landmark" (required, min 3 letters); links (http, www, maps.app, goo.gl) refused in both.
`snippets/ik-site.liquid` track page: `?k=<signed order key>` (the "Track or cancel order" button / link in every WhatsApp
order message, lib/self-cancel.js) logs in to that order's number and highlights it; "Cancel order" until the courier picks
it up (COD: reason + WhatsApp code; paid online, or the code can't be sent: a cancellation request for the team, Home >
Cancellation requests); FAQs from `/api/site/config` (`faqs`) at the bottom.
Build 053 also: PIN code first in the delivery form with "Get it by <date> · Free delivery · Cash on delivery available"
under it (part 2 paintShip, `.ikx-pinedd`); city + state in one row after the address. OTP box: "Code not coming? Place
order, confirm on WhatsApp" after 25 s (part 4). A failed online payment shows "Pay by UPI QR / UPI ID" and "Cash on
delivery instead" buttons under the error (part 4 showErr).

## Build 056: pay-online sheet on COD, "add 1 more design" before paying (Nov 2026)
Built on Build 055 in place (the store has the 20-theme maximum, so no copy). Part 4 + `assets/ik-express-4.css`:
- Tapping the Cash on delivery tile opens a bottom sheet once per visit (`sessionStorage.ikx_codask`): "Save ₹X by paying
  online" (COD total minus online total), "Prepaid orders are packed and dispatched first", "No ₹29 COD fee"; UPI app tiles
  (phones) or "Pay ₹Y online" (computers) pay straight away; "Continue with Cash on delivery" keeps COD. Not shown after a
  failed payment ("Cash on delivery instead" pays directly). Events: `method` with data `codask` shown / online / cod / close.
- An odd number of tattoos (one more is free) brings back the Build 038 sheet once per page view before paying:
  "Wait! Add 1 more design, get it FREE" with designs that are really free (no dearer than the cheapest paid one).
  Events: `freeask` shown / skip (an add is the usual `pick`).
- Sold-out design in the cart (parts 1, 2): `/api/quote` now prices the rest and returns `sold_out: [{variant_id, title}]`
  (all sold out: 409 with `sold_out`); the sheet takes those lines out of the Shopify cart (`/cart/update.js`) and says
  "X just sold out, so we took it out of your cart" instead of falling back to "Checkout on Shopify". `/api/order` leaves
  sold-out lines out too (live for every theme as soon as the API deploys).

## Build 056 home hero: ad banners as slides (Nov 2026)
`templates/index.json`: slide 1 = "Real tattoo? Nope." (IK05 ad, desktop 2400x750 + mobile 1080x1440), slide 2 = the
existing Buy 1 Get 1 banner, slide 3 = the men's "Real tattoo? Nope. Semi-permanent." banner. Files in Shopify Files as
`ik-hero-*.jpg` (sources in `src/public/banners/`, composed from the studio photos + the ad typography; the ad's Anton-like
face is not installed, Poppins Bold Italic stands in). Scrim off: the banners carry their own contrast. The theme's own
"Shop now" button stays bottom-left on every slide, so the logo sits top-left in the banners.
- Sale countdown bar (`snippets/ikl-sale-timer.liquid`, rendered from `ik-checkout.liquid`, so on every page, moved to the
  top of `<body>`): "<Name> Buy 1 Get 1 Sale ends in d h m s". 7-day phases from 3 Nov 2026 00:00 IST, same for everyone:
  Diwali -> Christmas -> New Year -> Valentine's -> Holi -> Summer -> round again. Only the name and deadline roll; the
  offer never ends. Edit NAMES / START in the snippet.

## Blog engine (3 Nov)
- `blog_record {handle, topic, angle, audience}` logs a post published via the Shopify connector (body read from /blogs/news.atom); existing handle → updates topic/angle/audience.
- Writer prompt: link whitelist (collections only), no team members in personal stories, no invented specs/safety/medical claims, no minors. Audience/angle rotate least-used over last 20 posts.
- 10 posts published 3 Nov via connector (app still lacks write_content; add scope → engine runs 12/day itself).

## Meta quality signals (3 Nov)
- Delivered server event (dv_<order id>) per delivered parcel → custom conversion "Delivered" (1883860485911181, purchase-type). Switch ad sets to it + value optimisation once ≥50/week.
- Customer lists refreshed daily by cron: "IK - delivered + prepaid customers" (120252176487760354, seed) and "IK - RTO + cancelled (exclude)" (120252176490570354).
- Lookalike 1% IN of the seed: 120252176492810354. Both active ad sets (Winning reels - Nov, sales1) target the LAL (Advantage+ expands) and exclude the RTO list; 13 states excluded (Assam, J&K, Tripura, MP, Jharkhand, Telangana, Bihar, Haryana, Arunachal, Manipur, Mizoram, Nagaland, Sikkim).

## Ads autopilot + Blue Dart routing (3 Nov) — lib/ads-auto.js, lib/ship-watch.js
- Night: all delivering ad sets/CBO campaigns paused 23:00–06:00 IST, resumed after (meta.ads_night_off to disable; ads_night_from/to).
- Scale: 10–12 IST once a day, best ad set (confirmed-purchase CPA, ≥3 purchases) +₹100 if CPA ≤ 1.2× target, +₹50 if ≤ 1.5×; caps follow; hard ceiling meta.ads_ceiling (₹5,000/day default).
- Reels: 11–13 IST once a day, strongest recent reel (views ≥ 1.5× median of last 21 days, not already an ad) → ACTIVE ad in the best ad set; Meta rejections (music/policy) remembered. `ads_auto` action shows log; `{run:'reel'}` forces one.
- Blue Dart: COD to MH/GJ/DL/PB/AP/GA (shipping.bluedart_states) + RJ/MP/UP test until 16 Nov → Blue Dart when it quotes (fixed: the old test set pick to a string, so no courier preference ever reached ShipPrime). No auto-rebook on late pickup (owner's call, 3 Nov).

## Delivery credit messaging (3 Nov)
- ₹50 "COD order delivered" credit now for every delivered COD order (backfilled, one per order) and told on WhatsApp once per credit via trigger `dlv_credit` / template `ik_dlv_credit_v1` (UTILITY; 9–21 IST, ≤8 per 5-min run, pauses on WhatsApp rate limits). credits.told_at.
- `credit_gift {phone, rupees, reason}` adds a manual credit (ref_idem gift:…), told the same way. `credit_status` shows counts + template status.

## Build 058: store credit on COD, claimed with the WhatsApp code (3 Nov 2026)
- Parts 2 and 4. A number with store credit sees "Use your ₹50 store credit — enter the OTP" (same code box as COD). `/api/credit/verify` checks the code; verified numbers (cod_otps.verified_at ≤ 30 min) get credit on COD and online, and a COD order then needs no second code (server treats it as OTP-verified: confirmed, cod-otp-verified tag).
- Credit is never applied to an unverified number (nobody can spend credit by typing someone else's number). COD credit is spent at placement and returned if the order is cancelled / RTO (referralSweep).

## Build 060: UPI → COD in one tap, retry fix (4 Nov 2026)

- PayU's own records for the last week: almost every UPI app attempt ends "Transaction was marked as dropped"; about 2 a
  day go through. Buyers come back from GPay/PhonePe within seconds and sit on the "Approve in GPay" screen. That screen
  now has **"UPI not working? Cash on delivery"** (when COD is on and it isn't a partial-COD advance): it stops the UPI
  wait, selects COD and shows the cart, so they place the order with the usual WhatsApp OTP. Logged as
  `method {upi_to_cod}`.
- Build 059's click catcher also took the UPI screens' own "Try again" buttons (`data-ikx-retry`): after a UPI timeout
  the sheet stayed locked. 059's buttons now use `data-ikx-reload`; `data-ikx-retry` is back to the UPI screens.
- Retry events are logged with their reason (`fail {error: "retry:quote"}`) instead of an empty `{}`.

## Build 059: never fall back to Shopify's checkout (Nov 2026)
Built on Build 057 (MAIN at the time; Build 058 was not published). Parts 1 and 3 only (identical in 057 and 058).
Orders placed in Shopify's own checkout skip the WhatsApp OTP, the COD fee and tracking (#2039, #2071). When the cart or
the price can't load, part 1 now retries instead: `native()` retries, the old "Checkout on Shopify · ₹X" button is
relabelled "Loading price… tap to try again" (MutationObserver), the price is refetched on its own at 2 / 4 / 8 s, and
every retry is logged as a `fail` event `retry:<why>`. Part 3: the "pay on Shopify's checkout" note now says
"Getting your price… one moment". Tested headless with a quote API that always fails: no navigation to /checkout.

## Build 062: faster price loading (Nov 2026)

Build 061 + `src/ikx-js-1.liquid`: the /api/quote request has a 9 s deadline and retries once straight away (12 s)
before the "Try again" path shows. Made by updating the unpublished Build 060 copy (the store was at the 20-theme
limit), so it carries 061's `assets/ik-express-4.css` too.
