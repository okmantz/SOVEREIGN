'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { fresh, until, scriptProvider } = require('./helpers');
const journey = require('../sidecar/lib/journey');
const planner = require('../sidecar/lib/planner');
const memory = require('../sidecar/lib/memory');
const strategy = require('../sidecar/lib/strategy');
const orchestrator = require('../sidecar/lib/orchestrator');
const sop = require('../sidecar/lib/sop');
const sites = require('../sidecar/lib/sites');
const jobs = require('../sidecar/lib/jobs');
const ledger = require('../sidecar/lib/ledger');
const activity = require('../sidecar/lib/activity');
const agents = require('../sidecar/lib/agents');

const GOAL = { name: 'Land 5 clients for my lead generation agency', targetCents: 500000, capitalCents: 5000, riskCents: 5000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function running(view, goal = GOAL, online = true) {
  if (online) view.state.settings.provider.name = 'openrouter';
  await journey.setGoal(view, goal).done; await journey.approveMilestones(view); journey.approveRoadmap(view); journey.completeSetup(view);
}

test('the owner\'s inputs become hard constraints in every agent prompt, and a $50 budget never allows a $100 item', () => {
  const { view } = fresh(); view.state.mission = { name: 'Sell planners', targetCents: 100000, capitalCents: 5000, riskCents: 3000, notes: 'No paid ads.' };
  const c = memory.constraints(view.state);
  assert.match(c, /Starting capital: \$50\.00/); assert.match(c, /Loss limit: \$30\.00/); assert.match(c, /Owner rule: No paid ads/); assert.match(c, /FREE-FIRST/); assert.match(c, /Never propose an item priced above it/);
  const plan = memory.cleanSpendPlan([{ item: 'Domain', costCents: 1200 }, { item: 'Ads', costCents: 10000 }, { item: 'Tool', costCents: 2000 }], 5000);
  assert.deepStrictEqual(plan.items.map((i) => i.item), ['Domain', 'Tool']); assert.ok(plan.totalCents <= 5000); // the $100 item is dropped in code
  view.state.mission.capitalCents = 0; assert.match(memory.constraints(view.state), /must cost \$0/);
});

test('ad settings and ad tasks are clamped to the owner\'s capital', () => {
  const ad = { role: 'ad_manager', settings: jobs.defaultSettings('ad_manager') }; // saved: $10 a day, $50 stop-loss
  const small = jobs.systemFor(ad, { capitalCents: 5000, riskCents: 5000 });
  assert.match(small, /Daily budget \(USD\): 3 \(capped/); assert.match(small, /Stop-loss per test \(USD\): 25 \(capped/);
  assert.match(jobs.systemFor(ad, { capitalCents: 1500, riskCents: 0 }), /too small for paid ads/);
  const rm = { milestones: [{ tasks: [{ role: 'ad_manager', task: 'ad_test_plan', title: 'Plan a small paid test', instructions: '', requires: [], optional: [] }, { role: 'social_manager', task: 'post_batch', title: 'Draft posts', requires: [], optional: [] }] }] };
  planner.budgetFit(rm, { capitalCents: 2000 });
  assert.ok(rm.milestones[0].tasks.every((t) => t.role !== 'ad_manager'), 'no paid ads on $20'); assert.strictEqual(rm.milestones[0].tasks.length, 1, 'duplicate swapped task removed');
  const rm2 = { milestones: [{ tasks: [{ role: 'ad_manager', task: 'ad_test_plan', title: 't', instructions: '', requires: [], optional: [] }] }] };
  planner.budgetFit(rm2, { capitalCents: 20000 }); assert.match(rm2.milestones[0].tasks[0].instructions, /at most \$100/);
});

test('team memory carries handoffs and decisions between agents, and stays bounded', () => {
  const { view } = fresh(); const w = view.state;
  const x = memory.extract('HANDOFF: Chose dental clinics, $19 offer\nDECISION: Niche is dental clinics\nDECISION: Price is $19\n\nBody text');
  assert.strictEqual(x.handoff, 'Chose dental clinics, $19 offer'); assert.deepStrictEqual(x.decisions, ['Niche is dental clinics', 'Price is $19']); assert.strictEqual(x.clean, 'Body text');
  memory.record(w, { refId: 't1', agentName: 'Scout', role: 'researcher', title: 'Niche scan', text: 'HANDOFF: Chose dental clinics\nDECISION: Niche is dental clinics\nlong report' });
  memory.record(w, { refId: 't1', agentName: 'Scout', role: 'researcher', title: 'Niche scan', text: 'HANDOFF: Chose vets instead\nreport' }); // same task again: replaced, not duplicated
  assert.strictEqual(w.memory.handoffs.length, 1);
  const b = memory.block(w); assert.match(b, /TEAM MEMORY/); assert.match(b, /Niche is dental clinics/); assert.match(b, /Scout \(Market Researcher\)/); assert.match(b, /Chose vets instead/);
  for (let i = 0; i < 60; i++) memory.record(w, { refId: 'r' + i, agentName: 'A', role: 'copywriter', title: 't' + i, text: 'HANDOFF: ' + 'x'.repeat(280) });
  assert.ok(w.memory.handoffs.length <= 40); assert.ok(memory.block(w).length < 3200, 'memory block never blows up the prompt');
});

test('the capital ladder: staged targets, a small first budget, and code (not the model) decides when to move up', () => {
  const { view } = fresh(); const w = view.state; w.mission = { name: 'g', targetCents: 500000, capitalCents: 5000, riskCents: 5000 };
  const s = strategy.draft(w, { pathLabel: 'Outreach', path: 'outreach' });
  assert.ok(s.stages.length >= 2 && s.stages.length <= 4); assert.strictEqual(s.stages.at(-1).targetCents, 500000);
  assert.ok(s.stages.every((x, i) => i === 0 || x.targetCents > s.stages[i - 1].targetCents)); assert.strictEqual(s.stages[0].budgetCents, 5000);
  const greedy = strategy.validate({ stages: [{ title: 'Big bet', thesis: 't', startBudgetCents: 900000 }, { title: 'Scale', thesis: 't' }] }, w, s, ['outreach']);
  assert.ok(greedy.stages[0].budgetCents <= 5000, 'a model cannot grant itself more than the capital'); assert.strictEqual(greedy.stages.at(-1).targetCents, 500000);
  assert.strictEqual(strategy.validate('garbage', w, s), s);
  w.strategy = s;
  assert.strictEqual(strategy.decision(w).action, 'iterate'); // no verified profit yet
  ledger.add(view, { type: 'revenue', amountCents: s.stages[0].targetCents + 100, source: 'stripe', ref: 'a' });
  assert.strictEqual(strategy.decision(w).action, 'advance');
  assert.ok(strategy.stageBudgetCents(w, s.stages[1]) > 0 && strategy.stageBudgetCents(w, s.stages[1]) <= memory.available(w), 'reinvestment comes from verified profit');
  ledger.add(view, { type: 'revenue', amountCents: 600000, source: 'stripe', ref: 'b' }); strategy.advance(w); strategy.advance(w); strategy.advance(w);
  assert.strictEqual(strategy.decision(w).action, 'goal');
});

test('independent tasks are eligible together; reviews and reports wait; the critic does not hold up producers', () => {
  const T = (role, task, status = 'todo') => ({ id: role + task, role, task, title: task, status, owner: 'agent', requires: [], optional: [], deliver: [] });
  const rm = { milestones: [{ id: 1, tasks: [T('researcher', 'market_scan'), T('researcher', 'validate_offer'), T('critic', 'review_plan')] }, { id: 2, tasks: [T('lead_generator', 'build_lead_list'), T('copywriter', 'email_copy'), T('email_marketer', 'write_sequence')] }] };
  assert.deepStrictEqual(orchestrator.eligible(rm).map((x) => x.t.id), ['researchermarket_scan'], 'nothing starts before the niche is researched, and one specialist works in order');
  rm.milestones[0].tasks[0].status = 'running';
  assert.deepStrictEqual(orchestrator.eligible(rm).map((x) => x.t.id), [], 'while the first task runs, the rest wait');
  rm.milestones[0].tasks[0].status = 'done';
  assert.deepStrictEqual(orchestrator.eligible(rm).map((x) => x.t.id), ['researchervalidate_offer'], 'the same specialist goes in order');
  rm.milestones[0].tasks[1].status = 'done';
  const ready = orchestrator.eligible(rm).map((x) => x.t.id).sort();
  assert.deepStrictEqual(ready, ['copywriteremail_copy', 'criticreview_plan', 'email_marketerwrite_sequence', 'lead_generatorbuild_lead_list'], 'once the niche is decided, four agents can start at once');
  rm.milestones[0].tasks[2].status = 'running'; // the critic is still reviewing
  const during = orchestrator.eligible(rm).map((x) => x.t.id);
  assert.ok(during.includes('lead_generatorbuild_lead_list') && during.includes('copywriteremail_copy'), 'producers do not wait for the critic');
  const rm2 = { milestones: [{ id: 1, tasks: [T('researcher', 'market_scan', 'running'), { ...T('finance', 'ledger_review'), id: 'fin' }] }] };
  assert.deepStrictEqual(orchestrator.eligible(rm2).map((x) => x.t.id), [], 'a report waits for the work before it');
  assert.ok(orchestrator.isConsumer({ role: 'builder', task: 'store_site', owner: 'agent' }), 'the storefront waits for products and copy');
});

test('the autopilot runs agents at the same time and every prompt carries the owner constraints and team memory', async () => {
  const { view } = fresh(); const prompts = []; let inflight = 0, peak = 0;
  const restore = scriptProvider(async (a) => { inflight++; peak = Math.max(peak, inflight); await sleep(60); inflight--; if (a.json) return '{}'; prompts.push(a.system); return 'HANDOFF: picked the dental niche\nDECISION: Niche is dental clinics\nfinished work'; });
  try { await running(view); await until(() => view.state.roadmap.milestones[0].status === 'done' && view.state.roadmap.milestones[1].status === 'done', 8000); } finally { restore(); }
  assert.ok(peak >= 3, 'several agents were working at once, peak ' + peak);
  assert.ok(prompts.length > 6 && prompts.every((p) => /OWNER CONSTRAINTS/.test(p) && /Starting capital: \$50\.00/.test(p)), 'every prompt carries the constraints');
  assert.ok(prompts.some((p) => /Niche is dental clinics/.test(p)), 'later agents read what earlier agents decided');
  assert.ok(view.state.roadmap.extras.length > 0, 'the Director gave idle agents extra work');
});

test('the SOP is filed in the Outbox at once and lists the plan, the team, the limits and the route', async () => {
  const { view } = fresh(); const events = []; view.subscribe((ev) => events.push(ev));
  await running(view, GOAL, false);
  const o = view.state.outbox.find((x) => x.kind === 'sop'); assert.ok(o, 'SOP is in the Outbox');
  for (const need of ['# Business SOP', 'Mission and limits', 'capital ladder', 'Team and ownership', 'How work moves', 'Milestones and procedures', 'Kill and scale rules', '$50.00', 'Done when:']) assert.ok(o.content.includes(need), need);
  const ev = events.find((e) => e.type === 'sop.route'); assert.ok(ev, 'the UI is told to fly it through the rooms');
  const r = ev.data.route.map((s) => s.ref); assert.strictEqual(r.at(-1), 'outbox'); assert.ok(r.includes('inbox') && r.filter((x) => x.startsWith('room:')).length >= 3, 'passes through several rooms');
});

test('sites: files are extracted safely, saved, previewed under a sandbox, and buy links must be https', async () => {
  const { view } = fresh();
  const reply = 'HANDOFF: x\nFILE: index.html\n```html\n<h1>Shop</h1>\n```\n```json file:products.json\n{"products":[{"id":"p1","name":"Planner","price":9}]}\n```\nFILE: ../evil.html\n```html\nx\n```\nFILE: run.exe\n```\nx\n```';
  assert.deepStrictEqual(sites.ingest(view, reply), ['index.html', 'products.json'], 'traversal and unknown types are refused');
  assert.strictEqual(sites.read(view, 'index.html'), '<h1>Shop</h1>'); assert.strictEqual(sites.read(view, '../evil.html'), null);
  assert.deepStrictEqual(sites.products(view), [{ id: 'p1', name: 'Planner', price: '9' }]);
  assert.throws(() => sites.setLinks(view, { p1: 'javascript:alert(1)' }), /https/); assert.throws(() => sites.setLinks(view, { p1: 'http://x.co' }), /https/);
  sites.setLinks(view, { p1: 'https://buy.example.com/p1' }); assert.deepStrictEqual(sites.links(view), { p1: 'https://buy.example.com/p1' });
  assert.match(sites.read(view, 'config.js'), /window\.STORE_LINKS/);
  assert.match(sites.context(view), /products\.json/); assert.ok(sites.view(view).files.includes('index.html'));
  const { start } = require('../sidecar/index'); const { server, port, root } = await start({ persist: false, port: 0, autopilot: false });
  try {
    const wid = root.defaultId; require('../sidecar/lib/sites').ingest(root.forWorld(wid), 'FILE: index.html\n```html\n<p>hi</p>\n```');
    const r = await fetch(`http://127.0.0.1:${port}/sites/${wid}/`); assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /sandbox/); assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/sites/${wid}/nope.html`)).status, 404);
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/sites/${wid}/`, { method: 'POST' })).status, 404, 'read-only');
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { origin: 'null' } })).status, 403, 'a sandboxed page cannot call the API');
  } finally { server.close(); }
});

