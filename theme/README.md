# Theme checkout sources (IK Express sheet)

`src/ikx-js-1..5.liquid` are the theme snippets `snippets/ikx-js-*.liquid` (one inline script split in five
because of snippet size), as uploaded to the Shopify theme. `build039-original/` is Build 039 before partial COD
(byte-identical to Build 038 / live at the time).

Partial COD (Oct 2026) changed parts 3, 4 and 5: COD tile / bill / button show "Pay ₹99 now, rest on delivery"
when `/api/quote` → `partial.mode` is `all`, or `check` and `/api/cod-check` says so for the typed address;
the order goes to `/api/order` with `method: 'partial'`, and the advance is paid through PayU Bolt (desktop)
or the chosen UPI app (phones).

Upload: themeFilesUpsert with body type TEXT (type URL is only honoured for assets, not snippets), then compare
each file's checksumMd5 with `md5sum src/ikx-js-*.liquid`.
