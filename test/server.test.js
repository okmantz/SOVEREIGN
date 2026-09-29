'use strict';
process.env.SOVEREIGN_NO_PERSIST = '1';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { start } = require('../sidecar/index');

const call = async (port, method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
// A stand-in Ollama server: /api/tags lists models, /api/chat answers.
function fakeOllama() {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        seen.push({ url: req.url, body: b });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.1:latest' }] }));
        if (req.url === '/api/chat') return res.end(JSON.stringify({ message: { content: 'ready' }, prompt_eval_count: 5, eval_count: 2 }));
        res.statusCode = 404; res.end('{}');
      });
    }).listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

test('Ollama settings: detect models, save the host, and chat through it', async () => {
  const ollama = await fakeOllama(); const { server, port } = await start({ persist: false, port: 0 });
  try {
    const host = `http://127.0.0.1:${ollama.port}`;
    const models = await call(port, 'GET', '/api/ollama/models?host=' + encodeURIComponent(host));
    assert.deepStrictEqual(models.json.models, ['llama3.1:latest', 'qwen2.5:7b']);
    const bad = await call(port, 'GET', '/api/ollama/models?host=' + encodeURIComponent('not a url'));
    assert.strictEqual(bad.status, 400);
    await call(port, 'POST', '/api/settings', { provider: { name: 'ollama', model: 'qwen2.5:7b' }, ollama: { host } });
    const st = (await call(port, 'GET', '/api/state')).json;
    assert.strictEqual(st.settings.ollama.host, host); assert.strictEqual(st.settings.provider.name, 'ollama');
    const t = await call(port, 'POST', '/api/provider/test');
    assert.strictEqual(t.json.reply, 'ready');
    assert.strictEqual(JSON.parse(ollama.seen.find((s) => s.url === '/api/chat').body).model, 'qwen2.5:7b');
  } finally { server.close(); ollama.srv.close(); }
});

test('an unreachable Ollama gives a plain-language error, not a crash', async () => {
  const { server, port } = await start({ persist: false, port: 0 });
  try {
    await call(port, 'POST', '/api/settings', { provider: { name: 'ollama', model: 'x' }, ollama: { host: 'http://127.0.0.1:9' } });
    const t = await call(port, 'POST', '/api/provider/test');
    assert.strictEqual(t.status, 502); assert.match(t.json.error, /Could not reach Ollama/);
  } finally { server.close(); }
});

test('chat with any agent, agents get desks over the API, rooms rename, foreign origins are blocked', async () => {
  const { server, port } = await start({ persist: false, port: 0 });
  try {
    const a = await call(port, 'POST', '/api/agents', { name: 'Quill', role: 'copywriter' });
    assert.ok(a.json.agent.deskId);
    const chat = await call(port, 'POST', `/api/agents/${a.json.agent.id}/chat`, { text: 'hello' });
    assert.match(chat.json.text, /Quill/);
    const room = Object.values((await call(port, 'GET', '/api/state')).json.rooms).find((r) => r.kind === 'studio');
    assert.strictEqual((await call(port, 'PATCH', '/api/rooms/' + room.id, { name: 'Writers room' })).json.room.name, 'Writers room');
    const inRoom = await call(port, 'POST', '/api/agents', { name: 'Ink', role: 'copywriter', roomId: room.id });
    assert.strictEqual((await call(port, 'GET', '/api/state')).json.desks[inRoom.json.agent.deskId].roomId, room.id);
    const evil = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { origin: 'https://evil.example' } });
    assert.strictEqual(evil.status, 403);
    // Secrets are write-only: saved values never come back in any response.
    await call(port, 'POST', '/api/secrets', { name: 'openrouter', value: 'sk-or-topsecretvalue123' });
    const conn = (await call(port, 'POST', '/api/connectors', { kind: 'stripe' })).json.connector;
    const saved = await call(port, 'PATCH', '/api/connectors/' + conn.id, { secrets: { apiKey: 'rk_live_topsecretvalue456' } });
    const state = await call(port, 'GET', '/api/state');
    for (const body of [JSON.stringify(saved.json), JSON.stringify(state.json)]) assert.ok(!/topsecretvalue/.test(body));
    assert.strictEqual(state.json.settings.keys.openrouter, true);
    assert.strictEqual(state.json.connectors[conn.id].secretsSet.apiKey, true);
  } finally { server.close(); }
});

