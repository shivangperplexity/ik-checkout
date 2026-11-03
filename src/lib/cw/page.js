/* The embedded admin page. App Bridge adds the session token to same-origin fetches. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="shopify-api-key" content="__API_KEY__">
<title>CodWing</title>
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap">
<style>
:root{--bg:#f3f5fd;--card:#fff;--line:#d9def0;--line-strong:#7f86b0;--ink:#04032e;--muted:#525a82;--wing:#224ff2;--indigo:#070655;--wing-soft:#e6ecfe;--go:#0a7a4f;--go-soft:#e2f5ec;--risk:#a14a05;--risk-soft:#fdf0dc}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:24px 16px 96px}
h1,h2{font-family:Poppins,"Plus Jakarta Sans",system-ui,sans-serif;margin:0;letter-spacing:-.01em}
h1{font-size:24px}h2{font-size:18px}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px}
.sub{color:var(--muted);margin:4px 0 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}
.card p.help{color:var(--muted);font-size:13px;margin:4px 0 16px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
@media (max-width:640px){.grid{grid-template-columns:1fr}}
label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600}
input,select{font:inherit;font-weight:400;height:42px;padding:0 12px;border:1.5px solid var(--line-strong);border-radius:10px;background:#fff;color:var(--ink);width:100%}
input:focus,select:focus{outline:none;border-color:var(--wing);box-shadow:0 0 0 3px var(--wing-soft)}
.lt{display:block;min-height:18px}
.hint{font-weight:500;color:var(--muted);font-size:12px}
.set{color:var(--go)}
.row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row b{display:block}.row span{color:var(--muted);font-size:13px}
.switch{position:relative;width:46px;height:26px;flex:none}
.switch input{opacity:0;width:0;height:0;position:absolute}
.switch i{position:absolute;inset:0;border-radius:999px;background:#c9cee6;transition:background .16s}
.switch i::after{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;border-radius:50%;background:#fff;transition:transform .16s}
.switch input:checked+i{background:var(--wing)}.switch input:checked+i::after{transform:translateX(20px)}
.switch input:focus-visible+i{outline:2px solid var(--wing);outline-offset:2px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:5px 9px;border-radius:6px}
.badge::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.b-go{background:var(--go-soft);color:var(--go)}.b-risk{background:var(--risk-soft);color:var(--risk)}
.bar{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--line);padding:12px 16px}
.bar .in{max-width:860px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;gap:12px}
button.primary{font:inherit;font-weight:700;height:44px;padding:0 22px;border:0;border-radius:10px;background:var(--wing);color:#fff;cursor:pointer}
button.primary:hover{background:var(--indigo)}button.primary[disabled]{opacity:.5;cursor:default}
.msg{color:var(--muted);font-size:13px}
.err{background:#fdeaea;color:#c0262d;border-radius:10px;padding:12px 14px;margin-bottom:16px;display:none}
.pg[hidden]{display:none!important}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div><h1>CodWing</h1><p class="sub" id="shopline">Loading your store…</p></div>
    <span class="badge b-risk" id="status">Setting up</span>
  </div>
  <div class="err" id="err"></div>

  <form id="f" autocomplete="off">
  <section class="card">
    <h2>Payment gateway</h2>
    <p class="help">Buyers pay straight into your own account. CodWing never holds your money.</p>
    <div class="grid">
      <label><span class="lt">Gateway</span><select name="gateway" id="gateway"><option value="none">Not connected</option><option value="razorpay">Razorpay</option><option value="payu">PayU</option></select></label>
    </div>
    <div class="grid pg" data-pg="razorpay" hidden style="margin-top:14px">
      <label><span class="lt">Razorpay Key ID</span><input name="razorpay_key_id" placeholder="rzp_live_…"></label>
      <label><span class="lt">Razorpay Key Secret <span class="hint" data-set="razorpay_key_secret"></span></span><input name="razorpay_key_secret" type="password" placeholder="Leave blank to keep the saved one"></label>
    </div>
    <div class="grid pg" data-pg="payu" hidden style="margin-top:14px">
      <label><span class="lt">PayU Merchant Key</span><input name="payu_key"></label>
      <label><span class="lt">PayU Salt <span class="hint" data-set="payu_salt"></span></span><input name="payu_salt" type="password" placeholder="Leave blank to keep the saved one"></label>
    </div>
  </section>

  <section class="card">
    <h2>WhatsApp Business</h2>
    <p class="help">COD OTPs and order updates go out from your own number through Meta's WhatsApp Cloud API.</p>
    <div class="grid">
      <label><span class="lt">Phone number ID</span><input name="wa_phone_id" inputmode="numeric"></label>
      <label><span class="lt">WhatsApp Business Account ID</span><input name="wa_waba_id" inputmode="numeric"></label>
      <label><span class="lt">Permanent access token <span class="hint" data-set="wa_token"></span></span><input name="wa_token" type="password" placeholder="Leave blank to keep the saved one"></label>
    </div>
  </section>

  <section class="card">
    <h2>Meta pixel</h2>
    <p class="help">Purchase events are also sent from our server, so ad blockers don't hide your sales.</p>
    <div class="grid">
      <label><span class="lt">Pixel ID</span><input name="pixel_id" inputmode="numeric"></label>
      <label><span class="lt">Conversions API token <span class="hint" data-set="capi_token"></span></span><input name="capi_token" type="password" placeholder="Leave blank to keep the saved one"></label>
    </div>
  </section>

  <section class="card">
    <h2>Cash on delivery</h2>
    <div class="row"><div><b>Offer cash on delivery</b><span>Show COD as a payment option at checkout.</span></div><label class="switch"><input type="checkbox" name="cod_on"><i></i></label></div>
    <div class="row"><div><b>Confirm COD with a WhatsApp OTP</b><span>Stops fake numbers and prank orders before they ship.</span></div><label class="switch"><input type="checkbox" name="cod_otp"><i></i></label></div>
    <div class="grid" style="margin-top:12px">
      <label><span class="lt">Prepaid discount (₹)</span><input name="prepaid_discount" type="number" min="0" max="5000"></label>
      <label><span class="lt">Highest COD order value (₹) <span class="hint">0 = no limit</span></span><input name="cod_max" type="number" min="0"></label>
      <label><span class="lt">Partial COD advance (₹) <span class="hint">0 = off</span></span><input name="partial_advance" type="number" min="0" max="5000"></label>
      <label><span class="lt">Ask the advance only in these states <span class="hint">e.g. RJ, MP. Blank = all</span></span><input name="partial_states" placeholder="RJ, MP"></label>
    </div>
  </section>

  <section class="card">
    <h2>Support contact</h2>
    <p class="help">Shown to buyers on the checkout and in WhatsApp messages.</p>
    <div class="grid">
      <label><span class="lt">Support email</span><input name="support_email" type="email"></label>
      <label><span class="lt">Support phone</span><input name="support_phone" inputmode="tel"></label>
    </div>
  </section>
  </form>
</div>

<div class="bar"><div class="in"><span class="msg" id="msg">Need help? support@codwing.com</span><button class="primary" id="save" type="button" disabled>Save</button></div></div>

<script>
var f = document.getElementById('f'), saveBtn = document.getElementById('save'), errBox = document.getElementById('err');
function toast(t, isErr){ try { shopify.toast.show(t, { isError: !!isErr }); } catch (e) { document.getElementById('msg').textContent = t; } }
function showPg(){ var g = f.gateway.value; document.querySelectorAll('.pg').forEach(function(el){ el.hidden = el.getAttribute('data-pg') !== g; }); }
function fill(d){
  document.getElementById('shopline').textContent = d.shop;
  var st = document.getElementById('status'), s = d.settings;
  var ready = s.gateway !== 'none' && d.secrets_set.wa_token;
  st.textContent = ready ? 'Ready' : 'Setting up'; st.className = 'badge ' + (ready ? 'b-go' : 'b-risk');
  Object.keys(s).forEach(function(k){ var el = f.elements[k]; if (!el) return; if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k] == null ? '' : s[k]; });
  document.querySelectorAll('[data-set]').forEach(function(el){ var on = d.secrets_set[el.getAttribute('data-set')]; el.textContent = on ? '· saved' : ''; el.className = 'hint' + (on ? ' set' : ''); });
  f.querySelectorAll('input[type=password]').forEach(function(el){ el.value = ''; });
  showPg(); saveBtn.disabled = false;
}
function fail(t){ errBox.textContent = t; errBox.style.display = 'block'; }
f.gateway.addEventListener('change', showPg);
fetch('/api/cw/me').then(function(r){ return r.json(); }).then(function(d){ if (!d.ok) return fail(d.error || 'Could not load your settings.'); fill(d); }).catch(function(){ fail('Could not reach CodWing. Check your connection and reload.'); });
saveBtn.addEventListener('click', function(){
  var body = {};
  Array.prototype.forEach.call(f.elements, function(el){ if (!el.name) return; body[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
  fetch('/api/cw/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); })
    .then(function(d){ saveBtn.textContent = 'Save'; if (!d.ok) { saveBtn.disabled = false; return toast(d.error || 'Not saved. Try again.', true); } fill(d); toast('Settings saved'); })
    .catch(function(){ saveBtn.disabled = false; saveBtn.textContent = 'Save'; toast('Not saved. Check your connection.', true); });
});
</script>
</body>
</html>`;
