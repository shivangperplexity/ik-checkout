/**
 * Label printing straight to the thermal printer, without any outside service.
 *
 *   Queue      print_jobs: one row per label to print. "Mark packed" (any device: phone, laptop, the packing scan)
 *              adds the order when auto-print is on; "Print label" in the dashboard adds it by hand. A job for an order
 *              that is not booked yet waits until it has an AWB (it prints the moment it is booked), for up to 3 days.
 *   Agent      a small script on the Mac the printer is plugged into (runs in the background from login, restarts
 *              itself): every few seconds it asks GET /api/print/next?k=<key>; a job comes back as the ready 6 x 4 inch
 *              label PDF (same page the dashboard's "Labels" button makes), the Mac prints it with its own `lp`, and the
 *              agent reports POST /api/print/done. Nothing to install but this script (curl and lp come with macOS).
 *   Setup      one line pasted into Terminal: bash -c "$(curl -fsSL https://…/api/print/setup?k=<key>)". It lists the
 *              Mac's printers, asks which one is the label printer, installs the agent as a LaunchAgent and prints a test.
 *   Key        a random secret in Settings (printer.key); "New key" in the dashboard cuts off an old Mac.
 */
import { labelPdf } from './labels.js';

const now = () => Math.floor(Date.now() / 1000);
const TAKE_TIMEOUT = 120;          // a job taken but not reported done is handed out again after this
const MAX_TRIES = 3;
const KEEP = 3 * 86400;            // a waiting job (order not booked yet) is dropped after this

/* table: print_jobs (lib/db.js SCHEMA) */

const randomKey = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** { auto, key } from Settings, plus the agent's last check-in { at, host, printer }. */
export async function printerState(env) {
  const row = async (k) => { const r = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind(k).first().catch(() => null); try { return r ? JSON.parse(r.v) : null; } catch { return null; } };
  const cfg = (await row('printer')) || {};
  const seen = (await row('printer_seen')) || {};
  /* PRINT_AGENT_KEY (Vercel env) works until a key is made in the dashboard */
  const envKey = /^[a-f0-9]{40}$/.test(String(env.PRINT_AGENT_KEY || '')) ? String(env.PRINT_AGENT_KEY) : '';
  return { auto: cfg.auto !== false, key: cfg.key || envKey, seen, online: Number(seen.at || 0) > now() - 90 };
}
async function saveCfg(env, patch) {
  const s = await printerState(env);
  const v = { auto: s.auto, key: s.key, ...patch };
  await env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v').bind('printer', JSON.stringify(v)).run();
  return v;
}
/** The key, made on first use. fresh = replace it (an old Mac stops working). */
export async function printerKey(env, fresh = false) {
  const s = await printerState(env);
  if (s.key && !fresh) return s.key;
  return (await saveCfg(env, { key: randomKey() })).key;
}
export const setAuto = (env, on) => saveCfg(env, { auto: !!on });

/** Add labels to print. Skips an order that already has one waiting. Returns how many were added. */
export async function enqueuePrint(env, ids, reason = 'manual') {
  let n = 0;
  for (const id of [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 200)) {
    const open = await env.DB.prepare('SELECT id FROM print_jobs WHERE order_id=? AND done_at IS NULL AND created_at>?').bind(id, now() - KEEP).first();
    if (open) continue;
    const o = await env.DB.prepare('SELECT order_name FROM orders WHERE order_id=?').bind(id).first().catch(() => null);
    await env.DB.prepare('INSERT INTO print_jobs (order_id, order_name, reason, created_at, tries) VALUES (?,?,?,?,0)').bind(id, o?.order_name || '', reason, now()).run();
    n++;
  }
  return n;
}
/** "Mark packed" with auto-print on: the orders that were marked packed go to the printer. */
export async function onPacked(env, results) {
  const s = await printerState(env).catch(() => null);
  if (!s || !s.auto || !s.key) return 0;
  return enqueuePrint(env, (results || []).filter((r) => r.ok).map((r) => r.id), 'packed');
}

