'use strict';
// Sovereign sidecar: local HTTP + SSE API and static host for the UI. Node core modules only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store, GRID } = require('./lib/store');
const { HttpError, assert, int } = require('./lib/util');
const station = require('./lib/station');
const agents = require('./lib/agents');
const director = require('./lib/director');
const runner = require('./lib/runner');
const guardrails = require('./lib/guardrails');
const ledger = require('./lib/ledger');
const secrets = require('./lib/secrets');
const providers = require('./lib/providers');
const integrations = require('./lib/integrations');
const avatars = require('./lib/avatars');
const jobs = require('./lib/jobs');
const worlds = require('./lib/worlds');
const journey = require('./lib/journey');
const activity = require('./lib/activity');
const sites = require('./lib/sites');
const sop = require('./lib/sop');
const memory = require('./lib/memory');
const comfy = require('./lib/comfy');
const bridge = require('./lib/company/bridge');
const companyRoutes = require('./lib/company/routes');
const { ROLES } = require('./lib/roles');

const PORT = int(process.env.PORT, 8787);
const HOST = '127.0.0.1'; // never bind beyond localhost: this process can spend money
const FRONTEND = path.join(__dirname, '..', 'frontend');

function publicState(root, worldId) {
  const store = root.forWorld(worldId), s = store.state, settings = root.data.settings;
  const transcripts = {}; for (const [k, v] of Object.entries(s.transcripts)) transcripts[k] = v.slice(-40);
  return {
    installId: root.data.installId,
    grid: GRID, fixed: station.FIXED, caps: station.CAPS, directorOnly: [...station.DIRECTOR_ONLY],
    roomKinds: station.ROOM_KINDS, connectorKinds: integrations.describe(),
    roles: Object.fromEntries(Object.entries(ROLES).map(([k, r]) => [k, { label: r.label, group: r.group, room: r.room, caps: r.caps, persona: r.persona, preset: r.preset }])),
    jobs: jobs.publicJobs(), worldKinds: worlds.KINDS,
    avatars: { options: avatars.OPTIONS, palette: avatars.PALETTE, presets: avatars.PRESETS },
    providerNames: providers.names,
    world: { id: s.id, name: s.name, kind: s.kind, color: s.color, focus: s.focus }, worlds: worlds.summary(root),
    mission: s.mission, journey: journey.view(s),
    settings: { ...settings, ingestSecretSet: secrets.has('ingest'), keys: { openrouter: secrets.has('openrouter'), openai: secrets.has('openai') } },
    agents: Object.fromEntries(Object.values(s.agents).map((a) => [a.id, { ...a, caps: station.effectiveCaps(s, a) }])),
    rooms: s.rooms, desks: s.desks, hallways: s.hallways, ventures: s.ventures,
    connectors: Object.fromEntries(Object.values(s.connectors).map((c) => [c.id, integrations.publicConnector(c)])),
    pnl: Object.fromEntries(Object.keys(s.ventures).map((id) => [id, ledger.pnl(s, id)])),
    progress: ledger.progress(s), ledger: s.ledger.slice(-60).reverse(),
    approvals: s.approvals.slice(-30).reverse(), outbox: (() => { const top = s.outbox.slice(0, 60), sopItem = s.outbox.find((o) => o.kind === 'sop'); return sopItem && !top.includes(sopItem) ? [...top, sopItem] : top; })(), transcripts,
    spentTodayCents: guardrails.spentToday(s),
    activity: activity.list(store), site: sites.view(store),
    company: (() => { try { return bridge.view(store); } catch (e) { return { enabled: false, error: e.message }; } })()
  };
}

