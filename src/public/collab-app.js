/*
 * Ink Kulture creator collab checkout (barter). Runs on inkkulture.in/pages/collab (page body: <div id="ik-collab"></div>
 * + this script) and on ik-checkout.vercel.app/collab. Everything renders in shadow DOM so the store theme's CSS can't
 * touch it (and it can't touch the theme). API: /api/barter/* on ik-checkout (lib/barter.js).
 */
(function () {
  if (window.__ikCollab) return; window.__ikCollab = 1;
  var ORIGIN = 'https://ik-checkout.vercel.app';
  var API = (location.hostname.indexOf('ik-checkout') > -1 ? '' : ORIGIN) + '/api/barter/';
  var LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="56 56 3983 858" role="img" aria-label="Ink Kulture"><path fill="currentColor" fill-rule="evenodd" d="M 4039 154 L 3772 153 L 3666 375 L 3546 609 L 3546 617 L 3834 615 L 3881 522 L 3725 522 L 3723 518 L 3762 441 L 3881 441 L 3926 360 L 3930 346 L 3813 344 L 3861 251 L 3991 251 Z M 3688 177 L 3674 162 L 3646 153 L 3403 153 L 3162 616 L 3291 617 L 3383 446 L 3379 617 L 3505 617 L 3505 442 L 3554 434 L 3589 413 L 3604 395 L 3693 224 L 3698 203 Z M 3544 255 L 3544 259 L 3541 261 L 3539 269 L 3536 271 L 3532 283 L 3529 285 L 3529 288 L 3522 297 L 3522 300 L 3520 301 L 3520 304 L 3515 311 L 3515 314 L 3513 315 L 3513 318 L 3510 321 L 3511 322 L 3508 325 L 3506 332 L 3501 337 L 3501 340 L 3498 343 L 3490 343 L 3487 346 L 3436 346 L 3434 344 L 3434 342 L 3437 339 L 3437 336 L 3439 335 L 3441 327 L 3444 325 L 3444 322 L 3448 319 L 3448 316 L 3451 313 L 3451 310 L 3453 309 L 3453 306 L 3455 305 L 3455 302 L 3458 299 L 3458 296 L 3460 295 L 3460 292 L 3463 289 L 3462 288 L 3465 285 L 3467 278 L 3472 274 L 3474 266 L 3477 264 L 3477 261 L 3479 260 L 3482 251 L 3486 251 L 3487 253 L 3509 253 L 3511 251 L 3540 251 Z M 3350 154 L 3222 153 L 3038 504 L 3010 520 L 2959 520 L 2955 515 L 3143 161 L 3143 153 L 3012 153 L 2807 549 L 2805 577 L 2817 603 L 2853 620 L 3070 617 L 3114 594 L 3138 568 Z M 2969 153 L 2659 154 L 2612 240 L 2610 250 L 2703 251 L 2704 255 L 2525 595 L 2518 617 L 2649 615 L 2838 251 L 2921 251 L 2969 163 Z M 2562 153 L 2429 153 L 2424 158 L 2415 182 L 2335 336 L 2335 342 L 2196 609 L 2196 617 L 2468 615 L 2515 528 L 2515 522 L 2378 522 L 2376 518 L 2562 161 Z M 2376 153 L 2246 153 L 2064 507 L 2044 520 L 1985 520 L 1983 511 L 2167 161 L 2167 153 L 2036 153 L 1841 536 L 1834 579 L 1843 600 L 1884 620 L 2096 617 L 2146 591 L 2167 565 Z M 988 153 L 771 617 L 907 617 L 992 439 L 1025 617 L 1233 617 L 1233 611 L 1170 558 L 1135 379 L 1371 171 L 1384 153 L 1228 153 L 1048 324 L 1045 320 L 1123 163 L 1123 153 Z M 933 154 L 800 153 L 699 367 L 674 158 L 669 153 L 534 153 L 324 598 L 320 617 L 453 617 L 555 401 L 588 617 L 711 617 Z M 1541 56 L 1575 116 L 1326 617 L 1480 617 L 1584 415 L 1613 593 L 2051 914 L 1767 539 L 1729 380 L 2092 57 L 1913 56 L 1643 296 L 1756 58 Z M 522 56 L 270 57 L 270 62 L 313 113 L 303 145 L 122 554 L 100 578 L 56 612 L 57 617 L 295 617 L 295 611 L 269 577 L 269 553 L 432 196 L 462 118 L 523 62 Z"/></svg>';

  var CSS = [
    ':host{display:block;--ink:#0a0a0c;--paper:#f7f5f1;--card:#fff;--line:#e6e2da;--mut:#6b6760;--ok:#13804b;--bad:#b42318;--gold:#c8a15a;--r:18px;color:var(--ink);font:15px/1.5 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;text-align:left;letter-spacing:normal;text-transform:none}',
    '#app{container-type:inline-size;color:var(--ink)}',
    '*{box-sizing:border-box}',
    'a{color:inherit}',
    'button,input,select{font:inherit;color:var(--ink);-webkit-tap-highlight-color:transparent}',
    'button{cursor:pointer}',
    'p{margin:0}',
    '.serif{font-family:"Instrument Serif",Georgia,"Times New Roman",serif;font-weight:400}',
    /* hero */
    '.hero{background:var(--ink);color:#f7f5f1;position:relative;overflow:hidden;border-radius:24px;padding:40px 22px 30px}',
    '.hero:before{content:"";position:absolute;inset:-40%;background:radial-gradient(closest-side,rgba(200,161,90,.24),transparent 70%) 80% 10%/60% 60% no-repeat,radial-gradient(closest-side,rgba(255,255,255,.07),transparent 70%) 0% 100%/70% 70% no-repeat;pointer-events:none}',
    '.hero>*{position:relative}',
    '.hero .logo{display:block;height:17px;width:auto;color:#f7f5f1;margin:0 0 28px}',
    '.eyebrow{display:inline-flex;gap:8px;align-items:center;font:700 11px/1 Inter,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--gold)}',
    '.eyebrow:before{content:"";width:22px;height:1px;background:var(--gold)}',
    'h1{font-size:clamp(36px,9cqw,70px);line-height:1;letter-spacing:-.01em;margin:16px 0 16px;max-width:820px;color:#f7f5f1}',
    'h1 em{color:var(--gold)}',
    '.lede{font-size:16.5px;color:#cfcac1;max-width:560px;margin:0 0 24px}',
    '.deal{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid #2c2a27;border-radius:var(--r);overflow:hidden;max-width:760px}',
    '.deal>div{padding:15px 18px}',
    '.deal>div+div{border-left:1px solid #2c2a27}',
    '.deal .k{font:700 10.5px/1 Inter,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#8f8a81}',
    '.deal .v{font-size:29px;margin:8px 0 2px;line-height:1;color:#f7f5f1}',
    '.deal .s{font-size:13px;color:#a9a399}',
    '@container (max-width:620px){.deal{grid-template-columns:1fr}.deal>div+div{border-left:0;border-top:1px solid #2c2a27}.hero{padding:30px 18px 24px;border-radius:20px}}',
    '.btn{appearance:none;-webkit-appearance:none;border:0;border-radius:999px;background:var(--ink);color:#fff;font:600 15px/1 Inter,sans-serif;padding:15px 22px;display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;min-height:50px}',
    '.btn.light{background:#f7f5f1;color:var(--ink)}',
    '.btn.ghost{background:transparent;color:var(--ink);border:1.5px solid var(--ink)}',
    '.btn.full{width:100%}',
    '.btn[disabled]{opacity:.4;cursor:default}',
    '.mine{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;background:#fff4e0;border:1px solid #f1d9ad;border-radius:16px;padding:14px 16px;margin:14px 0 0;font-size:14px}',
    'section{padding:40px 0 4px;scroll-margin-top:90px}',
    'h2{font-size:clamp(28px,6cqw,40px);line-height:1.05;margin:0 0 6px;letter-spacing:-.01em;color:var(--ink)}',
    '.sub{color:var(--mut);margin:0 0 18px}',
    '.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}',
    '@container (max-width:760px){.steps{grid-template-columns:repeat(2,1fr)}}',
    '.step{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px}',
    '.step .n{font-size:34px;line-height:1;color:var(--gold)}',
    '.step b{display:block;margin:10px 0 4px}',
    '.step p{color:var(--mut);font-size:13.5px}',
    '.terms{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:4px 18px;margin:14px 0 0;list-style:none}',
    '.terms li{padding:10px 0;border-bottom:1px solid var(--line);display:flex;gap:10px;font-size:14px}',
    '.terms li:last-child{border:0}',
    '.terms li:before{content:"\\2726";color:var(--gold);flex:none}',
    /* catalogue */
    '.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 14px}',
    '.search{flex:1 1 220px;min-width:0;border:1px solid var(--line);background:#fff;border-radius:999px;padding:12px 16px;font-size:16px;outline:none;-webkit-appearance:none;appearance:none}',
    '.search:focus{border-color:var(--ink)}',
    '.chips{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;flex:1 1 auto}',
    '.chips::-webkit-scrollbar{display:none}',
    '.chip{appearance:none;-webkit-appearance:none;border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:999px;padding:9px 15px;font-size:13.5px;white-space:nowrap;flex:none}',
    '.chip.on{background:var(--ink);color:#fff;border-color:var(--ink)}',
    '.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}',
    '@container (max-width:860px){.grid{grid-template-columns:repeat(3,1fr)}}',
    '@container (max-width:560px){.grid{grid-template-columns:repeat(2,1fr);gap:10px}}',
    '.p{appearance:none;-webkit-appearance:none;position:relative;display:block;width:100%;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:16px;overflow:hidden;text-align:left;padding:0;transition:transform .15s,border-color .15s,box-shadow .15s}',
    '@media(hover:hover){.p:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(10,10,12,.07)}}',
    '.p .img{display:block;width:100%;aspect-ratio:1/1;object-fit:contain;background:#fff;padding:9%}',
    '.p .t{padding:10px 12px 12px;border-top:1px solid #f0ede7}',
    '.p .nm{font-weight:600;font-size:14px;line-height:1.25;color:var(--ink)}',
    '.p .sz{color:var(--mut);font-size:12.5px;margin-top:3px}',
    '.p .mark{position:absolute;top:9px;right:9px;width:30px;height:30px;border-radius:50%;background:#fff;color:var(--ink);border:1px solid var(--line);display:grid;place-items:center;font-weight:700;font-size:15px;line-height:1}',
    '.p.on{border-color:var(--ink);box-shadow:0 0 0 2px var(--ink) inset}',
    '.p.on .mark{background:var(--ink);color:#fff;border-color:var(--ink)}',
    '.p.dim{opacity:.45}',
    '.more{display:flex;justify-content:center;margin:18px 0}',
    '.skel{aspect-ratio:1/1.25;border-radius:16px;background:linear-gradient(90deg,#ece8e1,#f4f1ec,#ece8e1);background-size:200% 100%;animation:sk 1.2s infinite}',
    '@keyframes sk{to{background-position:-200% 0}}',
    /* overlay: sticky bar + checkout sheet */
    '.bar{position:fixed;left:0;right:0;bottom:0;z-index:5;padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:rgba(10,10,12,.96);color:#fff;transform:translateY(110%);transition:transform .25s;font:15px/1.4 Inter,system-ui,sans-serif}',
    '.bar.show{transform:none}',
    '.bar .in{max-width:1100px;margin:0 auto;display:flex;align-items:center;gap:12px}',
    '.thumbs{display:flex;gap:6px;flex:1;min-width:0;overflow:hidden}',
    '.thumbs img{width:38px;height:38px;border-radius:9px;object-fit:contain;background:#fff;padding:3px;flex:none}',
    '.bar .cnt{font-size:13px;color:#cfcac1;white-space:nowrap}',
    '.sheet{position:fixed;inset:0;z-index:6;display:none;font:15px/1.5 Inter,system-ui,sans-serif;color:var(--ink)}',
    '.sheet.show{display:block}',
    '.sheet .bg{position:absolute;inset:0;background:rgba(10,10,12,.55)}',
    '.sheet .pan{position:absolute;right:0;top:0;bottom:0;width:min(520px,100%);background:var(--paper);overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;animation:in .25s ease}',
    '@keyframes in{from{transform:translateX(30px);opacity:0}to{transform:none;opacity:1}}',
    '.pan .hd{position:sticky;top:0;background:var(--paper);display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line);z-index:2}',
    '.pan .hd b{flex:1;font-size:16px}',
    '.x{appearance:none;-webkit-appearance:none;border:0;background:transparent;font-size:28px;line-height:1;padding:4px 8px;color:var(--ink)}',
    '.pan .bd{padding:18px 18px calc(30px + env(safe-area-inset-bottom))}',
    '.sum{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}',
    '.sum div{display:flex;gap:8px;align-items:center;background:#fff;border:1px solid var(--line);border-radius:12px;padding:6px 10px 6px 6px;font-size:13px}',
    '.sum img{width:34px;height:34px;border-radius:8px;object-fit:contain;background:#fff}',
    'label.f{display:block;margin:0 0 12px}',
    'label.f>span{display:block;font-size:12.5px;font-weight:600;margin:0 0 5px}',
    'label.f small{display:block;color:var(--mut);font-size:12px;margin-top:4px}',
    'input.i,select.i{width:100%;border:1px solid var(--line);background:#fff;border-radius:12px;padding:13px 14px;font-size:16px;outline:none;-webkit-appearance:none;appearance:none;min-height:48px}',
    'select.i{background:#fff url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27%3E%3Cpath d=%27M1 1l5 5 5-5%27 fill=%27none%27 stroke=%27%230a0a0c%27 stroke-width=%271.6%27/%3E%3C/svg%3E") no-repeat right 14px center;padding-right:34px}',
    'input.i:focus,select.i:focus{border-color:var(--ink)}',
    '.row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '.pre{position:relative;display:block}',
    '.pre i{position:absolute;left:14px;top:50%;transform:translateY(-50%);font-style:normal;color:var(--mut)}',
    '.pre input{padding-left:42px}',
    '.pre.ig input{padding-left:32px}',
    '.err{color:var(--bad);font-size:13.5px;margin:6px 0 10px}',
    '.okline{color:var(--ok)!important;font-weight:600}',
    '.badline{color:var(--bad)!important;font-weight:600}',
    '.box{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px;margin:6px 0 14px}',
    '.box .sub{margin:4px 0 0;font-size:13.5px}',
    '.dates{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}',
    '.agree{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;margin:12px 0 4px}',
    '.agree input{width:20px;height:20px;margin:1px 0 0;flex:none;accent-color:#0a0a0c}',
    '.mini{list-style:none;padding:0;margin:6px 0 0}',
    '.mini li{font-size:13px;padding:6px 0;display:flex;gap:8px}',
    '.mini li:before{content:"\\2726";color:var(--gold);flex:none}',
    '.otp{letter-spacing:.5em;text-align:center;font-size:24px!important;font-weight:700}',
    '.done{text-align:center;padding:16px 2px}',
    '.done .id{font-size:clamp(46px,14vw,64px);line-height:1;margin:10px 0 4px;letter-spacing:.02em}',
    '.pill{display:inline-block;background:#fff4e0;color:#8a4b00;border-radius:999px;padding:6px 12px;font-size:12.5px;font-weight:700}',
    '.done ol{text-align:left;margin:18px 0;padding-left:20px}',
    '.done ol li{margin:7px 0}',
    '.link{appearance:none;-webkit-appearance:none;background:none;border:0;color:var(--mut);text-decoration:underline;padding:6px;font-size:14px}',
  ].join('\n');

  var STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ls(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function img(u, w) { return u ? u + (u.indexOf('?') > -1 ? '&' : '?') + 'width=' + (w || 500) : ''; }
  function nice(iso) { if (!iso) return ''; var d = new Date(iso + 'T12:00:00+05:30'); return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }); }
  function addDays(iso, n) { return new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10); }

  function boot() {
    var mount = document.getElementById('ik-collab');
    if (!mount || mount.shadowRoot) return;
    /* page chrome: fonts, the store's own page title hidden, floating help buttons out of the way of the bar */
    var head = document.head;
    if (!document.querySelector('link[data-ikc-font]')) {
      var l = document.createElement('link'); l.rel = 'stylesheet'; l.setAttribute('data-ikc-font', '1');
      l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap'; head.appendChild(l);
    }
    var g = document.createElement('style');
    g.textContent = 'html.ikc-bar .iks-fab,html.ikc-open .iks-fab{display:none!important}html.ikc-open{overflow:hidden}#ik-collab{display:block;margin:0 auto;max-width:1100px;width:100%}';
    head.appendChild(g);
    var main = mount.closest('main') || document.body;
    [].forEach.call(main.querySelectorAll('h1'), function (h) { if (!mount.contains(h)) h.style.display = 'none'; });
    [].forEach.call(mount.parentNode.children, function (el) { if (el !== mount && el.tagName !== 'SCRIPT') el.style.display = 'none'; });   /* fallback text */

    mount.innerHTML = '';
    var R1 = mount.attachShadow({ mode: 'open' });
    var host2 = document.createElement('div');
    host2.style.cssText = 'position:relative;z-index:2147483000';
    document.body.appendChild(host2);
    var R2 = host2.attachShadow({ mode: 'open' });
    R1.innerHTML = '<style>' + CSS + '</style><div id="app"></div>';
    R2.innerHTML = '<style>' + CSS + '</style>' +
      '<div class="bar" id="bar"><div class="in"><div class="thumbs" id="thumbs"></div><span class="cnt" id="cnt"></span><button class="btn light" id="go" style="min-height:44px;padding:12px 18px">Continue</button></div></div>' +
      '<div class="sheet" id="sheet"><div class="bg" data-close></div><div class="pan"><div class="hd"><b id="sht">Your collab order</b><button class="x" data-close aria-label="Close">&times;</button></div><div class="bd" id="sbd"></div></div></div>';
    function $(s) { return R1.querySelector(s) || R2.querySelector(s); }
    function $$(s) { return [].slice.call(R1.querySelectorAll(s)).concat([].slice.call(R2.querySelectorAll(s))); }

    var MAX = 4, ITEMS = [], PICK = [], FILTER = '', SHOWN = 24, TOKEN = '', PHONE = '', EST = null, POST = '', TERMS = [];
    function call(p, body, get) {
      return fetch(API + p, { method: get ? 'GET' : 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}), body: get ? undefined : JSON.stringify(body || {}) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'Something went wrong, please try again' }; }); })
        .catch(function () { return { ok: false, error: 'Network error, please check your internet and try again' }; });
    }

    $('#app').innerHTML =
      '<div class="hero">' + LOGO.replace('<svg ', '<svg class="logo" ') +
      '<span class="eyebrow">Creator collab</span>' +
      '<h1 class="serif">Help a small Indian brand grow with the <em>magic</em> of your content.</h1>' +
      '<p class="lede">We are a tiny team making semi-permanent tattoos in India. Pick the designs you love, we send them to you free, and you show the world how they look on you.</p>' +
      '<div class="deal"><div><div class="k">You pick</div><div class="v serif">Up to 4</div><div class="s">tattoos of your choice</div></div>' +
      '<div><div class="k">You pay</div><div class="v serif">&#8377;0</div><div class="s">free delivery to your door</div></div>' +
      '<div><div class="k">You post</div><div class="v serif">1 reel + 1 story</div><div class="s">4 to 10 days after delivery</div></div></div>' +
      '<p style="margin:24px 0 0"><button class="btn light" id="jump">Pick your tattoos &darr;</button></p></div>' +
      '<div id="mine"></div>' +
      '<section><h2 class="serif">How it works</h2><p class="sub">Four simple steps. No payment, no app.</p><div class="steps">' +
      '<div class="step"><div class="n serif">01</div><b>Pick up to 4</b><p>Choose the designs you would actually wear on camera.</p></div>' +
      '<div class="step"><div class="n serif">02</div><b>Verify and check out</b><p>WhatsApp code, your Instagram, address and the date you will post.</p></div>' +
      '<div class="step"><div class="n serif">03</div><b>DM us your order ID</b><p>Send the ID (like IKC-1001) to @inkkulture.in on Instagram, in the chat where we spoke.</p></div>' +
      '<div class="step"><div class="n serif">04</div><b>We approve and ship</b><p>Once we see your DM, your tattoos are on the way. Track them on WhatsApp.</p></div>' +
      '</div><ul class="terms" id="terms"></ul></section>' +
      '<section id="pick"><h2 class="serif">Pick your tattoos</h2><p class="sub" id="picksub">Tap to select. Up to 4 designs.</p>' +
      '<div class="toolbar"><input class="search" id="q" type="search" placeholder="Search: lotus, script, dragon&hellip;" autocomplete="off">' +
      '<div class="chips"><button class="chip on" data-f="">All</button><button class="chip" data-f="small">Small</button><button class="chip" data-f="big">Big</button><button class="chip" data-f="band">Bands</button><button class="chip" data-f="script">Script</button></div></div>' +
      '<div class="grid" id="grid"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div><div class="more" id="more"></div></section>';
    $('#jump').onclick = function () { $('#pick').scrollIntoView({ behavior: 'smooth', block: 'start' }); };

    /* ---------- catalogue ---------- */
    function kind(it) {
      var s = (it.size || '').match(/([\d.]+)\s*[\u00d7x]\s*([\d.]+)/), area = s ? parseFloat(s[1]) * parseFloat(s[2]) : 0;
      return { small: area && area <= 40, big: area > 60, band: /band/i.test(it.title), script: /script|lettering|typography|mantra|word|quote/i.test(it.title) };
    }
    function visible() { var q = ($('#q').value || '').trim().toLowerCase(); return ITEMS.filter(function (it) { return (!q || it.title.toLowerCase().indexOf(q) > -1) && (!FILTER || kind(it)[FILTER]); }); }
    function render() {
      var list = visible(), full = PICK.length >= MAX;
      $('#grid').innerHTML = list.slice(0, SHOWN).map(function (it) {
        var on = PICK.indexOf(it.id) > -1;
        return '<button class="p' + (on ? ' on' : '') + (full && !on ? ' dim' : '') + '" data-id="' + it.id + '" aria-pressed="' + on + '">' + (it.image ? '<img class="img" loading="lazy" src="' + esc(img(it.image, 500)) + '" alt="">' : '<span class="img"></span>') + '<span class="mark">' + (on ? PICK.indexOf(it.id) + 1 : '+') + '</span><div class="t"><div class="nm">' + esc(it.title.split(' \u00b7 ')[0]) + '</div><div class="sz">' + esc(it.size || '') + '</div></div></button>';
      }).join('') || '<p class="sub">No designs match. Try another word.</p>';
      $('#more').innerHTML = list.length > SHOWN ? '<button class="btn ghost" id="mo">Show more (' + (list.length - SHOWN) + ')</button>' : '';
      if ($('#mo')) $('#mo').onclick = function () { SHOWN += 24; render(); };
      $$('.p').forEach(function (b) { b.onclick = function () { toggle(b.getAttribute('data-id')); }; });
      bar();
    }
    function toggle(id) {
      var i = PICK.indexOf(id);
      if (i > -1) PICK.splice(i, 1);
      else { if (PICK.length >= MAX) { flash('You can pick up to ' + MAX + ' tattoos. Tap one you picked to swap it.'); return; } PICK.push(id); }
      ls('ikc_pick', PICK); render();
    }
    function flash(m) { var s = $('#picksub'); s.textContent = m; s.style.color = 'var(--bad)'; clearTimeout(flash.t); flash.t = setTimeout(function () { s.textContent = 'Tap to select. Up to ' + MAX + ' designs.'; s.style.color = ''; }, 3200); }
    function picked() { return PICK.map(function (id) { return ITEMS.filter(function (x) { return x.id === id; })[0]; }).filter(Boolean); }
    function bar() {
      var p = picked();
      $('#bar').classList.toggle('show', p.length > 0);
      document.documentElement.classList.toggle('ikc-bar', p.length > 0);
      $('#thumbs').innerHTML = p.map(function (x) { return '<img src="' + esc(img(x.image, 96)) + '" alt="">'; }).join('');
      $('#cnt').textContent = p.length + ' of ' + MAX + ' picked';
    }
    $$('.chip[data-f]').forEach(function (c) { c.onclick = function () { $$('.chip[data-f]').forEach(function (x) { x.classList.remove('on'); }); c.classList.add('on'); FILTER = c.getAttribute('data-f'); SHOWN = 24; render(); }; });
    $('#q').oninput = function () { SHOWN = 24; render(); };

    /* ---------- checkout sheet ---------- */
    function open() { $('#sheet').classList.add('show'); document.documentElement.classList.add('ikc-open'); }
    function close() { $('#sheet').classList.remove('show'); document.documentElement.classList.remove('ikc-open'); }
    $$('[data-close]').forEach(function (x) { x.onclick = close; });
    $('#go').onclick = function () { if (!picked().length) return; TOKEN = ls('ikc_tok') || ''; PHONE = ls('ikc_phone') || ''; open(); if (TOKEN) form(); else login(); };
    function sum() { return '<div class="sum">' + picked().map(function (x) { return '<div><img src="' + esc(img(x.image, 96)) + '" alt="">' + esc(x.title.split(' \u00b7 ')[0]) + '</div>'; }).join('') + '</div>'; }

    function login() {
      $('#sht').textContent = 'Verify your WhatsApp';
      $('#sbd').innerHTML = sum() + '<label class="f"><span>WhatsApp number</span><div class="pre"><i>+91</i><input class="i" id="ph" type="tel" inputmode="numeric" maxlength="10" autocomplete="tel-national" placeholder="10-digit number" value="' + esc(PHONE) + '"></div><small>We send a 4-digit code on WhatsApp. Order updates come here too.</small></label><div class="err" id="er"></div><button class="btn full" id="snd">Send code on WhatsApp</button>';
      $('#snd').onclick = function () {
        var p = $('#ph').value.replace(/\D/g, '').slice(-10);
        if (p.length !== 10) { $('#er').textContent = 'Enter your 10-digit WhatsApp number'; return; }
        var b = this; b.disabled = true; b.textContent = 'Sending\u2026';
        call('otp', { phone: p }).then(function (r) {
          if (!r.ok) { b.disabled = false; b.textContent = 'Send code on WhatsApp'; $('#er').textContent = r.error || 'Could not send the code'; return; }
          PHONE = p; ls('ikc_phone', p); code();
        });
      };
    }
    function code() {
      $('#sbd').innerHTML = '<p style="margin:0 0 14px">Enter the 4-digit code we sent on WhatsApp to <b>+91 ' + esc(PHONE) + '</b>.</p><label class="f"><input class="i otp" id="cd" type="tel" inputmode="numeric" maxlength="4" autocomplete="one-time-code" placeholder="\u2022\u2022\u2022\u2022"></label><div class="err" id="er"></div><button class="btn full" id="vf">Verify</button><p style="text-align:center;margin:10px 0 0"><button class="link" id="rs">Resend code</button> &middot; <button class="link" id="ch">Change number</button></p>';
      $('#cd').focus();
      $('#cd').oninput = function () { if (this.value.replace(/\D/g, '').length === 4) $('#vf').click(); };
      $('#vf').onclick = function () {
        var b = this; if (b.disabled) return; b.disabled = true; b.textContent = 'Checking\u2026';
        call('verify', { phone: PHONE, code: $('#cd').value }).then(function (r) {
          if (!r.ok) { b.disabled = false; b.textContent = 'Verify'; $('#er').textContent = r.error || 'Wrong code'; return; }
          TOKEN = r.token; ls('ikc_tok', TOKEN); form();
        });
      };
      $('#rs').onclick = function () { call('otp', { phone: PHONE }).then(function (r) { $('#er').textContent = r.ok ? 'New code sent' : r.error || 'Could not send'; }); };
      $('#ch').onclick = login;
    }
    function form() {
      $('#sht').textContent = 'Your collab order';
      var d = ls('ikc_form') || {};
      $('#sbd').innerHTML = sum() +
        '<label class="f"><span>Your name</span><input class="i" id="nm" autocomplete="name" value="' + esc(d.name || '') + '"></label>' +
        '<label class="f"><span>Instagram username</span><div class="pre ig"><i>@</i><input class="i" id="ig" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="yourhandle" value="' + esc(d.instagram || '') + '"></div><small>The account you will post from.</small></label>' +
        '<label class="f"><span>Email</span><input class="i" id="em" type="email" autocomplete="email" value="' + esc(d.email || '') + '"></label>' +
        '<label class="f"><span>PIN code</span><input class="i" id="pin" type="tel" inputmode="numeric" maxlength="6" autocomplete="postal-code" value="' + esc(d.pincode || '') + '"><small id="eddl"></small></label>' +
        '<label class="f"><span>House / flat, street</span><input class="i" id="a1" autocomplete="address-line1" value="' + esc(d.address1 || '') + '"></label>' +
        '<label class="f"><span>Area, landmark (optional)</span><input class="i" id="a2" autocomplete="address-line2" value="' + esc(d.address2 || '') + '"></label>' +
        '<div class="row2"><label class="f"><span>City</span><input class="i" id="ct" autocomplete="address-level2" value="' + esc(d.city || '') + '"></label><label class="f"><span>State</span><select class="i" id="stt"><option value="">Select</option>' + STATES.map(function (s) { return '<option' + (s === d.state ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></label></div>' +
        '<div class="box" id="pd"></div>' +
        '<div class="box"><b>The collab</b><ul class="mini">' + TERMS.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul><label class="agree"><input type="checkbox" id="ag"><span>I agree: 1 reel + 1 Instagram story tagging @inkkulture.in, with commercial rights for Ink Kulture to reuse them.</span></label></div>' +
        '<div class="err" id="er"></div><button class="btn full" id="pl">Place collab order &middot; &#8377;0</button><p style="text-align:center;margin:10px 0 0;font-size:12.5px;color:var(--mut)">Verified as +91 ' + esc(PHONE) + ' &middot; <button class="link" id="lo" style="padding:0;font-size:12.5px">change</button></p>';
      dates();
      $('#lo').onclick = function () { TOKEN = ''; ls('ikc_tok', null); login(); };
      var save = function () { ls('ikc_form', { name: $('#nm').value, instagram: $('#ig').value, email: $('#em').value, pincode: $('#pin').value, address1: $('#a1').value, address2: $('#a2').value, city: $('#ct').value, state: $('#stt').value }); };
      $('#sbd').oninput = save; $('#sbd').onchange = save;
      $('#pin').oninput = function () { var p = this.value.replace(/\D/g, ''); this.value = p; if (p.length === 6) edd(p); else { EST = null; $('#eddl').textContent = ''; dates(); } };
      if (/^\d{6}$/.test(d.pincode || '')) edd(d.pincode);
      $('#pl').onclick = place;
    }
    function edd(pin) {
      $('#eddl').className = ''; $('#eddl').textContent = 'Checking delivery\u2026';
      call('edd?pin=' + pin, null, true).then(function (r) {
        if (!$('#pin') || $('#pin').value !== pin) return;
        if (!r.ok) { EST = null; $('#eddl').textContent = r.error || ''; dates(); return; }
        if (!r.serviceable) { EST = null; $('#eddl').className = 'badline'; $('#eddl').textContent = "Sorry, we can't deliver to this PIN code yet."; dates(); return; }
        EST = r; $('#eddl').className = 'okline'; $('#eddl').textContent = r.edd ? 'Delivery by ' + r.edd : 'We deliver here';
        if (r.city && !$('#ct').value) $('#ct').value = r.city;
        if (r.state) { var m = STATES.filter(function (s) { return s.toLowerCase() === String(r.state).toLowerCase(); })[0]; if (m && !$('#stt').value) $('#stt').value = m; }
        dates();
      });
    }
    function dates() {
      var box = $('#pd');
      if (!EST || !EST.window) { box.innerHTML = '<b>When will you post the reel?</b><p class="sub">Enter your PIN code first to see your delivery date.</p>'; POST = ''; return; }
      var w = EST.window; if (!POST || POST < w.min || POST > w.max) POST = w.def;
      var opts = [4, 6, 8, 10].map(function (n) { var iso = addDays(EST.date || w.min, n); return iso >= w.min && iso <= w.max ? '<button type="button" class="chip' + (iso === POST ? ' on' : '') + '" data-d="' + iso + '">' + nice(iso) + (n === 6 ? ' &#9733;' : '') + '</button>' : ''; }).join('');
      box.innerHTML = '<b>When will you post the reel?</b><p class="sub">Your tattoos arrive by <b style="color:var(--ink)">' + esc(EST.edd || nice(EST.date)) + '</b>. Post 4 to 10 days after that, so the tattoo has settled in and looks its best. 6 days is perfect.</p><div class="dates">' + opts + '</div><label class="f" style="margin:0"><span>Or pick a date</span><input class="i" type="date" id="pdt" min="' + w.min + '" max="' + w.max + '" value="' + POST + '"></label>';
      [].forEach.call(box.querySelectorAll('[data-d]'), function (c) { c.onclick = function () { POST = c.getAttribute('data-d'); dates(); }; });
      $('#pdt').onchange = function () { var v = this.value; if (v >= w.min && v <= w.max) { POST = v; dates(); } else this.value = POST; };
    }
    function place() {
      var er = $('#er'), b = $('#pl'); er.textContent = '';
      var body = { items: PICK.map(function (id) { return { id: id, qty: 1 }; }), name: $('#nm').value, instagram: $('#ig').value, email: $('#em').value, pincode: $('#pin').value, address1: $('#a1').value, address2: $('#a2').value, city: $('#ct').value, state: $('#stt').value, post_date: POST, agree: $('#ag').checked };
      if (!POST) { er.textContent = 'Enter your PIN code and pick the date you will post the reel'; return; }
      if (!body.agree) { er.textContent = 'Please accept the collab terms'; return; }
      b.disabled = true; b.textContent = 'Placing\u2026';
      call('order', body).then(function (r) {
        if (r.auth) { TOKEN = ''; ls('ikc_tok', null); login(); return; }
        if (!r.ok) { b.disabled = false; b.innerHTML = 'Place collab order &middot; &#8377;0'; er.textContent = r.error || 'Something went wrong'; return; }
        r.at = Date.now(); ls('ikc_done', r); ls('ikc_pick', null); PICK = []; render(); mine(); done(r);
      });
    }
    function done(r) {
      open(); $('#sht').textContent = 'Almost done';
      $('#sbd').innerHTML = '<div class="done"><span class="pill">Waiting for your DM</span><p style="margin:16px 0 0;color:var(--mut)">Your collab order ID</p><div class="id serif">' + esc(r.ref) + '</div><button class="link" id="cp">Copy ID</button>' +
        '<a class="btn full" style="margin-top:14px" href="https://ig.me/m/inkkulture.in" target="_blank" rel="noopener">DM this ID to @inkkulture.in</a>' +
        '<ol><li>Send <b>' + esc(r.ref) + '</b> to <b>@inkkulture.in</b> on Instagram, in the chat where we connected.</li><li>We approve it there and ship your tattoos' + (r.edd ? ' (delivery by <b>' + esc(r.edd) + '</b>)' : '') + '. Updates come on WhatsApp.</li><li>Post your reel + story on <b>' + esc(nice(r.post_date)) + '</b>, tagging @inkkulture.in.</li></ol>' +
        '<p style="font-size:13px;color:var(--mut)">Orders are not shipped until we get your DM.</p><button class="link" id="nw">Close</button></div>';
      $('#cp').onclick = function () { var t = this; try { navigator.clipboard.writeText(r.ref).then(function () { t.textContent = 'Copied \u2713'; }); } catch (e) { /* ignore */ } };
      $('#nw').onclick = close;
    }
    function mine() {
      var d = ls('ikc_done');
      if (!d || !d.ref || Date.now() - (d.at || 0) > 7 * 864e5) { $('#mine').innerHTML = ''; return; }
      $('#mine').innerHTML = '<div class="mine"><span>Your collab order <b>' + esc(d.ref) + '</b> is waiting. DM this ID to @inkkulture.in on Instagram.</span><button class="btn" id="mshow" style="min-height:40px;padding:10px 16px;font-size:14px">Show</button></div>';
      $('#mshow').onclick = function () { done(d); };
    }

    /* ---------- start ---------- */
    mine();
    fetch(API + 'catalogue').then(function (r) { return r.json(); }).then(function (r) {
      if (!r.ok) throw new Error(r.error);
      ITEMS = r.items; MAX = r.max || 4; TERMS = r.terms || [];
      $('#terms').innerHTML = TERMS.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
      PICK = (ls('ikc_pick') || []).filter(function (id) { return ITEMS.some(function (x) { return x.id === id; }); }).slice(0, MAX);
      render();
    }).catch(function () { $('#grid').innerHTML = '<p class="sub">Could not load the designs. Please refresh the page.</p>'; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
