// Ink Kulture: Bluetooth link to the label printer (macOS, JavaScript for Automation).
//
// Runs in the "IK Printer Bluetooth link" Terminal window (Terminal is the app macOS lets use Bluetooth):
//   osascript -l JavaScript ik-bt-link.js serve <printer name> <spool dir> "" [<settings.json>]   (log lines on stderr)
//   osascript -l JavaScript ik-bt-link.js list <printer name>
//
// - Keeps ONE Bluetooth connection (RFCOMM serial channel, like the printer's phone app) open, and opens it again by
//   itself when the printer drops it (switched off, out of range), instead of connecting for every label.
// - Sends every <spool>/*.prn as it is: dashboard labels arrive as ready printer commands (drawn by the server at
//   the printer's own resolution), and jobs from the Mac's printer driver too.
// - A label that cannot be sent after 3 tries goes to <spool>/failed with a .err note (the agent reports it).
// Only Foundation + IOBluetooth calls that are known to work here; nothing is drawn on the Mac.
ObjC.import('Foundation');
ObjC.import('IOBluetooth');

var FM = $.NSFileManager.defaultManager;

function str(x) { try { return ObjC.unwrap(x) || ''; } catch (e) { return ''; } }
function nap(s) { $.NSThread.sleepForTimeInterval(s); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function lg(msg) {
  var d = new Date(), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  console.log(pad(d.getDate()) + ' ' + M[d.getMonth()] + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' + msg);
}

/* ---------------- Bluetooth (one kept-open RFCOMM channel) ---------------- */
var BT = { dev: null, ch: null, chan: 0, mtu: 0 };
function findPrinter(hint) {
  var list = $.IOBluetoothDevice.pairedDevices, n = list ? Number(list.count) : 0, names = [], hit = null, guess = null;
  hint = String(hint || 'CD410').toLowerCase();
  for (var i = 0; i < n; i++) {
    var d = list.objectAtIndex(i), nm = str(d.name);
    names.push(nm);
    if (!hit && nm.toLowerCase().indexOf(hint) >= 0) hit = d;
    if (!guess && /cd4|print|pos|label|thermal/i.test(nm)) guess = d;
  }
  return { dev: hit || guess, names: names };
}
function isOpen() { try { return !!(BT.ch && BT.ch.isOpen); } catch (e) { return false; } }
function closeBT() {
  try { if (BT.ch) BT.ch.closeChannel; } catch (e) { /* gone */ }
  BT.ch = null;
}
function openBT(hint) {
  if (isOpen()) return true;
  closeBT();
  var f = findPrinter(hint);
  if (!f.dev) { lg('ERR printer "' + hint + '" is not paired with this Mac (paired: ' + f.names.join(', ') + ')'); return false; }
  BT.dev = f.dev;
  var codes = [], chans = [];
  if (BT.chan) chans.push(BT.chan);
  [1, 2, 3, 4, 5, 6].forEach(function (c) { if (chans.indexOf(c) < 0) chans.push(c); });
  for (var attempt = 0; attempt < 2; attempt++) {
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
/* send a whole file; if the connection drops, reconnect once and send the label again */
function sendFile(hint, path) {
  var data = $.NSData.dataWithContentsOfFile(path);
  if (!data || data.isNil()) return 'ERR cannot read ' + path;
  var total = Number(data.length);
  for (var round = 0; round < 2; round++) {
    if (!openBT(hint)) return 'ERR printer not connected';
    var step = Math.max(32, BT.mtu || 127), off = 0, err = 0, t0 = Date.now();
    while (off < total) {
      var len = Math.min(step, total - off);
      var part = data.subdataWithRange($.NSMakeRange(off, len));
      var w = BT.ch.writeSyncLength(part.bytes, len);
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
  return ObjC.deepUnwrap(a).filter(function (n) { return /\.prn$/.test(n); }).sort();
}
function fail(dir, name, why) {
  var fd = dir + '/failed';
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(fd, true, $(), null);
  FM.removeItemAtPathError(fd + '/' + name, null);
  FM.moveItemAtPathToPathError(dir + '/' + name, fd + '/' + name, null);
  $(why).writeToFileAtomicallyEncodingError(fd + '/' + name + '.err', true, $.NSUTF8StringEncoding, null);
}
function serve(hint, dir) {
  lg('link started for ' + hint);
  openBT(hint);
  var tries = {};
  for (;;) {
    var list = files(dir);
    if (!list.length) { nap(0.5); continue; }
    var name = list[0], path = dir + '/' + name, r;
    try { r = sendFile(hint, path); } catch (e) { r = 'ERR ' + (e && e.message ? e.message : e); }
    lg(name + ': ' + r);
    if (/^OK/.test(r)) { FM.removeItemAtPathError(path, null); delete tries[name]; }
    else if ((tries[name] = (tries[name] || 0) + 1) >= 3) { fail(dir, name, r); delete tries[name]; lg(name + ': gave up after 3 tries'); }
    else nap(5);
  }
}

function run(argv) {
  var mode = String(argv[0] || ''), hint = String(argv[1] || 'CD410');
  if (mode === 'list') { var f = findPrinter(hint); return 'paired: ' + f.names.join(', ') + (f.dev ? ' | printer: ' + str(f.dev.name) : ' | printer not found'); }
  if (mode === 'serve') {
    var dir = String(argv[2] || '');
    FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), null);
    serve(hint, dir);
    return '';
  }
  return 'usage: serve <printer> <spool> "" [settings.json] | list <printer>';
}
