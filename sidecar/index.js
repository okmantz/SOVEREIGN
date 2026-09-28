'use strict';
// Sovereign sidecar: local HTTP + SSE API and static host for the station UI. Node core modules only.
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

const PORT = int(process.env.PORT, 8787);
const HOST = '127.0.0.1'; // never bind beyond localhost: this process can spend money
const FRONTEND = path.join(__dirname, '..', 'frontend');

function publicState(store) {
  const s = store.state;
  const transcripts = {}; for (const [k, v] of Object.entries(s.transcripts)) transcripts[k] = v.slice(-30);
  return {
    grid: GRID, fixed: station.FIXED, caps: station.CAPS, directorOnly: [...station.DIRECTOR_ONLY],
    roomKinds: station.ROOM_KINDS, connectorKinds: station.CONNECTOR_KINDS, roles: agents.ROLES, palette: agents.PALETTE, accessories: agents.ACCESSORIES,
    providerNames: providers.names,
    mission: s.mission, settings: { ...s.settings, ingestSecretSet: secrets.has('ingest'), keys: { openrouter: secrets.has('openrouter') } },
    agents: Object.fromEntries(Object.values(s.agents).map((a) => [a.id, { ...a, caps: station.effectiveCaps(s, a) }])),
    rooms: s.rooms, desks: s.desks, hallways: s.hallways, connectors: s.connectors, ventures: s.ventures,
    pnl: Object.fromEntries(Object.keys(s.ventures).map((id) => [id, ledger.pnl(s, id)])),
    progress: ledger.progress(s), ledger: s.ledger.slice(-60).reverse(),
    approvals: s.approvals.slice(-30).reverse(), outbox: s.outbox.slice(0, 50), transcripts,
    spentTodayCents: guardrails.spentToday(s)
  };
}

const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

