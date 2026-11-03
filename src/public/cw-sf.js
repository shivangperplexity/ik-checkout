/* CodWing checkout for Shopify stores (https://codwing.com)
   - Tracks how far each visitor gets: visit > cart > checkout > phone > address > payment > order, so the seller's
     dashboard shows where buyers drop off and who to follow up with on WhatsApp.
   - Replaces the theme's cart drawer and checkout with one bottom sheet (the Ink Kulture "Express" flow):
     items with qty steppers > delivery details (PIN fills city and state) > pay online / cash on delivery > slide to pay.
     Cash on delivery can be confirmed with a WhatsApp code from the seller's own number; online payment is Razorpay.
   Install: <script src="https://app.codwing.com/sf.js?shop=STORE.myshopify.com" defer></script>
   Test without it: add ?cw_off=1 to any URL. Fail-safe: if CodWing can't be reached, the store's own checkout is used. */
(function () {
  'use strict';
  if (window.__codwing) return;
  window.__codwing = true;

  var me = document.currentScript || document.querySelector('script[src*="/sf.js"],script[src*="cw-sf.js"]');
  var SRC = me ? new URL(me.src, location.href) : null;
  var API = SRC ? SRC.origin : 'https://app.codwing.com';
  var SHOP = (SRC && SRC.searchParams.get('shop')) || (me && me.getAttribute('data-shop')) || (window.Shopify && window.Shopify.shop) || '';
  var qs = new URLSearchParams(location.search);
  if (!SHOP || qs.get('cw_off') === '1') return;
  var R = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
  var CFG = null, CART = null, Q = null, root = null, pill = null, method = '', picked = false, busy = false, done = false, opener = null;
  var otpState = { sent: false, skipped: false, code: '' };

  var STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];
  var ICON = {
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    bag: '<svg viewBox="0 0 24 24"><path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>'
  };

  /* ---------- helpers ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function el(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs || {}) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function money(p) { var r = Math.round(p) / 100; return '₹' + (r % 1 ? r.toFixed(2) : r.toLocaleString('en-IN')); }
  function img(u, w) { if (!u) return ''; if (u.indexOf('cdn.shopify') < 0 && u.indexOf('/cdn/') < 0) return u; return u + (u.indexOf('?') > -1 ? '&' : '?') + 'width=' + (w || 160); }
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function sstore(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) { return null; } }
  function api(path, body) {
    var opt = body ? { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(Object.assign({ shop: SHOP }, body)) } : {};
    var url = API + '/api/cw/' + path + (body ? '' : (path.indexOf('?') > -1 ? '&' : '?') + 'shop=' + encodeURIComponent(SHOP));
    return fetch(url, opt).then(function (r) { return r.json(); });
  }
  function tenDigits(v) { var d = String(v || '').replace(/\D/g, ''); if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2); if (d.length === 11 && d[0] === '0') d = d.slice(1); return d.slice(0, 10); }

  /* ---------- session + source ---------- */
  var SID = (function () {
    var r = qs.get('cwr');
    if (r && /^[\w-]{8,64}$/.test(r)) { sstore('cw_sid', r); return r; }
    var s = sstore('cw_sid');
    if (!s) { s = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2); sstore('cw_sid', s); }
    return s;
  })();
  var SOURCE = (function () {
    var s = sstore('cw_src');
    if (s) return s;
    var u = qs.get('utm_source'), c = qs.get('utm_campaign');
    s = u ? u + (c ? ' / ' + c : '') : qs.get('fbclid') ? 'facebook / instagram ad' : qs.get('gclid') ? 'google ad' : qs.get('cwr') ? 'whatsapp follow-up' : '';
    if (!s && document.referrer) { try { var h = new URL(document.referrer).hostname; if (h !== location.hostname) s = h.replace(/^www\./, ''); } catch (e) {} }
    s = s || 'direct'; sstore('cw_src', s); return s;
  })();

  var sentKey = {};
  function tk(step, extra) {
    var p = Object.assign({ shop: SHOP, sid: SID, step: step, src: SOURCE, page: location.pathname }, extra || {});
    var key = step + '|' + (p.cart ? JSON.stringify(p.cart) : '') + '|' + (p.phone || '');
    if (sentKey[key]) return; sentKey[key] = 1;
    try { fetch(API + '/api/cw/track', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(p), keepalive: true }).catch(function () {}); } catch (e) {}
  }
  function cartLite(c) { return (c && c.items || []).map(function (i) { return { v: i.variant_id, q: i.quantity, t: i.product_title, p: i.final_price }; }); }

  /* ---------- cart ---------- */
  var nativeFetch = window.fetch.bind(window);
  function getCart() {
    return nativeFetch(R + 'cart.js', { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (c) { CART = c; paintPill(); return c; });
  }
  var cartT = null;
  function cartChanged(added) {
    clearTimeout(cartT);
    cartT = setTimeout(function () {
      getCart().then(function (c) {
        if (c.item_count > 0) tk('cart', { cart: cartLite(c) });
        if (root && isOpen()) render();
        else if (added && CFG && CFG.on) { if (CFG.open_on_add) openSheet('cart'); else bump(); }
      }).catch(function () {});
    }, 120);
  }
  window.fetch = function (u, o) {
    var p = nativeFetch.apply(window, arguments);
    try {
      var url = typeof u === 'string' ? u : (u && u.url) || '';
      if (/\/cart\/(add|change|update|clear)/.test(url) && !(o && o.__cw)) p.then(function (r) { if (r.ok) cartChanged(/\/cart\/add/.test(url)); }, function () {});
    } catch (e) {}
    return p;
  };
  (function () {
    var open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__cwu = String(u || ''); return open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var x = this;
      if (/\/cart\/(add|change|update|clear)/.test(x.__cwu || '')) x.addEventListener('load', function () { if (x.status < 400) cartChanged(/\/cart\/add/.test(x.__cwu)); });
      return send.apply(this, arguments);
    };
  })();
  function cartPost(path, data) {
    return nativeFetch(R + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.description || j.message || 'cart'); return j; }); });
  }

  /* ---------- styles ---------- */
  function css(color) {
    var s = el('style', { id: 'cwx-css' });
    s.textContent = [
      '.cwx-root,.cwx-pill{--cwx-ink:' + color + ';--cwx-text:#0a0a0c;--cwx-muted:#5c5a55;--cwx-line:#e9e5dd;--cwx-soft:#f6f4ef;--cwx-green:#15803d;--cwx-green-bg:#e8f5ec;font-family:inherit}',
      '.cwx-root{position:fixed;inset:0;z-index:2147483000;display:none;color:var(--cwx-text);-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.35;text-align:left;letter-spacing:normal;text-transform:none}',
      '.cwx-root.is-open{display:block}.cwx-root *{box-sizing:border-box}',
      '.cwx-backdrop{position:absolute;inset:0;background:rgba(10,10,12,.55)}',
      '.cwx-sheet{position:absolute;left:0;right:0;bottom:0;height:min(94dvh,94vh);display:flex;flex-direction:column;background:#fff;border-radius:22px 22px 0 0;box-shadow:0 -10px 40px rgba(0,0,0,.25);overflow:hidden;animation:cwx-up .24s ease-out}',
      '@media(min-width:750px){.cwx-sheet{left:auto;top:0;height:100%;width:440px;border-radius:0;animation:cwx-in .24s ease-out}}',
      '@keyframes cwx-up{from{transform:translateY(48px);opacity:.5}to{transform:none;opacity:1}}@keyframes cwx-in{from{transform:translateX(40px);opacity:.5}to{transform:none;opacity:1}}',
      '.cwx-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:8px 16px 18px;display:flex;flex-direction:column;gap:14px;position:relative}',
      '.cwx-foot{flex:none;display:grid;gap:8px;padding:10px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--cwx-line);background:#fff;box-shadow:0 -8px 18px rgba(10,10,12,.05)}.cwx-foot:empty{display:none}',
      '.cwx-root svg,.cwx-pill svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}',
      '.cwx-m{color:var(--cwx-muted);font-size:12.5px}.cwx-green{color:var(--cwx-green)}',
      '.cwx-grab{width:40px;height:4px;border-radius:4px;background:#d6d1c7;align-self:center;flex:none}@media(min-width:750px){.cwx-grab{display:none}}',
      '.cwx-head{display:flex;align-items:center;gap:10px}.cwx-h{margin:0;flex:1;font-size:22px;font-weight:800;letter-spacing:-.01em;color:var(--cwx-text)}.cwx-h small{font-size:14px;font-weight:600;color:var(--cwx-muted)}',
      '.cwx-h3{margin:4px 0 0;display:flex;justify-content:space-between;align-items:baseline;font-size:15px;font-weight:800;color:var(--cwx-text)}.cwx-h3 small{font-size:12px;font-weight:600;color:var(--cwx-muted)}',
      '.cwx-secure{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:600;color:var(--cwx-muted)}.cwx-secure svg{width:14px;height:14px}',
      '.cwx-x{width:44px;height:44px;margin-right:-10px;display:grid;place-items:center;border:0;background:none;color:var(--cwx-text);cursor:pointer;border-radius:50%;padding:0}',
      '.cwx-x--abs{position:absolute;top:6px;right:16px}',
      '.cwx-root button:focus-visible,.cwx-root a:focus-visible,.cwx-slide__knob:focus-visible{outline:2px solid var(--cwx-ink);outline-offset:2px}',
      '.cwx-items{list-style:none;margin:0;padding:0;display:grid;gap:12px}',
      '.cwx-item{display:grid;grid-template-columns:60px minmax(0,1fr) auto;gap:12px;align-items:center}',
      '.cwx-item__img{width:60px;height:60px;border-radius:12px;background:var(--cwx-soft);overflow:hidden;display:block}.cwx-item__img img{width:100%;height:100%;object-fit:contain;padding:4px;display:block}',
      '.cwx-item__main{display:grid;gap:5px;min-width:0}.cwx-item__t{font-weight:600;color:inherit;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.cwx-item__v{font-size:12px;color:var(--cwx-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.cwx-step{display:inline-flex;align-items:center;gap:2px;width:fit-content;border:1px solid #d9d4ca;border-radius:10px;height:34px;padding:0 2px;font-weight:700}',
      '.cwx-step button{width:32px;height:30px;display:grid;place-items:center;border:0;background:none;color:inherit;cursor:pointer;border-radius:8px;padding:0}.cwx-step button svg{width:16px;height:16px}.cwx-step button:disabled{opacity:.4}.cwx-step span{min-width:18px;text-align:center}',
      '.cwx-item__p{display:grid;justify-items:end;gap:1px;font-size:14px;text-align:right;font-weight:700}.cwx-item__p s{font-size:12px;color:#7a756c;font-weight:400}',
      '.cwx-soldout{margin:0;padding:8px 10px;border-radius:10px;background:#fff7ed;color:#9a3412;font-size:12.5px;font-weight:600}',
      '.cwx-form{display:grid;gap:10px;scroll-margin-top:8px;padding-top:6px;border-top:1px solid var(--cwx-line);margin:0}',
      '.cwx-row2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}',
      '.cwx-in{display:flex;flex-direction:column;justify-content:center;gap:1px;min-height:54px;padding:6px 14px;border:1px solid #cfc9be;border-radius:12px;background:#fff;cursor:text;margin:0}',
      '.cwx-in:focus-within{border-color:var(--cwx-ink);box-shadow:0 0 0 3px rgba(10,10,12,.08)}.cwx-in.is-bad{border-color:#b42318;background:#fffafa}',
      '.cwx-in>span:first-child{font-size:11px;font-weight:600;color:var(--cwx-muted)}',
      '.cwx-in input,.cwx-in select{width:100%;border:0;padding:0;margin:0;outline:0;background:transparent;font:inherit;font-size:16px;font-weight:500;color:var(--cwx-text);min-height:24px;box-shadow:none;-webkit-appearance:none;appearance:none;letter-spacing:normal}',
      '.cwx-phone{display:flex;align-items:center;gap:8px}.cwx-phone b{font-size:16px;font-weight:600;color:var(--cwx-muted)}',
      '.cwx-pinok{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:12px;background:var(--cwx-green-bg);color:#17512d;font-size:13px;font-weight:600}.cwx-pinok[hidden]{display:none}.cwx-pinok svg{width:18px;height:18px}',
      '.cwx-pay{display:grid;gap:10px}.cwx-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.cwx-tiles.is-one{grid-template-columns:1fr}',
      '.cwx-tile{position:relative;display:grid;gap:2px;align-content:start;min-height:84px;padding:11px 12px;border:1px solid #d9d4ca;border-radius:14px;background:#fff;color:var(--cwx-text);font:inherit;text-align:left;cursor:pointer;margin:0}',
      '.cwx-tile.is-on{border:2px solid var(--cwx-ink);padding:10px 11px;background:#fbfaf7}.cwx-tile b{font-size:14px}.cwx-tile__amt{font-size:15px;font-weight:800}.cwx-tile .cwx-m{font-size:11.5px}',
      '.cwx-tile__save{position:absolute;top:-9px;right:10px;padding:2px 8px;border-radius:999px;background:var(--cwx-green);color:#fff;font-size:10.5px;font-weight:800}',
      '.cwx-bill{border-radius:12px;background:var(--cwx-soft);padding:0 14px}.cwx-bill summary{list-style:none;display:flex;justify-content:space-between;align-items:center;min-height:44px;font-weight:700;cursor:pointer}',
      '.cwx-bill summary::-webkit-details-marker{display:none}.cwx-bill[open] summary svg{transform:rotate(180deg)}',
      '.cwx-bill__rows{display:grid;gap:6px;padding:0 0 12px;font-size:13px}.cwx-r{display:flex;justify-content:space-between;gap:10px}.cwx-r.is-save{color:var(--cwx-green);font-weight:600}.cwx-r.is-total{padding-top:8px;border-top:1px solid #e2ddd3;font-size:15px;font-weight:800}',
      '.cwx-fine{margin:0;display:flex;align-items:center;justify-content:center;gap:5px;font-size:11.5px;color:var(--cwx-muted);text-align:center}.cwx-fine svg{width:13px;height:13px}',
      '.cwx-tot{display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:13px;font-weight:700}.cwx-tot s{margin-right:6px;font-weight:500;color:#7a756c}.cwx-tot b{font-size:19px;font-weight:800}',
      '.cwx-err{margin:0;padding:8px 10px;border-radius:10px;background:#fef2f2;color:#b91c1c;font-size:13px;font-weight:600}.cwx-err[hidden]{display:none}',
      '.cwx-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:54px;margin:0;padding:12px 18px;border:0;border-radius:14px;background:var(--cwx-ink);color:#fff;font:inherit;font-size:16px;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}',
      '.cwx-btn--ghost{background:#fff;color:var(--cwx-text);border:1.5px solid var(--cwx-text)}.cwx-btn:disabled{opacity:.5;cursor:default}',
      '.cwx-slide{position:relative;height:60px;border-radius:999px;background:var(--cwx-ink);color:#fff;overflow:hidden;user-select:none;-webkit-user-select:none;touch-action:pan-y}',
      '.cwx-slide__fill{position:absolute;left:0;top:0;bottom:0;width:60px;background:var(--cwx-green);border-radius:999px}',
      '.cwx-slide__label{position:absolute;inset:0;display:grid;place-items:center;padding-left:56px;font-weight:700;font-size:15.5px;pointer-events:none;animation:cwx-shine 2.4s ease-in-out infinite}',
      '.cwx-slide__knob{position:absolute;left:5px;top:5px;width:50px;height:50px;border-radius:50%;background:#fff;color:#0a0a0c;display:grid;place-items:center;cursor:grab;touch-action:none;box-shadow:0 2px 8px rgba(0,0,0,.25)}',
      '.cwx-slide.is-busy,.cwx-slide.is-done{pointer-events:none}.cwx-slide.is-busy .cwx-slide__label{animation:none;opacity:.85}',
      '@keyframes cwx-shine{0%,100%{opacity:1}50%{opacity:.7}}',
      '.cwx-load,.cwx-done,.cwx-empty{display:grid;gap:12px;justify-items:center;text-align:center;padding:40px 8px}.cwx-load p{margin:0;font-weight:700}',
      '.cwx-done h3,.cwx-empty h3{margin:0;font-size:22px;font-weight:800;color:var(--cwx-text)}.cwx-done p,.cwx-empty p{margin:0;color:#444;line-height:1.5}.cwx-done .cwx-btn,.cwx-empty .cwx-btn{max-width:360px}',
      '.cwx-tick{width:64px;height:64px;display:grid;place-items:center;border-radius:50%;background:var(--cwx-green);color:#fff}.cwx-tick svg{width:34px;height:34px;stroke-width:2.6}',
      '.cwx-spin{display:block;width:40px;height:40px;border:4px solid #e6e1d6;border-top-color:var(--cwx-ink);border-radius:50%;animation:cwx-spin .8s linear infinite}@keyframes cwx-spin{to{transform:rotate(360deg)}}',
      '.cwx-ov{position:absolute;inset:0;z-index:5;display:none;place-items:center;background:rgba(255,255,255,.75);backdrop-filter:blur(2px);padding:16px}.cwx-ov.is-on{display:grid}',
      '.cwx-ov__card{display:grid;gap:12px;justify-items:center;width:100%;max-width:360px;padding:22px 20px;border-radius:16px;background:#fff;box-shadow:0 10px 40px rgba(0,0,0,.18);text-align:center}.cwx-ov__card p{margin:0;font-weight:700}',
      '.cwx-otp h3{margin:0;font-size:19px;font-weight:800}.cwx-otp p{font-weight:500!important;color:#444;font-size:13.5px}',
      '.cwx-otp input{width:100%;max-width:220px;height:56px;text-align:center;font:inherit;font-size:28px;font-weight:800;letter-spacing:.4em;padding-left:.4em;border:1.5px solid #cfc9be;border-radius:12px;color:var(--cwx-text);background:#fff}',
      '.cwx-otp input:focus{outline:0;border-color:var(--cwx-ink);box-shadow:0 0 0 3px rgba(10,10,12,.08)}',
      '.cwx-link{border:0;background:none;padding:6px 2px;color:var(--cwx-text);font:inherit;font-size:13px;font-weight:700;text-decoration:underline;cursor:pointer}.cwx-link[hidden]{display:none}',
      '.cwx-pill{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147482000;display:flex;align-items:center;gap:10px;min-height:52px;padding:8px 10px 8px 16px;border:0;border-radius:999px;background:var(--cwx-ink);color:#fff;font:inherit;font-size:14px;font-weight:700;box-shadow:0 8px 28px rgba(0,0,0,.28);cursor:pointer;white-space:nowrap}',
      '.cwx-pill[hidden]{display:none}.cwx-pill i{font-style:normal;display:inline-grid;place-items:center;min-width:22px;height:22px;padding:0 6px;border-radius:999px;background:#fff;color:#0a0a0c;font-size:12px}',
      '.cwx-pill span.cwx-pill__go{display:inline-flex;align-items:center;gap:4px;padding:8px 12px;border-radius:999px;background:rgba(255,255,255,.16)}.cwx-pill span.cwx-pill__go svg{width:16px;height:16px}',
      '.cwx-pill.is-bump{animation:cwx-bump .5s ease}@keyframes cwx-bump{30%{transform:translateX(-50%) scale(1.06)}}'
    ].join('\n');
    document.head.appendChild(s);
  }

  /* ---------- pill ---------- */
  function paintPill() {
    if (!CFG || !CFG.on) return;
    if (!pill) {
      pill = el('button', { type: 'button', class: 'cwx-pill', hidden: '' });
      pill.addEventListener('click', function () { openSheet('cart', pill); });
      document.body.appendChild(pill);
    }
    var n = CART ? CART.item_count : 0;
    pill.hidden = !n || isOpen() || /\/(cart|checkouts?)(\/|$)/.test(location.pathname);
    pill.innerHTML = ICON.bag + '<span>View cart</span><i>' + n + '</i><span class="cwx-pill__go">' + (CART ? money(CART.total_price) : '') + ICON.arrow + '</span>';
    pill.setAttribute('aria-label', 'View cart, ' + n + ' item' + (n === 1 ? '' : 's'));
  }

  /* "Added" feedback without opening anything: the pill bounces and says so, the button says so for a moment */
  var bumpT = null;
  function bump(btn) {
    paintPill();
    if (pill && !pill.hidden) {
      pill.classList.remove('is-bump'); void pill.offsetWidth; pill.classList.add('is-bump');
      var lab = $('span', pill); if (lab) { lab.textContent = 'Added \u2713 View cart'; clearTimeout(bumpT); bumpT = setTimeout(paintPill, 1800); }
    }
    if (btn && btn.tagName === 'BUTTON' && !btn.__cwTxt) {
      btn.__cwTxt = btn.innerHTML; btn.innerHTML = 'Added \u2713';
      setTimeout(function () { btn.innerHTML = btn.__cwTxt; btn.__cwTxt = null; }, 1500);
    }
  }

  /* ---------- sheet ---------- */
  function isOpen() { return !!(root && root.classList.contains('is-open')); }
  function shell() {
    if (root) return;
    root = el('div', { class: 'cwx-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Cart and checkout' },
      '<div class="cwx-backdrop" data-cw-close></div><div class="cwx-sheet"><div class="cwx-scroll"></div><div class="cwx-foot"></div></div>');
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  }
  function closeThemeDrawers() {
    $$('dialog[open]').forEach(function (d) { if (!d.closest('.cwx-root')) try { d.close(); } catch (e) {} });
    $$('cart-drawer.active,cart-drawer.is-open,#CartDrawer.active,#cart-drawer.active,.cart-drawer.is-open,.drawer.active[id*="art"]').forEach(function (d) { d.classList.remove('active', 'is-open', 'animate'); });
    document.body.classList.remove('overflow-hidden', 'js-drawer-open', 'drawer-open');
  }
  function openSheet(where, from) {
    shell(); closeThemeDrawers();
    opener = from || document.activeElement;
    var was = isOpen();
    root.classList.add('is-open'); document.documentElement.style.overflow = 'hidden';
    if (pill) pill.hidden = true;
    if (!was) { done = false; tk('checkout', CART ? { cart: cartLite(CART) } : null); if (window.fbq) try { window.fbq('track', 'InitiateCheckout'); } catch (e) {} }
    if (CART && CART.item_count) render(where);
    else loading('Loading your cart…');
    return getCart().then(function () { render(where); }).catch(function () {
      if (where === 'checkout') { location.href = R + 'checkout?cw_off=1'; return; }
      screen('<h3>Couldn’t load your cart</h3><p>Please check your connection and try again.</p><a class="cwx-btn" href="' + R + 'cart?cw_off=1">Open cart page</a>');
    });
  }
  function closeSheet() {
    if (!root) return;
    root.classList.remove('is-open'); document.documentElement.style.overflow = '';
    if (done) { location.reload(); return; }
    paintPill();
    if (opener && opener.focus) try { opener.focus({ preventScroll: true }); } catch (e) {}
  }
  function scroller() { return $('.cwx-scroll', root); }
  function foot() { return $('.cwx-foot', root); }
  function loading(msg) { built = false; scroller().innerHTML = '<div class="cwx-load"><i class="cwx-spin"></i><p>' + esc(msg) + '</p></div>'; foot().innerHTML = ''; }
  function screen(html) {
    built = false;
    scroller().innerHTML = '<button type="button" class="cwx-x cwx-x--abs" data-cw-close aria-label="Close">' + ICON.close + '</button><div class="cwx-done">' + html + '</div>';
    foot().innerHTML = ''; scroller().scrollTop = 0;
  }
  function overlay(html) {
    var o = $('.cwx-ov', root);
    if (!o) { o = el('div', { class: 'cwx-ov', role: 'status', 'aria-live': 'polite' }); $('.cwx-sheet', root).appendChild(o); }
    o.innerHTML = '<div class="cwx-ov__card">' + html + '</div>'; o.classList.add('is-on'); return o;
  }
  function busyOverlay(msg) { overlay('<i class="cwx-spin"></i><p>' + esc(msg || 'Please wait…') + '</p>'); }
  function hideOverlay() { var o = root && $('.cwx-ov', root); if (o) o.classList.remove('is-on'); }

  var built = false;
  function render(where) {
    if (!root) return;
    if (!CART || !CART.item_count) {
      built = false;
      scroller().innerHTML = '<div class="cwx-grab"></div><div class="cwx-head"><h2 class="cwx-h">Your cart</h2><button type="button" class="cwx-x" data-cw-close aria-label="Close">' + ICON.close + '</button></div>' +
        '<div class="cwx-empty"><h3>Your cart is empty</h3><p>Add something you love and it will show up here.</p><button type="button" class="cwx-btn" data-cw-close>Continue shopping</button></div>';
      foot().innerHTML = ''; return;
    }
    if (!built) build();
    paintItems(); paintPay(); paintBill(); paintFoot();
    fetchQuote();
    if (where === 'checkout') setTimeout(function () { var f = $('.cwx-form', root); if (f) f.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 60);
  }
  function build() {
    built = true;
    var opts = '<option value="" disabled selected></option>' + STATES.map(function (s) { return '<option>' + s + '</option>'; }).join('');
    function field(name, label, attrs, cls) { return '<label class="cwx-in' + (cls ? ' ' + cls : '') + '" data-f="' + name + '"><span>' + label + '</span>' + (name === 'state' ? '<select name="state" autocomplete="address-level1">' + opts + '</select>' : '<input name="' + name + '" ' + (attrs || '') + '>') + '</label>'; }
    scroller().innerHTML =
      '<div class="cwx-grab"></div>' +
      '<div class="cwx-head"><h2 class="cwx-h">Your cart <small></small></h2><span class="cwx-secure">' + ICON.lock + 'Secure checkout</span><button type="button" class="cwx-x" data-cw-close aria-label="Close">' + ICON.close + '</button></div>' +
      '<ul class="cwx-items"></ul><p class="cwx-soldout" hidden></p>' +
      '<form class="cwx-form" novalidate autocomplete="on">' +
        '<h3 class="cwx-h3">Delivery details <small>Takes 30 seconds</small></h3>' +
        '<label class="cwx-in" data-f="phone"><span>Mobile number (for order updates on WhatsApp)</span><span class="cwx-phone"><b>+91</b><input name="phone" type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="14"></span></label>' +
        field('pincode', 'PIN code', 'inputmode="numeric" autocomplete="postal-code" maxlength="6"') +
        '<div class="cwx-pinok" hidden>' + ICON.pin + '<span></span></div>' +
        '<div class="cwx-row2">' + field('first_name', 'First name', 'autocomplete="given-name"') + field('last_name', 'Last name', 'autocomplete="family-name"') + '</div>' +
        field('address1', 'House / flat no., street, area', 'autocomplete="address-line1"') +
        field('address2', 'Landmark (optional)', 'autocomplete="address-line2"') +
        '<div class="cwx-row2">' + field('city', 'City', 'autocomplete="address-level2"') + field('state', 'State') + '</div>' +
        field('email', 'Email (optional)', 'type="email" autocomplete="email"') +
      '</form>' +
      '<div class="cwx-pay"><h3 class="cwx-h3">Payment</h3><div class="cwx-tiles"></div></div>' +
      '<details class="cwx-bill"><summary><span>Order summary</span>' + ICON.chev + '</summary><div class="cwx-bill__rows"></div></details>' +
      '<p class="cwx-fine">' + ICON.lock + '<span>Secure checkout · powered by CodWing</span></p>';
    var f = $('.cwx-form', root);
    var saved = store('cw_buyer') || {};
    var restored = store('cw_restore') || {};
    ['phone', 'pincode', 'first_name', 'last_name', 'address1', 'address2', 'city', 'state', 'email'].forEach(function (k) { var v = restored[k] || saved[k]; if (v && f.elements[k]) f.elements[k].value = v; });
    f.addEventListener('input', function (e) {
      var n = e.target.name;
      if (n === 'phone') { var d = tenDigits(e.target.value); if (e.target.value !== d && /^\+?9?1?\s?0?\d[\d\s-]*$/.test(e.target.value)) e.target.value = d; }
      if (n === 'pincode') { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); if (e.target.value.length === 6) onPin(); else $('.cwx-pinok', root).hidden = true; }
      var lab = e.target.closest('.cwx-in'); if (lab) lab.classList.remove('is-bad');
      showErr('');
      stepWatch();
    });
    f.addEventListener('change', function (e) { if (e.target.name === 'state') fetchQuote(); stepWatch(); });
    f.addEventListener('submit', function (e) { e.preventDefault(); });
    if (f.elements.pincode.value.length === 6) onPin(true);
    stepWatch();
  }
  function onPin(quiet) {
    var f = $('.cwx-form', root), pin = f.elements.pincode.value, ok = $('.cwx-pinok', root);
    nativeFetch(API + '/api/cw/pin?pin=' + pin).then(function (r) { return r.json(); }).then(function (d) {
      if (f.elements.pincode.value !== pin) return;
      if (!d.ok) { ok.hidden = true; if (!quiet && d.notfound) { var l = f.elements.pincode.closest('.cwx-in'); l.classList.add('is-bad'); showErr('We couldn’t find this PIN code. Please check it.'); } return; }
      if (!f.elements.city.value) f.elements.city.value = titleCase(d.city);
      var st = STATES.filter(function (s) { return s.toLowerCase() === String(d.state).toLowerCase() || (/daman|dadra/i.test(d.state) && /daman/i.test(s)); })[0];
      if (st && f.elements.state.value !== st) { f.elements.state.value = st; fetchQuote(); }
      ok.hidden = false; $('span', ok).textContent = 'Delivering to ' + titleCase(d.city) + ', ' + (st || d.state);
      stepWatch();
    }).catch(function () {});
  }
  function titleCase(s) { return String(s || '').toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); }
  function formData() {
    var f = $('.cwx-form', root), o = {};
    ['phone', 'pincode', 'first_name', 'last_name', 'address1', 'address2', 'city', 'state', 'email'].forEach(function (k) { o[k] = (f.elements[k] && f.elements[k].value || '').trim(); });
    o.phone = tenDigits(o.phone);
    return o;
  }
  function problems(d) {
    var p = [];
    if (!/^[6-9]\d{9}$/.test(d.phone)) p.push(['phone', 'Enter a valid 10-digit mobile number']);
    if (!/^[1-9]\d{5}$/.test(d.pincode)) p.push(['pincode', 'Enter a valid 6-digit PIN code']);
    if (!d.first_name) p.push(['first_name', 'Enter your name']);
    if (d.address1.length < 6) p.push(['address1', 'Enter your full address (house no., street, area)']);
    else if (/https?:|www\.|maps\.app|goo\.gl/i.test(d.address1 + ' ' + d.address2)) p.push(['address1', 'Please type the address, not a link']);
    if (!d.city) p.push(['city', 'Enter your city']);
    if (!d.state) p.push(['state', 'Pick your state']);
    if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) p.push(['email', 'Check your email address']);
    return p;
  }
  var stepT = null;
  function stepWatch() {
    clearTimeout(stepT);
    stepT = setTimeout(function () {
      if (!root || !built) return;
      var d = formData();
      if (/^[6-9]\d{9}$/.test(d.phone)) tk('phone', { phone: d.phone, name: (d.first_name + ' ' + d.last_name).trim() || undefined, cart: cartLite(CART) });
      if (!problems(d).length) tk('address', { phone: d.phone, name: (d.first_name + ' ' + d.last_name).trim(), pincode: d.pincode, city: d.city });
    }, 700);
  }

  var qT = null, qSeq = 0;
  function linesOf(c) { return c.items.map(function (i) { return { variant_id: i.variant_id, quantity: i.quantity, price: i.final_price, title: i.product_title }; }); }
  function fetchQuote() {
    clearTimeout(qT);
    qT = setTimeout(function () {
      if (!CART || !CART.item_count) return;
      var seq = ++qSeq, f = root && $('.cwx-form', root);
      api('quote', { lines: linesOf(CART), state: f ? f.elements.state.value : '' }).then(function (j) {
        if (seq !== qSeq || !j.ok) return;
        Q = j; if (j.cfg) CFG = Object.assign(CFG || {}, j.cfg);
        var sold = $('.cwx-soldout', root);
        if (sold) { sold.hidden = !j.soldOut.length; sold.textContent = j.soldOut.length ? 'Sold out and left out of this order: ' + j.soldOut.map(function (s) { return s.title || 'an item'; }).join(', ') : ''; }
        paintPay(); paintBill(); paintFoot();
      }).catch(function () {});
    }, 150);
  }

  function paintItems() {
    $('.cwx-h small', root).textContent = '(' + CART.item_count + ')';
    $('.cwx-items', root).innerHTML = CART.items.map(function (it) {
      var v = it.variant_title && it.variant_title !== 'Default Title' ? it.variant_title : '';
      return '<li class="cwx-item"><a class="cwx-item__img" href="' + esc(it.url) + '">' + (it.image ? '<img src="' + esc(img(it.image, 160)) + '" alt="" loading="lazy">' : '') + '</a>' +
        '<div class="cwx-item__main"><a class="cwx-item__t" href="' + esc(it.url) + '">' + esc(it.product_title) + '</a>' + (v ? '<span class="cwx-item__v">' + esc(v) + '</span>' : '') +
        '<span class="cwx-step"><button type="button" data-cw-qty="-1" data-key="' + esc(it.key) + '" aria-label="Remove one">' + ICON.minus + '</button><span>' + it.quantity + '</span><button type="button" data-cw-qty="1" data-key="' + esc(it.key) + '" aria-label="Add one">' + ICON.plus + '</button></span></div>' +
        '<div class="cwx-item__p">' + (it.original_line_price > it.final_line_price ? '<s>' + money(it.original_line_price) + '</s>' : '') + money(it.final_line_price) + '</div></li>';
    }).join('');
  }
  function quoteNow() { return Q && Q.quote && Q.quote.subtotal ? Q.quote : null; }
  function methods() {
    var q = quoteNow(), m = [];
    if (!q) { m.push({ id: 'cod', total: CART.total_price }); return m; }
    if (q.online) m.push({ id: 'online', total: q.online.total, save: q.online.discount });
    if (q.cod) m.push({ id: 'cod', total: q.cod.total, fee: q.cod.fee });
    if (q.partial) m.push({ id: 'partial', total: q.partial.total, now: q.partial.advance, rest: q.partial.rest });
    return m;
  }
  function pickMethod() {
    var ms = methods(), ids = ms.map(function (m) { return m.id; });
    if (!picked || ids.indexOf(method) < 0) method = ids.indexOf('online') > -1 ? 'online' : ids[0] || '';
    return ms;
  }
  function paintPay() {
    var ms = pickMethod(), t = $('.cwx-tiles', root);
    if (!ms.length) { t.className = 'cwx-tiles is-one'; t.innerHTML = '<p class="cwx-m">No payment method is available for this order. Please contact the store.</p>'; return; }
    t.className = 'cwx-tiles' + (ms.length === 1 ? ' is-one' : '');
    var codOnline = ms.filter(function (m) { return m.id === 'online'; })[0];
    t.innerHTML = ms.map(function (m) {
      var on = m.id === method ? ' is-on' : '';
      if (m.id === 'online') return '<button type="button" class="cwx-tile' + on + '" data-cw-method="online" aria-pressed="' + !!on + '">' + (m.save ? '<span class="cwx-tile__save">Save ' + money(m.save) + '</span>' : '') + '<b>Pay online</b><span class="cwx-tile__amt">' + money(m.total) + '</span><span class="cwx-m">UPI, cards, netbanking</span></button>';
      if (m.id === 'cod') return '<button type="button" class="cwx-tile' + on + '" data-cw-method="cod" aria-pressed="' + !!on + '"><b>Cash on delivery</b><span class="cwx-tile__amt">' + money(m.total) + '</span><span class="cwx-m">' + (m.fee ? 'Incl. ' + money(m.fee) + ' COD fee' : 'Pay when it arrives') + (codOnline && codOnline.total < m.total ? ' · pay online, save ' + money(m.total - codOnline.total) : '') + '</span></button>';
      return '<button type="button" class="cwx-tile' + on + '" data-cw-method="partial" aria-pressed="' + !!on + '"><b>Cash on delivery</b><span class="cwx-tile__amt">Pay ' + money(m.now) + ' now</span><span class="cwx-m">' + money(m.rest) + ' on delivery' + (m.fee ? ' · incl. ' + money(m.fee) + ' fee' : '') + '</span></button>';
    }).join('');
  }
  function paintBill() {
    var q = quoteNow(), rows = $('.cwx-bill__rows', root), sub = q ? q.subtotal : CART.total_price;
    var h = '<div class="cwx-r"><span>Items (' + CART.item_count + ')</span><span>' + money(sub) + '</span></div><div class="cwx-r is-save"><span>Delivery</span><span>Free</span></div>';
    var m = methods().filter(function (x) { return x.id === method; })[0];
    if (m && m.save) h += '<div class="cwx-r is-save"><span>Online payment discount</span><span>−' + money(m.save) + '</span></div>';
    if (m && m.fee) h += '<div class="cwx-r"><span>COD fee</span><span>' + money(m.fee) + '</span></div>';
    h += '<div class="cwx-r is-total"><span>Total</span><span>' + money(m ? m.total : sub) + '</span></div>';
    if (m && m.id === 'partial') h += '<div class="cwx-r"><span>Pay now</span><span>' + money(m.now) + '</span></div><div class="cwx-r"><span>Pay on delivery</span><span>' + money(m.rest) + '</span></div>';
    rows.innerHTML = h;
  }
  function slideLabel() {
    var m = methods().filter(function (x) { return x.id === method; })[0];
    if (!m) return 'Place order';
    if (m.id === 'online') return 'Slide to pay ' + money(m.total);
    if (m.id === 'partial') return 'Slide to pay ' + money(m.now) + ' now';
    return 'Slide to place order';
  }
  function paintFoot() {
    var m = methods().filter(function (x) { return x.id === method; })[0];
    var f = foot();
    if (!f.firstChild) {
      f.innerHTML = '<div class="cwx-tot"><span>Total</span><span><s hidden></s><b></b></span></div><p class="cwx-err" role="alert" hidden></p>' +
        '<div class="cwx-slide"><i class="cwx-slide__fill"></i><span class="cwx-slide__label"></span><span class="cwx-slide__knob" role="button" tabindex="0" aria-label="Place order">' + ICON.arrow + '</span></div>';
      bindSlide($('.cwx-slide', f));
    }
    var cod = methods().filter(function (x) { return x.id === 'cod'; })[0];
    $('.cwx-tot b', f).textContent = money(m ? m.total : CART.total_price);
    var s = $('.cwx-tot s', f);
    if (m && m.id === 'online' && cod && cod.total > m.total) { s.hidden = false; s.textContent = money(cod.total); } else s.hidden = true;
    if (!busy) $('.cwx-slide__label', f).textContent = slideLabel();
  }
  function showErr(msg) { var e = root && $('.cwx-err', root); if (!e) return; e.hidden = !msg; e.textContent = msg || ''; }

  function bindSlide(sl) {
    var knob = $('.cwx-slide__knob', sl), fill = $('.cwx-slide__fill', sl), x0 = 0, dx = 0, drag = false;
    function max() { return sl.clientWidth - knob.offsetWidth - 10; }
    function set(px) { knob.style.transform = 'translateX(' + px + 'px)'; fill.style.width = (px + 60) + 'px'; }
    function reset() { knob.style.transition = fill.style.transition = 'transform .25s ease, width .25s ease'; set(0); setTimeout(function () { knob.style.transition = fill.style.transition = ''; }, 260); }
    sl.__reset = function () { sl.classList.remove('is-busy', 'is-done'); reset(); busy = false; paintFoot(); };
    knob.addEventListener('pointerdown', function (e) { if (busy) return; drag = true; x0 = e.clientX; dx = 0; try { knob.setPointerCapture(e.pointerId); } catch (er) {} });
    knob.addEventListener('pointermove', function (e) { if (!drag) return; dx = Math.max(0, Math.min(max(), e.clientX - x0)); set(dx); });
    function up() { if (!drag) return; drag = false; if (dx > max() * 0.82) { set(max()); go(sl); } else reset(); }
    knob.addEventListener('pointerup', up); knob.addEventListener('pointercancel', up);
    knob.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); set(max()); go(sl); } });
    sl.addEventListener('click', function (e) { if (e.target === knob || busy) return; if (e.detail === 0) { set(max()); go(sl); } });
  }

  /* ---------- place the order ---------- */
  function go(sl) {
    if (busy) return;
    var d = formData(), p = problems(d);
    $$('.cwx-in.is-bad', root).forEach(function (l) { l.classList.remove('is-bad'); });
    if (p.length) {
      p.forEach(function (x) { var l = $('[data-f="' + x[0] + '"]', root); if (l) l.classList.add('is-bad'); });
      showErr(p[0][1]);
      var first = $('[data-f="' + p[0][0] + '"]', root); if (first) { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); var inp = $('input,select', first); if (inp) setTimeout(function () { inp.focus({ preventScroll: true }); }, 350); }
      sl.__reset(); return;
    }
    if (!method) { showErr('Pick a payment method'); sl.__reset(); return; }
    busy = true; sl.classList.add('is-busy'); $('.cwx-slide__label', sl).textContent = 'Placing your order…'; showErr('');
    store('cw_buyer', d); store('cw_restore', null);
    tk('payment', { phone: d.phone });
    var needOtp = method === 'cod' && CFG && CFG.otp && !otpState.code && !otpState.skipped;
    if (needOtp) return askOtp(d, sl);
    place(d, sl);
  }
  function place(d, sl) {
    busyOverlay(method === 'cod' ? 'Placing your order…' : 'Opening payment…');
    api('order', { sid: SID, src: SOURCE, lines: linesOf(CART), buyer: d, method: method, otp: otpState.code, otp_skipped: otpState.skipped }).then(function (j) {
      if (!j.ok) {
        hideOverlay();
        if (j.otp) { otpState.code = ''; return askOtp(d, sl, j.error, j.resend); }
        showErr(j.error || 'Something went wrong. Please try again.'); sl.__reset(); return;
      }
      if (j.order) return finish(j.order, d);
      if (j.pay) return pay(j.pay, d, sl);
    }).catch(function () { hideOverlay(); showErr('No internet connection? Please try again.'); sl.__reset(); });
  }
  function askOtp(d, sl, err, resend) {
    var sendIt = !otpState.sent || resend;
    function view(msg) {
      var o = overlay('<div class="cwx-otp" style="display:grid;gap:12px;justify-items:center"><h3>Confirm your order</h3><p>Enter the 4-digit code we sent on WhatsApp to +91 ' + esc(d.phone) + '</p>' +
        '<input inputmode="numeric" autocomplete="one-time-code" maxlength="4" aria-label="WhatsApp code">' + (msg ? '<p class="cwx-err" style="width:100%">' + esc(msg) + '</p>' : '') +
        '<button type="button" class="cwx-btn" data-cw-otp-ok>Confirm order</button><button type="button" class="cwx-link" data-cw-otp-resend hidden>Send the code again</button><button type="button" class="cwx-link" data-cw-otp-skip hidden>Code not coming? Place order, we’ll confirm on WhatsApp</button><button type="button" class="cwx-link" data-cw-otp-back>Change number</button></div>');
      var inp = $('input', o); setTimeout(function () { inp.focus(); }, 50);
      inp.addEventListener('input', function () { inp.value = inp.value.replace(/\D/g, '').slice(0, 4); if (inp.value.length === 4) submitCode(); });
      function submitCode() { if (inp.value.length !== 4) return; otpState.code = inp.value; place(d, sl); }
      $('[data-cw-otp-ok]', o).addEventListener('click', submitCode);
      $('[data-cw-otp-back]', o).addEventListener('click', function () { hideOverlay(); sl.__reset(); var ph = $('.cwx-form', root).elements.phone; ph.focus(); });
      $('[data-cw-otp-resend]', o).addEventListener('click', function () { send(); });
      $('[data-cw-otp-skip]', o).addEventListener('click', function () { otpState.skipped = true; otpState.code = ''; place(d, sl); });
      setTimeout(function () { var b = $('[data-cw-otp-resend]', o); if (b) b.hidden = false; }, 30000);
      setTimeout(function () { var b = $('[data-cw-otp-skip]', o); if (b) b.hidden = false; }, 25000);
    }
    function send() {
      busyOverlay('Sending a code on WhatsApp…');
      api('otp', { phone: d.phone }).then(function (j) {
        if (j.ok) { otpState.sent = true; view(''); }
        else if (j.skip) { otpState.skipped = true; place(d, sl); }
        else view(j.error);
      }).catch(function () { otpState.skipped = true; place(d, sl); });
    }
    if (sendIt) send(); else view(err);
  }
  function loadScript(src) { return new Promise(function (ok, bad) { if ($('script[src="' + src + '"]')) return ok(); var s = el('script', { src: src }); s.onload = ok; s.onerror = bad; document.head.appendChild(s); }); }
  function pay(p, d, sl) {
    if (p.payu) {
      busyOverlay('Opening PayU\u2026');
      var pf = el('form', { method: 'POST', action: p.payu.action });
      Object.keys(p.payu.fields).forEach(function (k) { var i = el('input', { type: 'hidden', name: k }); i.value = p.payu.fields[k]; pf.appendChild(i); });
      document.body.appendChild(pf); HTMLFormElement.prototype.submit.call(pf);
      return;
    }
    if (p.demo) { busyOverlay('Demo: payment successful…'); setTimeout(function () { api('paid', {}).then(function (j) { finish(j.order, d); }); }, 900); return; }
    loadScript('https://checkout.razorpay.com/v1/checkout.js').then(function () {
      hideOverlay();
      var rz = new window.Razorpay({
        key: p.key, order_id: p.order_id, amount: p.amount, currency: 'INR', name: p.name, prefill: p.prefill, theme: { color: CFG.color },
        handler: function (r) {
          busyOverlay('Confirming your payment…');
          api('paid', r).then(function (j) { if (j.ok) finish(j.order, d, j.note); else { hideOverlay(); showErr(j.error || 'Payment could not be confirmed. If money was taken, contact the store.'); sl.__reset(); } });
        },
        modal: { ondismiss: function () { showErr('Payment not finished. Try again, or pick cash on delivery.'); sl.__reset(); } }
      });
      rz.on('payment.failed', function () { showErr('Payment failed. Try again, or pick cash on delivery.'); });
      rz.open();
    }).catch(function () { hideOverlay(); showErr('Couldn’t open the payment page. Check your connection or pick cash on delivery.'); sl.__reset(); });
  }
  function finish(order, d, note) {
    done = true; busy = false; hideOverlay();
    var total = $('.cwx-tot b', root) ? $('.cwx-tot b', root).textContent : '';
    if (window.fbq) try { window.fbq('track', 'Purchase', { value: (methods().filter(function (x) { return x.id === method; })[0] || {}).total / 100 || 0, currency: 'INR' }); } catch (e) {}
    cartPost('cart/clear.js', {}).catch(function () {});
    CART = { items: [], item_count: 0, total_price: 0 };
    screen('<span class="cwx-tick">' + ICON.check + '</span><h3>Order placed' + (order && order.name ? ' ' + esc(order.name) : '') + '</h3>' +
      '<p>Thank you, ' + esc(d.first_name) + '! ' + esc(note || (method === 'cod' ? 'Keep ' + total + ' ready at delivery. ' : '') + 'We’ll send updates on WhatsApp to +91 ' + d.phone + '.') + '</p>' +
      (order && order.url ? '<a class="cwx-btn cwx-btn--ghost" href="' + esc(order.url) + '">View order</a>' : '') + '<button type="button" class="cwx-btn" data-cw-close>Continue shopping</button>');
  }

  /* ---------- clicks ---------- */
  function onClick(e) {
    var t = e.target;
    if (t.closest('[data-cw-close]')) { e.preventDefault(); closeSheet(); return; }
    var q = t.closest('[data-cw-qty]');
    if (q && !busy) {
      var key = q.getAttribute('data-key'), it = CART.items.filter(function (i) { return i.key === key; })[0]; if (!it) return;
      var n = Math.max(0, it.quantity + Number(q.getAttribute('data-cw-qty')));
      q.disabled = true;
      cartPost('cart/change.js', { id: key, quantity: n }).then(function (c) { CART = c; paintPill(); tk('cart', { cart: cartLite(c) }); render(); })
        .catch(function (err) { q.disabled = false; showErr(/stock|available/i.test(err.message) ? 'No more stock for this item.' : 'Couldn’t update the cart. Try again.'); });
      return;
    }
    var m = t.closest('[data-cw-method]');
    if (m) { method = m.getAttribute('data-cw-method'); picked = true; paintPay(); paintBill(); paintFoot(); showErr(''); tk('payment', { phone: formData().phone || undefined }); }
  }

  function isCheckoutBtn(t) {
    return t.closest('[name="checkout"],a[href$="/checkout"],a[href*="/checkout?"],form[action$="/checkout"] [type="submit"],[data-cw-checkout]');
  }
  function hookStore() {
    document.addEventListener('click', function (e) {
      if (!CFG || !CFG.on || e.defaultPrevented && !e.__cw) return;
      var t = e.target; if (!t || !t.closest || t.closest('.cwx-root')) return;
      if (isCheckoutBtn(t)) { e.preventDefault(); e.stopImmediatePropagation(); openSheet('checkout', t); return; }
      var buy = t.closest('.shopify-payment-button__button,.shopify-payment-button button,[data-shopify="payment-button"] button');
      if (buy) {
        e.preventDefault(); e.stopImmediatePropagation();
        var form = buy.closest('form') || $('form[action*="/cart/add"]');
        var fd = form ? new FormData(form) : null; if (!fd || !fd.get('id')) return;
        if (!fd.get('quantity')) fd.set('quantity', '1');
        nativeFetch(R + 'cart/add.js', { method: 'POST', body: fd, headers: { Accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (r) { if (!r.ok) throw new Error('add'); return getCart(); }).then(function (c) { tk('cart', { cart: cartLite(c) }); openSheet('checkout', buy); })
          .catch(function () { location.href = R + 'cart'; });
        return;
      }
      var cartLink = t.closest('a[href$="/cart"],a[href*="/cart?"],[data-cw-cart]');
      if (cartLink && !/\/cart\/add/.test(cartLink.getAttribute('href') || '')) { e.preventDefault(); e.stopImmediatePropagation(); openSheet('cart', cartLink); }
    }, true);
    document.addEventListener('submit', function (e) {
      if (!CFG || !CFG.on) return;
      var f = e.target; if (!f || !f.action || f.closest('.cwx-root')) return;
      if (/\/cart\/?$/.test(f.action) && e.submitter && e.submitter.name === 'checkout') { e.preventDefault(); e.stopImmediatePropagation(); openSheet('checkout', e.submitter); return; }
      if (!/\/cart\/add/.test(f.action)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      var fd = new FormData(f); if (!fd.get('quantity')) fd.set('quantity', '1');
      var btn = e.submitter || $('[type="submit"]', f); if (btn) btn.setAttribute('aria-busy', 'true');
      nativeFetch(R + 'cart/add.js', { method: 'POST', body: fd, headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) {
        if (btn) btn.removeAttribute('aria-busy');
        if (!r.ok) return r.json().then(function (j) { alert(j.description || 'This item could not be added.'); });
        return getCart().then(function (c) {
          tk('cart', { cart: cartLite(c) });
          if (CFG.open_on_add) openSheet('cart', btn); else bump(btn);
        });
      }).catch(function () { if (btn) btn.removeAttribute('aria-busy'); HTMLFormElement.prototype.submit.call(f); });
    }, true);
    if (/\/cart\/?$/.test(location.pathname) && qs.get('cw_off') !== '1') getCart().then(function (c) { if (c.item_count) openSheet('cart'); });
  }

  /* WhatsApp follow-up link: ?cwr=<session> puts the saved cart back and opens checkout with the details filled in */
  function restore() {
    var r = qs.get('cwr'); if (!r) return Promise.resolve();
    return api('restore?sid=' + encodeURIComponent(r)).then(function (j) {
      if (!j.ok) return;
      var nm = String(j.name || '').split(' ');
      store('cw_restore', { phone: j.phone, pincode: j.pincode, first_name: nm[0] || '', last_name: nm.slice(1).join(' ') });
      return getCart().then(function (c) {
        var have = {}; c.items.forEach(function (i) { have[i.variant_id] = 1; });
        var add = (j.cart || []).filter(function (i) { return i.v && !have[i.v]; }).map(function (i) { return { id: Number(i.v), quantity: i.q }; });
        return (add.length ? cartPost('cart/add.js', { items: add }).catch(function () {}) : Promise.resolve()).then(getCart).then(function (c2) { if (c2.item_count) openSheet('checkout'); });
      });
    }).catch(function () {});
  }

  /* Back from PayU: ?cw_done=<order name> shows the thank-you screen; ?cw_fail=1 reopens checkout with the error */
  function payuBack() {
    var ok = qs.get('cw_done'), bad = qs.get('cw_fail');
    if (!ok && !bad) return false;
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    var d = store('cw_buyer') || { first_name: '', phone: '' };
    if (ok) { method = 'online'; shell(); root.classList.add('is-open'); document.documentElement.style.overflow = 'hidden'; finish(ok === 'paid' ? { name: '' } : { name: ok }, d, ok === 'paid' ? 'Payment received. Your order is being confirmed.' : ''); }
    else getCart().then(function (c) { if (c.item_count) openSheet('checkout').then(function () { showErr('Payment not finished. Try again, or pick cash on delivery.'); }); });
    return true;
  }

  /* ---------- start ---------- */
  tk('visit');
  api('cfg').then(function (c) {
    if (!c || !c.ok) return;
    CFG = c;
    if (!CFG.on) { getCart().then(function (x) { if (x.item_count) tk('cart', { cart: cartLite(x) }); }).catch(function () {}); return; }
    css(CFG.color || '#111111');
    hookStore();
    getCart().catch(function () {});
    if (!payuBack()) restore();
  }).catch(function () {});
  window.CodWing = { open: function () { return openSheet('cart'); }, checkout: function () { return openSheet('checkout'); } };
})();
