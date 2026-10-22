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
import { createHash } from 'node:crypto';
import { agentScript, setupScript } from './mac-setup.js';
export { setupScript };

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
  const station = (await row('print_station')) || {};
  return { auto: cfg.auto !== false, key: cfg.key || envKey, tune: cfg.tune || null, seen, online: Number(seen.at || 0) > now() - 90, station, stationOn: stationFresh(station) };
}
/* Print station: a phone or computer holding the Bluetooth printer, with the dashboard open and "Print station" on.
   It asks for queued labels every few seconds (admin action print_station) and prints them over Bluetooth. While it is
   checking in, the Mac agent gets no jobs, so one label never goes to two printers. */
const STATION_FRESH = 45;
const stationFresh = (st) => Number((st && st.at) || 0) > now() - STATION_FRESH;
/** Check-in from the print station (written at most every 15 s; off = hand jobs back to the Mac right away). */
export async function stationBeat(env, name, off = false) {
  const r = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind('print_station').first().catch(() => null);
  let cur = {}; try { cur = r ? JSON.parse(r.v) : {}; } catch { /* none */ }
  if (!off && Number(cur.at || 0) > now() - 15 && cur.name === name) return cur;
  const v = { at: off ? 0 : now(), name: String(name || '').slice(0, 60) };
  await env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v').bind('print_station', JSON.stringify(v)).run();
  return v;
}
async function saveCfg(env, patch) {
  const s = await printerState(env);
  const v = { auto: s.auto, key: s.key, ...(s.tune ? { tune: s.tune } : {}), ...patch };
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

/* How the Bluetooth link prints (TSPL): label size, darkness 0-15, speed 1-6 in/s (slower = sharper), direction,
   black-and-white threshold. Kept with the printer settings; the Mac picks changes up within 10 minutes. */
export const TUNE_DEFAULTS = { w: 100, h: 150, gap: 2, density: 12, speed: 3, direction: 1, threshold: 160, invert: false };
export async function printTune(env) {
  const r = await env.DB.prepare('SELECT v FROM settings WHERE k=?').bind('printer').first().catch(() => null);
  let t = {}; try { t = (r ? JSON.parse(r.v) : {}).tune || {}; } catch { /* defaults */ }
  return { ...TUNE_DEFAULTS, ...t };
}
export async function setTune(env, b) {
  const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
  const cur = await printTune(env);
  const tune = {
    w: clamp(b.w ?? cur.w, 20, 120, 100), h: clamp(b.h ?? cur.h, 20, 300, 150), gap: clamp(b.gap ?? cur.gap, 0, 10, 2),
    density: clamp(b.density ?? cur.density, 0, 15, 12), speed: clamp(b.speed ?? cur.speed, 1, 6, 3),
    direction: Number(b.direction ?? cur.direction) ? 1 : 0, threshold: clamp(b.threshold ?? cur.threshold, 60, 230, 160),
    invert: !!(b.invert ?? cur.invert),
  };
  await saveCfg(env, { tune });
  return tune;
}

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
  if (!s || !s.auto || !(s.key || s.stationOn)) return 0;
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

/** Changes whenever the Mac's agent or setup changes: the agent updates itself when it differs. */
export const macVersion = (base, key) => createHash('sha1').update(agentScript(base, key) + setupScript(base, key, '', '', true)).digest('hex').slice(0, 12);

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
  if (op === 'setup') return text(setupScript(base, st.key, get('p'), get('bt'), get('u') === '1'));
  if (op === 'agent') return text(agentScript(base, st.key));
  if (op === 'version') return text(macVersion(base, st.key));
  if (op === 'settings') return new Response(JSON.stringify(await printTune(env)), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (op === 'next') {
    /* check-in: who is printing, on what (written at most every 30 s) */
    const host = get('host').slice(0, 60) || st.seen.host || '', printer = get('printer').slice(0, 80) || st.seen.printer || '';
    if (Number(st.seen.at || 0) < now() - 30 || printer !== st.seen.printer || host !== st.seen.host) {
      await env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v')
        .bind('printer_seen', JSON.stringify({ at: now(), host, printer })).run().catch(() => {});
    }
    if (st.stationOn) return new Response(null, { status: 204 });   /* the Bluetooth print station is printing */
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
