/* Ink Kulture: print shipping labels straight to a Bluetooth (BLE) label printer from the dashboard.
   Works where the browser has Web Bluetooth: Bluefy on iPhone/iPad, Chrome on Mac, Android, Windows.

   1. connect()   the browser's own device picker; the first characteristic that can be written to is used (thermal
                  printers expose a "serial" service under one of a handful of known UUIDs, listed in SVC).
   2. printPdf()  each page of the label PDF is drawn with PDF.js at the printer's resolution (8 dots per mm), turned
                  into black and white, and sent as one TSPL BITMAP (label mode, default) or ESC/POS raster image
                  (receipt mode), in small Bluetooth packets.
   Settings (this device only, localStorage): mode tspl|escpos, label width/height/gap in mm, invert, darkness, auto. */
(function (root) {
  var SVC = [
    0x18f0, 0xff00, 0xffe0, 0xffe5, 0xfee7, 0xae30, 0xae00, 0xff12, 0x1101,
    '49535343-fe7d-4ae5-8fa9-9fafd205e455', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '0000ff00-0000-1000-8000-00805f9b34fb',
    '000018f0-0000-1000-8000-00805f9b34fb', '00001101-0000-1000-8000-00805f9b34fb', '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  ];
  var KEY = 'ik_bt';
  var S = { dev: null, ch: null, wwr: false, name: '', busy: false };
  function cfg() {
    var d = { mode: 'tspl', w: 100, h: 150, gap: 2, invert: false, dark: 10, auto: true, chunk: 180 };
    try { var j = JSON.parse(localStorage.getItem(KEY) || '{}'); for (var k in j) d[k] = j[k]; } catch (e) { /* defaults */ }
    return d;
  }
  function save(c) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* not kept */ } }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var available = function () { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); };

  async function attach() {
    var server = await S.dev.gatt.connect();
    var services = await server.getPrimaryServices();
    var pick = null;
    for (var i = 0; i < services.length && !pick; i++) {
      var chs = [];
      try { chs = await services[i].getCharacteristics(); } catch (e) { continue; }
      for (var j = 0; j < chs.length; j++) {
        var p = chs[j].properties;
        if (p.writeWithoutResponse || p.write) { pick = chs[j]; break; }
      }
    }
    if (!pick) throw new Error('Connected, but this printer has no data channel the browser can write to');
    S.ch = pick; S.wwr = !!pick.properties.writeWithoutResponse;
    return S.name;
  }
  async function connect() {
    if (!available()) throw new Error('This browser has no Bluetooth. On iPhone open the dashboard in the Bluefy app; on a computer use Chrome.');
    S.dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SVC });
    S.name = S.dev.name || 'printer';
    S.dev.addEventListener('gattserverdisconnected', function () { S.ch = null; });
    await attach();
    var c = cfg(); c.last = S.name; save(c);
    return S.name;
  }
  async function ensure() {
    if (S.ch && S.dev && S.dev.gatt.connected) return;
    if (S.dev) { await attach(); return; }
    throw new Error('Connect the Bluetooth printer first (Settings, Label printer)');
  }
  async function send(bytes, onProgress) {
    await ensure();
    var n = Math.max(20, Math.min(512, cfg().chunk || 180));
    for (var off = 0, k = 0; off < bytes.length; off += n, k++) {
      var part = bytes.subarray(off, Math.min(bytes.length, off + n));
      var tries = 0;
      for (;;) {
        try {
          if (S.wwr && S.ch.writeValueWithoutResponse) await S.ch.writeValueWithoutResponse(part);
          else await S.ch.writeValue(part);
          break;
        } catch (e) {
          if (++tries > 3) throw e;
          await sleep(150);
          if (!S.dev.gatt.connected) await attach();
        }
      }
      if (S.wwr && k % 8 === 7) await sleep(12);   /* let the printer's buffer drain */
      if (onProgress && k % 20 === 0) onProgress(off / bytes.length);
    }
    if (onProgress) onProgress(1);
  }

  /* ---------- image -> printer commands ---------- */
  var enc = function (s) { return new TextEncoder().encode(s); };
  function join(parts) {
    var len = 0; parts.forEach(function (p) { len += p.length; });
    var out = new Uint8Array(len), o = 0; parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }
  /* canvas -> 1 bit per dot, rows of `wb` bytes; `black` decides which bit value prints */
  function pack(canvas, oneIsBlack) {
    var c = cfg(), w = canvas.width, h = canvas.height, wb = Math.ceil(w / 8);
    var px = canvas.getContext('2d').getImageData(0, 0, w, h).data, out = new Uint8Array(wb * h);
    var blackBit = oneIsBlack ? 1 : 0; if (c.invert) blackBit ^= 1;
    for (var y = 0; y < h; y++) {
      for (var xb = 0; xb < wb; xb++) {
        var v = 0;
        for (var b = 0; b < 8; b++) {
          var x = xb * 8 + b, dark = false;
          if (x < w) { var i = (y * w + x) * 4; dark = px[i + 3] > 40 && (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) < 150; }
          if ((dark ? blackBit : blackBit ^ 1) === 1) v |= 0x80 >> b;
        }
        out[y * wb + xb] = v;
      }
    }
    return { data: out, wb: wb, h: h };
  }
  function tspl(canvas) {
    var c = cfg(), b = pack(canvas, false);
    return join([enc('SIZE ' + c.w + ' mm,' + c.h + ' mm\r\nGAP ' + c.gap + ' mm,0 mm\r\nDENSITY ' + (c.dark | 0) + '\r\nDIRECTION 1,0\r\nREFERENCE 0,0\r\nCLS\r\nBITMAP 0,0,' + b.wb + ',' + b.h + ',0,'), b.data, enc('\r\nPRINT 1,1\r\n')]);
  }
  function escpos(canvas) {
    var b = pack(canvas, true), parts = [new Uint8Array([0x1b, 0x40])], band = 256;
    for (var y = 0; y < b.h; y += band) {
      var rows = Math.min(band, b.h - y);
      parts.push(new Uint8Array([0x1d, 0x76, 0x30, 0x00, b.wb & 255, b.wb >> 8, rows & 255, rows >> 8]));
      parts.push(b.data.subarray(y * b.wb, (y + rows) * b.wb));
    }
    parts.push(new Uint8Array([0x1b, 0x64, 0x04]));
    return join(parts);
  }
  var commands = function (canvas) { return cfg().mode === 'escpos' ? escpos(canvas) : tspl(canvas); };

  /* a blank label-sized canvas: width x height in printer dots (8 per mm) */
  function blank() {
    var c = cfg(), cv = document.createElement('canvas');
    cv.width = Math.round(c.w * 8); cv.height = Math.round(c.h * 8);
    var g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    return cv;
  }
  var pdfReady = null;
  function loadPdfJs() {
    if (root.pdfjsLib) return Promise.resolve(root.pdfjsLib);
    if (!pdfReady) pdfReady = new Promise(function (ok, no) {
      var s = document.createElement('script'); s.src = '/pdfjs.min.js';
      s.onload = function () { root.pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs.worker.min.js'; ok(root.pdfjsLib); };
      s.onerror = function () { pdfReady = null; no(new Error('Could not load the PDF reader')); };
      document.head.appendChild(s);
    });
    return pdfReady;
  }
  /* every page of a PDF, each drawn to fit the label (a landscape page is turned to fit a portrait label) */
  async function pdfCanvases(bytes) {
    var lib = await loadPdfJs();
    var doc = await lib.getDocument({ data: bytes }).promise, out = [];
    for (var n = 1; n <= doc.numPages; n++) {
      var page = await doc.getPage(n), cv = blank(), g = cv.getContext('2d');
      var vp0 = page.getViewport({ scale: 1 });
      var turn = (vp0.width > vp0.height) !== (cv.width > cv.height);
      var vpr = page.getViewport({ scale: 1, rotation: turn ? 90 : 0 });
      var k = Math.min(cv.width / vpr.width, cv.height / vpr.height);
      var vp = page.getViewport({ scale: k, rotation: turn ? 90 : 0 });
      var tmp = document.createElement('canvas'); tmp.width = Math.ceil(vp.width); tmp.height = Math.ceil(vp.height);
      var tg = tmp.getContext('2d'); tg.fillStyle = '#fff'; tg.fillRect(0, 0, tmp.width, tmp.height);
      await page.render({ canvasContext: tg, viewport: vp }).promise;
      g.drawImage(tmp, Math.round((cv.width - tmp.width) / 2), Math.round((cv.height - tmp.height) / 2));
      out.push(cv);
    }
    return out;
  }

  async function printPdf(bytes, onProgress) {
    if (S.busy) throw new Error('Still printing the previous label');
    S.busy = true;
    try {
      var pages = await pdfCanvases(bytes);
      for (var i = 0; i < pages.length; i++) {
        await send(commands(pages[i]), onProgress ? function (f) { onProgress((i + f) / pages.length); } : null);
        if (i < pages.length - 1) await sleep(400);
      }
      return pages.length;
    } finally { S.busy = false; }
  }
  async function printTest() {
    var cv = blank(), g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.fillStyle = '#000'; g.lineWidth = 6; g.strokeRect(12, 12, W - 24, H - 24);
    g.font = 'bold 72px sans-serif'; g.fillText('INK KULTURE', 50, 150);
    g.font = '40px sans-serif'; g.fillText('Bluetooth test label', 50, 230);
    g.fillText(new Date().toLocaleString('en-IN'), 50, 290);
    for (var i = 0; i < 60; i++) if ((i * 7) % 3) g.fillRect(50 + i * 11, 360, (i % 4) + 2, 200);
    g.font = '32px sans-serif'; g.fillText('If this reads correctly, labels will too.', 50, 640);
    S.busy = true;
    try { await send(commands(cv)); } finally { S.busy = false; }
  }

  root.IKBT = {
    available: available, connect: connect, printPdf: printPdf, printTest: printTest, cfg: cfg, save: save,
    connected: function () { return !!(S.ch && S.dev && S.dev.gatt && S.dev.gatt.connected); },
    name: function () { return S.name || cfg().last || ''; },
    busy: function () { return S.busy; },
  };
})(typeof window !== 'undefined' ? window : globalThis);
