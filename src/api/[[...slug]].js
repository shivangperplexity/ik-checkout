import { waitUntil } from '@vercel/functions';
import { handle } from '../lib/app.js';
import { makeDb } from '../lib/db.js';
import { handleG4w, handleAct, autoCancelStale } from '../lib/wa-g4w.js';
import { handlePay, handlePaid, offerPrepaidConversion } from '../lib/wa-convert.js';

// Vercel only routes single-segment /api/<x> to this file, so vercel.json rewrites two-segment paths
// (/api/payu/return, /api/wa/webhook, /api/wa/g4w, /api/wa/act, /api/wa/addr, /api/wa/pay, /api/wa/paid, /api/admin/leads,
// /api/pincode/<pin>) to /api/x?a=<seg1>&b=<seg2>. Rebuild the original path here so lib/app.js can route on it.
export default {
  async fetch(request) {
    let req = request;
    const u = new URL(request.url);
    const a = u.searchParams.get('a');
    const b = u.searchParams.get('b');
    if (a && b && u.pathname === '/api/x') {
      u.searchParams.delete('a');
      u.searchParams.delete('b');
      u.pathname = `/api/${a}/${b}`;
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      req = new Request(u.toString(), { method: request.method, headers: request.headers, body: hasBody ? await request.arrayBuffer() : undefined });
    }
    const env = { ...process.env, DB: makeDb(process.env) };
    const ctx = { waitUntil };
    const path = new URL(req.url).pathname;
    try {
      /* WhatsApp via Go4WhatsUp: inbound replies, one-tap confirm, COD -> prepaid. */
      if (path === '/api/wa/g4w') return await handleG4w(req, env, ctx);
      if (path === '/api/wa/act') return await handleAct(req, env);
      if (path === '/api/wa/ndr') { const { handleNdr } = await import('../lib/wa-ndr.js'); return await handleNdr(req, env); }
      if (path === '/api/wa/addr') { const { handleAddr } = await import('../lib/wa-address.js'); return await handleAddr(req, env); }
      if (path === '/api/wa/pay') return await handlePay(req, env);
      if (path === '/api/wa/paid' && req.method === 'POST') return await handlePaid(req, env, ctx);
    } catch (e) {
      console.error('wa route', path, e);
      return new Response('Something went wrong. Please try again.', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    /* Piggyback the WhatsApp sweeps on the existing cron run; app.js checks the same secret again and owns the
       rest of the job. The discount offer goes out before anything is cancelled. Both are off by default. */
    if (path === '/api/cron' && env.CRON_SECRET && req.headers.get('Authorization') === `Bearer ${env.CRON_SECRET}`) {
      await offerPrepaidConversion(env).catch((e) => console.error('offerPrepaidConversion', e));
      await autoCancelStale(env).catch((e) => console.error('autoCancelStale', e));
      /* WhatsApp shipment updates from Shiprocket tracking. */
      await (async () => { const { withSettings } = await import('../lib/settings.js'); const { shipUpdates } = await import('../lib/wa-ship.js'); return shipUpdates(await withSettings(env)); })().catch((e) => console.error('shipUpdates', e));
      /* automatic NDR rules: re-attempt / return / wait for the customer (lib/ndr-rules.js) */
      await (async () => { const { withSettings } = await import('../lib/settings.js'); const { autoNdr } = await import('../lib/ndr-rules.js'); const r = await autoNdr(await withSettings(env)); const pl = r.pilot || {}; if (r.actions?.length || r.failed || r.error || pl.nudged || pl.told || pl.failed || pl.error || pl.pending) console.log('autoNdr', JSON.stringify(r)); })().catch((e) => console.error('autoNdr', e));
    }
    return handle(req, env, ctx);
  },
};
