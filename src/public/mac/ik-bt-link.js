// Ink Kulture: Bluetooth link to the label printer (macOS, JavaScript for Automation).
//
// Runs in the "IK Printer Bluetooth link" Terminal window (Terminal is the app macOS lets use Bluetooth):
//   osascript -l JavaScript ik-bt-link.js serve <printer name> <spool dir> <log file> [<settings.json>]
//   osascript -l JavaScript ik-bt-link.js list <printer name>
//
// - One Bluetooth connection (RFCOMM serial channel, like the printer's phone app) is opened and KEPT open; it is
//   re-opened by itself if the printer drops it (switched off, out of range, idle), so labels never wait on a reconnect
//   dance per label.
// - <spool>/*.pdf  labels from the dashboard: each page is drawn by macOS at the printer's own resolution (8 dots per
//   mm, 203 dpi) with no smoothing and no dithering, turned into pure black and white, and sent as one TSPL BITMAP:
//   sharp text and barcodes that scan.  Darkness / speed / size come from settings.json.
// - <spool>/*.prn  print jobs from the Mac's printer driver (other apps): sent as they are.
// - A label that cannot be sent after 3 tries goes to <spool>/failed with a .err note.
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('IOBluetooth');

var FM = $.NSFileManager.defaultManager;
var LOG = '';
var CFG = { w: 100, h: 150, gap: 2, density: 12, speed: 3, direction: 1, threshold: 160, invert: false, chunk: 0 };

function str(x) { try { return ObjC.unwrap(x) || ''; } catch (e) { return ''; } }
function nap(s) { $.NSThread.sleepForTimeInterval(s); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function lg(msg) {
  var d = new Date(), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var line = pad(d.getDate()) + ' ' + M[d.getMonth()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' + msg + '\n';
  if (!LOG) return;
  if (!FM.fileExistsAtPath(LOG)) FM.createFileAtPathContentsAttributes(LOG, $(), $());
  var fh = $.NSFileHandle.fileHandleForWritingAtPath(LOG);
  if (!fh || fh.isNil()) return;
  fh.seekToEndOfFile;
  fh.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding));
  fh.closeFile;
}
function readText(path) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  return s && !s.isNil() ? str(s) : '';
}
function loadCfg(path) {
  if (!path) return;
  try { var j = JSON.parse(readText(path) || '{}'); for (var k in j) if (j[k] !== null && j[k] !== '') CFG[k] = j[k]; } catch (e) { lg('settings.json not readable: ' + e); }
}

/* ---------------- base64 (no atob in JXA) ---------------- */
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B64I = (function () { var t = new Int16Array(256); for (var i = 0; i < 256; i++) t[i] = -1; for (var j = 0; j < 64; j++) t[B64.charCodeAt(j)] = j; return t; })();
function b64dec(s) {
  var n = s.length, out = new Uint8Array(Math.floor(n * 3 / 4)), o = 0, buf = 0, bits = 0;
  for (var i = 0; i < n; i++) {
    var v = B64I[s.charCodeAt(i) & 255];
    if (v < 0) continue;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 255; }
  }
  return out.subarray(0, o);
}
function b64enc(u) {
  var parts = [], s = '';
  for (var i = 0; i < u.length; i += 3) {
    var a = u[i], b = i + 1 < u.length ? u[i + 1] : 0, c = i + 2 < u.length ? u[i + 2] : 0;
    var t = (a << 16) | (b << 8) | c;
    s += B64[(t >> 18) & 63] + B64[(t >> 12) & 63] + (i + 1 < u.length ? B64[(t >> 6) & 63] : '=') + (i + 2 < u.length ? B64[t & 63] : '=');
    if (s.length > 8192) { parts.push(s); s = ''; }
  }
  parts.push(s);
  return parts.join('');
}
function toNSData(u) { return $.NSData.alloc.initWithBase64EncodedStringOptions($(b64enc(u)), 0); }
function asciiBytes(s) { var u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; }
function concat(list) {
  var n = 0, i; for (i = 0; i < list.length; i++) n += list[i].length;
  var out = new Uint8Array(n), o = 0; for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
  return out;
}

