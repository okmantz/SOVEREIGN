'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { fresh, scriptProvider } = require('./helpers');
const comfy = require('../sidecar/lib/comfy');
const sites = require('../sidecar/lib/sites');
const station = require('../sidecar/lib/station');
const integrations = require('../sidecar/lib/integrations');
const memory = require('../sidecar/lib/memory');
const agents = require('../sidecar/lib/agents');
const runner = require('../sidecar/lib/runner');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// A stand-in for ComfyUI's real HTTP API.
async function fakeComfy({ models = ['sdxl_base.safetensors'], rejectPrompt = null, slowPolls = 1 } = {}) {
  const posted = [], jobs = new Map(); let n = 0, active = 0, peak = 0;
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/system_stats') return json({ system: { comfyui_version: '0.3.9' }, devices: [{ name: 'Test GPU', vram_total: 12e9 }] });
    if (u.pathname === '/object_info/CheckpointLoaderSimple') return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [models] } } } });
    if (u.pathname === '/prompt' && req.method === 'POST') {
      let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw); posted.push(body);
      if (rejectPrompt) return json(rejectPrompt, 400);
      const id = 'job' + (++n); jobs.set(id, { polls: 0 }); active++; peak = Math.max(peak, active); return json({ prompt_id: id });
    }
    if (u.pathname.startsWith('/history/')) { const id = u.pathname.split('/').pop(), j = jobs.get(id); if (!j) return json({}); if (++j.polls <= slowPolls) return json({}); active = Math.max(0, active - 1);
      return json({ [id]: { status: { status_str: 'success' }, outputs: { 9: { images: [{ filename: `sov_${id}.png`, subfolder: '', type: 'output' }] } } } }); }
    if (u.pathname === '/view') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, posted, base: `http://127.0.0.1:${srv.address().port}`, peak: () => peak };
}
async function connected(view, base, config = {}) {
  const c = station.createConnector(view.state, { kind: 'comfyui' });
  integrations.configure(view, c.id, { config: { baseUrl: base, ...config } }); const r = await integrations.test(view, c.id); return { c: view.state.connectors[c.id], r };
}

test('ComfyUI connects, lists models, picks one, and reports what it found', async () => {
  const { view } = fresh(); const api = await fakeComfy({ models: ['a.safetensors', 'b.safetensors'] });
  try {
    const { c, r } = await connected(view, api.base);
    assert.strictEqual(c.status, 'ready'); assert.match(r.detail, /0\.3\.9/); assert.match(r.detail, /Test GPU/); assert.match(r.detail, /2 models installed; using a\.safetensors/); assert.strictEqual(c.config.checkpoint, 'a.safetensors');
    assert.ok(integrations.describe().comfyui.live, 'shows up as a live connector'); assert.strictEqual(integrations.publicConnector(c).hasWorkflow, false);
  } finally { api.srv.close(); }
  const { view: v2 } = fresh(); const c2 = station.createConnector(v2.state, { kind: 'comfyui' }); integrations.configure(v2, c2.id, { config: { baseUrl: 'http://127.0.0.1:9' } });
  await assert.rejects(integrations.test(v2, c2.id), /Could not reach ComfyUI/); assert.strictEqual(v2.state.connectors[c2.id].status, 'error');
});

test('rendering queues the job, polls, downloads the file and saves it into the site under img/', async () => {
  const { view } = fresh(); const api = await fakeComfy({ slowPolls: 2 });
  try {
    await connected(view, api.base, { width: '768', height: '512' });
    const r = await comfy.generate(view, [{ name: 'Hero Image!', prompt: 'a cozy desk with a paper planner, morning light' }, { name: 'tall', prompt: 'a tall poster of planners', width: 640, height: 1000 }]);
    assert.strictEqual(r.errors.length, 0); assert.strictEqual(r.images.length, 2);
    assert.match(r.images[0].name, /^img\/hero-image-\d+\.png$/); assert.deepStrictEqual(sites.read(view, r.images[0].name), PNG);
    const g = api.posted[0].prompt; assert.strictEqual(g[6].inputs.text, 'a cozy desk with a paper planner, morning light'); assert.strictEqual(g[4].inputs.ckpt_name, 'sdxl_base.safetensors'); assert.strictEqual(g[5].inputs.width, 768); assert.strictEqual(g[5].inputs.height, 512);
    const g2 = api.posted[1].prompt; assert.strictEqual(g2[5].inputs.width, 640); assert.strictEqual(g2[5].inputs.height, 1000, 'per-image sizes are honoured');
    assert.strictEqual(api.peak(), 1, 'one render at a time so a local GPU is not flooded');
    assert.ok(sites.view(view).images.length === 2 && sites.context(view).includes('Generated images'), 'the Builder is told which images exist');
  } finally { api.srv.close(); }
});

test('bad requests fail with a plain reason and never crash the caller', async () => {
  const { view } = fresh();
  let api = await fakeComfy({ rejectPrompt: { error: { message: 'Prompt outputs failed validation' }, node_errors: { 4: { errors: [{ details: 'ckpt_name: Value not in list' }] } } } });
  try { await connected(view, api.base); const r = await comfy.generate(view, [{ name: 'a', prompt: 'a valid long prompt' }, { name: 'b', prompt: 'another valid prompt' }]);
    assert.strictEqual(r.images.length, 0); assert.match(r.errors[0], /model \(checkpoint\) is not installed/); assert.strictEqual(r.errors.length, 1, 'it stops instead of failing every image the same way'); assert.match(view.state.connectors[Object.keys(view.state.connectors)[0]].lastError, /checkpoint/);
  } finally { api.srv.close(); }
  assert.strictEqual((await comfy.generate({ ...view, state: { connectors: { x: { kind: 'comfyui', status: 'ready', config: { baseUrl: 'http://127.0.0.1:9' }, id: 'x' } } }, change() {} }, [{ prompt: 'a valid prompt here' }]).catch((e) => ({ images: [], errors: [e.message] }))).images.length, 0);
  await assert.rejects(comfy.generate(fresh().view, [{ prompt: 'x long prompt' }]), /not connected/);
});