async function testPdf(note) {
  const P = await import('pdf-lib');
  const d = await P.PDFDocument.create(), p = d.addPage([288, 432]);
  const f = await d.embedFont(P.StandardFonts.HelveticaBold), g = await d.embedFont(P.StandardFonts.Helvetica);
  p.drawRectangle({ x: 12, y: 12, width: 264, height: 408, borderWidth: 2, borderColor: P.rgb(0, 0, 0) });
  p.drawText('INK KULTURE', { x: 30, y: 370, size: 26, font: f });
  p.drawText('Test label', { x: 30, y: 330, size: 18, font: g });
  p.drawText('The label printer is connected.', { x: 30, y: 290, size: 12, font: g });
  p.drawText(String(note || '').slice(0, 40), { x: 30, y: 268, size: 10, font: g });
  for (let i = 0; i < 40; i++) if ((i * 7) % 3) p.drawRectangle({ x: 30 + i * 5.5, y: 60, width: (i % 4) + 1, height: 70, color: P.rgb(0, 0, 0) });
  return d.save();
}
/** One 6 x 4 inch page, exactly like the dashboard's "Labels (6x4 in)" download. */
async function readyLabel(env, orderId) {
  const raw = await labelPdf(env, orderId);
  if (!globalThis.PDFLib) globalThis.PDFLib = await import('pdf-lib');
  if (!globalThis.mergeLabels6x4) await import('../public/labels6x4.js');
  return globalThis.mergeLabels6x4([raw]);
}

/** The next label for the agent: { id, order, pdf } or null. Claims it so two agents never print one label twice. */
export async function nextJob(env) {
  const t = now();
  const rows = (await env.DB.prepare(`SELECT * FROM print_jobs WHERE done_at IS NULL AND created_at>? AND COALESCE(tries,0)<? AND (taken_at IS NULL OR taken_at<?)
      ORDER BY id LIMIT 25`).bind(t - KEEP, MAX_TRIES, t - TAKE_TIMEOUT).all()).results;
  for (const j of rows) {
    /* an order not booked yet waits (no try used) until it has an AWB */
    if (j.order_id) {
      const live = await env.DB.prepare("SELECT awb FROM shipments WHERE order_id=? AND LENGTH(COALESCE(awb,'')) > 0 AND COALESCE(status,'')<>'cancelled'").bind(String(j.order_id)).first();
      if (!live) continue;
    }
    const claim = await env.DB.prepare('UPDATE print_jobs SET taken_at=?, tries=COALESCE(tries,0)+1 WHERE id=? AND done_at IS NULL AND (taken_at IS NULL OR taken_at<?) RETURNING id').bind(t, j.id, t - TAKE_TIMEOUT).first();
    if (!claim) continue;
    try {
      const pdf = j.order_id ? await readyLabel(env, j.order_id) : await testPdf(j.reason);
      return { id: j.id, order: j.order_name || 'test', pdf };
    } catch (e) {
      const last = Number(j.tries || 0) + 1 >= MAX_TRIES;
      await env.DB.prepare(`UPDATE print_jobs SET error=?, taken_at=NULL${last ? ', done_at=?, ok=FALSE' : ''} WHERE id=?`).bind(...[String(e.message || e).slice(0, 300), ...(last ? [t] : []), j.id]).run();
    }
  }
  return null;
}

export async function jobDone(env, id, ok, msg) {
  await env.DB.prepare('UPDATE print_jobs SET done_at=?, ok=?, error=? WHERE id=?').bind(now(), !!ok, ok ? null : String(msg || 'print failed').slice(0, 300), Number(id) || 0).run();
}

/** Recent jobs for the dashboard. */
export async function recentJobs(env, n = 12) {
  return (await env.DB.prepare('SELECT id, order_id, order_name, reason, created_at, taken_at, done_at, ok, error, tries FROM print_jobs ORDER BY id DESC LIMIT ?').bind(n).all()).results;
}

/* ---------------- the Mac side ---------------- */

const shq = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";

