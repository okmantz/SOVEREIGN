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
