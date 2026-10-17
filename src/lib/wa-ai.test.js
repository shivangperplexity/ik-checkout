import test from 'node:test';
import assert from 'node:assert/strict';
import { aiReply, customerOrders, DEFAULT_KNOWLEDGE, drainQueue, backlog, budget, pickModel, aiAnswer } from './wa-ai.js';
import { processInbound } from './wa-g4w.js';
import { replyAction } from './go4whatsup.js';

const NOW = () => Math.floor(Date.now() / 1000);

/* An in-memory messages / orders / queue store that answers the queries these modules make. */
function world({ orders = [], answer = 'It lasts up to 2 weeks.', aiOn = true, provider = 'groq', model = 'llama-3.3-70b-versatile', rpm = 20, rpd = 800, metaFail = null, scans = null } = {}) {
  const msgs = [], queue = {}, sent = [], api = [], settings = {};
  let id = 0;
  const db = { prepare(sql) {
    const q = sql.replace(/\s+/g, ' ');
    const ops = (a) => ({
      first: async () => {
        if (/^INSERT INTO messages/.test(q)) { msgs.push({ id: ++id, ts: a[0], direction: a[1], phone: a[2], trigger: a[3], template: a[4], status: a[5], order_name: a[6], wamid: a[7], error: a[8], preview: a[9] }); return { id }; }
        if (/COUNT\(\*\) AS n FROM messages WHERE phone=\? AND trigger='ai'/.test(q)) return { n: msgs.filter((m) => m.phone === a[0] && m.trigger === 'ai' && m.direction === 'out' && !/queued|expired|merged/.test(m.status) && m.ts > a[1]).length };
        if (/COUNT\(\*\) AS n FROM messages WHERE direction='out' AND trigger='ai'/.test(q)) return { n: msgs.filter((m) => m.trigger === 'ai' && m.direction === 'out' && !/queued|capped|expired|merged/.test(m.status) && m.ts > a[0]).length };
        if (/SELECT id FROM messages WHERE phone=\?/.test(q)) return msgs.find((m) => m.phone === a[0] && m.direction === 'in' && m.trigger === 'reply' && !m.template && m.id > a[1]) || null;
        if (/WHERE o\.order_name=\?/.test(q)) return orders.find((o) => o.order_name === a[0]) || null;
        if (/COUNT\(\*\) AS n FROM ai_queue/.test(q)) return { n: Object.keys(queue).length };
        if (/FROM wa_pending|FROM wa_optout|FROM orders WHERE phone=\? AND method='cod'/.test(q)) return null;
        return null;
      },
      all: async () => {
        if (/SELECT id, direction, trigger, template, status, preview, ts, wamid FROM messages WHERE phone=\?/.test(q)) return { results: msgs.filter((m) => m.phone === a[0] && m.ts > a[1] && m.preview).sort((x, y) => y.id - x.id).slice(0, 16) };
        if (/WHERE o\.phone=\?/.test(q)) return { results: orders.filter((o) => o.phone === a[0]) };
        if (/FROM ai_queue ORDER BY queued_at/.test(q)) return { results: Object.values(queue).slice(0, a[0]) };
        if (/SELECT phone FROM ai_queue/.test(q)) return { results: Object.values(queue) };
        if (/SELECT m\.phone, MAX\(m\.ts\)/.test(q)) {
          const by = {};
          for (const m of msgs) if (m.direction === 'in' && m.trigger === 'reply' && !m.template && m.ts > a[0]) {
            const ans = Math.max(0, ...msgs.filter((o) => o.phone === m.phone && o.direction === 'out' && /^(ai|agent)$/.test(o.trigger) && !/failed|capped|queued|expired/.test(o.status)).map((o) => o.ts));
            if (m.ts > ans) { const b = by[m.phone] ||= { phone: m.phone, last_ts: 0, n: 0, last_text: '' }; b.n++; if (m.ts >= b.last_ts) { b.last_ts = m.ts; b.last_text = m.preview; } }
          }
          return { results: Object.values(by) };
        }
        if (/SELECT phone, first_name, last_name FROM orders/.test(q)) return { results: [] };
        return { results: [] };
      },
      run: async () => {
        if (/^INSERT INTO ai_queue/.test(q)) queue[a[0]] = { phone: a[0], via: a[1], phone_id: a[2], queued_at: a[3], tries: 0 };
        else if (/^DELETE FROM ai_queue WHERE phone=\?/.test(q)) delete queue[a[0]];
        else if (/^UPDATE ai_queue SET tries/.test(q)) queue[a[0]].tries++;
        else if (/^INSERT INTO settings/.test(q)) settings[a[0]] = JSON.parse(a[1]);
        return {};
      },
    });
    return { bind: (...a) => ops(a), ...ops([]) };
  } };
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    if (/api\.groq\.com|api\.anthropic\.com/.test(url)) {
      const b = JSON.parse(o.body); api.push(b);
      if (api.limit !== undefined && api.length > api.limit) return new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429 });
      return /anthropic/.test(url) ? new Response(JSON.stringify({ content: [{ type: 'text', text: answer }] })) : new Response(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 500, completion_tokens: 40 } }));
    }
    if (/graph\.facebook/.test(url)) {
      const b = JSON.parse(o.body); sent.push({ phoneId: url.split('/')[4], ...b });
      if (metaFail) return new Response(JSON.stringify({ error: metaFail }), { status: 400 });
      return new Response('{"messages":[{"id":"wamid.x"}]}');
    }
    if (/go4whatsup/.test(url)) { sent.push({ g4w: true, ...JSON.parse(o.body) }); return new Response('{"ErrorCode":200,"Data":{"messageId":"g1"}}'); }
    if (/shiprocket/.test(url)) { if (/login/.test(url)) return new Response('{"token":"t"}'); return new Response(JSON.stringify(scans || {})); }
    return new Response('{}');
  };
  const env = { DB: db, AI_WAIT_MS: 0, WA_PHONE_ID: 'p', WA_TOKEN: 't', SHIPROCKET_EMAIL: 'a', SHIPROCKET_PASSWORD: 'b', SETTINGS: { ai: { enabled: aiOn, provider, key: 'sk-test', model, knowledge: '', rpm, rpd }, wa: { admin_phone: '9000000000' }, shipping: {} } };
  const inbound = (phone, text, ago = 0, via = '') => { msgs.push({ id: ++id, ts: NOW() - ago, direction: 'in', phone, trigger: 'reply', template: '', status: 'received', wamid: via, preview: text }); return id; };
  return { env, msgs, queue, sent, api, settings, inbound, done: () => { globalThis.fetch = real; } };
}
const order = (x = {}) => ({ order_id: '1', order_name: '#1601', phone: '9999999999', status: 'placed', method: 'cod', total_paise: 39900, confirmed_at: 1, shipped_at: 1, created_at: NOW() - 86400, contents_json: '[{"title":"Snake Tattoo","quantity":2}]', awb: 'A1', courier: 'Delhivery', stage: 'transit', edd: '2026-10-20', ...x });