/** The one-line setup command shown in the dashboard. */
export const setupCommand = (base, key) => `bash -c "$(curl -fsSL '${base}/api/print/setup?k=${key}')"`;

/** The setup script (bash 3.2, as on every Mac): pick the printer, install the agent, start it at login, print a test. */
export function setupScript(base, key, preset = '', bthint = '') {
  const agent = `#!/bin/bash
# Ink Kulture label printer: prints labels from the IK dashboard queue on this Mac.
URL=${shq(base)}
KEY=${shq(key)}
DIR="$HOME/Library/Application Support/IKPrinter"
PRINTER="$(cat "$DIR/printer" 2>/dev/null)"
mkdir -p "$DIR"
while true; do
  H=$(date +%H); H=\${H#0}
  if [ "$H" -ge 8 ] && [ "$H" -lt 23 ]; then WAIT=5; else WAIT=30; fi
  P="$PRINTER"; [ -z "$P" ] && P=$(lpstat -d 2>/dev/null | sed -n 's/^system default destination: //p')
  CODE=$(curl -s -m 25 -o "$DIR/job.pdf" -D "$DIR/head.txt" -w '%{http_code}' -G "$URL/api/print/next" --data-urlencode "k=$KEY" --data-urlencode "host=$(hostname -s)" --data-urlencode "printer=$P")
  if [ "$CODE" = "200" ]; then
    ID=$(grep -i '^x-job-id:' "$DIR/head.txt" | tr -d '\\r' | awk '{print $2}')
    ORD=$(grep -i '^x-order:' "$DIR/head.txt" | tr -d '\\r' | cut -d' ' -f2-)
    if OUT=$(lp -d "$P" -o fit-to-page "$DIR/job.pdf" 2>&1); then ST=1; else ST=0; fi
    curl -s -m 15 -X POST "$URL/api/print/done" --data-urlencode "k=$KEY" --data-urlencode "id=$ID" --data-urlencode "ok=$ST" --data-urlencode "msg=$OUT" >/dev/null
    echo "$(date '+%d %b %H:%M:%S') $ORD ok=$ST $OUT" >> "$DIR/agent.log"
    tail -n 300 "$DIR/agent.log" > "$DIR/agent.tmp" && mv "$DIR/agent.tmp" "$DIR/agent.log"
    continue
  fi
  [ "$CODE" = "401" ] && WAIT=300
  M="$(stat -f %m "$DIR/relay.log" 2>/dev/null)-$(stat -f %m "$DIR/agent.log" 2>/dev/null)"
  if [ "$M" != "$LASTM" ]; then
    LASTM="$M"
    { echo "relay:"; tail -n 15 "$DIR/relay.log" 2>/dev/null; echo "agent:"; tail -n 5 "$DIR/agent.log" 2>/dev/null; echo "port: $(cat "$DIR/bt-port" 2>/dev/null) $(ls -l "$(cat "$DIR/bt-port" 2>/dev/null)" 2>&1 | awk '{print $1}')"; echo "queue:"; lpstat -o "$P" 2>/dev/null | head -3; } > "$DIR/upload.txt" 2>&1
    curl -s -m 15 -X POST "$URL/api/print/log" --data-urlencode "k=$KEY" --data-urlencode "host=$(hostname -s)" --data-urlencode "log@$DIR/upload.txt" >/dev/null
  fi
  sleep $WAIT
done
`;
  return `#!/bin/bash
# Ink Kulture: label printer setup for this Mac
set -e
URL=${shq(base)}
KEY=${shq(key)}
DIR="$HOME/Library/Application Support/IKPrinter"
PLIST="$HOME/Library/LaunchAgents/in.inkkulture.printer.plist"
echo ""
echo "Ink Kulture label printer setup"
echo "-------------------------------"
LIST=$(lpstat -p 2>/dev/null | awk '/^printer /{print $2}')
if [ -z "$LIST" ]; then
  echo "No printer found on this Mac. Connect the label printer, add it in System Settings > Printers & Scanners, then run this again."
  exit 1
fi
DEF=$(lpstat -d 2>/dev/null | sed -n 's/^system default destination: //p')
i=0
for p in $LIST; do i=$((i+1)); if [ "$p" = "$DEF" ]; then echo "  $i) $p   (default)"; else echo "  $i) $p"; fi; done
echo ""
PRESET=${shq(String(preset).replace(/[^\w.@-]/g, ''))}
BTHINT=${shq(String(bthint || 'CD410|print|label|thermal|pos|xp|tsc|sp4').replace(/[^\w|.-]/g, ''))}
PMATCH=$( [ -n "$PRESET" ] && { echo "$LIST" | grep -x "$PRESET" || echo "$LIST" | grep -i "$PRESET"; } | head -1 )
if [ -n "$PMATCH" ]; then
  PRINTER="$PMATCH"
  echo "Label printer: $PRINTER"
else
  printf "Which one is the label printer? Type its number and press Return: "
  read N < /dev/tty
  PRINTER=$(echo "$LIST" | sed -n "\${N}p")
fi
if [ -z "$PRINTER" ]; then echo "That number is not in the list. Run the setup again."; exit 1; fi
mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
echo "$PRINTER" > "$DIR/printer"
cat > "$DIR/ik-printer.sh" <<'IKAGENT'
${agent}IKAGENT
chmod +x "$DIR/ik-printer.sh"
cat > "$PLIST" <<IKPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>in.inkkulture.printer</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/ik-printer.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/stdout.log</string>
  <key>StandardErrorPath</key><string>$DIR/stderr.log</string>
</dict></plist>
IKPLIST
# Paper: 4 x 6 in (100 x 150 mm) when the driver offers it
PSL=$(lpoptions -p "$PRINTER" -l 2>/dev/null | grep -i -E '^(PageSize|media)[/:]' | head -1)
if [ -n "$PSL" ]; then
  OPT=$(echo "$PSL" | cut -d/ -f1 | cut -d: -f1)
  VAL=$(echo "$PSL" | cut -d: -f2- | tr ' ' '\n' | sed 's/^\\*//' | grep -i -E '100x150|100\\*150|4x6|w288h432|101\\.6x152|100mmx150mm|w283h425' | head -1)
  if [ -n "$VAL" ]; then lpoptions -p "$PRINTER" -o "$OPT=$VAL" >/dev/null 2>&1 && echo "Paper size: $VAL"; fi
fi
# A Bluetooth printer: the driver prints to 127.0.0.1:9100 and a small relay hands each job to the printer's Bluetooth port
URI=$(lpstat -v "$PRINTER" 2>/dev/null | sed -n 's/^device for [^:]*: //p')
case "$URI" in
  socket://127.0.0.1*|socket://localhost*)
    PORTS=$(ls /dev/cu.* 2>/dev/null | grep -i -v -E 'incoming|debug|wlan|airpod|buds|modem')
    BT=$(echo "$PORTS" | grep -i -E "$BTHINT" | head -1)
    [ -z "$BT" ] && BT=$(echo "$PORTS" | head -1)
    if [ -z "$BT" ]; then
      echo "Bluetooth: no printer port found. Switch the printer on, connect it in System Settings > Bluetooth, then run this setup again."
    else
      cat > "$DIR/ik-bt-writer.pl" <<'IKPERL'
#!/usr/bin/perl
# Ink Kulture: sends queued label jobs to the Bluetooth printer port. Opens the port without waiting for a carrier
# signal (Bluetooth printers never raise one), keeps one connection open like the phone app does, retries on errors.
use strict; use warnings; use Fcntl; use POSIX qw(:termios_h);
my ($port, $spool, $log) = @ARGV;
my $fh; my %tries;
sub lg { if (open(my $l, '>>', $log)) { my @t = localtime; printf $l "%02d %s %02d:%02d:%02d %s\\n", $t[3], (qw(Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec))[$t[4]], $t[2], $t[1], $t[0], join(' ', @_); close $l; } }
sub opn {
  my $h;
  unless (sysopen($h, $port, O_RDWR | O_NOCTTY | O_NONBLOCK)) { lg("could not open $port: $!"); return 0; }
  my $t = POSIX::Termios->new;
  if ($t->getattr(fileno $h)) {
    $t->setcflag((($t->getcflag) & ~(PARENB | CSTOPB | CSIZE)) | CS8 | CLOCAL | CREAD);
    $t->setlflag(0); $t->setoflag(0); $t->setiflag(0);
    $t->setattr(fileno $h, TCSANOW);
  }
  my $fl = fcntl($h, F_GETFL, 0); fcntl($h, F_SETFL, $fl & ~O_NONBLOCK);
  binmode $h; $fh = $h; lg("port open: $port"); return 1;
}
sub cls { if ($fh) { close $fh; $fh = undef; } }
lg("writer started for $port");
while (1) {
  my @jobs = ();
  if (opendir(my $d, $spool)) { @jobs = sort grep { /\\.prn$/ } readdir $d; closedir $d; }
  for my $f (@jobs) {
    my $p = "$spool/$f"; my $data;
    { open(my $i, '<:raw', $p) or next; local $/; $data = <$i>; close $i; }
    if (!defined $data || !length $data) { unlink $p; next; }
    unless ($fh) { opn() or do { sleep 3; last; }; }
    my ($off, $ok, $t0) = (0, 1, time);
    eval {
      local $SIG{ALRM} = sub { die "timeout\\n" };
      alarm 120;
      while ($off < length $data) {
        my $w = syswrite($fh, $data, 4096, $off);
        die "write: $!\\n" unless defined $w;
        $off += $w;
      }
      alarm 0;
    };
    alarm 0;
    if ($@) { $ok = 0; lg("send failed after $off of " . length($data) . " bytes: $@"); cls(); }
    else { lg("sent " . length($data) . " bytes in " . (time - $t0) . "s"); }
    if ($ok || ++$tries{$f} >= 3) { unlink $p; delete $tries{$f}; lg("dropped $f after 3 tries") unless $ok; }
    else { sleep 3; last; }
  }
  sleep 1;
}
IKPERL
      cat > "$DIR/ik-bt-relay.sh" <<'IKRELAY'
#!/bin/bash
# Ink Kulture: the printer driver sends each label to 127.0.0.1:9100; it is queued here and the writer
# (ik-bt-writer.pl) sends it to the Bluetooth printer over one open connection.
DIR="$HOME/Library/Application Support/IKPrinter"
BT="$(cat "$DIR/bt-port")"
SP="$DIR/spool"; mkdir -p "$SP"
( while true; do
    F="$SP/$(date +%s)-$$-$RANDOM.prn"
    if nc -l 127.0.0.1 9100 > "$F.part"; then mv "$F.part" "$F"; else rm -f "$F.part"; sleep 2; fi
  done ) &
exec /usr/bin/perl "$DIR/ik-bt-writer.pl" "$BT" "$SP" "$DIR/relay.log"
IKRELAY
      echo "$BT" > "$DIR/bt-port"
      chmod +x "$DIR/ik-bt-relay.sh"
      RPL="$HOME/Library/LaunchAgents/in.inkkulture.btrelay.plist"
      cat > "$RPL" <<IKRP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>in.inkkulture.btrelay</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/ik-bt-relay.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$DIR/relay.log</string>
</dict></plist>
IKRP
      launchctl unload "$RPL" >/dev/null 2>&1 || true
      sleep 1
      # an older relay or a stuck send (even one still waiting to open the port) is stopped, or the printer stays busy
      for HP in $(lsof -t "$BT" 2>/dev/null) $(pgrep -f 'IKPrinter/ik-bt' 2>/dev/null) $(pgrep -f 'IKPrinter/spool' 2>/dev/null); do
        [ "$HP" != "$$" ] && [ "$HP" != "$PPID" ] && kill -9 "$HP" 2>/dev/null
      done
      launchctl load -w "$RPL"
      echo "Bluetooth: labels go to $BT"
    fi;;
  *)
    # a USB / network printer: no Bluetooth relay needed (an older one is removed)
    RPL="$HOME/Library/LaunchAgents/in.inkkulture.btrelay.plist"
    if [ -f "$RPL" ]; then
      launchctl unload "$RPL" >/dev/null 2>&1 || true
      rm -f "$RPL"
      for HP in $(pgrep -f 'IKPrinter/ik-bt' 2>/dev/null); do [ "$HP" != "$$" ] && kill -9 "$HP" 2>/dev/null; done
      echo "Bluetooth relay removed (this printer is on $URI)"
    fi;;
esac
launchctl unload "$PLIST" >/dev/null 2>&1 || true
launchctl load -w "$PLIST"
curl -s -m 15 -X POST "$URL/api/print/test" --data-urlencode "k=$KEY" --data-urlencode "printer=$PRINTER" >/dev/null || true
echo ""
echo "Checking (20 seconds)..."
sleep 20
echo "-- print queue:"; lpstat -o "$PRINTER" 2>/dev/null | head -5; echo "(end)"
[ -f "$DIR/relay.log" ] && { echo "-- relay:"; tail -n 4 "$DIR/relay.log"; }
[ -f "$DIR/agent.log" ] && { echo "-- agent:"; tail -n 3 "$DIR/agent.log"; }
[ -f "$DIR/bt-port" ] && { echo "-- port:"; lsof "$(cat "$DIR/bt-port")" 2>/dev/null | tail -n +2 | awk '{print $1, $2}' | head -3; echo "(end)"; }
echo ""
echo "Done. Labels will print on: $PRINTER"
echo "A test label is on its way (a few seconds). This keeps running in the background and starts by itself when you log in."
echo "To remove it later: launchctl unload \\"$PLIST\\" && rm \\"$PLIST\\""
`;
}

