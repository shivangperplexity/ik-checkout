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
