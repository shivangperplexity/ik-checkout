/**
 * The Mac side of label printing (bash 3.2 and JavaScript for Automation, as on every Mac): the setup script the
 * dashboard's one-line command runs, and the background agent it installs.
 *
 *   Agent    (LaunchAgent, background) asks /api/print/next every few seconds. A label PDF goes:
 *              - to the Bluetooth link (when set up): dropped in the link's spool folder, the link draws it at the
 *                printer's resolution and sends it; the agent reports printed / the link's error;
 *              - otherwise to the Mac's printer queue with lp (USB / network printers).
 *            Every 10 minutes it checks for a newer version of itself (/api/print/version) and of the link
 *            (public/mac/ik-bt-link.js) and updates itself, and refreshes the printer settings (darkness, speed...).
 *   Link     (Bluetooth printers) public/mac/ik-bt-link.js, run by osascript in a small Terminal window, because macOS
 *            lets Terminal use Bluetooth but not background programs. It keeps one connection to the printer open.
 *            Print jobs from other Mac apps reach it through the driver's 127.0.0.1:9100 queue (nc listener).
 *
 * Written with String.raw so the bash reads as bash: no ${...} in the scripts except the JS values put in.
 */
const shq = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";

export function agentScript(base, key) {
  return String.raw`#!/bin/bash
# Ink Kulture label printer: prints labels from the IK dashboard queue on this Mac.
URL=${shq(base)}
KEY=${shq(key)}
DIR="$HOME/Library/Application Support/IKPrinter"
PRINTER="$(cat "$DIR/printer" 2>/dev/null)"
SP="$DIR/spool"
mkdir -p "$DIR" "$SP"
N=0
lg() { echo "$(date '+%d %b %H:%M:%S') $*" >> "$DIR/agent.log"; }
while true; do
  H=$(date +%H); H=$((10#$H))
  if [ "$H" -ge 8 ] && [ "$H" -lt 23 ]; then WAIT=5; else WAIT=30; fi
  P="$PRINTER"; [ -z "$P" ] && P=$(lpstat -d 2>/dev/null | sed -n 's/^system default destination: //p')
  FMT=pdf; [ -f "$DIR/direct" ] && FMT=tspl
  CODE=$(curl -s -m 40 -o "$DIR/job.bin" -D "$DIR/head.txt" -w '%{http_code}' -G "$URL/api/print/next" --data-urlencode "k=$KEY" --data-urlencode "fmt=$FMT" --data-urlencode "host=$(hostname -s)" --data-urlencode "printer=$P")
  if [ "$CODE" = "200" ]; then
    ID=$(grep -i '^x-job-id:' "$DIR/head.txt" | tr -d '\r' | awk '{print $2}')
    ORD=$(grep -i '^x-order:' "$DIR/head.txt" | tr -d '\r' | cut -d' ' -f2-)
    XF=$(grep -i '^x-format:' "$DIR/head.txt" | tr -d '\r' | awk '{print $2}')
    if [ "$XF" = "tspl" ] && [ -f "$DIR/direct" ]; then
      # ready printer commands (drawn by the server at the printer's resolution): the Bluetooth link sends them
      F="$(date +%s)-job$ID.prn"
      cp "$DIR/job.bin" "$SP/$F.part" && mv "$SP/$F.part" "$SP/$F"
      W=0; while [ -f "$SP/$F" ] && [ $W -lt 150 ]; do sleep 1; W=$((W+1)); done
      if [ -f "$SP/failed/$F.err" ]; then ST=0; OUT="$(cat "$SP/failed/$F.err")"
      elif [ -f "$SP/$F" ]; then ST=0; OUT="printer not reachable yet: the label prints as soon as it connects"
      else ST=1; OUT="printed over Bluetooth"; fi
    else
      [ "$XF" = "pdf" ] && [ "$FMT" = "tspl" ] && lg "server could not draw $ORD: $(grep -i '^x-render-error:' "$DIR/head.txt" | tr -d '\r' | cut -d' ' -f2-)"
      cp "$DIR/job.bin" "$DIR/job.pdf"
      if OUT=$(lp -d "$P" -o fit-to-page "$DIR/job.pdf" 2>&1); then ST=1; else ST=0; fi
    fi
    curl -s -m 15 -X POST "$URL/api/print/done" --data-urlencode "k=$KEY" --data-urlencode "id=$ID" --data-urlencode "ok=$ST" --data-urlencode "msg=$OUT" >/dev/null
    lg "$ORD ok=$ST $OUT"
    tail -n 300 "$DIR/agent.log" > "$DIR/agent.tmp" && mv "$DIR/agent.tmp" "$DIR/agent.log"
    continue
  fi
  [ "$CODE" = "401" ] && WAIT=300
  N=$((N+1))
  # the Bluetooth link window: reopen it if it was closed
  if [ $((N % 12)) = 1 ] && [ -f "$DIR/IK Printer Bluetooth.command" ] && ! pgrep -f 'ik-bt-link.js serve' >/dev/null 2>&1; then
    open -g -a Terminal "$DIR/IK Printer Bluetooth.command" >/dev/null 2>&1 && lg "Bluetooth link window reopened"
  fi
  # every ~10 minutes: printer settings, a newer link, a newer agent
  if [ $((N % 120)) = 2 ] && [ "$CODE" != "401" ]; then
    curl -s -m 15 -f -o "$DIR/settings.new" -G "$URL/api/print/settings" --data-urlencode "k=$KEY" && grep -q density "$DIR/settings.new" && ! cmp -s "$DIR/settings.new" "$DIR/settings.json" && mv "$DIR/settings.new" "$DIR/settings.json" && lg "printer settings updated: $(cat "$DIR/settings.json")"
    if [ -f "$DIR/ik-bt-link.js" ] && curl -s -m 20 -f -o "$DIR/link.new" "$URL/mac/ik-bt-link.js" && grep -q 'function serve' "$DIR/link.new" && ! cmp -s "$DIR/link.new" "$DIR/ik-bt-link.js"; then
      mv "$DIR/link.new" "$DIR/ik-bt-link.js"; pkill -f 'ik-bt-link.js serve'; lg "Bluetooth link updated"
    fi
    V=$(curl -s -m 15 -f -G "$URL/api/print/version" --data-urlencode "k=$KEY")
    if [ -n "$V" ] && [ "$V" != "$(cat "$DIR/version" 2>/dev/null)" ]; then
      if curl -s -m 30 -f -o "$DIR/update.sh" -G "$URL/api/print/setup" --data-urlencode "k=$KEY" --data-urlencode "u=1" --data-urlencode "p=$PRINTER"; then
        lg "updating to $V"; /bin/bash "$DIR/update.sh" >> "$DIR/update.log" 2>&1; echo "$V" > "$DIR/version"
        exec /bin/bash "$DIR/ik-printer.sh"
      fi
    fi
    tail -n 400 "$DIR/relay.log" > "$DIR/relay.tmp" 2>/dev/null && mv "$DIR/relay.tmp" "$DIR/relay.log"
  fi
  M="$(stat -f %m "$DIR/relay.log" 2>/dev/null)-$(stat -f %m "$DIR/agent.log" 2>/dev/null)"
  if [ "$M" != "$LASTM" ]; then
    LASTM="$M"
    { echo "link:"; tail -n 15 "$DIR/relay.log" 2>/dev/null; echo "agent:"; tail -n 6 "$DIR/agent.log" 2>/dev/null; echo "version: $(cat "$DIR/version" 2>/dev/null) direct: $([ -f "$DIR/direct" ] && echo yes || echo no) link running: $(pgrep -f 'ik-bt-link.js serve' >/dev/null && echo yes || echo no)"; echo "queue:"; lpstat -o "$P" 2>/dev/null | head -3; } > "$DIR/upload.txt" 2>&1
    curl -s -m 15 -X POST "$URL/api/print/log" --data-urlencode "k=$KEY" --data-urlencode "host=$(hostname -s)" --data-urlencode "log@$DIR/upload.txt" >/dev/null
  fi
  sleep $WAIT
done
`;
}