function build(root) {
  const routes = []; // per server, so each one is bound to its own store
  const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
  const ok = (extra = {}) => ({ ok: true, ...extra });
  const mutate = (store, fn) => { const r = fn(); store.change('state'); return r; };
  const bgFail = (store, what) => (e) => store.emit('notice', { text: `${what}: ${e.message}`, kind: 'error' });

  on('GET', '/api/state', ({ store }) => publicState(root, store.id));

  // ----- worlds
  on('POST', '/api/worlds', ({ body }) => ok({ id: worlds.create(root, body) }));
  on('PATCH', '/api/worlds/:id', ({ params, body }) => { worlds.update(root, params.id, body); return ok(); });
  on('DELETE', '/api/worlds/:id', ({ params }) => { worlds.remove(root, params.id); return ok(); });
  on('POST', '/api/worlds/connect', ({ body }) => { worlds.connect(root, body.a, body.b); return ok(); });
  on('POST', '/api/worlds/disconnect', ({ body }) => { worlds.disconnect(root, body.a, body.b); return ok(); });

  // ----- goal and guided journey
  const goal = ({ store, body }) => { const r = journey.setGoal(store, body); r.done.catch(() => {}); return ok({ reset: r.reset }); };
  on('POST', '/api/goal', goal); on('POST', '/api/mission', goal);
  on('POST', '/api/journey/milestones/generate', ({ store }) => { journey.generateMilestones(store).catch(() => {}); return ok(); });
  on('POST', '/api/journey/milestones/save', ({ store, body }) => { journey.saveMilestones(store, body.milestones); return ok(); });
  on('POST', '/api/journey/milestones/approve', ({ store }) => { journey.approveMilestones(store).catch(() => {}); return ok(); });
  on('POST', '/api/journey/roadmap/generate', ({ store }) => { journey.generateRoadmap(store).catch(() => {}); return ok(); });
  on('POST', '/api/journey/roadmap/back', ({ store }) => { journey.backToMilestones(store); return ok(); });
  on('POST', '/api/journey/roadmap/approve', ({ store }) => { journey.approveRoadmap(store); return ok(); });
  on('POST', '/api/journey/requirement', ({ store, body }) => { journey.skipRequirement(store, body.kind, body.skipped !== false); return ok(); });
  on('POST', '/api/journey/setup/complete', ({ store }) => ok(journey.completeSetup(store)));
  on('POST', '/api/journey/pause', ({ store }) => { journey.pause(store); return ok(); });
  on('POST', '/api/journey/resume', ({ store }) => { journey.resume(store); return ok(); });
  on('POST', '/api/journey/replan', ({ store, body }) => { journey.replan(store, { advance: !!(body && body.advance) }).catch(() => {}); return ok(); });
  on('POST', '/api/journey/carry/:id/done', ({ store, params }) => { journey.resolveCarry(store, params.id, 'done'); return ok(); });
  on('POST', '/api/journey/carry/:id/retry', ({ store, params }) => { journey.resolveCarry(store, params.id, 'retry'); return ok(); });
  on('POST', '/api/sop/replay', ({ store }) => { sop.replay(store); return ok(); });
  on('POST', '/api/sop/issue', ({ store }) => ok(sop.issue(store)));
  on('POST', '/api/memory/note', ({ store, body }) => { const t = memory.addOwnerNote(store.state, body.text); assert(t, 'Write the rule in a few words.'); store.change('state'); return ok(); });
  on('POST', '/api/memory/note/remove', ({ store, body }) => { const m = memory.ensure(store.state); m.ownerNotes = m.ownerNotes.filter((n) => n.text !== body.text); store.change('state'); return ok(); });
  on('GET', '/api/comfy/detect', async () => ok(await comfy.detect()));
  // One click: find ComfyUI, create the connector if needed, save the address, test it and pick a model.
  on('POST', '/api/comfy/connect', async ({ store, body }) => {
    const found = body && body.baseUrl ? { found: true, baseUrl: comfy.normalize(body.baseUrl) } : await comfy.detect();
    assert(found.found, 'I could not find ComfyUI. Start it, then try again (or type its address in the ComfyUI connector).');
    let c = comfy.findConnector(store.state) || Object.values(store.state.connectors).find((x) => x.kind === 'comfyui');
    if (!c) c = mutate(store, () => station.createConnector(store.state, { kind: 'comfyui' }));
    integrations.configure(store, c.id, { config: { baseUrl: found.baseUrl } });
    const r = await integrations.test(store, c.id); store.change('state');
    return ok({ connector: integrations.publicConnector(store.state.connectors[c.id]), detail: r.detail });
  });
  on('POST', '/api/comfy/workflow', ({ store, body }) => ok(comfy.saveWorkflow(store, body.workflow)));
  on('POST', '/api/comfy/test-image', async ({ store, body }) => { assert(comfy.available(store.state), 'Connect ComfyUI first.'); const r = await comfy.generate(store, [{ name: 'test', prompt: String((body && body.prompt) || 'a small potted plant on a wooden desk, soft morning light, product photo').slice(0, 400) }], { max: 1 }); assert(r.images.length, r.errors[0] || 'No image was produced.', 502); return ok({ images: r.images.map((i) => ({ name: i.name, url: `/sites/${store.id || store.defaultId}/${i.name}` })) }); });
  on('POST', '/api/site/links', ({ store, body }) => { sites.setLinks(store, body.links || {}); return ok({ links: sites.links(store) }); });
  on('POST', '/api/journey/task/:id/remove', ({ store, params }) => { journey.removeTask(store, params.id); return ok(); });
  on('POST', '/api/journey/task/:id/retry', ({ store, params }) => { journey.retryTask(store, params.id); return ok(); });
  on('POST', '/api/journey/task/:id/done', ({ store, params }) => { journey.completeTask(store, params.id); return ok(); });
  on('POST', '/api/journey/task/:id/skip', ({ store, params }) => { journey.skipTask(store, params.id); return ok(); });

  // ----- settings, keys, provider
  on('POST', '/api/settings', ({ store, body }) => mutate(store, () => {
    const st = root.data.settings;
    if (body.provider) {
      assert(providers.names.includes(body.provider.name), 'Unknown provider.');
      st.provider = { name: body.provider.name, model: String(body.provider.model || st.provider.model).slice(0, 80) };
    }
    if (body.ollama) {
      if (body.ollama.host != null) st.ollama.host = providers.ollama.cleanHost(body.ollama.host);
      if (body.ollama.keepAlive != null) st.ollama.keepAlive = /^\d+[smh]$/.test(String(body.ollama.keepAlive)) ? String(body.ollama.keepAlive) : st.ollama.keepAlive;
      if (body.ollama.numCtx != null) st.ollama.numCtx = Math.max(1024, Math.min(32768, int(body.ollama.numCtx, st.ollama.numCtx)));
    }
    if (body.concurrency) { const c = st.concurrency; if (body.concurrency.ollama != null) c.ollama = Math.max(1, Math.min(8, int(body.concurrency.ollama, c.ollama))); if (body.concurrency.other != null) c.other = Math.max(1, Math.min(16, int(body.concurrency.other, c.other))); }
    if (['fast', 'balanced', 'thorough'].includes(body.speed)) st.speed = body.speed;
    if (body.loop && typeof body.loop === 'object') { const l = st.loop = st.loop || {}; if (['off', 'smart', 'always'].includes(body.loop.evaluate)) l.evaluate = body.loop.evaluate; if (body.loop.maxRevisions != null) l.maxRevisions = Math.max(0, Math.min(3, int(body.loop.maxRevisions, 1))); if (body.loop.maxRounds != null) l.maxRounds = Math.max(0, Math.min(500, int(body.loop.maxRounds, 0))); }
    if (body.company && typeof body.company === 'object') { const c = st.company = { enabled: true, autonomy: 'approval_only', allowPaid: false, autopilot: false, ...(st.company || {}) }; if (body.company.enabled != null) c.enabled = !!body.company.enabled; if (['approval_only', 'permissioned'].includes(body.company.autonomy)) c.autonomy = body.company.autonomy; if (body.company.allowPaid != null) c.allowPaid = !!body.company.allowPaid; if (body.company.autopilot != null) c.autopilot = !!body.company.autopilot; }
    if (body.autoDelegate != null) st.autoDelegate = !!body.autoDelegate;
    if (body.autoContinue != null) st.autoContinue = !!body.autoContinue;
    if (body.waitMinutes != null) st.waitMinutes = Math.max(0, Math.min(240, int(body.waitMinutes, 10)));
    if (body.intro != null) st.intro = !!body.intro;
    if (body.openaiCompat && body.openaiCompat.baseUrl != null) {
      const u = String(body.openaiCompat.baseUrl).trim().replace(/\/+$/, ''); assert(/^https?:\/\/\S+$/.test(u), 'Base URL must start with http:// or https://');
      st.openaiCompat = { baseUrl: u };
    }
    if (body.policy) {
      if (['ask', 'auto'].includes(body.policy.directorStructure)) st.policy.directorStructure = body.policy.directorStructure;
      if (['ask', 'auto'].includes(body.policy.connectorWrites)) st.policy.connectorWrites = body.policy.connectorWrites;
      if (body.policy.spendApprovalCents != null) st.policy.spendApprovalCents = Math.max(0, int(body.policy.spendApprovalCents));
    }
    if (body.budgets) {
      if (body.budgets.globalDailyCents != null) st.budgets.globalDailyCents = Math.max(0, int(body.budgets.globalDailyCents));
      if (body.budgets.perAgentDailyCents != null) st.budgets.perAgentDailyCents = Math.max(0, int(body.budgets.perAgentDailyCents));
    }
    if (st.provider.name === 'ollama') providers.ollama.warm(store.state); // load the model now so the first real request is fast
    return ok();
  }));
  on('POST', '/api/secrets', ({ store, body }) => {
    assert(['openrouter', 'openai'].includes(body.name), 'Unknown key name.');
    assert(typeof body.value === 'string' && body.value.length > 8, 'That key looks too short.');
    secrets.set(body.name, body.value); store.change('state'); return ok(); // write-only: never echoed back
  });
  on('POST', '/api/secrets/ingest', ({ store }) => { const s = secrets.rotateIngestSecret(); store.change('state'); return ok({ secret: s }); });
  on('POST', '/api/provider/test', async ({ store }) => {
    const d = director.getDirector(store.state), t0 = Date.now();
    const r = await providers.complete(store, { agent: { ...d, model: null }, purpose: 'agent', maxTokens: 20, system: 'Reply with the single word: ready', messages: [{ role: 'user', content: 'ping' }] });
    return ok({ model: r.model, reply: String(r.text).slice(0, 80), ms: Date.now() - t0 });
  });
  on('GET', '/api/ollama/models', async ({ query }) => ok({ models: await providers.ollama.listModels(query.get('host') || root.data.settings.ollama.host) }));
  on('POST', '/api/ollama/warm', async ({ store }) => ok({ warmed: await providers.ollama.warm(store.state) }));
  on('POST', '/api/reset', ({ body }) => { assert(body.confirm === 'RESET', 'Type RESET to confirm.'); secrets.clearAll(); root.reset(); director.ensureDirector(root.forWorld(root.defaultId)); return ok(); });

  // ----- agents
  on('POST', '/api/agents', ({ store, body }) => ok({ agent: mutate(store, () => agents.createAgent(store.state, body)) }));
  on('PATCH', '/api/agents/:id', ({ store, params, body }) => ok({ agent: mutate(store, () => agents.updateAgent(store.state, params.id, body)) }));
  on('DELETE', '/api/agents/:id', ({ store, params }) => mutate(store, () => { agents.deleteAgent(store.state, params.id); return ok(); }));
  on('POST', '/api/agents/:id/run', async ({ store, params, body }) => { assert(body.task, 'Give the agent a task.'); return ok({ text: await runner.runAgent(store, params.id, String(body.task)) }); });
  on('POST', '/api/agents/:id/chat', async ({ store, params, body }) => {
    assert(body.text && String(body.text).trim(), 'Say something first.');
    return ok({ text: await runner.runAgent(store, params.id, String(body.text).slice(0, 4000)) });
  });
  // Run one of the agent's job tasks. Runs in the background; the result lands in the Outbox.
  on('POST', '/api/agents/:id/task', ({ store, params, body }) => {
    const a = store.state.agents[params.id]; assert(a, 'Agent not found', 404); assert(a.role !== 'director', 'The Director plans; ask it in the chat instead.');
    assert(body.taskId || body.instructions, 'Pick a task or describe one.');
    if (body.taskId) assert(jobs.spec(a.role).tasks.some((t) => t.id === body.taskId), 'That role has no such task.');
    runner.assign(store, { agentId: a.id, taskId: body.taskId || undefined, instructions: String(body.instructions || '').slice(0, 1500) })
      .then((r) => store.emit('notice', { text: `${a.name} finished. See the Outbox.`, kind: 'ok', outboxId: r.outboxId })).catch(bgFail(store, `${a.name} could not finish`));
    return ok({ queued: true });
  });

  // ----- station
  on('POST', '/api/rooms', ({ store, body }) => ok({ room: mutate(store, () => station.createRoom(store.state, body)) }));
  on('PATCH', '/api/rooms/:id', ({ store, params, body }) => ok({ room: mutate(store, () => station.updateRoom(store.state, params.id, body)) }));
  on('DELETE', '/api/rooms/:id', ({ store, params }) => mutate(store, () => { station.deleteRoom(store.state, params.id); return ok(); }));
  on('POST', '/api/desks', ({ store, body }) => ok({ desk: mutate(store, () => station.createDesk(store.state, body)) }));
  on('PATCH', '/api/desks/:id', ({ store, params, body }) => ok({ desk: mutate(store, () => station.updateDesk(store.state, params.id, body)) }));
  on('DELETE', '/api/desks/:id', ({ store, params }) => mutate(store, () => { station.deleteDesk(store.state, params.id); return ok(); }));
  on('POST', '/api/hallways', ({ store, body }) => ok({ hallway: mutate(store, () => station.createHallway(store.state, body)) }));
  on('DELETE', '/api/hallways/:id', ({ store, params }) => mutate(store, () => { station.deleteHallway(store.state, params.id); return ok(); }));
  on('POST', '/api/connectors', ({ store, body }) => ok({ connector: integrations.publicConnector(mutate(store, () => station.createConnector(store.state, body))) }));
  on('PATCH', '/api/connectors/:id', ({ store, params, body }) => mutate(store, () => {
    station.updateConnectorBasics(store.state, params.id, body);
    return ok({ connector: integrations.publicConnector(integrations.configure(store, params.id, body)) });
  }));
  on('DELETE', '/api/connectors/:id', ({ store, params }) => mutate(store, () => {
    const c = store.state.connectors[params.id]; assert(c, 'Connector not found', 404);
    integrations.forget(c); station.deleteConnector(store.state, params.id); return ok();
  }));
  on('POST', '/api/connectors/:id/test', async ({ store, params }) => ok(await integrations.test(store, params.id)));
  on('POST', '/api/connectors/:id/sync', async ({ store, params }) => ok(await integrations.sync(store, params.id)));
  on('POST', '/api/connectors/:id/disconnect', ({ store, params }) => mutate(store, () => { const c = store.state.connectors[params.id]; assert(c, 'Connector not found', 404); integrations.oauth.disconnect(c.id); c.status = 'untested'; return ok(); }));

  // ----- company layer (owner-facing): recipes launch a whole business, switches control autonomy and spending
  on('GET', '/api/launch/recipes', () => ok({ recipes: bridge.recipes() }));
  on('POST', '/api/launch/recipe', ({ store, body }) => ok(bridge.launchRecipe(store, body || {})));

  // ----- work, Director, approvals
  on('POST', '/api/run', async ({ store, body }) => { assert(body.task, 'Describe the task.'); return ok(await runner.dispatch(store, { start: body.from || 'inbox', task: String(body.task) })); });
  on('POST', '/api/director/message', async ({ store, body }) => { assert(body.text, 'Say something to the Director.'); return ok(await director.handleMessage(store, String(body.text).slice(0, 4000))); });
  on('POST', '/api/approvals/:id/approve', async ({ store, params }) => ok({ approval: await guardrails.resolveApproval(store, params.id, true) }));
  on('POST', '/api/approvals/:id/reject', async ({ store, params }) => ok({ approval: await guardrails.resolveApproval(store, params.id, false) }));

  // ----- money
  on('POST', '/api/ledger/claim', ({ store, body }) => ok({ entry: ledger.claim(store, body) })); // unverified by construction
  on('POST', '/api/ingest/:connector', ({ store, params, raw, headers }) => ok({ entry: ledger.ingest(store, params.connector, raw, headers['x-sovereign-signature']) }));
  return routes;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(FRONTEND, p));
  if (!file.startsWith(FRONTEND) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

// The live preview of a site an agent built. It is agent-written code, so it is sandboxed: it gets an opaque origin, which means
// it cannot call this server's API (that check rejects any origin that is not localhost) and cannot touch the Sovereign page.
function serveSite(root, req, res, url) {
  const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean); // ['sites', worldId, ...file]
  const wid = parts[1], world = wid && root.world(wid);
  if (!world || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); return res.end('Not found'); }
  if (parts.length === 2 && !url.pathname.endsWith('/')) { res.writeHead(302, { location: url.pathname + '/' }); return res.end(); }
  const name = parts.slice(2).join('/') || 'index.html', store = root.forWorld(wid), body = sites.read(store, name);
  if (body == null) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end(sites.names(store).length ? 'File not found in this site.' : 'No site has been built yet. The Builder will make one when its task runs.'); }
  res.writeHead(200, { 'content-type': sites.mime(name), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*',
    'content-security-policy': "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'none'" });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (res, status, title, msg) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="background:#020805;color:#b6ffd0;font:16px ui-monospace,monospace;padding:48px"><h2>${esc(title)}</h2><p>${esc(msg)}</p><p><a style="color:#00ff88" href="/">Back to Sovereign</a></p><script>setTimeout(()=>location.replace('/'),2500)</script>`);
};
// A connector lives in one world; OAuth links only carry its id, so search every world.
function findConnector(root, id) {
  for (const w of Object.values(root.data.worlds)) if (w.connectors[id]) return { store: root.forWorld(w.id), connector: w.connectors[id] };
  return null;
}
async function handleOAuth(root, req, res, url) {
  const resolve = (id) => {
    const hit = findConnector(root, id); const adapter = hit && integrations.adapterFor(hit.connector.kind);
    assert(hit && adapter && adapter.oauth, 'That connector does not use sign-in.', 404);
    return { connector: hit.connector, adapter, sec: integrations.secretsOf(hit.connector), store: hit.store };
  };
  try {
    const redirectUri = `http://${req.headers.host}/oauth/callback`;
    if (url.pathname === '/oauth/start') {
      const { connector, adapter, sec } = resolve(url.searchParams.get('connector'));
      res.writeHead(302, { location: integrations.oauth.start(connector, adapter, sec, redirectUri) }); return res.end();
    }
    if (url.pathname === '/oauth/callback') {
      let owner; const id = await integrations.oauth.finish({ state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error') }, (cid) => { const r = resolve(cid); owner = r.store; return r; });
      await integrations.test(owner, id).catch(() => {});
      owner.change('state');
      return page(res, 200, 'Connected', 'Sign-in worked. Returning to your station…');
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) { page(res, e.status || 500, 'Could not connect', e.message); }
}

function createServer(root) {
  const routes = build(root);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // Block drive-by requests from other websites to this local, money-spending server.
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !url.pathname.startsWith('/api/ingest/') && !url.pathname.startsWith('/hooks/') && !((url.pathname.startsWith('/sites/') || url.pathname.startsWith('/venture/')) && (req.method === 'GET' || req.method === 'HEAD'))) { res.writeHead(403); return res.end('Forbidden origin'); }
    if (url.pathname.startsWith('/api/company') || url.pathname.startsWith('/hooks/') || url.pathname.startsWith('/venture/')) { if (await companyRoutes.handle(bridge.companyFor(root), req, res)) return; }
    if (url.pathname.startsWith('/oauth/')) return handleOAuth(root, req, res, url);
    if (url.pathname.startsWith('/sites/')) return serveSite(root, req, res, url);
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      const off = root.subscribe((ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { off(); clearInterval(ping); });
      return;
    }
    const route = routes.map((r) => ({ r, m: r.re.exec(url.pathname) })).find((x) => x.m && x.r.method === req.method);
    if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"No such endpoint"}'); }
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; assert(size < 1e6, 'Body too large', 413); chunks.push(c); }
      const raw = Buffer.concat(chunks).toString('utf8');
      const isIngest = url.pathname.startsWith('/api/ingest/');
      let body = {}; if (raw && !isIngest) { try { body = JSON.parse(raw); } catch (_) { throw new HttpError(400, 'Body must be JSON.'); } }
      // Which world? An explicit header wins; ingest events find the world that owns the venture.
      let wid = req.headers['x-world'] || url.searchParams.get('world');
      if (isIngest && !wid) { try { const vid = JSON.parse(raw).ventureId; wid = (Object.values(root.data.worlds).find((w) => w.ventures[vid]) || {}).id; } catch (_) { /* default world */ } }
      if (!wid || !root.world(wid)) wid = root.defaultId;
      const out = await route.r.fn({ params: route.m.groups || {}, body, raw, headers: req.headers, query: url.searchParams, store: root.forWorld(wid), root });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    } catch (e) {
      const status = e.status || 500; if (status === 500) console.error(e);
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function start(opts = {}) {
  const root = opts.store || new Store({ persist: opts.persist });
  for (const w of Object.values(root.data.worlds)) { const v = root.forWorld(w.id); agents.migrate(v.state); director.ensureDirector(v); }
  const server = createServer(root);
  // Read-only pull from payment and ad sources every 10 minutes; the autopilot is nudged every 20 seconds.
  const sync = setInterval(() => { for (const w of Object.values(root.data.worlds)) integrations.syncDue(root.forWorld(w.id)); }, 10 * 60 * 1000); sync.unref();
  const tick = setInterval(() => journey.tickAll(root), 20000); tick.unref();
  server.on('close', () => { clearInterval(sync); clearInterval(tick); });
  return new Promise((resolve) => server.listen(opts.port ?? PORT, HOST, () => {
    try { bridge.setPort(root, server.address().port); } catch (_) { /* the company layer is optional at boot */ }
    if (root.data.settings.provider.name === 'ollama') providers.ollama.warm(root.state);
    if (opts.autopilot !== false) journey.tickAll(root); // pick up where a running roadmap left off
    resolve({ server, store: root, root, port: server.address().port });
  }));
}

if (require.main === module) {
  start().then(({ port }) => console.log(`Sovereign is running → http://localhost:${port}`));
}
module.exports = { start, publicState };
