import { waitUntil } from '@vercel/functions';
import { handle } from '../lib/app.js';
import { makeDb } from '../lib/db.js';

// Vercel only routes single-segment /api/<x> to this file, so vercel.json rewrites two-segment paths
// (/api/payu/return, /api/wa/webhook, /api/admin/leads, /api/pincode/<pin>) to /api/x?a=<seg1>&b=<seg2>.
// Rebuild the original path here so lib/app.js can route on it.
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
    return handle(req, env, { waitUntil });
  },
};