test('a pasted API-format workflow is filled in and validated; junk is refused', async () => {
  const { view } = fresh(); const api = await fakeComfy();
  try {
    await connected(view, api.base);
    assert.throws(() => comfy.saveWorkflow(view, '{"nope":1}'), /API-format/); assert.throws(() => comfy.saveWorkflow(view, 'not json'), /valid JSON/);
    const wf = { 1: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}, product photo', clip: ['4', 1] } }, 2: { class_type: 'KSampler', inputs: { seed: '{{seed}}', negative: '{{negative}}' } }, 9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } } };
    assert.deepStrictEqual(comfy.saveWorkflow(view, JSON.stringify(wf)), { custom: true }); assert.strictEqual(integrations.publicConnector(comfy.findConnector(view.state)).hasWorkflow, true);
    assert.ok(!('workflow' in integrations.publicConnector(comfy.findConnector(view.state))), 'the large text is never sent to the browser');
    const r = await comfy.generate(view, [{ name: 'custom', prompt: 'a lamp on a desk' }]); assert.strictEqual(r.images.length, 1);
    const sent = api.posted[0].prompt; assert.strictEqual(sent[1].inputs.text, 'a lamp on a desk, product photo'); assert.strictEqual(typeof sent[2].inputs.seed, 'number', 'numbers stay numbers'); assert.deepStrictEqual(sent[1].inputs.clip, ['4', 1]);
    assert.deepStrictEqual(comfy.saveWorkflow(view, ''), { custom: false });
  } finally { api.srv.close(); }
});

test('an agent that ends a reply with an images block gets pictures in the Outbox, and every agent is told it can', async () => {
  const { view } = fresh(); const api = await fakeComfy(); const w = view.state;
  w.mission = { name: 'Sell planners', targetCents: 100000, capitalCents: 5000, riskCents: 5000 };
  assert.ok(!/IMAGE GENERATION/.test(memory.constraints(w)), 'not mentioned while ComfyUI is not connected');
  try {
    await connected(view, api.base); assert.match(memory.constraints(w), /IMAGE GENERATION: ComfyUI is connected/);
    const d = agents.createAgent(w, { name: 'Pixel', role: 'designer' });
    const restore = scriptProvider(async () => 'HANDOFF: made 2 images\nHere is the plan.\n```images\n[{"name":"hero","prompt":"a bright desk with planners, soft light, product photo"},{"name":"flatlay","prompt":"flat lay of three planners, pastel, top-down"}]\n```\nUse hero on the landing page.');
    try { const r = await runner.assign(view, { agentId: d.id, taskId: 'generate_visuals', title: 'Images' }); const o = w.outbox.find((x) => x.id === r.outboxId);
      assert.strictEqual(o.meta.images.length, 2); assert.match(o.meta.images[0].url, /^\/sites\/.+\/img\/hero-\d+\.png$/); assert.match(o.content, /Generated with ComfyUI/); assert.ok(!/```images/.test(o.content), 'the raw block is replaced by the result');
    } finally { restore(); }
    const noBlock = scriptProvider(async () => 'HANDOFF: x\nplain answer'); try { const r2 = await runner.assign(view, { agentId: d.id, taskId: 'design_brief', title: 'brief' }); assert.ok(!w.outbox.find((x) => x.id === r2.outboxId).meta.images, 'no block, no render'); } finally { noBlock(); }
  } finally { api.srv.close(); }
});

test('the API: one-click connect, a sandbox-safe image route, and a media type for pictures', async () => {
  const api = await fakeComfy(); const { start } = require('../sidecar/index'); const { server, port, root } = await start({ persist: false, port: 0, autopilot: false });
  const post = (p, body) => fetch(`http://127.0.0.1:${port}/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  try {
    let r = await post('/comfy/connect', { baseUrl: api.base }); const j = await r.json(); assert.strictEqual(r.status, 200); assert.strictEqual(j.connector.status, 'ready'); assert.match(j.detail, /Connected to ComfyUI/);
    r = await post('/comfy/connect', { baseUrl: api.base }); assert.strictEqual(Object.values(root.forWorld(root.defaultId).state.connectors).filter((c) => c.kind === 'comfyui').length, 1, 'connecting twice reuses the connector');
    r = await post('/comfy/test-image', { prompt: 'a small plant on a desk, soft light' }); const t = await r.json(); assert.strictEqual(r.status, 200); assert.strictEqual(t.images.length, 1);
    const img = await fetch(`http://127.0.0.1:${port}${t.images[0].url}`); assert.strictEqual(img.status, 200); assert.strictEqual(img.headers.get('content-type'), 'image/png'); assert.deepStrictEqual(Buffer.from(await img.arrayBuffer()), PNG);
    r = await post('/comfy/connect', { baseUrl: 'http://127.0.0.1:9' }); assert.ok(r.status >= 400, 'a wrong address is an error, not a silent success');
    r = await post('/comfy/workflow', { workflow: '{"a":1}' }); assert.strictEqual(r.status, 400);
  } finally { server.close(); api.srv.close(); }
});
