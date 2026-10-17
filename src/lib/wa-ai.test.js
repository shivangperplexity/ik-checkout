import test from 'node:test';
import assert from 'node:assert/strict';
import { aiAnswer, aiReply, customerOrders, DEFAULT_KNOWLEDGE } from './wa-ai.js';
import { processInbound } from './wa-g4w.js';

function world({ orders = [], msgs = [], answer = 'It lasts up to 2 weeks.', aiOn = true, provider = 'anthropic', model = 'claude-haiku-5-5' } = {}) {
  const sent = [], logged = [], api = [];
  const db = { prepare(sql) { const q = sql.replace(/\s+/g, ' '); return { all: async () => ({ results: /FROM orders o LEFT JOIN shipments/.test(q) ? orders : /FROM messages WHERE phone/.test(q) ? msgs : [] }), bind: (...a) => ({
    all: async () => ({ results: /FROM orders o LEFT JOIN shipments/.test(q) ? orders : /FROM messages WHERE phone/.test(q) ? msgs : [] }),
    first: async () => { if (/INSERT INTO messages/.test(q)) { logged.push({ direction: a[1], phone: a[2], trigger: a[3], template: a[4], status: a[5], preview: a[9] }); return { id: 1 }; } return /COUNT\(\*\) AS n FROM messages/.test(q) ? { n: logged.filter((l) => l.trigger === 'ai' && l.direction === 'out').length } : null; },
    run: async () => { if (/INSERT INTO messages/.test(q)) logged.push({ direction: a[1], phone: a[2], trigger: a[3], template: a[4], status: a[5], preview: a[9] }); return {}; },
  }) }; } };
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => { const url = String(u); if (/api\.anthropic\.com/.test(url)) { api.push({ via: 'anthropic', auth: o.headers['x-api-key'], ...JSON.parse(o.body) }); return new Response(JSON.stringify({ content: [{ type: 'text', text: answer }], usage: { input_tokens: 500, output_tokens: 40 } })); }
    if (/chat\/completions/.test(url)) { const b = JSON.parse(o.body); api.push({ via: url, auth: o.headers.Authorization, model: b.model, system: b.messages[0].content, messages: b.messages.slice(1) }); return new Response(JSON.stringify({ choices: [{ message: { content: answer } }], usage: { prompt_tokens: 500, completion_tokens: 40 } })); } if (/graph\.facebook/.test(url)) { sent.push(JSON.parse(o.body)); return new Response('{"messages":[{"id":"m1"}]}'); } return new Response('{}'); };
  const env = { DB: db, WA_PHONE_ID: 'p', WA_TOKEN: 't', SETTINGS: { ai: { enabled: aiOn, provider, key: 'sk-test', model, knowledge: '' }, wa: { admin_phone: '9000000000' } } };
  return { env, sent, logged, api, done: () => { globalThis.fetch = real; } };
}
const order = (x = {}) => ({ order_id: '1', order_name: '#1601', status: 'placed', method: 'cod', total_paise: 39900, confirmed_at: 1, shipped_at: 1, created_at: Math.floor(Date.now() / 1000) - 86400, contents_json: '[{"title":"Snake Tattoo","quantity":2}]', awb: 'A1', courier: 'Delhivery', stage: 'transit', edd: '2026-10-20', ...x });

test('the prompt carries the store knowledge and the customer\'s live orders; reply is sent as WhatsApp text', async () => {
  const w = world({ orders: [order()] });
  try {
    assert.equal(await aiReply(w.env, '9999999999', 'where is my order?'), 'replied');
    const req = w.api[0];
    assert.equal(req.model, 'claude-haiku-5-5');
    assert.match(req.system, /Buy 1 Get 1 Free/); assert.match(req.system, /Order #1601 .*Delhivery, AWB A1: In transit, expected 2026-10-20/);
    assert.deepEqual(req.messages, [{ role: 'user', content: 'where is my order?' }]);
    assert.equal(w.sent[0].text.body, 'It lasts up to 2 weeks.'); assert.equal(w.sent[0].to, '919999999999');
    assert.ok(w.logged.some((l) => l.trigger === 'ai' && l.status === 'sent'));
  } finally { w.done(); }
});

test('handoff: token stripped from the customer reply, logged, owner pinged', async () => {
  const w = world({ answer: 'Sorry about that. A team member will reply here shortly. [HANDOFF]' });
  try {
    assert.equal(await aiReply(w.env, '9999999999', 'my tattoo came damaged, refund!'), 'handoff');
    assert.equal(w.sent[0].text.body, 'Sorry about that. A team member will reply here shortly.');
    assert.equal(w.sent[1].to, '919000000000'); assert.match(w.sent[1].text.body, /needs a reply/);
    assert.ok(w.logged.some((l) => l.status === 'handoff'));
  } finally { w.done(); }
});

test('off without a key or switch; recent thread is passed for continuity; orders text for an unconfirmed COD', async () => {
  const w = world({ aiOn: false });
  try { assert.equal(await aiReply(w.env, '9999999999', 'hi'), 'off'); assert.equal(w.api.length, 0); } finally { w.done(); }
  const w2 = world({ msgs: [{ direction: 'out', trigger: 'ai', preview: 'Up to 2 weeks.', ts: 2 }, { direction: 'in', trigger: 'reply', preview: 'how long does it last', ts: 1 }] });
  try {
    await aiReply(w2.env, '9999999999', 'and is it waterproof?');
    assert.deepEqual(w2.api[0].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  } finally { w2.done(); }
  const w3 = world({ orders: [order({ confirmed_at: null, shipped_at: null, awb: null, stage: null })] });
  try { assert.match(await customerOrders(w3.env, '9999999999'), /COD not yet confirmed/); } finally { w3.done(); }
  assert.match(DEFAULT_KNOWLEDGE, /2 weeks/);
});

test('inbound routing: known words keep their flows, anything else goes to the assistant', async () => {
  const w = world();
  try {
    await processInbound(w.env, [{ from: '9999999999', text: 'kitne din chalega?' }]);
    assert.equal(w.api.length, 1, 'plain text -> assistant');
    await processInbound(w.env, [{ from: '9999999999', text: 'STOP' }]);
    assert.equal(w.api.length, 1, 'STOP is not sent to the assistant');
  } finally { w.done(); }
});

test('free default: Groq over the OpenAI chat format, system prompt first, default model when none is set', async () => {
  const w = world({ orders: [order()], provider: 'groq', model: '', answer: '<think>internal</think>Aapka order #1601 Delhivery se aa raha hai.' });
  try {
    assert.equal(await aiReply(w.env, '9999999999', 'mera order kaha hai'), 'replied');
    const req = w.api[0];
    assert.equal(req.via, 'https://api.groq.com/openai/v1/chat/completions'); assert.equal(req.auth, 'Bearer sk-test');
    assert.equal(req.model, 'llama-3.3-70b-versatile');
    assert.match(req.system, /Order #1601/); assert.deepEqual(req.messages, [{ role: 'user', content: 'mera order kaha hai' }]);
    assert.equal(w.sent[0].text.body, 'Aapka order #1601 Delhivery se aa raha hai.', 'reasoning tags stripped');
  } finally { w.done(); }
  const { aiCfg } = await import('./wa-ai.js');
  assert.equal(aiCfg({ GROQ_API_KEY: 'g', SETTINGS: { ai: {} } }).key, 'g', 'key from Vercel env');
  assert.equal(aiCfg({ SETTINGS: { ai: { provider: 'nope' } } }).provider, 'groq');
});