test('the builder\'s files land in the site folder when a task finishes, and the store plan builds a free storefront', async () => {
  const p = planner.template('Sell planners on my own store', { kind: 'general' });
  const tasks = p.milestones.flatMap((m) => m.tasks); assert.ok(tasks.some((t) => t.task === 'store_site' && t.role === 'builder')); assert.ok(tasks.some((t) => t.task === 'import_products'));
  assert.ok(jobs.spec('builder').tasks.some((t) => t.id === 'store_site' && /STORE_LINKS/.test(t.prompt) && /FILE:/.test(t.prompt)));
  const { view } = fresh(); const b = agents.createAgent(view.state, { name: 'Forge', role: 'builder' }); const runner = require('../sidecar/lib/runner');
  const restore = scriptProvider(async () => 'HANDOFF: built it\nFILE: index.html\n```html\n<h1>Built</h1>\n```');
  try { const r = await runner.assign(view, { agentId: b.id, taskId: 'store_site', title: 't' }); assert.ok(view.state.outbox.find((o) => o.id === r.outboxId).meta.files.includes('index.html')); } finally { restore(); }
  assert.strictEqual(sites.read(view, 'index.html'), '<h1>Built</h1>');
});

test('the team never stops on its own: it plans round after round, and stops only when verified profit reaches the target', async () => {
  const { view } = fresh(); const w = () => view.state; w().settings.waitMinutes = 0; let rounds = 0;
  const restore = scriptProvider(async (a) => { await sleep(15); return a.json ? '{}' : 'HANDOFF: did it\nDECISION: keep going\nwork'; });
  try {
    await running(view); // the outreach plan is blocked on email, so a lesser autopilot would wait forever
    await until(() => (w().cycles || []).length >= 2 && w().roadmap && w().roadmap.status === 'running', 15000);
    assert.ok(w().journey.cycle >= 2, 'planned new rounds by itself'); assert.ok(w().outbox.filter((o) => o.kind === 'sop').length >= 2, 'a fresh SOP for each new round');
    assert.ok((w().carry || []).some((c) => c.kind === 'blocked' && c.connect === 'email'), 'the blocked email step moved to the owner\'s list instead of stopping the team');
    assert.ok(journey.view(w()).needsYou.some((n) => n.carry && n.connect === 'email'), 'and it stays visible under Needs you');
    ledger.add(view, { type: 'revenue', amountCents: 600000, source: 'stripe', ref: 'win' }); journey.kick(view);
    await until(() => w().roadmap.status === 'achieved', 8000); assert.strictEqual(journey.view(w()).achieved, true);
    const calls = []; const r2 = scriptProvider(async () => { calls.push(1); return '{}'; }); await sleep(300); r2(); assert.strictEqual(calls.length, 0, 'nothing runs once the goal is reached');
  } finally { restore(); }
});

