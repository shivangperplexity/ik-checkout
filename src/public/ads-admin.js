/* IK dashboard → More → Meta ads (lib/ads-studio.js). Numbers per campaign / ad set / ad, pause / resume / delete an
   ad, and a new Reel ad from an MP4: checked here first (format, length, sound), uploaded to Meta in parts, then made
   like the best ad of the chosen ad set. */
(function () {
  'use strict';
  var A = window.IKA, esc = A.esc, inr = A.inr, toast = A.toast, rpc = A.rpc;
  var P = { preset: 'last_7d', tree: null, file: null, check: null, sel: '' };
  var PRESETS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['last_7d', '7 days'], ['last_14d', '14 days'], ['last_30d', '30 days']];
  var PART = 2400 * 1024;
  var CSS = '.ads-c{border:1px solid #e5e2da;border-radius:12px;padding:12px;margin:0 0 12px;background:#fff}.ads-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
    '.ads-h b{flex:1;min-width:160px}.ads-m{font-size:12px;color:#5c5a55}.ads-m span{margin-right:10px;white-space:nowrap}.ads-set{margin:8px 0 0 8px;padding:8px 0 0 10px;border-left:3px solid #eee}' +
    '.ads-ad{display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px dashed #eee}.ads-ad img{width:40px;height:40px;object-fit:cover;border-radius:6px;background:#f2f0ea}' +
    '.ads-ad .t{flex:1;min-width:0}.ads-ad .t div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ads-chip{font-size:11px;padding:2px 7px;border-radius:99px;background:#eee}' +
    '.ads-chip.on{background:#dcf3e3;color:#11632f}.ads-chip.bad{background:#fde4e2;color:#b42318}.ads-btn{font:inherit;font-size:12px;padding:5px 9px;border:1px solid #d9d4ca;border-radius:8px;background:#fff;cursor:pointer}' +
    '.ads-btn.red{color:#b42318;border-color:#f1b7b1}.ads-up label{display:block;margin:8px 0 4px;font-size:13px;font-weight:600}.ads-up select,.ads-up input,.ads-up textarea{width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid #d9d4ca;border-radius:8px}' +
    '.ads-ck{margin:8px 0;padding:0;list-style:none}.ads-ck li{margin:4px 0;font-size:13px}.ads-bar{height:8px;background:#eee;border-radius:9px;overflow:hidden;margin:8px 0}.ads-bar i{display:block;height:100%;width:0;background:#0a0a0c}' +
    '.ads-go{width:100%;padding:12px;border:0;border-radius:10px;background:#0a0a0c;color:#fff;font:inherit;font-weight:700;margin-top:10px;cursor:pointer}.ads-go:disabled{opacity:.5}';
  function $(s, r) { return (r || document).querySelector(s); }
  function m(x) { x = x || {}; return '<div class="ads-m"><span>Spend ' + inr(x.spend) + '</span><span>Purch ' + (x.purchases || 0) + '</span><span>ROAS ' + (x.roas || 0) + '</span>' + (x.cpa ? '<span>CPA ' + inr(x.cpa) + '</span>' : '') + (x.ctr != null && x.ctr !== undefined && x.impressions !== undefined ? '<span>CTR ' + x.ctr + '%</span>' : '') + '</div>'; }
  function chip(st, eff) { var on = st === 'ACTIVE' && eff === 'ACTIVE', bad = /DISAPPROVED|WITH_ISSUES/.test(eff || ''); return '<span class="ads-chip' + (on ? ' on' : bad ? ' bad' : '') + '">' + esc(on ? 'Active' : String(eff || st).replace(/_/g, ' ').toLowerCase()) + '</span>'; }

  function load(main) {
    if (!$('#ads-css')) { var st = document.createElement('style'); st.id = 'ads-css'; st.textContent = CSS; document.head.appendChild(st); }
    main.innerHTML = '<div class="ads-c ads-up" id="ads-up"></div><div class="ads-h" style="margin:0 0 10px"><b>Campaigns</b><select id="ads-pr">' + PRESETS.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === P.preset ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select></div><div id="ads-tree"><p class="mut">Loading…</p></div>';
    $('#ads-pr').onchange = function () { P.preset = this.value; tree(); };
    upForm(); tree();
  }
  function tree() {
    var box = $('#ads-tree'); if (!box) return;
    rpc('ads_tree', { preset: P.preset }).then(function (r) { P.tree = r; paintTree(); upSets(); }).catch(function (e) { box.innerHTML = '<p class="mut">' + esc(e.message) + '</p>'; });
  }
  function paintTree() {
    var box = $('#ads-tree'); if (!box || !P.tree) return;
    box.innerHTML = P.tree.campaigns.map(function (c) {
      return '<div class="ads-c"><div class="ads-h"><b>' + esc(c.name) + '</b>' + chip(c.status, c.eff) + (c.daily ? '<span class="ads-m">' + inr(c.daily) + '/day</span>' : '') + '</div>' + m(c.m) +
        c.sets.map(function (s) {
          return '<div class="ads-set"><div class="ads-h"><b style="font-weight:600">' + esc(s.name) + '</b>' + chip(s.status, s.eff) + (s.daily ? '<span class="ads-m">' + inr(s.daily) + '/day</span>' : '') + '</div>' + m(s.m) +
            s.ads.map(function (a) {
              return '<div class="ads-ad">' + (a.thumb ? '<img src="' + esc(a.thumb) + '" alt="" loading="lazy">' : '<img alt="">') + '<div class="t"><div>' + esc(a.name) + ' ' + chip(a.status, a.eff) + '</div>' + m(a.m) + '</div>' +
                (a.video ? '<button class="ads-btn" data-rv="' + a.id + '">Copyright check</button>' : '') + '<button class="ads-btn" data-st="' + a.id + '" data-to="' + (a.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE') + '">' + (a.status === 'ACTIVE' ? 'Pause' : 'Turn on') + '</button>' +
                '<button class="ads-btn red" data-del="' + a.id + '" data-n="' + esc(a.name) + '">Delete</button></div>';
            }).join('') + '</div>';
        }).join('') + '</div>';
    }).join('') || '<p class="mut">No campaigns.</p>';
    box.onclick = function (e) {
      var rv = e.target.closest('[data-rv]');
      if (rv) { rv.disabled = true; rv.textContent = 'Checking…'; rpc('ads_review', { ad_id: rv.dataset.rv }).then(function (r) { rv.textContent = r.verdict; rv.title = r.notes || ''; if (r.notes) toast(r.notes); }).catch(function (e) { rv.disabled = false; rv.textContent = 'Copyright check'; toast(e.message); }); return; }
      var b = e.target.closest('[data-st],[data-del]'); if (!b) return;
      if (b.dataset.del && !confirm('Delete the ad "' + b.dataset.n + '"? This cannot be undone.')) return;
      b.disabled = true;
      rpc('ads_ad_status', { id: b.dataset.st || b.dataset.del, status: b.dataset.del ? 'DELETED' : b.dataset.to })
        .then(function () { toast(b.dataset.del ? 'Ad deleted' : 'Done'); tree(); }).catch(function (e) { b.disabled = false; toast(e.message); });
    };
  }

  /* ---- new Reel ad ---- */
  function upForm() {
    var u = $('#ads-up');
    u.innerHTML = '<div class="ads-h"><b>New Reel ad</b></div>' +
      '<label>1. Video (MP4)</label><input type="file" id="ads-f" accept="video/mp4,video/quicktime,video/*">' +
      '<ul class="ads-ck" id="ads-ck"></ul>' +
      '<label>2. Ad set</label><select id="ads-set"><option value="">Loading ad sets…</option></select>' +
      '<div class="ads-m" id="ads-tpl" style="margin-top:6px"></div>' +
      '<label>Ad name (optional)</label><input id="ads-nm" placeholder="Reel ' + new Date().toLocaleDateString('en-IN') + '">' +
      '<label>Primary text (empty = same as the copied ad)</label><textarea id="ads-msg" rows="2"></textarea>' +
      '<label>Start as</label><select id="ads-on"><option value="PAUSED">Paused (I will turn it on)</option><option value="ACTIVE">Active now</option></select>' +
      '<div class="ads-bar" id="ads-bar" hidden><i></i></div><div class="ads-m" id="ads-msg2"></div>' +
      '<button class="ads-go" id="ads-go" disabled>Upload and create ad</button>';
    $('#ads-f').onchange = function () { P.file = this.files[0] || null; P.check = null; checkVideo(); };
    $('#ads-set').onchange = function () { P.sel = this.value; template(); };
    $('#ads-go').onclick = go;
  }
  function upSets() {
    var sel = $('#ads-set'); if (!sel || !P.tree) return;
    var opts = [], win = '';
    P.tree.campaigns.forEach(function (c) { c.sets.forEach(function (s) { opts.push('<option value="' + s.id + '">' + esc(c.name + ' › ' + s.name) + (s.status === 'ACTIVE' ? '' : ' (paused)') + '</option>'); if (!win && /winning/i.test(s.name + ' ' + c.name) && s.status === 'ACTIVE') win = s.id; }); });
    sel.innerHTML = '<option value="">Choose an ad set</option>' + opts.join('');
    if (!P.sel && win) P.sel = win;
    if (P.sel) { sel.value = P.sel; template(); }
    ready();
  }
  function template() {
    var t = $('#ads-tpl'); if (!P.sel) { t.textContent = ''; ready(); return; }
    t.textContent = 'Finding the best ad in this ad set to copy…';
    rpc('ads_template', { adset_id: P.sel }).then(function (r) {
      var x = r.template;
      t.innerHTML = x ? 'Copies <b>' + esc(x.name) + '</b>: button ' + esc(x.cta.replace(/_/g, ' ').toLowerCase()) + ', link ' + esc(x.link) + (x.message ? '<br>Text: “' + esc(x.message.slice(0, 140)) + (x.message.length > 140 ? '…' : '') + '”' : '') : 'No ad in this ad set yet: the default text, Shop now button and inkkulture.in are used.';
    }).catch(function (e) { t.textContent = e.message; });
    ready();
  }
  function ready() { var b = $('#ads-go'); if (b) b.disabled = !(P.file && P.check && P.check.ok && P.sel); }

  /* format, length and sound of the chosen file, before anything is uploaded */
  function checkVideo() {
    var ck = $('#ads-ck'), f = P.file; ck.innerHTML = ''; ready();
    if (!f) return;
    ck.innerHTML = '<li>Checking the video…</li>';
    var url = URL.createObjectURL(f), v = document.createElement('video'); v.preload = 'metadata'; v.muted = true; v.src = url;
    v.onerror = function () { ck.innerHTML = '<li>✗ This file can’t be read as a video. Export it again as MP4 (H.264).</li>'; P.check = { ok: false }; ready(); };
    v.onloadedmetadata = function () {
      var w = v.videoWidth, h = v.videoHeight, d = v.duration, r = w && h ? w / h : 0, out = [], ok = true;
      if (Math.abs(r - 9 / 16) < 0.03) out.push('✓ 9:16 vertical (Reels format), ' + w + '×' + h);
      else if (Math.abs(r - 4 / 5) < 0.03) out.push('⚠ 4:5 (' + w + '×' + h + '): runs in Reels with bars; 9:16 fills the screen');
      else { out.push('✗ ' + w + '×' + h + ' is not 9:16. Reels ads need a vertical 9:16 video (1080×1920)'); ok = false; }
      if (w && w < 540) { out.push('⚠ Low resolution: 1080×1920 looks much better'); }
      if (d < 3) { out.push('✗ Too short (' + d.toFixed(1) + ' s): at least 3 s'); ok = false; }
      else if (d > 90) out.push('⚠ ' + Math.round(d) + ' s long: Reels ads work best under 30 s (Meta allows up to 15 min)');
      else out.push('✓ ' + Math.round(d) + ' s long' + (d > 30 ? ' (under 30 s usually performs better)' : ''));
      if (f.size > 1024 * 1024 * 1024) { out.push('✗ File is over 1 GB'); ok = false; } else out.push('✓ ' + (f.size / 1048576).toFixed(1) + ' MB');
      URL.revokeObjectURL(url);
      ck.innerHTML = out.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '<li id="ads-snd">Checking the sound…</li>';
      P.check = { ok: ok, w: w, h: h, d: d };
      ready();
      sound(f);
    };
  }
  function sound(f) {
    var li = function (t) { var x = $('#ads-snd'); if (x) x.textContent = t; };
    if (f.size > 300 * 1024 * 1024) return li('Sound not checked (file too big to check here).');
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return li('Sound not checked on this browser.');
    f.arrayBuffer().then(function (buf) {
      var ctx = new AC(), done = function (b) {
        try { ctx.close(); } catch (e) { /* ignore */ }
        if (!b || !b.length) return li('✗ No sound in this video. Meta will run it, but Reels with sound usually do much better.');
        var ch = b.getChannelData(0), n = 0, s = 0, peak = 0;
        for (var i = 0; i < ch.length; i += 50) { var x = Math.abs(ch[i]); s += x * x; n++; if (x > peak) peak = x; }
        var rms = Math.sqrt(s / Math.max(1, n));
        if (peak < 0.01) return li('✗ The sound track is silent. Add voice or music before running it.');
        li('♪ Has sound. Copyright: Meta checks the music when it reviews the ad; its answer (OK / audio muted / rejected) shows here after the ad is made, and on the ad’s “Copyright check” button.');
      };
      try { var p = ctx.decodeAudioData(buf, done, function () { done(null); }); if (p && p.catch) p.catch(function () { done(null); }); } catch (e) { done(null); }
    }).catch(function () { li('Sound not checked.'); });
  }

  function b64(blob) { return new Promise(function (ok, no) { var r = new FileReader(); r.onload = function () { ok(String(r.result).split(',')[1] || ''); }; r.onerror = no; r.readAsDataURL(blob); }); }
  function wait(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  function go() {
    var f = P.file, btn = $('#ads-go'), bar = $('#ads-bar'), fill = bar.querySelector('i'), msg = $('#ads-msg2');
    var say = function (t) { msg.textContent = t; }, prog = function (x) { fill.style.width = Math.round(x * 100) + '%'; };
    btn.disabled = true; bar.hidden = false; prog(0); say('Starting upload…');
    var vid = '', ses = '';
    rpc('ads_video_start', { size: f.size }).then(function (r) {
      vid = r.video_id; ses = r.session;
      var step = function (start, end) {
        if (start >= end) return Promise.resolve();
        var range = f.slice(start, end), parts = Math.max(1, Math.ceil(range.size / PART)), i = 0, last = null;
        var one = function () {
          if (i >= parts) return Promise.resolve(last);
          var piece = range.slice(i * PART, Math.min(range.size, (i + 1) * PART));
          return b64(piece).then(function (data) { return rpc('ads_video_chunk', { session: ses, start: start, part: i, parts: parts, data: data }); })
            .then(function (x) { i++; last = x; prog((start + Math.min(range.size, i * PART)) / f.size * 0.9); say('Uploading… ' + Math.round((start + Math.min(range.size, i * PART)) / f.size * 100) + '%'); return one(); });
        };
        return one().then(function (x) { return step(x.start, x.end); });
      };
      return step(r.start, r.end);
    }).then(function () {
      say('Finishing upload…'); return rpc('ads_video_finish', { session: ses, title: $('#ads-nm').value || f.name });
    }).then(function () {
      var tries = 0;
      var poll = function () {
        return rpc('ads_video_info', { video_id: vid }).then(function (v) {
          prog(0.9 + Math.min(0.09, tries * 0.005));
          if (v.copyright) say('Meta copyright check: ' + v.copyright.replace(/_/g, ' '));
          if (v.status === 'error') throw new Error('Meta could not process this video. Export it again as MP4 (H.264, AAC sound).');
          if (v.cover && (v.status === 'ready' || tries > 6)) return v;
          if (++tries > 60) throw new Error('Meta is still processing the video. Wait a few minutes and try again.');
          say('Meta is processing the video… ' + (v.progress ? v.progress + '%' : '')); return wait(5000).then(poll);
        });
      };
      return poll();
    }).then(function (v) {
      say('Creating the ad…');
      return rpc('ads_video_ad', { adset_id: P.sel, video_id: vid, cover: v.cover, name: $('#ads-nm').value, message: $('#ads-msg').value, status: $('#ads-on').value }).then(function (r) { r.copyright = v.copyright; return r; });
    }).then(function (r) {
      prog(1);
      say('Ad created' + (r.copied_from ? ' like “' + r.copied_from.name + '”' : '') + ' · ' + ($('#ads-on').value === 'ACTIVE' ? 'active (Meta reviews it first)' : 'paused') + (r.copyright ? ' · copyright check: ' + r.copyright.replace(/_/g, ' ') : ''));
      toast('Reel ad created'); P.file = null; $('#ads-f').value = ''; $('#ads-ck').innerHTML = ''; tree();
      review(r.ad_id, 0);
    }).catch(function (e) { say('✗ ' + e.message); toast(e.message); btn.disabled = false; });
  }
  /* Meta tells about copyright music when it reviews the ad: follow it for up to 15 minutes */
  function review(id, n) {
    var msg = $('#ads-msg2'); if (!msg) return;
    rpc('ads_review', { ad_id: id }).then(function (r) {
      var done = !/in review/.test(r.verdict) || n >= 60;
      msg.innerHTML = esc('Meta review (copyright / music): ' + r.verdict + (r.notes ? ' · ' + r.notes : '') + (done ? '' : ' · checking again in 15 s'));
      if (!done) setTimeout(function () { review(id, n + 1); }, 15000);
    }).catch(function () { if (n < 60) setTimeout(function () { review(id, n + 1); }, 15000); });
  }
  window.IKAds = { load: load };
})();
