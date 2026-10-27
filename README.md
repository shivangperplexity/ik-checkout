# ik-checkout — Ink Kulture custom checkout API

Serverless API behind the IK Express checkout on inkkulture.in (Vercel, Node 22, Neon Postgres).

## Layout
```
src/api/[[...slug]].js   Vercel entry: rebuilds /api/a/b paths, calls lib/app.js handle()
src/lib/app.js           all routes: quote, lead, track, order, payu return/status, wa webhook, admin, cron, shipping
src/lib/shopify.js       re-exports shopify.orig.js with the emoji address guard
src/lib/shopify.orig.js  Shopify Admin GraphQL: variants, draft order create/complete, tags, cancel, fulfil
src/lib/shipping.js      NimbusPost delivery estimate for the "Express shipping" row (Delhivery / Xpressbees)
src/lib/…                pricing, payu, meta (CAPI), whatsapp, settings, admin, db, util, address-guard
public/admin.html        admin dashboard
```

## Repository ↔ Vercel
Imported on 9 Oct 2026 from the Vercel production deployment `dpl_62UhNWEa5rtZCsjQGknvxXDCZBVt` (complete).
The Vercel project's **root directory is `src`** (package.json, vercel.json, api/, lib/, public/ live there).
Production deploys from `main`.

## Build 036d changes (this import)
- `/api/shipping?pin=&cod=` → NimbusPost estimate, one anonymous "Express shipping" option.
  NimbusPost login, pickup PIN (default 410206) and parcel weight are set in the admin dashboard →
  Settings → "Express shipping (NimbusPost)" (with a Test button); `NIMBUS_*` env vars work as a fallback.
- Orders created and completed with `sourceName: "web"` → attributed to the Online Store channel in Shopify
  Analytics; UTMs/landing page also written to the order note.
- Order attributes: PayU txn id (prepaid), promised delivery date, session id.
- Buyer validation accepts Shopify-style `first_name` / `last_name` from the Build 036 theme.

## WhatsApp via Go4WhatsUp (Oct 2026)
Sending switches from Meta direct to Go4WhatsUp as soon as `G4W_API_KEY` + `G4W_SECURE_KEY` are set; the Meta path stays as fallback.
- `lib/go4whatsup.js` transport (send by template `_id`, named variables, image header via `sendAttachmentWithVariable`), inbound parser.
- `lib/whatsapp.js` `fireTrigger`: design image + cart summary from the order/lead, signed `confirm`/`pay` links, abandoned-cart template rotation (per phone per day, pending variants fall back), STOP opt-out for marketing templates.
- `lib/wa-g4w.js` `/api/wa/g4w?k=<G4W_WEBHOOK_SECRET>` (button taps / replies, STOP/START), `/api/wa/act` one-tap confirm page (acts only on a tap, never on link previews), `autoCancelStale` (`COD_AUTOCANCEL_HOURS`, off by default).
- `lib/wa-convert.js` COD → prepaid: `/api/wa/pay` (PayU form, `COD_CONVERT_DISCOUNT`% off product subtotal), `/api/wa/paid` (claims once; Shopify order edit only committed if the edited total equals the payment, otherwise still marked paid and tagged `prepaid-needs-attention`), cron offer (`COD_CONVERT_HOURS`, off by default).
- Env: `G4W_API_KEY`, `G4W_SECURE_KEY`, `G4W_WEBHOOK_SECRET`, optional `WA_HEADER_IMAGE`, `COD_CONVERT_HOURS`, `COD_CONVERT_DISCOUNT`, `COD_AUTOCANCEL_HOURS`, `WA_LINK_SECRET`.

## Build 045: payment options + COD switch (Oct 2026)
- Checkout payment section redesigned (theme `src/ikx-js-3/4/5.liquid`, new `assets/ik-express-4.css`, `snippets/ik-checkout.liquid`
  loads it): one UPI card with Google Pay / PhonePe / Paytm tiles (tap = pay in that app), "All UPI apps", "Pay via UPI ID"
  (PayU page), black rows for Debit/Credit Cards and Netbanking (PayU opens on that method via `enforce_paymethod`),
  and Cash on delivery (select, then the footer button, as before) only when COD is on. Computers get "Scan QR" instead of tiles.
- Dashboard → Settings → **Cash on delivery** on/off (`settings.checkout.cod`, default on). Off: `/api/quote` sends
  `cod_on: false` (the checkout hides COD), and `/api/order` (COD and partial), `/api/otp/send` and `/api/cod-check` refuse COD,
  so older theme builds can't place COD orders either.

## Build 046: COD only for non-ad traffic (Oct 2026)
- Settings → Cash on delivery has three choices: **Everyone**, **Not for ad traffic**, **Off** (`settings.checkout.cod` + `cod_mode`).
- Ad traffic = `lib/attribution.js cameFromAd()`: this visit's link (utm_medium paid/cpc, `utm_content=Facebook_UA`, an fbclid that
  carries a Meta ad id, gclid), or for a direct visit the last link click the browser remembers (`localStorage.ik_click`, 30 days)
  or Meta's `_fbc` cookie. Instagram bio link, direct, Google search and WhatsApp links keep COD.
- The checkout now sends `attribution` with `/api/quote`, `/api/otp/send` and `/api/cod-check`; `/api/order` already did and enforces it.
  Orders from ads are tagged `from-ad` in Shopify.
- Theme: part 1 (remembers the last click, sends attribution with the quote) and part 4 (attribution on OTP / COD check).