/* ---------------- PDF page -> printer dots -> TSPL ---------------- */
function renderPdf(path) {
  var W = Math.round(CFG.w * 8), H = Math.round(CFG.h * 8);
  var rep = $.NSPDFImageRep.imageRepWithData($.NSData.dataWithContentsOfFile(path));
  if (!rep || rep.isNil()) throw new Error('not a readable PDF');
  var pages = Number(rep.pageCount) || 1, out = [];
  for (var p = 0; p < pages; p++) {
    rep.setCurrentPage(p);
    var b = rep.bounds, pw = b.size.width, ph = b.size.height;
    var turn = (pw > ph) !== (W > H);
    var bmp = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, W, H, 8, 4, true, false, 'NSDeviceRGBColorSpace', W * 4, 32);
    var ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(bmp);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext(ctx);
    ctx.setShouldAntialias(false);
    ctx.setImageInterpolation(1);   /* none */
    $.NSColor.whiteColor.setFill;
    $.NSBezierPath.fillRect($.NSMakeRect(0, 0, W, H));
    var k = turn ? Math.min(W / ph, H / pw) : Math.min(W / pw, H / ph);
    var dw = (turn ? ph : pw) * k, dh = (turn ? pw : ph) * k;
    var t = $.NSAffineTransform.transform;
    t.translateXByYBy(Math.round((W - dw) / 2), Math.round((H - dh) / 2));
    if (turn) { t.translateXByYBy(dw, 0); t.rotateByDegrees(90); }
    t.scaleBy(k);
    t.concat;
    rep.drawInRect($.NSMakeRect(0, 0, pw, ph));
    ctx.flushGraphics;
    $.NSGraphicsContext.restoreGraphicsState;
    var rgba = b64dec(str($.NSData.dataWithBytesLength(bmp.bitmapData, W * H * 4).base64EncodedStringWithOptions(0)));
    out.push({ W: W, H: H, rgba: rgba });
  }
  return out;
}
/* TSPL BITMAP: bit 0 = print a dot (black), 1 = leave white */
function tspl(img) {
  var W = img.W, H = img.H, wb = Math.ceil(W / 8), bits = new Uint8Array(wb * H), px = img.rgba, thr = Number(CFG.threshold) || 160, black = 0;
  for (var y = 0; y < H; y++) {
    for (var xb = 0; xb < wb; xb++) {
      var v = 0xff;
      for (var bit = 0; bit < 8; bit++) {
        var x = xb * 8 + bit;
        if (x >= W) continue;
        var i = (y * W + x) * 4, a = px[i + 3];
        /* premultiplied: blend onto white */
        var r = px[i] + (255 - a), g = px[i + 1] + (255 - a), bl = px[i + 2] + (255 - a);
        var dark = (r * 299 + g * 587 + bl * 114) / 1000 < thr;
        if (CFG.invert) dark = !dark;
        if (dark) { v &= ~(0x80 >> bit); black++; }
      }
      bits[y * wb + xb] = v;
    }
  }
  var head = 'SIZE ' + CFG.w + ' mm,' + CFG.h + ' mm\r\nGAP ' + CFG.gap + ' mm,0 mm\r\nSPEED ' + CFG.speed + '\r\nDENSITY ' + CFG.density +
    '\r\nDIRECTION ' + CFG.direction + ',0\r\nREFERENCE 0,0\r\nOFFSET 0 mm\r\nSET TEAR ON\r\nCLS\r\nBITMAP 0,0,' + wb + ',' + H + ',0,';
  return { bytes: concat([asciiBytes(head), bits, asciiBytes('\r\nPRINT 1,1\r\n')]), black: black };
}

/* ---------------- Bluetooth (one kept-open RFCOMM channel) ---------------- */
var BT = { dev: null, ch: null, chan: 0, mtu: 0 };
function findPrinter(hint) {
  var list = $.IOBluetoothDevice.pairedDevices, n = list && !list.isNil() ? Number(list.count) : 0, names = [], hit = null, guess = null;
  hint = String(hint || 'CD410').toLowerCase();
  for (var i = 0; i < n; i++) {
    var d = list.objectAtIndex(i), nm = str(d.name);
    names.push(nm);
    if (!hit && nm.toLowerCase().indexOf(hint) >= 0) hit = d;
    if (!guess && /cd4|print|pos|label|thermal/i.test(nm)) guess = d;
  }
  return { dev: hit || guess, names: names };
}
function channelsFor(dev) {
  var out = [];
  if (BT.chan) out.push(BT.chan);
  try {
    var rec = dev.getServiceRecordForUUID($.IOBluetoothSDPUUID.uuid16(0x1101));
    if (rec && !rec.isNil()) { var r = Ref(); if (rec.getRFCOMMChannelID(r) === 0 && r[0]) out.push(Number(r[0])); }
  } catch (e) { /* the usual channels */ }
  [1, 2, 3, 4, 5, 6].forEach(function (c) { if (out.indexOf(c) < 0) out.push(c); });
  return out;
}
function isOpen() { try { return !!(BT.ch && !BT.ch.isNil() && BT.ch.isOpen); } catch (e) { return false; } }
function closeBT() {
  try { if (BT.ch && !BT.ch.isNil()) BT.ch.closeChannel; } catch (e) { /* gone */ }
  BT.ch = null;
}
function openBT(hint) {
  if (isOpen()) return true;
  closeBT();
  var f = findPrinter(hint);
  if (!f.dev) { lg('ERR printer "' + hint + '" is not paired with this Mac (paired: ' + f.names.join(', ') + ')'); return false; }
  BT.dev = f.dev;
  var codes = [];
  for (var attempt = 0; attempt < 2; attempt++) {
    var chans = channelsFor(BT.dev);
    for (var k = 0; k < chans.length; k++) {
      var ref = Ref();
      var rv = BT.dev.openRFCOMMChannelSyncWithChannelIDDelegate(ref, chans[k], null);
      codes.push(chans[k] + ':' + rv);
      if (rv === 0 && ref[0] && !ref[0].isNil()) {
        BT.ch = ref[0]; BT.chan = chans[k]; BT.mtu = Number(BT.ch.getMTU) || 127;
        lg('connected to ' + str(BT.dev.name) + ' (channel ' + BT.chan + ', packet ' + BT.mtu + ' bytes)');
        return true;
      }
    }
    nap(2);
  }
  lg('ERR could not connect to the printer (' + codes.join(' ') + '): is it switched on and near the Mac?');
  return false;
}
/* write all bytes; on a dropped connection reconnect once and send the whole label again */
function sendBytes(hint, u) {
  for (var round = 0; round < 2; round++) {
    if (!openBT(hint)) return 'ERR printer not connected';
    var data = toNSData(u), total = u.length, step = Math.max(32, Math.min(BT.mtu || 127, Number(CFG.chunk) || 4096)), off = 0, err = 0, t0 = Date.now();
    while (off < total) {
      var len = Math.min(step, total - off);
      var w = BT.ch.writeSyncLength(data.subdataWithRange($.NSMakeRange(off, len)).bytes, len);
      if (w !== 0) { err = w; break; }
      off += len;
    }
    if (!err) return 'OK sent ' + total + ' bytes in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's';
    lg('connection dropped at ' + off + ' of ' + total + ' bytes (code ' + err + '), reconnecting');
    closeBT(); nap(1.5);
  }
  return 'ERR the printer kept dropping the connection';
}