test('order context: live courier scans for a parcel on the way, delivered date, quoted order number only if it is theirs', async () => {
  const scans = { tracking_data: { etd: '2026-10-19 18:00:00', shipment_track: [{ current_status: 'In Transit' }], shipment_track_activities: [
    { date: '2026-10-17 14:20:00', activity: 'In Transit - Reached hub', location: 'Bhiwandi' }, { date: '2026-10-16 18:00:00', activity: 'In Transit - Shipment picked up', location: 'Navi Mumbai' }] } };
  const w = world({ scans, orders: [order(), order({ order_id: '2', order_name: '#1500', stage: 'delivered', delivered_at: NOW() - 5 * 86400, awb: 'A2' }), order({ order_id: '3', order_name: '#1777', phone: '8888888888' })] });
  try {
    const t = await customerOrders(w.env, '9999999999', 'what about #1777?');
    assert.match(t, /Order #1601 .*In transit, expected 2026-10-19.*Latest courier scans: 17\/10 14:20 · In Transit - Reached hub · Bhiwandi/);
    assert.match(t, /Order #1500 .*Delivered on/);
    assert.match(t, /Order #1777 exists but is registered to a different phone number/);
    assert.doesNotMatch(t, /#1777 placed/);
  } finally { w.done(); }
});

test('live reply: the prompt has knowledge + orders, the reply goes out and is logged accepted', async () => {
  const w = world({ orders: [order()] });
  try {
    const id = w.inbound('9999999999', 'where is my order?');
    assert.equal(await aiReply(w.env, '9999999999', 'where is my order?', { msgId: id }), 'replied');
    const req = w.api[0];
    assert.match(req.messages[0].content, /Buy 1 Get 1 Free/); assert.match(req.messages[0].content, /Order #1601/);
    assert.deepEqual(req.messages.slice(1), [{ role: 'user', content: 'where is my order?' }], 'the message once, not twice');
    assert.equal(w.sent[0].text.body, 'It lasts up to 2 weeks.');
    assert.ok(w.msgs.some((m) => m.trigger === 'ai' && m.status === 'accepted'));
  } finally { w.done(); }
});

test('a burst of messages gets one answer covering all of them', async () => {
  const w = world();
  try {
    const a = w.inbound('9999999999', 'hi'), b = w.inbound('9999999999', 'kitne din chalega?');
    assert.equal(await aiReply(w.env, '9999999999', 'hi', { msgId: a }), 'merged');
    assert.equal(await aiReply(w.env, '9999999999', 'kitne din chalega?', { msgId: b }), 'replied');
    assert.equal(w.api.length, 1);
    assert.equal(w.api[0].messages[1].content, 'hi\nkitne din chalega?');
    assert.equal(await aiReply(w.env, '9999999999', 'kitne din chalega?', { msgId: b }), 'nothing', 'already answered');
  } finally { w.done(); }
});

test('rate limit: over the per-minute budget the phone is queued, the drain answers it later', async () => {
  const w = world({ rpm: 1 });
  try {
    const a = w.inbound('9999999999', 'is it waterproof?');
    assert.equal(await aiReply(w.env, '9999999999', 'question', { msgId: a }), 'replied');
    const b = w.inbound('8888888888', 'how to apply?');
    assert.equal(await aiReply(w.env, '8888888888', 'question', { msgId: b }), 'queued');
    assert.ok(w.queue['8888888888']);
    assert.equal((await budget(w.env)).minute, 0);
    w.env.SETTINGS.ai.rpm = 5;
    const d = await drainQueue(w.env, { gapMs: 0 });
    assert.equal(d.done, 1); assert.equal(d.remaining, 0);
    assert.equal(w.sent.at(-1).to, '918888888888');
  } finally { w.done(); }
});

test('provider 429 queues instead of failing', async () => {
  const w = world();
  w.api.limit = 0;
  try { const a = w.inbound('9999999999', 'hello there'); assert.equal(await aiReply(w.env, '9999999999', 'question', { msgId: a }), 'queued'); assert.ok(w.queue['9999999999']); } finally { w.done(); }
});

test('backlog: unanswered customers, with the 24h window; old ones are not answered, recent ones get an apology for the delay', async () => {
  const w = world();
  try {
    w.inbound('9999999999', 'where is my order', 5 * 3600);
    w.inbound('7777777777', 'hello?', 30 * 3600);
    w.inbound('6666666666', 'answered already', 3600); w.msgs.push({ id: 999, ts: NOW() - 60, direction: 'out', phone: '6666666666', trigger: 'ai', status: 'accepted', preview: 'ok' });
    const rows = await backlog(w.env);
    assert.deepEqual(rows.map((r) => [r.phone, r.in_window]).sort(), [['7777777777', false], ['9999999999', true]]);
    w.queue['9999999999'] = { phone: '9999999999', queued_at: NOW() }; w.queue['7777777777'] = { phone: '7777777777', queued_at: NOW() };
    const d = await drainQueue(w.env, { gapMs: 0 });
    assert.deepEqual(d.results.map((r) => r.result).sort(), ['expired', 'replied']);
    assert.match(w.api[0].messages[0].content, /5 hours ago .* apology/);
  } finally { w.done(); }
});

test('handoff: token stripped, logged, owner pinged; re-engagement on one channel retries the other', async () => {
  const w = world({ answer: 'Sorry about that. A team member will reply here shortly. [HANDOFF]' });
  try {
    const a = w.inbound('9999999999', 'damaged item, refund!');
    assert.equal(await aiReply(w.env, '9999999999', 'question', { msgId: a }), 'handoff');
    assert.equal(w.sent[0].text.body, 'Sorry about that. A team member will reply here shortly.');
    assert.match(w.sent[1].text.body, /needs a reply/);
  } finally { w.done(); }
  const w2 = world({ metaFail: { code: 131047, message: 'Re-engagement message' } });
  w2.env.G4W_API_KEY = 'a'; w2.env.G4W_SECURE_KEY = 'b';
  try {
    const a = w2.inbound('9999999999', 'is it waterproof?');
    assert.equal(await aiReply(w2.env, '9999999999', 'question', { msgId: a }), 'replied');
    assert.ok(w2.sent.some((x) => x.g4w), 'answered through Go4WhatsUp after Meta refused');
  } finally { w2.done(); }
});

test('inbound routing: plain text goes to the assistant from the number written to; STOP does not', async () => {
  const w = world();
  try {
    await processInbound(w.env, [{ from: '9999999999', text: 'kitne din chalega?', via: 'meta', phoneId: 'PHONE_B' }]);
    assert.equal(w.api.length, 1); assert.equal(w.sent[0].phoneId, 'PHONE_B');
    await processInbound(w.env, [{ from: '9999999999', text: 'STOP' }]);
    assert.equal(w.api.length, 1);
  } finally { w.done(); }
  assert.equal(replyAction('Re-attempt'), 'REATTEMPT'); assert.match(DEFAULT_KNOWLEDGE, /2 weeks/);
});

test('saved model not available to this key: switches to one from the key\'s list and remembers it', async () => {
  const calls = [], saved = {};
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (/\/models$/.test(String(u))) { calls.push('list'); return new Response(JSON.stringify({ data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.1-8b-instant' }, { id: 'openai/gpt-oss-120b' }] })); }
    const b = JSON.parse(o.body); calls.push('chat ' + b.model);
    if (b.model === 'llama-3.3-70b-versatile') return new Response(JSON.stringify({ error: { message: 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.' } }), { status: 404 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '<think>x</think>Up to 2 weeks.' } }] }));
  };
  const db = { prepare: (sql) => ({ all: async () => ({ results: [] }), bind: (...a) => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => { if (/INSERT INTO settings/.test(sql)) saved[a[0]] = JSON.parse(a[1]); return {}; } }) }) };
  try {
    const a = await aiAnswer({ DB: db, SETTINGS: { ai: { enabled: true, provider: 'groq', key: 'k', model: 'llama-3.3-70b-versatile' } } }, { text: 'how long does it last' });
    assert.equal(a.text, 'Up to 2 weeks.'); assert.equal(a.switched, 'openai/gpt-oss-120b');
    assert.deepEqual(calls, ['chat llama-3.3-70b-versatile', 'list', 'chat openai/gpt-oss-120b']);
    assert.equal(saved.ai.model, 'openai/gpt-oss-120b');
  } finally { globalThis.fetch = real; }
  assert.equal(pickModel(['llama-3.1-8b-instant', 'qwen/qwen3.8-27b']), 'qwen/qwen3.8-27b');
});
