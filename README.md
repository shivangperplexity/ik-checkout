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