/* ---------------- spool ---------------- */
function files(dir) {
  var a = FM.contentsOfDirectoryAtPathError(dir, null);
  if (!a || a.isNil()) return [];
  return ObjC.deepUnwrap(a).filter(function (n) { return /\.(pdf|prn)$/.test(n); }).sort();
}
function bytesOf(path) { return b64dec(str($.NSData.dataWithContentsOfFile(path).base64EncodedStringWithOptions(0))); }
function fail(dir, name, why) {
  var fd = dir + '/failed';
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(fd, true, $(), null);
  FM.removeItemAtPathError(fd + '/' + name, null);
  FM.moveItemAtPathToPathError(dir + '/' + name, fd + '/' + name, null);
  $(why).writeToFileAtomicallyEncodingError(fd + '/' + name + '.err', true, $.NSUTF8StringEncoding, null);
}
function serve(hint, dir, cfgPath) {
  lg('link started for ' + hint + ' (TSPL ' + CFG.w + 'x' + CFG.h + ' mm, darkness ' + CFG.density + ', speed ' + CFG.speed + ')');
  openBT(hint);
  var tries = {}, idle = 0;
  for (;;) {
    var list = files(dir);
    if (!list.length) {
      nap(0.5); idle++;
      if (idle % 120 === 0) loadCfg(cfgPath);   /* settings changes apply within a minute */
      continue;
    }
    idle = 0;
    var name = list[0], path = dir + '/' + name, r;
    try {
      if (/\.pdf$/.test(name)) {
        var pages = renderPdf(path), msgs = [];
        for (var p = 0; p < pages.length; p++) {
          var job = tspl(pages[p]);
          if (job.black < 50) { msgs.push('page ' + (p + 1) + ' blank, skipped'); continue; }
          r = sendBytes(hint, job.bytes);
          msgs.push(r);
          if (!/^OK/.test(r)) break;
          if (p < pages.length - 1) nap(0.4);
        }
        r = msgs.join('; ') || 'ERR nothing to print';
        if (msgs.length && msgs.every(function (m) { return /^OK|skipped/.test(m); })) r = 'OK ' + r;
      } else {
        r = sendBytes(hint, bytesOf(path));
      }
    } catch (e) { r = 'ERR ' + (e && e.message ? e.message : e); }
    lg(name + ': ' + r.replace(/^OK OK/, 'OK'));
    if (/^OK/.test(r)) { FM.removeItemAtPathError(path, null); delete tries[name]; }
    else if ((tries[name] = (tries[name] || 0) + 1) >= 3) { fail(dir, name, r); delete tries[name]; lg(name + ': gave up after 3 tries'); }
    else nap(5);
  }
}

function run(argv) {
  var mode = String(argv[0] || ''), hint = String(argv[1] || 'CD410');
  if (mode === 'list') { var f = findPrinter(hint); return 'paired: ' + f.names.join(', ') + (f.dev ? ' | printer: ' + str(f.dev.name) : ' | printer not found'); }
  if (mode === 'serve') {
    var dir = String(argv[2] || ''); LOG = String(argv[3] || ''); loadCfg(String(argv[4] || ''));
    FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), null);
    serve(hint, dir, String(argv[4] || ''));
    return '';
  }
  if (mode === 'render') {   /* test: render a PDF and report how many dots would print */
    LOG = ''; loadCfg(String(argv[3] || ''));
    var pg = renderPdf(String(argv[2] || '')), rep = [];
    for (var i = 0; i < pg.length; i++) { var j = tspl(pg[i]); rep.push('page ' + (i + 1) + ': ' + j.bytes.length + ' bytes, ' + j.black + ' black dots'); }
    return rep.join('\n');
  }
  return 'usage: serve <printer> <spool> <log> [settings.json] | list <printer> | render <printer> <pdf> [settings.json]';
}
