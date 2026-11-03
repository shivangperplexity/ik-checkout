/* The embedded admin dashboard (app.codwing.com inside Shopify admin). App Bridge adds the session token to
   same-origin fetches. ?demo=1 shows sample data without Shopify (for previews and the sales page). */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="shopify-api-key" content="__API_KEY__">
<title>CodWing</title>
<!--AB--><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script><!--/AB-->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap">
<style>
:root{--bg:#f3f5fd;--card:#fff;--line:#d9def0;--line-strong:#7f86b0;--ink:#04032e;--muted:#525a82;--wing:#224ff2;--sky:#3e8bf4;--indigo:#070655;--wing-soft:#e6ecfe;--go:#0a7a4f;--go-soft:#e2f5ec;--risk:#a14a05;--risk-soft:#fdf0dc;--bad:#c0262d;--bad-soft:#fdeaea;--wa:#128c4a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:20px 16px 96px}
h1,h2,h3{font-family:Poppins,"Plus Jakarta Sans",system-ui,sans-serif;margin:0;letter-spacing:-.01em}
h1{font-size:22px}h2{font-size:17px}h3{font-size:15px}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.sub{color:var(--muted);margin:2px 0 0;font-size:13.5px}
.tabs{display:flex;gap:4px;overflow-x:auto;margin:0 -16px 16px;padding:0 16px;border-bottom:1px solid var(--line);scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:none;font:inherit;font-weight:700;font-size:14px;color:var(--muted);background:none;border:0;border-bottom:3px solid transparent;padding:10px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.tab.is-on{color:var(--wing);border-bottom-color:var(--wing)}
.tab .n{font-size:11px;background:var(--wing);color:#fff;border-radius:99px;padding:1px 7px}
.view[hidden]{display:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-bottom:14px}
.card p.help{color:var(--muted);font-size:13px;margin:4px 0 14px}
.card .top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:640px){.grid{grid-template-columns:1fr}}
label.f{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600}
input,select{font:inherit;font-weight:400;height:42px;padding:0 12px;border:1.5px solid var(--line-strong);border-radius:10px;background:#fff;color:var(--ink);width:100%}
input[type=color]{padding:3px;width:64px}
input:focus,select:focus{outline:none;border-color:var(--wing);box-shadow:0 0 0 3px var(--wing-soft)}
.lt{display:block;min-height:18px}
.hint{font-weight:500;color:var(--muted);font-size:12px}.set{color:var(--go)}
.row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row b{display:block}.row span.d{color:var(--muted);font-size:13px}
.switch{position:relative;width:46px;height:26px;flex:none}
.switch input{opacity:0;width:0;height:0;position:absolute}
.switch i{position:absolute;inset:0;border-radius:999px;background:#c9cee6;transition:background .16s}
.switch i::after{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;border-radius:50%;background:#fff;transition:transform .16s}
.switch input:checked+i{background:var(--wing)}.switch input:checked+i::after{transform:translateX(20px)}
.switch input:focus-visible+i{outline:2px solid var(--wing);outline-offset:2px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:4px 9px;border-radius:6px;white-space:nowrap}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.b-go{background:var(--go-soft);color:var(--go)}.b-risk{background:var(--risk-soft);color:var(--risk)}.b-bad{background:var(--bad-soft);color:var(--bad)}.b-info{background:var(--wing-soft);color:var(--wing)}
.btn{font:inherit;font-weight:700;font-size:14px;height:40px;padding:0 16px;border:0;border-radius:10px;background:var(--wing);color:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;text-decoration:none;white-space:nowrap}
.btn:hover{background:var(--indigo)}.btn[disabled]{opacity:.5;cursor:default}
.btn.ghost{background:#fff;color:var(--ink);border:1.5px solid var(--line-strong)}.btn.ghost:hover{border-color:var(--ink)}
.btn.wa{background:var(--wa)}.btn.wa:hover{background:#0b6b38}
.btn.sm{height:34px;padding:0 12px;font-size:13px}
.chips{display:inline-flex;background:#e9ecf8;border-radius:10px;padding:3px}
.chip{font:inherit;font-size:13px;font-weight:700;border:0;background:none;color:var(--muted);padding:6px 12px;border-radius:8px;cursor:pointer}
.chip.is-on{background:#fff;color:var(--ink);box-shadow:0 1px 3px rgba(4,3,46,.12)}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px}
@media (max-width:760px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{background:#fff;border:1px solid var(--line);border-radius:14px;padding:14px}
.kpi span{display:block;color:var(--muted);font-size:12.5px;font-weight:600}
.kpi b{display:block;font-family:Poppins,sans-serif;font-size:24px;margin-top:2px;font-variant-numeric:tabular-nums}
.kpi em{font-style:normal;font-size:12px;color:var(--muted)}
.funnel{display:grid;gap:8px}
.fr{display:grid;grid-template-columns:120px minmax(0,1fr) 64px;gap:10px;align-items:center;font-size:13.5px}
.fr .lbl{font-weight:700}
.fr .bar{height:26px;background:#eef1fb;border-radius:8px;overflow:hidden}
.fr .bar i{display:block;height:100%;background:linear-gradient(90deg,var(--wing),var(--sky));border-radius:8px;min-width:2px}
.fr .num{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
.drop{grid-column:2/4;font-size:12px;color:var(--bad);font-weight:600;margin:-4px 0 2px}
.drop.big{background:var(--bad-soft);padding:4px 8px;border-radius:6px;width:fit-content}
@media (max-width:520px){.fr{grid-template-columns:84px minmax(0,1fr) 48px}.drop{grid-column:1/4}}
.list{display:grid}
.li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;align-items:center;padding:12px 0;border-top:1px solid var(--line)}
.li:first-child{border-top:0}
.li .who{font-weight:700}.li .meta{color:var(--muted);font-size:12.5px}
.li .items{font-size:13px;color:#2b2f55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.li .act{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
.empty{color:var(--muted);font-size:14px;padding:18px 0;text-align:center}
.check{display:grid;gap:10px}
.ck{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:12px}
.ck .dot{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:13px;background:#eef1fb;color:var(--muted)}
.ck.ok .dot{background:var(--go-soft);color:var(--go)}
.ck b{display:block}.ck span{color:var(--muted);font-size:13px}
.code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0a33;color:#dfe5ff;padding:12px 14px;border-radius:10px;overflow-x:auto;white-space:pre}
.live{display:flex;flex-wrap:wrap;gap:8px}
.lv{display:inline-flex;align-items:center;gap:6px;background:#f6f7fd;border:1px solid var(--line);border-radius:999px;padding:5px 10px;font-size:12.5px}
.lv i{width:8px;height:8px;border-radius:50%;background:var(--go);box-shadow:0 0 0 3px var(--go-soft)}
.bar-save{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--line);padding:12px 16px}
.bar-save[hidden]{display:none}
.bar-save .in{max-width:1040px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;gap:12px}
.msg{color:var(--muted);font-size:13px}
.err{background:var(--bad-soft);color:var(--bad);border-radius:10px;padding:12px 14px;margin-bottom:14px;display:none}
.pg[hidden],.pp[hidden],#sf[hidden]{display:none!important}
.ship-bar{position:sticky;top:0;z-index:3;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#fff;border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:12px}
.ship-bar .msg{flex:1;min-width:140px}
.so{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:8px 12px;align-items:start;padding:12px 0;border-top:1px solid var(--line)}
.so:first-child{border-top:0}
.so input[type=checkbox]{width:20px;height:20px;margin:2px 0 0;accent-color:var(--wing)}
.so .who{font-weight:700}.so .meta{color:var(--muted);font-size:12.5px}
.so .act{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-items:center}
.rates{grid-column:2/4;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.rt{display:grid;grid-template-columns:minmax(0,1fr) 70px 70px auto;gap:8px;align-items:center;padding:8px 10px;border-top:1px solid var(--line);font-size:13px}
.rt:first-child{border-top:0}.rt.is-pick{background:var(--wing-soft)}
.rt b{font-weight:700}.rt .sc{color:var(--muted);font-size:12px}
@media (max-width:560px){.so{grid-template-columns:28px minmax(0,1fr)}.so .act{grid-column:2;justify-content:flex-start}.rates{grid-column:1/3}.li{grid-template-columns:1fr}.li .act{justify-content:flex-start}}
@media (max-width:560px){.rt{grid-template-columns:minmax(0,1fr) 60px auto}.rt .sc2{display:none}}
.cod{color:var(--risk);font-weight:700}.pre{color:var(--go);font-weight:700}
.demo{background:var(--indigo);color:#fff;border-radius:12px;padding:10px 14px;font-size:13px;margin-bottom:14px;display:none}
.demo a{color:#fff;font-weight:700}
</style>
</head>
<body>
<div class="wrap">
  <div class="demo" id="demoNote">Sample data. This is how your CodWing dashboard looks once your store is connected. <a href="/demo" target="_blank">Try the demo checkout</a></div>
  <div class="head">
    <div><h1 id="storeName">CodWing</h1><p class="sub" id="shopline">Loading your store…</p></div>
    <span class="badge b-risk" id="status">Setting up</span>
  </div>
  <div class="err" id="err"></div>
  <nav class="tabs" role="tablist">
    <button class="tab is-on" data-tab="home" role="tab">Overview</button>
    <button class="tab" data-tab="carts" role="tab">Abandoned carts <span class="n" id="abN" hidden></span></button>
    <button class="tab" data-tab="orders" role="tab">Orders</button>
    <button class="tab" data-tab="ship" role="tab">Shipping <span class="n" id="shipN" hidden></span></button>
    <button class="tab" data-tab="settings" role="tab">Settings</button>
    <button class="tab" data-tab="install" role="tab">Install</button>
  </nav>

  <section class="view" data-view="home">
    <div class="card" id="setupCard">
      <div class="top"><h2>Get set up</h2><span class="hint" id="setupCount"></span></div>
      <div class="check" id="checklist"></div>
    </div>
    <div class="top" style="display:flex;justify-content:space-between;align-items:center;margin:4px 0 12px;gap:10px;flex-wrap:wrap">
      <h2>How your store is doing</h2>
      <div class="chips" id="range"><button class="chip is-on" data-d="1">Today</button><button class="chip" data-d="7">7 days</button><button class="chip" data-d="30">30 days</button></div>
    </div>
    <div class="kpis" id="kpis"></div>
    <div class="grid">
      <div class="card"><div class="top"><h2>Where buyers drop off</h2></div><div class="funnel" id="funnel"></div></div>
      <div class="card"><div class="top"><h2>On your store now</h2><span class="hint">last 5 minutes</span></div><div id="live"></div>
        <div class="top" style="margin:18px 0 8px"><h2>Follow up today</h2><button class="btn ghost sm" data-go="carts">See all</button></div><div class="list" id="abTop"></div></div>
    </div>
  </section>

  <section class="view" data-view="carts" hidden>
    <div class="card">
      <div class="top"><div><h2>Abandoned checkouts</h2><p class="help" style="margin:2px 0 0">People who gave their number but did not order. Tap WhatsApp to send them their saved cart from your own WhatsApp.</p></div>
      <div class="chips" id="range2"><button class="chip is-on" data-d="1">Today</button><button class="chip" data-d="7">7 days</button><button class="chip" data-d="30">30 days</button></div></div>
      <div class="list" id="abList"></div>
    </div>
  </section>

  <section class="view" data-view="orders" hidden>
    <div class="card"><div class="top"><h2>Orders from CodWing checkout</h2></div><div class="list" id="orderList"></div></div>
  </section>

  <section class="view" data-view="ship" hidden>
    <div class="card" id="shipConnect">
      <div class="top"><div><h2>Shipping account</h2><p class="help" style="margin:2px 0 0">Your own Shiprocket or ShipPrime account. Courier charges are billed by them, to you.</p></div><span style="display:flex;gap:8px;align-items:center"><button type="button" class="btn ghost sm" id="shipEdit" hidden>Change</button><span class="badge b-risk" id="shipState">Not connected</span></span></div>
      <form id="sf" autocomplete="off">
        <div class="grid">
          <label class="f"><span class="lt">Ship with</span><select name="ship_provider" id="shipProv"><option value="none">Choose…</option><option value="shiprocket">Shiprocket</option><option value="shipprime">ShipPrime</option></select></label>
          <label class="f"><span class="lt">Courier choice</span><select name="ship_rule"><option value="rto">Fewest returns (RTO) for COD</option><option value="cheapest">Cheapest</option><option value="fastest">Fastest</option></select></label>
        </div>
        <div class="grid pp" data-pp="shiprocket" hidden style="margin-top:14px">
          <label class="f"><span class="lt">Shiprocket API user email</span><input name="sr_email" type="email" placeholder="api@yourstore.in"></label>
          <label class="f"><span class="lt">API user password <span class="hint" data-set="sr_password"></span></span><input name="sr_password" type="password" placeholder="Leave blank to keep the saved one"></label>
          <label class="f"><span class="lt">Pickup location <button type="button" class="btn ghost sm" id="loadPk" style="height:26px;margin-left:6px">Load from Shiprocket</button></span><select name="sr_pickup" id="srPickup"><option value="">Save login, then load</option></select></label>
          <p class="help" style="margin:0;align-self:end">Shiprocket → Settings → API → Create an API user (a separate email, not your login).</p>
        </div>
        <div class="grid pp" data-pp="shipprime" hidden style="margin-top:14px">
          <label class="f"><span class="lt">ShipPrime API token <span class="hint" data-set="sp_token"></span></span><input name="sp_token" type="password" placeholder="Leave blank to keep the saved one"></label>
          <label class="f"><span class="lt">Pickup phone</span><input name="pickup_phone" inputmode="tel"></label>
          <label class="f"><span class="lt">Pickup address</span><input name="pickup_address1"></label>
          <label class="f"><span class="lt">Area / landmark</span><input name="pickup_address2"></label>
          <label class="f"><span class="lt">City</span><input name="pickup_city"></label>
          <label class="f"><span class="lt">State</span><input name="pickup_state"></label>
          <label class="f"><span class="lt">Pickup PIN code</span><input name="pickup_pin" inputmode="numeric" maxlength="6"></label>
        </div>
        <div class="grid" style="margin-top:14px">
          <label class="f"><span class="lt">Parcel weight (g)</span><input name="pkg_weight_g" type="number" min="10"></label>
          <label class="f"><span class="lt">Extra weight per extra item (g)</span><input name="pkg_extra_g" type="number" min="0"></label>
          <label class="f"><span class="lt">Box size L × B × H (cm)</span><span style="display:flex;gap:6px"><input name="pkg_l" type="number" min="1"><input name="pkg_b" type="number" min="1"><input name="pkg_h" type="number" min="1"></span></label>
          <label class="f"><span class="lt">Pay up to ₹ more for a courier with fewer returns</span><input name="ship_max_extra" type="number" min="0"></label>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:14px"><button type="button" class="btn" id="shipSave">Save shipping settings</button><span class="msg" id="shipMsg"></span></div>
      </form>
    </div>
    <div class="ship-bar" id="shipBar">
      <label style="display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px"><input type="checkbox" id="selAll" style="width:18px;height:18px;accent-color:var(--wing)"> All</label>
      <span class="msg" id="selMsg">Select orders to ship</span>
      <button class="btn sm" id="bShip" disabled>Ship selected</button>
      <button class="btn ghost sm" id="bLabels" disabled>Labels</button>
      <button class="btn ghost sm" id="bPacked" disabled>Mark packed</button>
    </div>
    <div class="card"><div class="top"><h2>Ready to ship</h2><button class="btn ghost sm" id="shipRefresh">Refresh</button></div><div id="shipList"><p class="empty">Loading orders…</p></div></div>
    <div class="card"><div class="top"><h2>Shipped</h2><span class="hint">last 60</span></div><div id="shippedList"></div></div>
  </section>

  <section class="view" data-view="settings" hidden>
  <form id="f" autocomplete="off">
  <section class="card">
    <h2>Checkout</h2>
    <div class="row"><div><b>Use CodWing checkout</b><span class="d">Cart drawer and checkout button open the CodWing one-page checkout.</span></div><label class="switch"><input type="checkbox" name="sheet_on"><i></i></label></div>
    <div class="row"><div><b>Open the cart after "Add to cart"</b><span class="d">Off: the "View cart" button bounces and buyers keep shopping. On: the cart opens right away.</span></div><label class="switch"><input type="checkbox" name="open_on_add"><i></i></label></div>
    <div class="grid" style="margin-top:8px">
      <label class="f"><span class="lt">Button colour</span><input name="brand_color" type="color"></label>
    </div>
  </section>
  <section class="card">
    <h2>Payment gateway</h2>
    <p class="help">Buyers pay straight into your own account. CodWing never holds your money.</p>
    <div class="grid">
      <label class="f"><span class="lt">Gateway</span><select name="gateway" id="gateway"><option value="none">Not connected (cash on delivery only)</option><option value="razorpay">Razorpay</option><option value="payu">PayU</option></select></label>
    </div>
    <div class="grid pg" data-pg="razorpay" hidden style="margin-top:14px">
      <label class="f"><span class="lt">Razorpay Key ID</span><input name="razorpay_key_id" placeholder="rzp_live_…"></label>
      <label class="f"><span class="lt">Razorpay Key Secret <span class="hint" data-set="razorpay_key_secret"></span></span><input name="razorpay_key_secret" type="password" placeholder="Leave blank to keep the saved one"></label>
    </div>
    <div class="grid pg" data-pg="payu" hidden style="margin-top:14px">
      <label class="f"><span class="lt">PayU Merchant Key</span><input name="payu_key"></label>
      <label class="f"><span class="lt">PayU Salt <span class="hint" data-set="payu_salt"></span></span><input name="payu_salt" type="password" placeholder="Leave blank to keep the saved one"></label>
    </div>
    <div class="row pg" data-pg="payu" hidden style="margin-top:6px"><div><b>PayU test mode</b><span class="d">Only for trying payments with PayU test keys. Keep off for real orders.</span></div><label class="switch"><input type="checkbox" name="payu_test"><i></i></label></div>
  </section>
  <section class="card">
    <h2>WhatsApp Business</h2>
    <p class="help">COD codes go out from your own WhatsApp number (Meta Cloud API). Find these in Meta Business Suite → WhatsApp Manager → API setup. We can connect it for you on a call.</p>
    <div class="grid">
      <label class="f"><span class="lt">Phone number ID</span><input name="wa_phone_id" inputmode="numeric"></label>
      <label class="f"><span class="lt">WhatsApp Business Account ID</span><input name="wa_waba_id" inputmode="numeric"></label>
      <label class="f"><span class="lt">Permanent access token <span class="hint" data-set="wa_token"></span></span><input name="wa_token" type="password" placeholder="Leave blank to keep the saved one"></label>
      <label class="f"><span class="lt">Code template name</span><input name="wa_otp_template" placeholder="codwing_otp"></label>
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap"><button class="btn ghost sm" type="button" id="mkTpl">Create the code template in my WhatsApp</button><span class="msg" id="tplMsg"></span></div>
  </section>
  <section class="card">
    <h2>Meta pixel</h2>
    <p class="help">InitiateCheckout and Purchase are sent to your pixel from the checkout.</p>
    <div class="grid">
      <label class="f"><span class="lt">Pixel ID</span><input name="pixel_id" inputmode="numeric"></label>
      <label class="f"><span class="lt">Conversions API token <span class="hint" data-set="capi_token"></span></span><input name="capi_token" type="password" placeholder="Leave blank to keep the saved one"></label>
    </div>
  </section>
  <section class="card">
    <h2>Cash on delivery</h2>
    <div class="row"><div><b>Offer cash on delivery</b><span class="d">Show COD as a payment option at checkout.</span></div><label class="switch"><input type="checkbox" name="cod_on"><i></i></label></div>
    <div class="row"><div><b>Confirm COD with a WhatsApp code</b><span class="d">Stops fake numbers and prank orders before they ship.</span></div><label class="switch"><input type="checkbox" name="cod_otp"><i></i></label></div>
    <div class="grid" style="margin-top:12px">
      <label class="f"><span class="lt">Online payment discount (₹)</span><input name="prepaid_discount" type="number" min="0" max="5000"></label>
      <label class="f"><span class="lt">COD fee (₹) <span class="hint">0 = none</span></span><input name="cod_fee" type="number" min="0" max="500"></label>
      <label class="f"><span class="lt">Highest COD order value (₹) <span class="hint">0 = no limit</span></span><input name="cod_max" type="number" min="0"></label>
      <label class="f"><span class="lt">Partial COD advance (₹) <span class="hint">0 = off</span></span><input name="partial_advance" type="number" min="0" max="5000"></label>
      <label class="f"><span class="lt">Ask the advance only in these states <span class="hint">e.g. RJ, MP. Blank = all</span></span><input name="partial_states" placeholder="RJ, MP"></label>
    </div>
  </section>
  <section class="card">
    <h2>Support contact</h2>
    <p class="help">Shown to buyers at checkout and in WhatsApp messages.</p>
    <div class="grid">
      <label class="f"><span class="lt">Support email</span><input name="support_email" type="email"></label>
      <label class="f"><span class="lt">Support phone</span><input name="support_phone" inputmode="tel"></label>
    </div>
  </section>
  </form>
  </section>

  <section class="view" data-view="install" hidden>
    <div class="card">
      <h2>Add CodWing to your store</h2>
      <p class="help">One click adds the checkout to your live theme. Remove it any time from here or by uninstalling the app.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center"><button class="btn" id="installBtn" type="button">Add to my store</button><a class="btn ghost" href="/demo" target="_blank" rel="noopener">See the demo store</a><span class="msg" id="installMsg"></span></div>
    </div>
    <div class="card">
      <h2>Or paste it into your theme yourself</h2>
      <p class="help">Online Store → Themes → ⋯ → Edit code → layout/theme.liquid, just before &lt;/head&gt;:</p>
      <div class="code" id="snippet"></div>
      <p class="help" style="margin-top:12px">To see your store without CodWing for a moment, add <b>?cw_off=1</b> to any page address.</p>
    </div>
  </section>
</div>

<div class="bar-save" id="saveBar" hidden><div class="in"><span class="msg" id="msg">Need help? support@codwing.com</span><button class="btn" id="save" type="button" disabled>Save</button></div></div>

<script>
var DEMO = /[?&]demo=1/.test(location.search);
var f = document.getElementById('f'), saveBtn = document.getElementById('save'), errBox = document.getElementById('err');
var ME = null, DAYS = 1, STATS = null;
var STEP_LABEL = { visit: 'Visited', cart: 'Added to cart', checkout: 'Opened checkout', phone: 'Gave phone', address: 'Filled address', payment: 'Chose payment', order: 'Ordered' };
function $(s, r) { return (r || document).querySelector(s); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function rs(p) { var r = Math.round(p) / 100; return '₹' + Math.round(r).toLocaleString('en-IN'); }
function ago(t) { var s = Math.max(0, Math.floor(Date.now() / 1000) - t); return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : Math.floor(s / 86400) + ' d ago'; }
function toast(t, isErr) { try { shopify.toast.show(t, { isError: !!isErr }); } catch (e) { document.getElementById('msg').textContent = t; } }
function fail(t) { errBox.textContent = t; errBox.style.display = 'block'; }

/* ---- sample data for ?demo=1 ---- */
function demoData(path, body) {
  var t = Math.floor(Date.now() / 1000), k = DAYS === 1 ? 1 : DAYS === 7 ? 6.4 : 26;
  if (path.indexOf('/api/cw/me') === 0) return { ok: true, shop: 'yourstore.myshopify.com', name: 'Your Store', domain: 'https://yourstore.in', sf_url: 'https://app.codwing.com/sf.js?shop=yourstore.myshopify.com',
    settings: { ship_provider: 'shiprocket', sr_email: 'api@yourstore.in', sr_pickup: 'Warehouse', ship_rule: 'rto', ship_max_extra: 15, pkg_weight_g: 300, pkg_extra_g: 50, pkg_l: 20, pkg_b: 15, pkg_h: 5, gateway: 'razorpay', razorpay_key_id: 'rzp_live_xxxxxxxx', cod_on: true, cod_otp: true, prepaid_discount: 50, cod_fee: 29, partial_advance: 99, partial_states: 'RJ,MP', cod_max: 0, sheet_on: true, open_on_add: false, brand_color: '#111111', wa_otp_template: 'codwing_otp', wa_phone_id: '1234567890', wa_waba_id: '9876543210', pixel_id: '', support_email: 'help@yourstore.in', support_phone: '' },
    secrets_set: { razorpay_key_secret: true, wa_token: true, payu_salt: false, capi_token: false, sr_password: true, sp_token: false }, ready: { online: true, whatsapp: true, pixel: false, cod: true, shipping: true }, installed: true };
  if (path.indexOf('/api/cw/stats') === 0) {
    var n = [1240, 214, 151, 98, 77, 64, 41].map(function (x) { return Math.round(x * k); });
    var names = [['Priya S', 'Jaipur', 'Oversized Tee', 79900, 'payment'], ['Rahul', 'Indore', 'Everyday Hoodie', 149900, 'address'], ['Aisha K', 'Mumbai', 'Cap, Canvas Tote Bag', 89800, 'payment'], ['', 'Patna', 'Oversized Tee x2', 159800, 'phone'], ['Vikram', 'Pune', 'Everyday Hoodie', 149900, 'address']];
    return { ok: true, days: DAYS, funnel: ['visit', 'cart', 'checkout', 'phone', 'address', 'payment', 'order'].map(function (s, i) { return { name: s, n: n[i] }; }),
      live: [{ step: 'payment', name: 'Neha', city: 'Delhi', value: 79900, ago: 20 }, { step: 'cart', name: '', city: '', value: 149900, ago: 64 }, { step: 'visit', name: '', city: '', value: 0, ago: 90 }, { step: 'address', name: 'Arjun', city: 'Lucknow', value: 49900, ago: 140 }],
      abandoned: names.map(function (x, i) { return { sid: 'demo' + i, phone: '98' + (76543210 + i * 1111), name: x[0], city: x[1], value: x[3], step: x[4], at: t - 1800 - i * 2900, contacted_at: i === 2 ? t - 600 : null, items: [{ t: x[2], q: 1 }], wa: 'https://wa.me/' }; }),
      orders: { count: n[6], value: n[6] * 112000, by: { online: Math.round(n[6] * .46), cod: Math.round(n[6] * .41), partial: n[6] - Math.round(n[6] * .46) - Math.round(n[6] * .41) }, stuck: 0 },
      recent: [['#1048', 'online', 129800], ['#1047', 'cod', 82800], ['#1046', 'partial', 178800], ['#1045', 'online', 74900], ['#1044', 'cod', 52800]].map(function (o, i) { return { name: o[0], method: o[1], status: 'placed', total: o[2], paid: o[1] === 'online' ? o[2] : o[1] === 'partial' ? 9900 : 0, at: t - i * 3100 - 400, error: '' }; }) };
  }
  if (path.indexOf('/api/cw/ship_list') === 0) {
    var ppl = [['#1052', 'Priya Sharma', 'Jaipur', '302001', true, 82800, 'Oversized Tee'], ['#1051', 'Rahul Verma', 'Indore', '452001', true, 152800, 'Everyday Hoodie'], ['#1050', 'Aisha Khan', 'Mumbai', '400050', false, 89800, 'Cap, Canvas Tote Bag'], ['#1049', 'Vikram Rao', 'Pune', '411001', true, 52800, 'Canvas Tote Bag'], ['#1048', 'Neha Gupta', 'Delhi', '110017', false, 129800, 'Oversized Tee x2']];
    return { ok: true, ready: true, provider: 'shiprocket', rule: 'rto', orders: ppl.map(function (o, i) { return { id: String(9000 + i), name: o[0], customer: o[1], phone: '98765432' + (10 + i), cod: o[4], collect: o[4] ? o[5] : 0, total: o[5], at: t - i * 5400, address: { city: o[2], pin: o[3], state: '' }, items: [{ title: o[6], quantity: 1 }], shipment: DEMO_SHIP[String(9000 + i)] || null }; }),
      shipped: [{ order_id: '8990', order_name: '#1047', cod: true, collect: 82800, at: t - 86400, awb: '19041234567890', courier: 'Delhivery Surface', charge: 6100, label_url: '#', status: 'booked', packed: true, fulfilled: true, track: '#' }, { order_id: '8991', order_name: '#1046', cod: false, collect: 0, at: t - 90000, awb: '1340987654321', courier: 'Xpressbees Surface', charge: 5400, label_url: '#', status: 'booked', packed: false, fulfilled: true, track: '#' }] };
  }
  if (path.indexOf('/api/cw/ship_rates') === 0) return { ok: true, parcel: { weight_g: 300 }, pick: '2', why: 'Fewer returns to this PIN (\u20B97 more than cheapest)', rates: [{ id: '1', courier: 'Xpressbees Surface', charge: 54, days: 4, rto: 2.8, delivery: 3.9 }, { id: '2', courier: 'Delhivery Surface', charge: 61, days: 4, rto: 4.3, delivery: 4.4 }, { id: '3', courier: 'Ekart Logistics', charge: 63, days: 5, rto: 3.6, delivery: 4.0 }, { id: '4', courier: 'Blue Dart Air', charge: 118, days: 2, rto: 4.6, delivery: 4.7 }] };
  if (path.indexOf('/api/cw/ship_book') === 0) { DEMO_SHIP[body.order_id] = { awb: '1904' + Math.floor(Math.random() * 1e10), courier: 'Delhivery Surface', charge: 6100, label_url: '#', status: 'booked', packed: false, fulfilled: true, track: '#' }; return { ok: true, shipment: DEMO_SHIP[body.order_id] }; }
  if (path.indexOf('/api/cw/ship_labels') === 0) return { ok: true, labels: [] };
  if (path.indexOf('/api/cw/ship_pickups') === 0) return { ok: true, pickups: [{ name: 'Warehouse', pin: '400001', city: 'Mumbai' }] };
  return { ok: true };
}
var DEMO_SHIP = {};
function api(path, body) {
  if (DEMO) return new Promise(function (ok) { setTimeout(function () { ok(body && path.indexOf('settings') > -1 ? Object.assign(demoData('/api/cw/me'), { settings: Object.assign(demoData('/api/cw/me').settings, body) }) : demoData(path, body || {})); }, 120); });
  return fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then(function (r) { return r.json(); });
}

/* ---- tabs ---- */
function show(tab) {
  document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('is-on', b.getAttribute('data-tab') === tab); });
  document.querySelectorAll('.view').forEach(function (v) { v.hidden = v.getAttribute('data-view') !== tab; });
  document.getElementById('saveBar').hidden = tab !== 'settings';
  if (tab === 'ship' && !SHIP) loadShip();
  window.scrollTo(0, 0);
}
document.querySelector('.tabs').addEventListener('click', function (e) { var b = e.target.closest('.tab'); if (b) show(b.getAttribute('data-tab')); });
document.addEventListener('click', function (e) { var g = e.target.closest('[data-go]'); if (g) show(g.getAttribute('data-go')); });

/* ---- settings ---- */
function showPg() { var g = f.gateway.value; document.querySelectorAll('.pg').forEach(function (el) { el.hidden = el.getAttribute('data-pg') !== g; }); }
function fill(d) {
  ME = d;
  document.getElementById('storeName').textContent = d.name || 'CodWing';
  document.getElementById('shopline').textContent = (d.domain || d.shop).replace(/^https?:\\/\\//, '');
  var s = d.settings, r = d.ready || {};
  Object.keys(s).forEach(function (k) { var el = f.elements[k]; if (!el) return; if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k] == null ? '' : s[k]; });
  document.querySelectorAll('[data-set]').forEach(function (el) { var on = d.secrets_set[el.getAttribute('data-set')]; el.textContent = on ? '· saved' : ''; el.className = 'hint' + (on ? ' set' : ''); });
  f.querySelectorAll('input[type=password]').forEach(function (el) { el.value = ''; });
  var sf = document.getElementById('sf');
  Object.keys(s).forEach(function (k) { var el = sf.elements[k]; if (!el || el.type === 'password') return; if (k === 'sr_pickup') { if (s[k] && !Array.prototype.some.call(el.options, function (o) { return o.value === s[k]; })) el.add(new Option(s[k], s[k])); } el.value = s[k] == null ? '' : s[k]; });
  sf.querySelectorAll('input[type=password]').forEach(function (el) { el.value = ''; });
  showPp();
  var ss = document.getElementById('shipState'); ss.textContent = r.shipping ? 'Connected' + (s.ship_provider === 'shipprime' ? ' \u00B7 ShipPrime' : s.ship_provider === 'shiprocket' ? ' \u00B7 Shiprocket' : '') : 'Not connected'; ss.className = 'badge ' + (r.shipping ? 'b-go' : 'b-risk');
  sf.hidden = !!r.shipping; document.getElementById('shipEdit').hidden = !r.shipping;
  showPg(); saveBtn.disabled = false;
  document.getElementById('snippet').textContent = '<script src="' + d.sf_url + '" defer><\\/script>';
  var steps = [
    { ok: !!(STATS && STATS.funnel && STATS.funnel[0].n) || !!d.installed, t: 'Add CodWing to your store', d: 'One click puts the checkout and tracking on your theme.', go: 'install', btn: 'Install' },
    { ok: r.online, t: 'Connect Razorpay or PayU', d: 'Take UPI and card payments with your own payment gateway account.', go: 'settings', btn: 'Connect' },
    { ok: r.whatsapp, t: 'Connect your WhatsApp number', d: 'For COD codes. Paste your Cloud API details; we can do it with you.', go: 'settings', btn: 'Connect' },
    { ok: r.pixel, t: 'Add your Meta pixel', d: 'Checkout and purchase events for your ads.', go: 'settings', btn: 'Add' },
    { ok: r.shipping, t: 'Connect Shiprocket or ShipPrime', d: 'Ship orders, print labels and pick couriers with fewer returns.', go: 'ship', btn: 'Connect' }
  ];
  var okN = steps.filter(function (x) { return x.ok; }).length;
  document.getElementById('setupCount').textContent = okN + ' of ' + steps.length + ' done';
  document.getElementById('checklist').innerHTML = steps.map(function (x, i) {
    return '<div class="ck' + (x.ok ? ' ok' : '') + '"><span class="dot">' + (x.ok ? '✓' : i + 1) + '</span><div><b>' + esc(x.t) + '</b><span>' + esc(x.d) + '</span></div>' +
      (x.ok ? '<span class="badge b-go">Done</span>' : x.soon ? '<span class="badge b-info">Soon</span>' : '<button class="btn sm" data-go="' + x.go + '">' + x.btn + '</button>') + '</div>';
  }).join('');
  var live = r.online || r.cod;
  var st = document.getElementById('status'); st.textContent = okN >= 3 ? 'Live' : 'Setting up'; st.className = 'badge ' + (okN >= 3 ? 'b-go' : 'b-risk');
}
f.gateway.addEventListener('change', showPg);
saveBtn.addEventListener('click', function () {
  var body = {};
  Array.prototype.forEach.call(f.elements, function (el) { if (!el.name) return; body[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
  api('/api/cw/settings', body).then(function (d) { saveBtn.textContent = 'Save'; if (!d.ok) { saveBtn.disabled = false; return toast(d.error || 'Not saved. Try again.', true); } fill(d); toast('Settings saved'); })
    .catch(function () { saveBtn.disabled = false; saveBtn.textContent = 'Save'; toast('Not saved. Check your connection.', true); });
});
document.getElementById('mkTpl').addEventListener('click', function () {
  var m = document.getElementById('tplMsg'); m.textContent = 'Asking WhatsApp…';
  api('/api/cw/wa_template', {}).then(function (d) { m.textContent = d.ok ? 'Template sent to Meta for approval (' + (d.status || 'pending') + '). Usually approved in minutes.' : d.error; });
});
document.getElementById('installBtn').addEventListener('click', function () {
  var b = this, m = document.getElementById('installMsg'); b.disabled = true; m.textContent = 'Adding…';
  api('/api/cw/install', {}).then(function (d) { b.disabled = false; m.textContent = d.ok ? (d.already ? 'Already on your store.' : 'Added. Open your store to see it.') : d.error; if (d.ok) toast('CodWing is on your store'); });
});

/* ---- stats ---- */
function paintStats(s) {
  STATS = s;
  var fn = s.funnel, by = {}; fn.forEach(function (x) { by[x.name] = x.n; });
  var conv = by.visit ? (by.order / by.visit * 100) : 0, ckConv = by.checkout ? (by.order / by.checkout * 100) : 0;
  document.getElementById('kpis').innerHTML = [
    ['Visitors', by.visit.toLocaleString('en-IN'), ''],
    ['Opened checkout', by.checkout.toLocaleString('en-IN'), by.visit ? Math.round(by.checkout / by.visit * 100) + '% of visitors' : ''],
    ['Orders', s.orders.count.toLocaleString('en-IN'), conv ? conv.toFixed(1) + '% conversion' : ''],
    ['Revenue', rs(s.orders.value), ckConv ? Math.round(ckConv) + '% of checkouts ordered' : '']
  ].map(function (k) { return '<div class="kpi"><span>' + k[0] + '</span><b>' + k[1] + '</b><em>' + k[2] + '</em></div>'; }).join('');
  var max = Math.max(1, fn[0].n), worst = -1, worstAt = -1;
  for (var i = 2; i < fn.length; i++) { var lost = fn[i - 1].n ? (fn[i - 1].n - fn[i].n) / fn[i - 1].n : 0; if (lost > worst) { worst = lost; worstAt = i; } }
  document.getElementById('funnel').innerHTML = fn.map(function (x, i) {
    var row = '<div class="fr"><span class="lbl">' + STEP_LABEL[x.name] + '</span><span class="bar"><i style="width:' + Math.max(1, x.n / max * 100) + '%"></i></span><span class="num">' + x.n.toLocaleString('en-IN') + '</span></div>';
    if (i > 0 && fn[i - 1].n) { var l = fn[i - 1].n - x.n, pc = Math.round(l / fn[i - 1].n * 100); if (l > 0) row = '<div class="fr"><span></span><span class="drop' + (i === worstAt ? ' big' : '') + '">↓ ' + l.toLocaleString('en-IN') + ' left here (' + pc + '%)' + (i === worstAt ? ' · biggest drop' : '') + '</span></div>' + row; }
    return row;
  }).join('');
  document.getElementById('live').innerHTML = s.live.length ? '<div class="live">' + s.live.map(function (v) { return '<span class="lv"><i></i>' + esc(v.name || 'Visitor') + (v.city ? ', ' + esc(v.city) : '') + ' · <b>' + STEP_LABEL[v.step] + '</b>' + (v.value ? ' · ' + rs(v.value) : '') + '</span>'; }).join('') + '</div>' : '<p class="empty">Nobody on your store right now.</p>';
  var open = s.abandoned.filter(function (a) { return !a.contacted_at; });
  var n = document.getElementById('abN'); n.hidden = !open.length; n.textContent = open.length;
  document.getElementById('abTop').innerHTML = open.length ? open.slice(0, 3).map(abRow).join('') : '<p class="empty">No one to follow up with yet.</p>';
  document.getElementById('abList').innerHTML = s.abandoned.length ? s.abandoned.map(abRow).join('') : '<p class="empty">No abandoned checkouts in this period. People appear here once they type their phone number and leave without ordering.</p>';
  var M = { online: 'Paid online', cod: 'Cash on delivery', partial: 'Partial COD' };
  document.getElementById('orderList').innerHTML = (s.orders.stuck ? '<p class="err" style="display:block">' + s.orders.stuck + ' payment(s) went through but the Shopify order could not be created. Contact support@codwing.com.</p>' : '') +
    (s.recent.length ? s.recent.map(function (o) {
      return '<div class="li"><div><div class="who">' + esc(o.name || 'Payment pending') + ' · ' + rs(o.total) + '</div><div class="meta">' + M[o.method] + (o.paid ? ' · ' + rs(o.paid) + ' paid' : '') + ' · ' + ago(o.at) + '</div></div><div class="act">' +
        (o.status === 'placed' ? '<span class="badge b-go">Placed</span>' : o.status === 'awaiting_payment' ? '<span class="badge b-risk">Not paid</span>' : '<span class="badge b-bad">Needs attention</span>') + '</div></div>';
    }).join('') : '<p class="empty">Orders placed through CodWing will show here.</p>');
}
function abRow(a) {
  return '<div class="li"><div><div class="who">' + esc(a.name || '+91 ' + a.phone) + (a.city ? ' <span class="meta">· ' + esc(a.city) + '</span>' : '') + '</div>' +
    '<div class="items">' + esc(a.items.map(function (i) { return i.t + (i.q > 1 ? ' ×' + i.q : ''); }).join(', ') || 'Cart') + (a.value ? ' · <b>' + rs(a.value) + '</b>' : '') + '</div>' +
    '<div class="meta">Left at: <b>' + STEP_LABEL[a.step] + '</b> · ' + ago(a.at) + '</div></div>' +
    '<div class="act">' + (a.contacted_at ? '<span class="badge b-go">Messaged</span>' : '') + '<a class="btn wa sm" href="' + esc(a.wa) + '" target="_blank" rel="noopener" data-sid="' + esc(a.sid) + '">WhatsApp</a></div></div>';
}
document.addEventListener('click', function (e) {
  var w = e.target.closest('a.btn.wa[data-sid]'); if (!w) return;
  api('/api/cw/contacted', { sid: w.getAttribute('data-sid') }).then(function () { if (STATS) { STATS.abandoned.forEach(function (a) { if (a.sid === w.getAttribute('data-sid')) a.contacted_at = Math.floor(Date.now() / 1000); }); paintStats(STATS); } });
  if (DEMO) e.preventDefault();
});
function loadStats() { return api('/api/cw/stats?days=' + DAYS).then(function (d) { if (d.ok) paintStats(d); }); }
['range', 'range2'].forEach(function (id) {
  document.getElementById(id).addEventListener('click', function (e) {
    var c = e.target.closest('.chip'); if (!c) return; DAYS = Number(c.getAttribute('data-d'));
    document.querySelectorAll('.chip').forEach(function (x) { x.classList.toggle('is-on', Number(x.getAttribute('data-d')) === DAYS); });
    loadStats();
  });
});

/* ---- shipping ---- */
var SHIP = null, SEL = {};
function showPp() { var v = document.getElementById('shipProv').value; document.querySelectorAll('.pp').forEach(function (el) { el.hidden = el.getAttribute('data-pp') !== v; }); }
document.getElementById('shipProv').addEventListener('change', showPp);
document.getElementById('shipEdit').addEventListener('click', function () { var sf = document.getElementById('sf'); sf.hidden = !sf.hidden; });
document.getElementById('shipSave').addEventListener('click', function () {
  var sf = document.getElementById('sf'), body = {}, m = document.getElementById('shipMsg');
  Array.prototype.forEach.call(sf.elements, function (el) { if (el.name) body[el.name] = el.value; });
  m.textContent = 'Saving…';
  api('/api/cw/settings', body).then(function (d) { if (!d.ok) { m.textContent = d.error || 'Not saved'; return; } fill(d); m.textContent = d.ready && d.ready.shipping ? 'Saved. Connected.' : 'Saved. Fill the remaining fields to connect.'; SHIP = null; loadShip(); });
});
document.getElementById('loadPk').addEventListener('click', function () {
  var m = document.getElementById('shipMsg'); m.textContent = 'Asking Shiprocket…';
  api('/api/cw/ship_pickups').then(function (d) {
    if (!d.ok) { m.textContent = d.error; return; }
    var sel = document.getElementById('srPickup'), cur = sel.value; sel.innerHTML = '';
    d.pickups.forEach(function (p) { sel.add(new Option(p.name + ' (' + p.city + ' ' + p.pin + ')', p.name)); });
    if (cur) sel.value = cur; m.textContent = d.pickups.length + ' pickup location(s) found. Pick one and save.';
  });
});
function loadShip() {
  document.getElementById('shipList').innerHTML = '<p class="empty">Loading orders…</p>';
  return api('/api/cw/ship_list').then(function (d) {
    if (!d.ok) { document.getElementById('shipList').innerHTML = '<p class="empty">' + esc(d.error || 'Could not load orders') + '</p>'; return; }
    SHIP = d; SEL = {}; paintShip();
  });
}
function paintShip() {
  var d = SHIP, open = d.orders.filter(function (o) { return !(o.shipment && o.shipment.awb); });
  var n = document.getElementById('shipN'); n.hidden = !open.length; n.textContent = open.length;
  document.getElementById('shipList').innerHTML = d.orders.length ? d.orders.map(function (o) {
    var sh = o.shipment;
    return '<div class="so" data-oid="' + o.id + '"><input type="checkbox" data-sel="' + o.id + '"' + (SEL[o.id] ? ' checked' : '') + ' aria-label="Select ' + esc(o.name) + '">' +
      '<div><div class="who">' + esc(o.name) + ' \u00B7 ' + esc(o.customer || '') + '</div>' +
      '<div class="meta">' + esc(o.address.city) + ' ' + esc(o.address.pin) + ' \u00B7 ' + (o.cod ? '<span class="cod">COD ' + rs(o.collect) + '</span>' : '<span class="pre">Prepaid ' + rs(o.total) + '</span>') + ' \u00B7 ' + ago(o.at) + '</div>' +
      '<div class="meta">' + esc(o.items.map(function (i) { return i.title + (i.quantity > 1 ? ' \u00D7' + i.quantity : ''); }).join(', ')) + '</div>' +
      (sh && sh.awb ? '<div class="meta" style="color:var(--go);font-weight:700">' + esc(sh.courier) + ' \u00B7 AWB ' + esc(sh.awb) + '</div>' : sh && sh.error ? '<div class="meta" style="color:var(--bad)">' + esc(sh.error) + '</div>' : '') +
      '<div class="msg" data-res="' + o.id + '"></div></div>' +
      '<div class="act">' + (sh && sh.awb ? (sh.label_url ? '<a class="btn ghost sm" href="' + esc(sh.label_url) + '" target="_blank" rel="noopener">Label</a>' : '') + '<span class="badge b-go">Shipped</span>' : '<button class="btn ghost sm" data-rates="' + o.id + '">Couriers</button><button class="btn sm" data-ship="' + o.id + '">Ship</button>') + '</div>' +
      '<div class="rates" data-rt="' + o.id + '" hidden></div></div>';
  }).join('') : '<p class="empty">' + (d.ready ? 'No unshipped orders. Nice.' : 'Connect a shipping account above to start shipping.') + '</p>';
  document.getElementById('shippedList').innerHTML = d.shipped.length ? d.shipped.map(function (r) {
    return '<div class="li"><div><div class="who">' + esc(r.order_name) + ' \u00B7 ' + esc(r.courier) + '</div><div class="meta">AWB ' + esc(r.awb) + ' \u00B7 ' + (r.cod ? 'COD ' + rs(r.collect) : 'Prepaid') + ' \u00B7 ' + ago(r.at) + (r.fulfilled ? '' : ' \u00B7 <b style="color:var(--risk)">not marked fulfilled in Shopify</b>') + '</div></div>' +
      '<div class="act">' + (r.label_url ? '<a class="btn ghost sm" href="' + esc(r.label_url) + '" target="_blank" rel="noopener">Label</a>' : '') + (r.track ? '<a class="btn ghost sm" href="' + esc(r.track) + '" target="_blank" rel="noopener">Track</a>' : '') +
      '<button class="btn sm ' + (r.packed ? 'ghost' : '') + '" data-pack="' + r.order_id + '" data-on="' + (r.packed ? '0' : '1') + '">' + (r.packed ? 'Packed \u2713' : 'Mark packed') + '</button></div></div>';
  }).join('') : '<p class="empty">Shipped orders show here with their label and tracking.</p>';
  selMsg();
}
function selIds() { return Object.keys(SEL).filter(function (k) { return SEL[k]; }); }
function selMsg() {
  var ids = selIds(), m = document.getElementById('selMsg');
  m.textContent = ids.length ? ids.length + ' selected' : 'Select orders to ship';
  ['bShip', 'bLabels', 'bPacked'].forEach(function (b) { document.getElementById(b).disabled = !ids.length; });
}
function shipOne(id, courier) {
  var res = document.querySelector('[data-res="' + id + '"]'); if (res) res.textContent = 'Booking…';
  return api('/api/cw/ship_book', { order_id: id, courier_id: courier || '' }).then(function (r) {
    var o = SHIP.orders.filter(function (x) { return x.id === id; })[0];
    if (r.ok) { if (o) o.shipment = { awb: r.shipment.awb, courier: r.shipment.courier, label_url: r.shipment.label_url, status: 'booked' }; }
    else if (o) o.shipment = { error: r.error };
    return r;
  });
}
document.getElementById('shipList').addEventListener('click', function (e) {
  var c = e.target.closest('[data-sel]'); if (c) { SEL[c.getAttribute('data-sel')] = c.checked; selMsg(); return; }
  var s1 = e.target.closest('[data-ship]'); if (s1) { s1.disabled = true; shipOne(s1.getAttribute('data-ship')).then(function (r) { paintShip(); toast(r.ok ? 'Shipped with ' + r.shipment.courier : r.error, !r.ok); }); return; }
  var rb = e.target.closest('[data-rates]');
  if (rb) {
    var id = rb.getAttribute('data-rates'), box = document.querySelector('[data-rt="' + id + '"]');
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false; box.innerHTML = '<div class="rt"><span class="meta">Checking couriers…</span></div>';
    api('/api/cw/ship_rates', { order_id: id }).then(function (d) {
      if (!d.ok) { box.innerHTML = '<div class="rt"><span class="meta">' + esc(d.error) + '</span></div>'; return; }
      if (!d.rates.length) { box.innerHTML = '<div class="rt"><span class="meta">No courier delivers to this PIN code.</span></div>'; return; }
      box.innerHTML = '<div class="rt" style="background:#f6f7fd"><span class="meta"><b>Suggested:</b> ' + esc(d.why) + '</span><span class="sc">Returns</span><span class="sc sc2">Delivery</span><span></span></div>' + d.rates.map(function (r) {
        var st = function (v) { return v == null ? '\u2013' : v.toFixed(1) + '/5'; };
        return '<div class="rt' + (r.id === d.pick ? ' is-pick' : '') + '"><span><b>' + esc(r.courier) + '</b><br><span class="sc">\u20B9' + Math.round(r.charge) + (r.days ? ' \u00B7 ' + r.days + ' days' : '') + '</span></span><span class="sc">' + st(r.rto) + '</span><span class="sc sc2">' + st(r.delivery) + '</span><button class="btn sm' + (r.id === d.pick ? '' : ' ghost') + '" data-ship-with="' + esc(r.id) + '" data-for="' + id + '">Ship</button></div>';
      }).join('');
    });
    return;
  }
  var sw = e.target.closest('[data-ship-with]'); if (sw) { sw.disabled = true; shipOne(sw.getAttribute('data-for'), sw.getAttribute('data-ship-with')).then(function (r) { paintShip(); toast(r.ok ? 'Shipped with ' + r.shipment.courier : r.error, !r.ok); }); }
});
document.getElementById('shippedList').addEventListener('click', function (e) {
  var b = e.target.closest('[data-pack]'); if (!b) return;
  var on = b.getAttribute('data-on') === '1', id = b.getAttribute('data-pack');
  api('/api/cw/ship_pack', { order_ids: [id], packed: on }).then(function () { SHIP.shipped.forEach(function (r) { if (r.order_id === id) r.packed = on; }); paintShip(); });
});
document.getElementById('selAll').addEventListener('change', function () { var on = this.checked; SHIP.orders.forEach(function (o) { SEL[o.id] = on && !(o.shipment && o.shipment.awb); }); paintShip(); });
document.getElementById('shipRefresh').addEventListener('click', loadShip);
document.getElementById('bShip').addEventListener('click', function () {
  var ids = selIds().filter(function (id) { var o = SHIP.orders.filter(function (x) { return x.id === id; })[0]; return o && !(o.shipment && o.shipment.awb); });
  if (!ids.length) return toast('Those orders are already shipped');
  var b = this, done = 0, bad = 0; b.disabled = true;
  (function next(i) {
    if (i >= ids.length) { b.disabled = false; SEL = {}; paintShip(); document.getElementById('selMsg').textContent = done + ' shipped' + (bad ? ', ' + bad + ' failed (see the red notes)' : ''); return; }
    document.getElementById('selMsg').textContent = 'Shipping ' + (i + 1) + ' of ' + ids.length + '…';
    shipOne(ids[i]).then(function (r) { if (r.ok) done++; else bad++; next(i + 1); });
  })(0);
});
document.getElementById('bLabels').addEventListener('click', function () {
  api('/api/cw/ship_labels', { order_ids: selIds() }).then(function (d) {
    if (!d.ok || !d.labels.length) return toast(d.error || 'No labels yet: ship the orders first', true);
    d.labels.forEach(function (l) { window.open(l.url, '_blank'); });
  });
});
document.getElementById('bPacked').addEventListener('click', function () {
  var ids = selIds(); api('/api/cw/ship_pack', { order_ids: ids, packed: true }).then(function () { toast(ids.length + ' marked packed'); SEL = {}; loadShip(); });
});

if (DEMO) document.getElementById('demoNote').style.display = 'block';
api('/api/cw/me').then(function (d) { if (!d.ok) return fail(d.error || 'Could not load your settings.'); fill(d); return loadStats().then(function () { fill(ME); }); })
  .catch(function () { fail('Could not reach CodWing. Check your connection and reload.'); });
setInterval(function () { if (!document.hidden && ME) loadStats(); }, 30000);
</script>
</body>
</html>`;