function build(store) {
  const S = () => store.state;
  const ok = (extra = {}) => ({ ok: true, ...extra });
  const mutate = (fn) => { const r = fn(); store.change('state'); return r; };

  on('GET', '/api/state', () => publicState(store));

  on('POST', '/api/mission', async ({ body }) => {
    const m = { name: String(body.name || 'Untitled mission').slice(0, 80), targetCents: Math.max(0, int(body.targetCents)), capitalCents: Math.max(0, int(body.capitalCents)),
      riskCents: Math.max(0, int(body.riskCents)), deadline: body.deadline ? String(body.deadline).slice(0, 10) : null, createdAt: Date.now() };
    assert(m.targetCents > 0, 'Set a profit target above zero.');
    mutate(() => { S().mission = m; });
    director.handleMessage(store, `MISSION SET: "${m.name}". Target ${m.targetCents / 100} USD verified profit, capital ${m.capitalCents / 100} USD, loss limit ${m.riskCents / 100} USD. Propose the starting crew, station layout and first venture.`).catch((e) => console.error('[director]', e.message));
    return ok({ mission: m });
  });

  on('POST', '/api/settings', ({ body }) => mutate(() => {
    const st = S().settings;
    if (body.provider) {
      assert(providers.names.includes(body.provider.name), 'Unknown provider.');
      st.provider = { name: body.provider.name, model: String(body.provider.model || st.provider.model).slice(0, 80) };
    }
    if (body.policy) {
      if (['ask', 'auto'].includes(body.policy.directorStructure)) st.policy.directorStructure = body.policy.directorStructure;
      if (body.policy.spendApprovalCents != null) st.policy.spendApprovalCents = Math.max(0, int(body.policy.spendApprovalCents));
      if (body.policy.firstOutreachApproval != null) st.policy.firstOutreachApproval = !!body.policy.firstOutreachApproval;
    }
    if (body.budgets) {
      if (body.budgets.globalDailyCents != null) st.budgets.globalDailyCents = Math.max(0, int(body.budgets.globalDailyCents));
      if (body.budgets.perAgentDailyCents != null) st.budgets.perAgentDailyCents = Math.max(0, int(body.budgets.perAgentDailyCents));
    }
    return ok();
  }));
  on('POST', '/api/secrets', ({ body }) => {
    assert(body.name === 'openrouter', 'Only the OpenRouter key is supported right now.');
    assert(typeof body.value === 'string' && body.value.length > 8, 'That key looks too short.');
    secrets.set(body.name, body.value); store.change('state'); return ok(); // write-only: never echoed back
  });
  on('POST', '/api/secrets/ingest', () => { const s = secrets.rotateIngestSecret(); store.change('state'); return ok({ secret: s }); });

  // Agents
  on('POST', '/api/agents', ({ body }) => ok({ agent: mutate(() => agents.createAgent(S(), body)) }));
  on('PATCH', '/api/agents/:id', ({ params, body }) => ok({ agent: mutate(() => agents.updateAgent(S(), params.id, body)) }));
  on('DELETE', '/api/agents/:id', ({ params }) => mutate(() => { agents.deleteAgent(S(), params.id); return ok(); }));
  on('POST', '/api/agents/:id/run', async ({ params, body }) => { assert(body.task, 'Give the agent a task.'); return ok({ text: await runner.runAgent(store, params.id, String(body.task)) }); });

  // Station
  on('POST', '/api/rooms', ({ body }) => ok({ room: mutate(() => station.createRoom(S(), body)) }));
  on('PATCH', '/api/rooms/:id', ({ params, body }) => ok({ room: mutate(() => station.updateRoom(S(), params.id, body)) }));
  on('DELETE', '/api/rooms/:id', ({ params }) => mutate(() => { station.deleteRoom(S(), params.id); return ok(); }));
  on('POST', '/api/desks', ({ body }) => ok({ desk: mutate(() => station.createDesk(S(), body)) }));
  on('PATCH', '/api/desks/:id', ({ params, body }) => ok({ desk: mutate(() => station.updateDesk(S(), params.id, body)) }));
  on('DELETE', '/api/desks/:id', ({ params }) => mutate(() => { station.deleteDesk(S(), params.id); return ok(); }));
  on('POST', '/api/hallways', ({ body }) => ok({ hallway: mutate(() => station.createHallway(S(), body)) }));
  on('DELETE', '/api/hallways/:id', ({ params }) => mutate(() => { station.deleteHallway(S(), params.id); return ok(); }));
  on('POST', '/api/connectors', ({ body }) => ok({ connector: mutate(() => station.createConnector(S(), body)) }));
  on('DELETE', '/api/connectors/:id', ({ params }) => mutate(() => { station.deleteConnector(S(), params.id); return ok(); }));

  // Work, Director, approvals
  on('POST', '/api/run', async ({ body }) => { assert(body.task, 'Describe the task.'); return ok(await runner.dispatch(store, { start: body.from || 'inbox', task: String(body.task) })); });
  on('POST', '/api/director/message', async ({ body }) => { assert(body.text, 'Say something to the Director.'); return ok(await director.handleMessage(store, String(body.text).slice(0, 4000))); });
  on('POST', '/api/approvals/:id/approve', async ({ params }) => ok({ approval: await guardrails.resolveApproval(store, params.id, true) }));
  on('POST', '/api/approvals/:id/reject', async ({ params }) => ok({ approval: await guardrails.resolveApproval(store, params.id, false) }));

  // Money
  on('POST', '/api/ledger/claim', ({ body }) => ok({ entry: ledger.claim(store, body) })); // unverified by construction
  on('POST', '/api/ingest/:connector', ({ params, raw, headers }) => ok({ entry: ledger.ingest(store, params.connector, raw, headers['x-sovereign-signature']) }));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(FRONTEND, p));
  if (!file.startsWith(FRONTEND) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function createServer(store) {
  build(store);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // Block drive-by requests from other websites to this local, money-spending server.
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !url.pathname.startsWith('/api/ingest/')) { res.writeHead(403); return res.end('Forbidden origin'); }
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      const off = store.subscribe((ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`));
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
      let body = {}; if (raw && !url.pathname.startsWith('/api/ingest/')) { try { body = JSON.parse(raw); } catch (_) { throw new HttpError(400, 'Body must be JSON.'); } }
      const out = await route.r.fn({ params: route.m.groups || {}, body, raw, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    } catch (e) {
      const status = e.status || 500; if (status === 500) console.error(e);
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function start(opts = {}) {
  const store = opts.store || new Store({ persist: opts.persist });
  director.ensureDirector(store);
  const server = createServer(store);
  return new Promise((resolve) => server.listen(opts.port ?? PORT, HOST, () => resolve({ server, store, port: server.address().port })));
}

if (require.main === module) {
  start().then(({ port }) => console.log(`Sovereign is running → http://localhost:${port}`));
}
module.exports = { start, publicState };