/* ---------------- HTTP: /api/print/{setup,next,done,test} ---------------- */

const text = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

export async function handlePrint(req, env) {
  const url = new URL(req.url);
  const op = url.pathname.split('/').pop();
  let form = null;
  if (req.method === 'POST') { try { form = new URLSearchParams(await req.text()); } catch { form = new URLSearchParams(); } }
  const get = (k) => String((form && form.get(k)) ?? url.searchParams.get(k) ?? '');
  const st = await printerState(env);
  const key = get('k');
  if (!st.key || !/^[a-f0-9]{40}$/.test(key) || key !== st.key) return text('not allowed', 401);
  const base = String(env.WORKER_URL || url.origin).replace(/\/$/, '');
  if (op === 'setup') return text(setupScript(base, st.key, get('p'), get('bt')));
  if (op === 'next') {
    /* check-in: who is printing, on what (written at most every 30 s) */
    const host = get('host').slice(0, 60) || st.seen.host || '', printer = get('printer').slice(0, 80) || st.seen.printer || '';
    if (Number(st.seen.at || 0) < now() - 30 || printer !== st.seen.printer || host !== st.seen.host) {
      await env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v')
        .bind('printer_seen', JSON.stringify({ at: now(), host, printer })).run().catch(() => {});
    }
    const job = await nextJob(env);
    if (!job) return new Response(null, { status: 204 });
    return new Response(job.pdf, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Job-Id': String(job.id), 'X-Order': String(job.order).replace(/[^\w#-]/g, '') } });
  }
  if (op === 'log') { console.log('print-log', get('host').slice(0, 40), '\n' + get('log').slice(0, 4000)); return text('ok'); }
  if (op === 'done') { await jobDone(env, get('id'), get('ok') === '1', get('msg')); return text('ok'); }
  if (op === 'test') {
    await env.DB.prepare('INSERT INTO print_jobs (order_id, order_name, reason, created_at, tries) VALUES (?,?,?,?,0)').bind('', 'test', 'Printer: ' + get('printer').slice(0, 40), now()).run();
    return text('ok');
  }
  return text('not found', 404);
}