// ---- v0.3: Ollama speed features, worlds over HTTP, the guided journey over HTTP, and start-fresh
function streamingOllama({ delay = 0 } = {}) {
  return new Promise((resolve) => {
    const seen = []; let active = 0, peak = 0;
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
        seen.push({ url: req.url, body: b ? JSON.parse(b) : null });
        if (req.url === '/api/generate') { res.setHeader('content-type', 'application/json'); return res.end('{"done":true}'); }
        if (req.url !== '/api/chat') { res.statusCode = 404; return res.end('{}'); }
        active++; peak = Math.max(peak, active);
        res.setHeader('content-type', 'application/x-ndjson');
        for (const piece of ['Hel', 'lo ', 'there']) { res.write(JSON.stringify({ message: { content: piece }, done: false }) + '\n'); await new Promise((r) => setTimeout(r, delay)); }
        res.end(JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 9, eval_count: 3 }) + '\n'); active--;
      });
    }).listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen, peak: () => peak }));
  });
}
const ollamaStore = (port) => { const { Store } = require('../sidecar/lib/store'); const s = new Store({ persist: false }); s.state.settings.provider = { name: 'ollama', model: 'm' }; s.state.settings.ollama.host = `http://127.0.0.1:${port}`; return s; };

test('Ollama streams tokens to the UI, keeps the model loaded, caps context and output, and uses JSON mode for planning', async () => {
  const o = await streamingOllama(); const providers = require('../sidecar/lib/providers'); const store = ollamaStore(o.port);
  try {
    const partials = [];
    const r = await providers.complete(store, { agent: null, purpose: 'agent', maxTokens: 321, system: 's', messages: [{ role: 'user', content: 'hi' }], onToken: (t) => partials.push(t) });
    assert.strictEqual(r.text, 'Hello there'); assert.deepStrictEqual(partials, ['Hel', 'Hello ', 'Hello there']); assert.strictEqual(r.tokensIn, 9); assert.strictEqual(r.tokensOut, 3);
    const b = o.seen.find((x) => x.url === '/api/chat').body;
    assert.strictEqual(b.stream, true); assert.strictEqual(b.keep_alive, '30m'); assert.strictEqual(b.options.num_ctx, 4096); assert.strictEqual(b.options.num_predict, 321); assert.strictEqual(b.format, undefined);
    await providers.complete(store, { agent: null, purpose: 'planner', json: true, maxTokens: 500, system: 's', messages: [{ role: 'user', content: 'plan' }] });
    const b2 = o.seen.filter((x) => x.url === '/api/chat')[1].body; assert.strictEqual(b2.format, 'json'); assert.ok(b2.options.temperature <= 0.3);
    assert.strictEqual(await providers.ollama.warm(store.state), true); assert.strictEqual(o.seen.at(-1).url, '/api/generate'); assert.strictEqual(o.seen.at(-1).body.keep_alive, '30m');
  } finally { o.srv.close(); }
});

test('calls to a local model queue so a burst of agents cannot flood it', async () => {
  const o = await streamingOllama({ delay: 15 }); const providers = require('../sidecar/lib/providers'); const store = ollamaStore(o.port);
  try {
    store.state.settings.concurrency.ollama = 1;
    const go = () => providers.complete(store, { agent: null, purpose: 'agent', system: 's', messages: [{ role: 'user', content: 'x' }] });
    await Promise.all([go(), go(), go(), go()]); assert.strictEqual(o.peak(), 1, 'never more than one at a time');
    store.state.settings.concurrency.ollama = 3; await Promise.all([go(), go(), go(), go()]); assert.ok(o.peak() >= 2 && o.peak() <= 3, 'peak ' + o.peak());
  } finally { o.srv.close(); }
});