test('a carried step runs on its own the moment the owner connects it; the offline model stops instead of spinning', async () => {
  const { view } = fresh(); const w = () => view.state; w().settings.waitMinutes = 0;
  const restore = scriptProvider(async (a) => (a.json ? '{}' : 'HANDOFF: ok\nwork'));
  try {
    await running(view); await until(() => (w().carry || []).length > 0, 10000);
    const c = Object.values(w().connectors).find((x) => x.kind === 'email'); c.status = 'ready'; c.config = { from: 'a@b.co', fromName: 'A', dailyLimit: 20, footer: 'x', optOutLine: 'x', address: 'x' };
    require('../sidecar/lib/secrets').set(`conn:${c.id}:apiKey`, 'k'.repeat(12)); const integ = require('../sidecar/lib/integrations'), orig = integ.missing; integ.missing = () => [];
    try { journey.kick(view); await until(() => !(w().carry || []).some((x) => x.connect === 'email') && (w().roadmap.extras || []).some((x) => x.carried), 8000); } finally { integ.missing = orig; }
  } finally { restore(); }
  const off = fresh().view; await running(off, GOAL, false); await until(() => off.state.roadmap.status === 'done' || off.state.roadmap.milestones.some((m) => m.tasks.some((t) => t.status === 'blocked')), 5000);
  await sleep(200); assert.ok(off.state.roadmap.status !== 'cycling' && (off.state.journey.cycle || 0) === 0, 'the offline demo model never loops');
});

