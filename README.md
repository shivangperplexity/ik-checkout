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

## Status of this repository
Imported on 9 Oct 2026 from the Vercel production deployment `dpl_62UhNWEa5rtZCsjQGknvxXDCZBVt`.
The following files still need to be copied in from Vercel → Deployments → latest → **Source**
(they could not be pulled automatically):

- [ ] src/lib/address-guard.js
- [ ] src/lib/admin.js
- [ ] src/lib/db.js
- [ ] src/lib/meta.js
- [ ] src/lib/payu.js
- [ ] src/lib/pricing.js
- [ ] src/lib/pricing.orig.js
- [ ] src/lib/settings.js
- [ ] src/lib/util.js
- [ ] src/lib/whatsapp.js
- [ ] public/admin.html

Until they are in, do **not** connect this repo to the Vercel project (a build from it would be incomplete).

## Build 036d changes (this import)
- `/api/shipping?pin=&cod=` → NimbusPost estimate, one anonymous "Express shipping" option.
  Reads `nimbus_email`, `nimbus_password`, `nimbus_origin_pin` (default 410206), `nimbus_weight_g` from the
  dashboard settings (`env.SETTINGS`) or `NIMBUS_*` env vars. See `ADMIN_FIELDS` in shipping.js for the admin form.
- Orders created and completed with `sourceName: "web"` → attributed to the Online Store channel in Shopify
  Analytics; UTMs/landing page also written to the order note.
- Order attributes: PayU txn id (prepaid), promised delivery date, session id.
- Buyer validation accepts Shopify-style `first_name` / `last_name` from the Build 036 theme.