test('worlds over HTTP: create, scope state by header, connect, and reset for a fresh start', async () => {
  const { server, port, store: root } = await start({ persist: false, port: 0, autopilot: false });
  const callW = async (world, method, path, body) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json', ...(world ? { 'x-world': world } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  try {
    const first = (await callW(null, 'GET', '/api/state')).json; assert.strictEqual(first.worlds.length, 1); assert.strictEqual(first.journey.stage, 'goal'); assert.ok(first.installId);
    assert.ok(first.jobs.content_manager.settings.length >= 5); assert.ok(first.worldKinds.trading);
    const w2 = (await callW(null, 'POST', '/api/worlds', { name: 'Trading', kind: 'trading' })).json.id;
    const s2 = (await callW(w2, 'GET', '/api/state')).json; assert.strictEqual(s2.world.name, 'Trading'); assert.strictEqual(Object.keys(s2.agents).length, 1); assert.strictEqual(s2.worlds.length, 2);
    await callW(w2, 'POST', '/api/agents', { name: 'Scout', role: 'researcher' });
    assert.strictEqual(Object.keys((await callW(w2, 'GET', '/api/state')).json.agents).length, 2);
    assert.strictEqual(Object.keys((await callW(root.defaultId, 'GET', '/api/state')).json.agents).length, 1, 'the other world is untouched');
    assert.strictEqual((await callW(null, 'POST', '/api/worlds/connect', { a: root.defaultId, b: w2 })).status, 200);
    assert.deepStrictEqual((await callW(null, 'GET', '/api/state')).json.worlds.find((w) => w.id === root.defaultId).links, [w2]);
    assert.strictEqual((await callW(null, 'POST', '/api/reset', { confirm: 'nope' })).status, 400);
    const installBefore = first.installId; assert.strictEqual((await callW(null, 'POST', '/api/reset', { confirm: 'RESET' })).status, 200);
    const after = (await callW(null, 'GET', '/api/state')).json; assert.strictEqual(after.worlds.length, 1); assert.notStrictEqual(after.installId, installBefore); assert.strictEqual(after.mission, null);
  } finally { server.close(); }
});

test('the guided journey over HTTP, from goal to a running team, with the Director drafting in the background', async () => {
  const { server, port } = await start({ persist: false, port: 0, autopilot: false });
  const call2 = async (method, path, body) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const state = async () => (await call2('GET', '/api/state')).json;
  const until = async (fn) => { for (let i = 0; i < 200; i++) { const s = await state(); if (fn(s)) return s; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };
  try {
    assert.strictEqual((await call2('POST', '/api/goal', { name: 'hi', targetCents: 100 })).status, 400);
    await call2('POST', '/api/goal', { name: 'Sell planners on Etsy for $3k a month', targetCents: 300000, capitalCents: 20000, riskCents: 10000 });
    let s = await until((x) => x.journey.stage === 'milestones' && !x.journey.busy && x.journey.milestones.length);
    assert.strictEqual(s.mission.targetCents, 300000); assert.strictEqual(s.journey.pathLabel, 'Online store');
    assert.strictEqual((await call2('POST', '/api/journey/roadmap/approve')).status, 400, 'cannot skip stages');
    await call2('POST', '/api/journey/milestones/approve'); s = await until((x) => x.journey.stage === 'roadmap' && !x.journey.busy && x.journey.roadmap);
    assert.ok(s.journey.roadmap.milestones.length >= 4);
    await call2('POST', '/api/journey/roadmap/approve'); s = await state(); assert.strictEqual(s.journey.stage, 'setup'); assert.deepStrictEqual(s.journey.setup.requirements.map((r) => r.kind), ['etsy']);
    const done = await call2('POST', '/api/journey/setup/complete'); assert.strictEqual(done.status, 200);
    s = await until((x) => x.journey.progress.done >= 3); assert.strictEqual(s.journey.stage, 'run'); assert.ok(Object.keys(s.agents).length >= 6);
    await call2('POST', '/api/journey/pause'); s = await state(); assert.strictEqual(s.journey.roadmap.paused, true);
    const t = await call2('POST', '/api/agents/' + Object.values(s.agents).find((a) => a.role === 'copywriter').id + '/task', { taskId: 'landing_page' }); assert.strictEqual(t.json.queued, true);
    assert.strictEqual((await call2('POST', '/api/agents/' + Object.values(s.agents).find((a) => a.role === 'copywriter').id + '/task', { taskId: 'nope' })).status, 400);
  } finally { server.close(); }
});