test('model outages and budget limits pause the plan and it resumes on its own; an owner pause does not', async () => {
  const { root, view } = fresh(); const w = () => view.state;
  const restore = scriptProvider(async () => { const e = new Error('Could not reach Ollama'); e.status = 502; throw e; });
  try { await running(view); await until(() => w().roadmap.paused); } finally { restore(); }
  assert.strictEqual(w().roadmap.pauseKind, 'model'); assert.ok(w().roadmap.resumeAt > Date.now());
  journey.tickAll(root); assert.strictEqual(w().roadmap.paused, true, 'not before the retry time');
  w().roadmap.resumeAt = Date.now() - 1; const ok = scriptProvider(async (a) => (a.json ? '{}' : 'HANDOFF: ok\nwork'));
  try { journey.tickAll(root); assert.strictEqual(w().roadmap.paused, false, 'resumed by itself'); await until(() => journey.view(w()).progress.done >= 2); } finally { ok(); }
  journey.pause(view); w().roadmap.resumeAt = Date.now() - 1; journey.tickAll(root); assert.strictEqual(w().roadmap.paused, true, 'a pause by the owner is respected');
});

test('activity tracking reports who is working and on what, and cleans up after failures', async () => {
  const { view } = fresh(); const d = Object.values(view.state.agents)[0], seen = [];
  view.subscribe((e) => { if (e.type === 'run.start' || e.type === 'run.done') seen.push(e.type); });
  await assert.rejects(activity.track(view, d.id, 'Doing a thing', async () => { assert.deepStrictEqual(activity.list(view).map((x) => x.title), ['Doing a thing']); throw new Error('boom'); }), /boom/);
  assert.deepStrictEqual(activity.list(view), []); assert.deepStrictEqual(seen, ['run.start', 'run.done']);
  await Promise.all([activity.track(view, d.id, 'a', () => sleep(20)), activity.track(view, d.id, 'b', () => sleep(40))]); assert.deepStrictEqual(activity.list(view), [], 'overlapping work on one agent still ends cleanly');
});