/**
 * The setup script. update = run by the agent itself (no questions, no test label, the agent is not restarted:
 * it restarts itself after).
 */
export function setupScript(base, key, preset = '', bthint = '', update = false) {
  const P = shq(String(preset).replace(/[^\w.@-]/g, ''));
  const HINTS = shq(String(bthint || 'CD410|print|label|thermal|pos|xp|tsc|sp4').replace(/[^\w|.-]/g, ''));
  return String.raw`#!/bin/bash
# Ink Kulture: label printer setup for this Mac
URL=${shq(base)}
KEY=${shq(key)}
UPDATE=${update ? 1 : 0}
DIR="$HOME/Library/Application Support/IKPrinter"
PLIST="$HOME/Library/LaunchAgents/in.inkkulture.printer.plist"
RPL="$HOME/Library/LaunchAgents/in.inkkulture.btrelay.plist"
CMDF="$DIR/IK Printer Bluetooth.command"
mkdir -p "$DIR/spool" "$HOME/Library/LaunchAgents"
say() { [ "$UPDATE" = 1 ] && echo "$(date '+%d %b %H:%M:%S') update: $*" >> "$DIR/relay.log" || echo "$*"; }
[ "$UPDATE" = 1 ] || { echo ""; echo "Ink Kulture label printer setup"; echo "-------------------------------"; }
LIST=$(lpstat -p 2>/dev/null | awk '/^printer /{print $2}')
PRESET=${P}
BTHINT=${HINTS}
PRINTER=""
[ -n "$PRESET" ] && PRINTER=$( { echo "$LIST" | grep -x "$PRESET" || echo "$LIST" | grep -i "$PRESET"; } | head -1 )
[ -z "$PRINTER" ] && [ "$UPDATE" = 1 ] && PRINTER="$(cat "$DIR/printer" 2>/dev/null)"
if [ -z "$PRINTER" ]; then
  if [ -z "$LIST" ]; then echo "No printer found on this Mac. Add the label printer in System Settings > Printers & Scanners, then run this again."; exit 1; fi
  DEF=$(lpstat -d 2>/dev/null | sed -n 's/^system default destination: //p')
  i=0
  for p in $LIST; do i=$((i+1)); if [ "$p" = "$DEF" ]; then echo "  $i) $p   (default)"; else echo "  $i) $p"; fi; done
  printf "Which one is the label printer? Type its number and press Return: "
  read N < /dev/tty
  PRINTER=$(echo "$LIST" | sed -n "$N"p)
  if [ -z "$PRINTER" ]; then echo "That number is not in the list. Run the setup again."; exit 1; fi
fi
say "Label printer: $PRINTER"
echo "$PRINTER" > "$DIR/printer"
curl -s -m 30 -f -o "$DIR/ik-printer.new" -G "$URL/api/print/agent" --data-urlencode "k=$KEY" && grep -q 'api/print/next' "$DIR/ik-printer.new" && mv "$DIR/ik-printer.new" "$DIR/ik-printer.sh"
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
# Paper for the Mac's own printer queue: 4 x 6 in (100 x 150 mm) when the driver offers it
PSL=$(lpoptions -p "$PRINTER" -l 2>/dev/null | grep -i -E '^(PageSize|media)[/:]' | head -1)
if [ -n "$PSL" ]; then
  OPT=$(echo "$PSL" | cut -d/ -f1 | cut -d: -f1)
  VAL=$(echo "$PSL" | cut -d: -f2- | tr ' ' '\n' | sed 's/^\*//' | grep -i -E '100x150|100\*150|4x6|w288h432|101\.6x152|100mmx150mm|w283h425' | head -1)
  [ -n "$VAL" ] && lpoptions -p "$PRINTER" -o "$OPT=$VAL" >/dev/null 2>&1
fi
URI=$(lpstat -v "$PRINTER" 2>/dev/null | sed -n 's/^device for [^:]*: //p')
# stop the older Bluetooth senders (background relay, Perl writer, earlier link) and stuck sends
stop_link() {
  for HP in $(pgrep -f 'ik-bt-writer' 2>/dev/null) $(pgrep -f 'ik-bt-rfcomm' 2>/dev/null) $(pgrep -f 'ik-bt-link.js serve' 2>/dev/null) $(pgrep -f 'IKPrinter/ik-bt-relay' 2>/dev/null) $(pgrep -f 'nc -l 127.0.0.1 9100' 2>/dev/null); do
    [ "$HP" != "$$" ] && [ "$HP" != "$PPID" ] && kill -9 "$HP" 2>/dev/null
  done
  rm -f "$DIR/ik-bt-writer.pl" "$DIR/ik-bt-rfcomm.js"
}
case "$URI" in
  socket://127.0.0.1*|socket://localhost*)
    # Bluetooth printer
    BT=$(ls /dev/cu.* 2>/dev/null | grep -i -v -E 'incoming|debug|wlan|airpod|buds|modem' | grep -i -E "$BTHINT" | head -1)
    HINT="$(basename "$BT" 2>/dev/null | sed 's/^cu\.//')"; [ -z "$HINT" ] && HINT="$(cat "$DIR/bt-name" 2>/dev/null)"; [ -z "$HINT" ] && HINT="CD410"
    echo "$HINT" > "$DIR/bt-name"
    if ! curl -s -m 30 -f -o "$DIR/ik-bt-link.new" "$URL/mac/ik-bt-link.js" || ! grep -q 'function serve' "$DIR/ik-bt-link.new"; then
      say "Could not download the Bluetooth link. Check the internet connection and run this again."; exit 1
    fi
    mv "$DIR/ik-bt-link.new" "$DIR/ik-bt-link.js"
    curl -s -m 15 -f -o "$DIR/settings.new" -G "$URL/api/print/settings" --data-urlencode "k=$KEY" && grep -q density "$DIR/settings.new" && mv "$DIR/settings.new" "$DIR/settings.json"
    [ -f "$DIR/settings.json" ] || echo '{"w":100,"h":150,"gap":2,"density":12,"speed":3,"direction":1,"threshold":160}' > "$DIR/settings.json"
    cat > "$DIR/ik-bt-relay.sh" <<'IKRELAY'
#!/bin/bash
# Ink Kulture: Bluetooth link. Print jobs from the Mac's printer driver arrive on 127.0.0.1:9100 and are queued;
# dashboard labels are queued by the agent; ik-bt-link.js sends them all over one kept-open Bluetooth connection.
DIR="$HOME/Library/Application Support/IKPrinter"
SP="$DIR/spool"; mkdir -p "$SP"
HINT="$(cat "$DIR/bt-name" 2>/dev/null)"; [ -z "$HINT" ] && HINT="CD410"
( while true; do
    F="$SP/$(date +%s)-$$-$RANDOM.prn"
    if nc -l 127.0.0.1 9100 > "$F.part"; then [ -s "$F.part" ] && mv "$F.part" "$F" || rm -f "$F.part"; else rm -f "$F.part"; sleep 2; fi
  done ) &
CR=0; LASTF=""
while true; do
  FIRST=$(ls "$SP" 2>/dev/null | grep -E '\.prn$' | sort | head -1)
  /usr/bin/osascript -l JavaScript "$DIR/ik-bt-link.js" serve "$HINT" "$SP" "" "$DIR/settings.json" 2>> "$DIR/relay.log"
  RC=$?
  echo "$(date '+%d %b %H:%M:%S') link stopped (code $RC), restarting" >> "$DIR/relay.log"
  # a label the link keeps failing on is set aside so the others still print
  if [ -n "$FIRST" ] && [ -f "$SP/$FIRST" ]; then
    if [ "$FIRST" = "$LASTF" ]; then CR=$((CR+1)); else CR=1; LASTF="$FIRST"; fi
    if [ $CR -ge 2 ]; then mkdir -p "$SP/failed"; mv "$SP/$FIRST" "$SP/failed/"; echo "the Bluetooth link stopped (code $RC) while sending this label" > "$SP/failed/$FIRST.err"; CR=0; fi
  fi
  sleep 3
done
IKRELAY
    chmod +x "$DIR/ik-bt-relay.sh"
    cat > "$CMDF" <<IKCMD
#!/bin/bash
printf '\033]0;IK Printer Bluetooth link\007'
echo "Ink Kulture: Bluetooth link to the label printer ($HINT)."
echo "Keep this window open (minimise is fine). It opens by itself after a restart."
exec /bin/bash "$DIR/ik-bt-relay.sh"
IKCMD
    chmod +x "$CMDF"
    launchctl unload "$RPL" >/dev/null 2>&1
    cat > "$RPL" <<IKRP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>in.inkkulture.btrelay</string>
  <key>ProgramArguments</key><array><string>/usr/bin/open</string><string>-g</string><string>-a</string><string>Terminal</string><string>$CMDF</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
IKRP
    stop_link
    rm -f "$DIR/spool/"*.pdf
    sleep 1
    touch "$DIR/direct"
    echo "$(date '+%d %b %H:%M:%S') setup: Bluetooth link for $HINT (labels drawn at the printer's resolution)" >> "$DIR/relay.log"
    launchctl load -w "$RPL"
    say "Bluetooth: the 'IK Printer Bluetooth link' Terminal window opens. Keep it open (minimise is fine)."
    say "If macOS asks whether Terminal or osascript may use Bluetooth, click Allow.";;
  *)
    # USB / network printer: the Mac's printer queue prints; no Bluetooth link
    rm -f "$DIR/direct"
    if [ -f "$RPL" ] || [ -f "$CMDF" ]; then
      launchctl unload "$RPL" >/dev/null 2>&1; rm -f "$RPL" "$CMDF"; stop_link
      say "Bluetooth link removed (this printer is on $URI)"
    fi;;
esac
if [ "$UPDATE" = 1 ]; then exit 0; fi
curl -s -m 15 -f -G "$URL/api/print/version" --data-urlencode "k=$KEY" > "$DIR/version" 2>/dev/null
launchctl unload "$PLIST" >/dev/null 2>&1
launchctl load -w "$PLIST"
curl -s -m 15 -X POST "$URL/api/print/test" --data-urlencode "k=$KEY" --data-urlencode "printer=$PRINTER" >/dev/null
echo ""
echo "Done. A test label is on its way (about 20 seconds)."
echo "From now on this Mac updates its printing by itself: you will not need to run this again."
`;
}