// ---- streaming providers
async function fakeApi(handler) {
  const seen = []; const srv = http.createServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c; const body = JSON.parse(raw || '{}'); seen.push(body); handler(body, res, seen.length); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return { srv, seen, base: `http://127.0.0.1:${srv.address().port}/v1` };
}
const sse = (res, parts, usage) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const p of parts) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n'); if (usage) res.write('data: ' + JSON.stringify({ choices: [], usage }) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); };

test('cloud providers stream tokens, fall back when a server rejects streaming, and retry rate limits', async () => {
  const openai = require('../sidecar/lib/providers/openai'); const state = (base) => ({ settings: { openaiCompat: { baseUrl: base } } });
  let api = await fakeApi((b, res) => sse(res, ['Hel', 'lo ', 'there'], { prompt_tokens: 7, completion_tokens: 3 }));
  try { const seen = []; const r = await openai.complete({ state: state(api.base), model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, onToken: (t) => seen.push(t) });
    assert.strictEqual(r.text, 'Hello there'); assert.deepStrictEqual(seen, ['Hel', 'Hello ', 'Hello there']); assert.strictEqual(r.tokensIn, 7); assert.strictEqual(api.seen[0].stream, true); } finally { api.srv.close(); }
  api = await fakeApi((b, res) => { if (b.stream_options) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"unknown parameter"}}'); } sse(res, ['ok']); });
  try { const r = await openai.complete({ state: state(api.base), model: 'm', system: 's', messages: [{ role: 'user', content: 'x' }] }); assert.strictEqual(r.text, 'ok'); assert.strictEqual(api.seen.length, 2, 'retried without the streaming option'); } finally { api.srv.close(); }
  api = await fakeApi((b, res) => { if (!b.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: 'plain' } }] })); } res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"no streaming here"}'); });
  try { assert.strictEqual((await openai.complete({ state: state(api.base), model: 'm', system: 's', messages: [] })).text, 'plain', 'falls all the way back to a plain request'); } finally { api.srv.close(); }
  api = await fakeApi((b, res, n) => { if (n < 3) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"slow down"}}'); } sse(res, ['finally']); });
  try { assert.strictEqual((await openai.complete({ state: state(api.base), model: 'm', system: 's', messages: [] })).text, 'finally'); assert.strictEqual(api.seen.length, 3, 'two rate limits, then success'); } finally { api.srv.close(); }
  api = await fakeApi((b, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad key"}}'); });
  try { await assert.rejects(openai.complete({ state: state(api.base), model: 'm', system: 's', messages: [] }), /bad key/); assert.strictEqual(api.seen.length, 1, 'a real error is not retried'); } finally { api.srv.close(); }
});
