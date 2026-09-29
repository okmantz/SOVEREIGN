'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fresh, until } = require('./helpers');
const journey = require('../sidecar/lib/journey');
const director = require('../sidecar/lib/director');
const guardrails = require('../sidecar/lib/guardrails');
const ledger = require('../sidecar/lib/ledger');
const sites = require('../sidecar/lib/sites');
const runner = require('../sidecar/lib/runner');
const jobs = require('../sidecar/lib/jobs');
const { ROLES } = require('../sidecar/lib/roles');
const playbooks = require('../sidecar/lib/company/playbooks');
const bridge = require('../sidecar/lib/company/bridge');
const { mk } = require('./company.helpers');

const GOAL = { name: 'Sell a done-for-you invoice follow-up service to small dental clinics', targetCents: 100000, capitalCents: 20000, riskCents: 10000 };

// Drive a world from the goal to a running team with the offline model.
async function running(goal = GOAL) {
  const { root, view } = fresh(); const w = () => view.state;
  await journey.setGoal(view, goal).done; await journey.approveMilestones(view); journey.approveRoadmap(view);
  journey.completeSetup(view); return { root, view, w };
}
const agentOf = (w, role) => Object.values(w.agents).find((a) => a.role === role);

test('every agent role has a job, a full job description, and a tool list that really exists', () => {
  const { co } = mk(); const bridged = bridge.companyFor(fresh().root); const real = new Set(bridged.tools.list().map((t) => t.name));
  for (const role of Object.keys(ROLES)) {
    const pb = playbooks.PLAYBOOKS[role]; assert.ok(pb, `${role} has a playbook`);
    for (const f of ['identity', 'reportsTo', 'owns', 'never', 'escalate', 'procedure', 'done']) assert.ok(pb[f] && pb[f].length, `${role}.${f}`);
    assert.ok(jobs.spec(role).summary, `${role} has a job`);
    if (role !== 'custom') assert.ok(jobs.spec(role).tasks.length || role === 'director', `${role} has tasks`);
    for (const t of pb.tools) assert.ok(real.has(t), `${role} lists tool ${t}, which must be registered`);
    const prompt = jobs.systemFor({ role, settings: jobs.defaultSettings(role) }, null);
    assert.match(prompt, /ROLE:/); assert.match(prompt, /You never:/); assert.match(prompt, /Stop and escalate when:/);
    assert.ok(jobs.systemFor({ role, settings: jobs.defaultSettings(role) }, null, { local: true }).length < prompt.length + 1, 'the local-model prompt is not longer');
  }
  assert.ok(co);
});

test('free-only by default: anything that costs money is refused until the owner turns paid on', async () => {
  const { co } = mk(); const v = co.ventures.create({ name: 'V', type: 'saas', capital_allocated: 100 }); co.cfo.fund(v.venture_id, 100);
  co.tools.register({ name: 't.paid', description: 'x', required_permission: 3, cost: 5, handler: async () => ({ ok: 1 }) });
  const r = await co.tools.invoke('t.paid', {}, { agent_id: 'a', venture_id: v.venture_id, approved: true });
  assert.equal(r.status, 'denied'); assert.match(r.reason, /free-only/);
  const img = await co.tools.invoke('image.generate', { prompt: 'x' }, { agent_id: 'a', venture_id: v.venture_id, approved: true }); assert.equal(img.status, 'denied');
  co.setSettings({ allow_paid: true });
  assert.equal((await co.tools.invoke('t.paid', {}, { agent_id: 'a', venture_id: v.venture_id, approved: true })).status, 'done');
  const fresh2 = require('../sidecar/lib/company').createCompany({ dataDir: require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'sov-')) });
  assert.equal(fresh2.settings().sandbox.mode, 'auto', 'the sandbox uses Docker only if it is there, and never requires it'); assert.equal(fresh2.settings().allow_paid, false);
});

test('the goal comes first: the plan starts with the CFO budget and CEO strategy and ends with the CEO review, and the boardroom is built', async () => {
  const { w } = await running();
  const rm = w().roadmap, all = rm.milestones.flatMap((m) => m.tasks);
  const first = rm.milestones[0].tasks.map((t) => t.role + ':' + t.task);
  assert.ok(first.includes('cfo:budget_plan') && first.includes('ceo:business_strategy'), 'CFO and CEO decide before anything is built');
  assert.ok(first.indexOf('ceo:business_strategy') > first.indexOf('researcher:market_scan'), 'the CEO decides after the research, not before it');
  const last = rm.milestones[rm.milestones.length - 1].tasks.map((t) => t.role + ':' + t.task);
  assert.ok(last.includes('ceo:weekly_review'), 'the CEO closes every round with a scale / hold / pivot / kill call');
  assert.ok(all.some((t) => t.role === 'account_manager'), 'an agency plan carries the account manager from its recipe');
  const ceo = agentOf(w(), 'ceo'), cfo = agentOf(w(), 'cfo'); assert.ok(ceo && cfo, 'CEO and CFO exist');
  const room = (a) => w().rooms[w().desks[a.deskId].roomId];
  assert.equal(room(ceo).kind, 'boardroom'); assert.equal(room(cfo).kind, 'boardroom');
  assert.equal(Object.values(w().agents).filter((a) => a.role === 'ceo').length, 1);
  assert.throws(() => require('../sidecar/lib/agents').createAgent(w(), { name: 'Second', role: 'ceo' }), /only one CEO/);
});

test('the CEO consumer task waits for the research; the CFO budget runs alongside it', async () => {
  const { w } = await running(); const orch = require('../sidecar/lib/orchestrator');
  const ready = orch.eligible(w().roadmap).map((x) => x.t.role + ':' + x.t.task);
  assert.ok(!ready.includes('ceo:business_strategy'), 'not ready until research and critique are done');
});

test('the goal becomes a venture the CEO owns, linked to its world, with the loss limit as a kill condition', async () => {
  const { root, view } = await running(); const co = bridge.companyFor(root);
  const v = bridge.ventureOf(co, view.id); assert.ok(v, 'venture exists'); assert.equal(v.strategy.world_id, view.id);
  assert.equal(v.capital_allocated, 200); assert.equal(v.kill_conditions.max_loss, 100); assert.equal(v.status, 'RESEARCH');
  assert.equal(co.db.get('portfolio', {}).total_capital, 200, 'the CFO holds the owner\'s capital');
  const txt = bridge.briefing(view); assert.match(txt, /COMPANY BRIEFING/); assert.match(txt, /Kill conditions: loss over \$100/); assert.match(txt, /verified only/);
});

test('one truth for money: verified Sovereign entries reach the CFO, company Stripe revenue reaches the goal bar, agents can only claim', async () => {
  const { root, view, w } = await running(); const co = bridge.companyFor(root), v = bridge.ventureOf(co, view.id);
  ledger.add(view, { type: 'revenue', amountCents: 5000, source: 'stripe', ref: 'ch_1' });
  ledger.claim(view, { type: 'revenue', amountCents: 999900, note: 'trust me' });
  bridge.syncLedger(view);
  assert.equal(co.ledger.summary({ venture_id: v.venture_id }).net_revenue, 50, 'only the verified $50 arrived');
  bridge.syncLedger(view); assert.equal(co.ledger.summary({ venture_id: v.venture_id }).net_revenue, 50, 'idempotent');
  co.ledger.record({ venture_id: v.venture_id, category: 'revenue', amount: 49, source: 'stripe', ref: 'evt_9' });   // a Stripe checkout the company layer received
  co.ledger.record({ venture_id: v.venture_id, category: 'revenue', amount: 5000, source: 'agent_claim' });          // an unverified claim
  bridge.syncLedger(view); bridge.syncLedger(view);
  const p = ledger.progress(w()); assert.equal(p.revenueCents, 5000 + 4900, 'the $49 checkout is now on the goal bar exactly once');
  assert.equal(p.claimedCents, 999900, 'claims stay claims');
  assert.equal(co.ledger.summary({ venture_id: v.venture_id }).net_revenue, 99);
});

test('agents call only the tools their role allows, and cannot mark a sale or write revenue', async () => {
  const { root, view, w } = await running(); const co = bridge.companyFor(root), v = bridge.ventureOf(co, view.id);
  const lead = agentOf(w(), 'lead_generator'), res = agentOf(w(), 'researcher'), copy = agentOf(w(), 'copywriter');
  const block = (o) => 'Here is the list.\n```tool\n' + JSON.stringify(o) + '\n```';
  let r = await bridge.runAgentTools(view, lead, block({ tool: 'crm.prospect.add', input: { name: 'Dr Lee', company: 'Lee Dental', contact: 'lee@leedental.example', source: 'agent', problem: 'late invoices' } }));
  assert.match(r.text, /crm\.prospect\.add: done/); assert.equal(co.crm.prospects(v.venture_id).length, 1); assert.ok(!r.text.includes('```tool'));
  const pid = co.crm.prospects(v.venture_id)[0].id;
  r = await bridge.runAgentTools(view, res, block({ tool: 'deploy.ship', input: {} })); assert.match(r.text, /refused.*researcher role/);
  r = await bridge.runAgentTools(view, copy, block({ tool: 'crm.prospect.update', input: { prospect_id: pid, status: 'contacted' } })); assert.match(r.text, /refused/);
  r = await bridge.runAgentTools(view, agentOf(w(), 'email_marketer'), block({ tool: 'crm.prospect.update', input: { prospect_id: pid, status: 'won' } })); assert.match(r.text, /error/);
  assert.notEqual(co.crm.prospects(v.venture_id)[0].status, 'won', 'only a verified payment can win a customer');
  r = await bridge.runAgentTools(view, agentOf(w(), 'email_marketer'), block({ tool: 'crm.prospect.update', input: { prospect_id: pid, status: 'contacted', note: 'sent' } })); assert.match(r.text, /done/);
  r = await bridge.runAgentTools(view, agentOf(w(), 'cfo'), block({ tool: 'spend.request', input: { amount: 20, purpose: 'ads' } })); assert.match(r.text, /free-only/);
  r = await bridge.runAgentTools(view, lead, 'no tools here'); assert.equal(r.text, 'no tools here');
});

test('publishing a site is an approval in Sovereign, and approving it exports the ZIP with no key and no cost', async () => {
  const { root, view, w } = await running({ name: 'Launch a small SaaS app that sends invoice reminders to clinics', targetCents: 100000, capitalCents: 20000, riskCents: 10000 }); const co = bridge.companyFor(root);
  sites.ingest(view, 'FILE: index.html\n```html\n<!doctype html><h1>Dental invoices</h1>\n```');
  assert.ok(agentOf(w(), 'devops') && agentOf(w(), 'builder') && agentOf(w(), 'product_manager'), 'a product plan carries DevOps, the Builder and the Product Manager');
  const r = await bridge.runAgentTools(view, agentOf(w(), 'builder'), '```tool\n{"tool":"site.publish","input":{"target":"bundle"}}\n```');
  assert.match(r.text, /pending_approval|waiting for your approval/);
  const appr = w().approvals.find((a) => a.kind === 'company.approval'); assert.ok(appr, 'the approval is in the same list as every other approval');
  const out = await guardrails.resolveApproval(view, appr.id, true); assert.equal(out.status, 'approved', out.error);
  const item = w().outbox.find((o) => /site\.publish/.test(o.title)); assert.ok(item, 'the result lands in the Outbox'); assert.match(item.content, /site\.zip/);
  const fs = require('node:fs'), path = require('node:path'); const v = bridge.ventureOf(co, view.id);
  assert.ok(fs.existsSync(path.join(co.sandbox.dir(v.venture_id, 'artifacts'), 'site.zip')));
});

test('an approved tool runs exactly once', async () => {
  const { root, view } = await running(); const co = bridge.companyFor(root), v = bridge.ventureOf(co, view.id); let ran = 0;
  co.tools.register({ name: 't.once', description: 'x', required_permission: 4, handler: async () => { ran++; return { ok: 1 }; } });
  const r = await co.tools.invoke('t.once', {}, { agent_id: 'a', venture_id: v.venture_id }); assert.equal(r.status, 'pending_approval');
  const appr = view.state.approvals.find((a) => a.kind === 'company.approval' && /t\.once/.test(a.summary));
  const out = await guardrails.resolveApproval(view, appr.id, true); assert.equal(out.status, 'approved', out.error); assert.equal(ran, 1);
});

test('a rejected company approval in Sovereign is rejected in the company too', async () => {
  const { root, view } = await running(); const co = bridge.companyFor(root), v = bridge.ventureOf(co, view.id);
  co.tools.register({ name: 't.lvl4', description: 'x', required_permission: 4, handler: async () => ({}) });
  const r = await co.tools.invoke('t.lvl4', {}, { agent_id: 'a', venture_id: v.venture_id }); assert.equal(r.status, 'pending_approval');
  const appr = view.state.approvals.find((a) => a.kind === 'company.approval'); await guardrails.resolveApproval(view, appr.id, false);
  bridge.reconcileApprovals(view); assert.equal(co.permissions.getApproval(r.approval_id).status, 'rejected');
});

test('the CEO stops a dead venture: the roadmap pauses no matter how many tasks remain', async () => {
  const { root, view } = await running(); const co = bridge.companyFor(root), v = bridge.ventureOf(co, view.id);
  assert.equal(view.state.roadmap.status, 'running');
  co.ceo.killVenture(v.venture_id, 'test kill');
  assert.equal(view.state.roadmap.paused, true); assert.equal(view.state.roadmap.pauseKind, 'ceo');
  assert.ok(!['model', 'budget'].includes(view.state.roadmap.pauseKind), 'the autopilot does not silently resume a CEO stop');
});

test('the Director can open a new world for a separate business; it is linked, has its own goal, and needs approval', async () => {
  const { root, view } = fresh(); const before = Object.keys(root.data.worlds).length;
  const res = director.propose(view, [{ type: 'create_world', name: 'Invoice SaaS', kind: 'product', goal: 'Launch a tiny invoice reminder app', targetCents: 50000, capitalCents: 10000, riskCents: 5000 }]);
  assert.equal(res.applied, false); assert.ok(res.approvalId); assert.equal(Object.keys(root.data.worlds).length, before, 'nothing happens before the owner approves');
  const out = await guardrails.resolveApproval(view, res.approvalId, true); assert.equal(out.status, 'approved', out.error);
  const worlds = Object.values(root.data.worlds); assert.equal(worlds.length, before + 1);
  const nw = worlds.find((x) => x.name === 'Invoice SaaS'); assert.equal(nw.kind, 'product'); assert.ok(nw.mission && nw.mission.targetCents === 50000);
  assert.ok(Object.values(nw.connectors).some((c) => c.kind === 'portal'), 'linked back to the world that opened it');
  assert.ok(Object.values(nw.agents).some((a) => a.role === 'director'));
  await until(() => !nw.journey.busy); assert.equal(nw.journey.stage, 'milestones');
  assert.throws(() => director.propose(view, [{ type: 'create_world', name: 'X', kind: 'nonsense' }]), /Unknown world kind/);
});

test('directives from the CEO reach the right agent as normal assignments, and only while the plan is running', async () => {
  const { root, view, w } = await running(); const co = bridge.companyFor(root), v = bridge.ventureOf(co, view.id);
  co.directives.add({ venture_id: v.venture_id, role: 'Support', task: 'Retention: Acme', description: 'inactive 20 days' });
  assert.equal(bridge.assignDirective(root, co.directives.list()[0]), false, 'there is no support agent on an agency plan yet, so it stays open');
  const before = w().roadmap.paused; w().roadmap.paused = true; co.directives.add({ venture_id: v.venture_id, role: 'Developer', task: 'x', description: 'y' });
  assert.equal(bridge.assignDirective(root, co.directives.list().find((d) => d.task === 'x')), false, 'nothing is assigned while paused'); w().roadmap.paused = before;
});

test('worlds keep their own venture, and each new goal never leaks another world\'s money', async () => {
  const { root, view } = await running(); const co = bridge.companyFor(root);
  const id2 = require('../sidecar/lib/worlds').create(root, { name: 'Second', kind: 'content' }); const v2 = root.forWorld(id2);
  await journey.setGoal(v2, { name: 'Grow a newsletter about invoicing', targetCents: 20000, capitalCents: 0 }).done; await journey.approveMilestones(v2); journey.approveRoadmap(v2); journey.completeSetup(v2);
  ledger.add(view, { type: 'revenue', amountCents: 7700, source: 'stripe', ref: 'only-w1' }); bridge.syncLedger(view); bridge.syncLedger(v2);
  const a = bridge.ventureOf(co, view.id), b = bridge.ventureOf(co, v2.id); assert.notEqual(a.venture_id, b.venture_id);
  assert.equal(co.ledger.summary({ venture_id: a.venture_id }).net_revenue, 77); assert.equal(co.ledger.summary({ venture_id: b.venture_id }).net_revenue, 0);
});

test('nothing in the company layer runs when it is switched off', async () => {
  const { root, view } = fresh(); root.data.settings.company.enabled = false;
  assert.equal(bridge.ensureVenture(view), null); await bridge.tick(root);
});

test('a recipe launches a whole company: world of the right kind, goal, venture with the recipe\'s kill rules, and a plan with the CEO and CFO', async () => {
  const { root, view } = fresh(); const list = bridge.recipes();
  assert.deepEqual(list.map((r) => r.id).sort(), ['agency', 'content', 'digital_product', 'ecommerce', 'saas']);
  for (const r of list) for (const role of r.roles) assert.ok(ROLES[role.id] && playbooks.PLAYBOOKS[role.id], `${r.id}: ${role.id} is a real role with a playbook`);
  assert.throws(() => bridge.launchRecipe(view, { recipe: 'nope', goal: 'x y z w' }), /Unknown recipe/); assert.throws(() => bridge.launchRecipe(view, { recipe: 'saas', goal: '' }), /Describe the goal/);
  const { worldId } = bridge.launchRecipe(view, { recipe: 'saas', goal: 'Launch a tiny invoice reminder app for dental clinics', targetCents: 100000, capitalCents: 10000, riskCents: 5000 });
  const nw = root.world(worldId), nv = root.forWorld(worldId); assert.equal(nw.kind, 'product'); assert.equal(nw.mission.capitalCents, 10000);
  await until(() => !nw.journey.busy); await journey.approveMilestones(nv); journey.approveRoadmap(nv); journey.completeSetup(nv);
  const co = bridge.companyFor(root), v = bridge.ventureOf(co, worldId);
  assert.equal(v.strategy.recipe, 'saas'); assert.equal(v.kill_conditions.max_loss, 50); assert.equal(v.kill_conditions.max_days_no_revenue, 60); assert.ok('mrr' in v.kpis);
  const roles = Object.values(nw.agents).map((a) => a.role); for (const r of ['director', 'ceo', 'cfo', 'product_manager', 'developer', 'devops']) assert.ok(roles.includes(r), r);
});

test('the public state carries the company view and the settings switches persist', async () => {
  const { start } = require('../sidecar/index'); const { Store } = require('../sidecar/lib/store');
  const root = new Store({ persist: false }); const { server, port } = await start({ store: root, port: 0, autopilot: false });
  try {
    const base = 'http://127.0.0.1:' + port, call = async (m, p, b) => (await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();
    const s = await call('GET', '/api/state'); assert.equal(s.company.freeOnly, true); assert.equal(s.company.autonomy, 'approval_only');
    await call('POST', '/api/settings', { company: { allowPaid: true, autonomy: 'permissioned', autopilot: true } });
    const s2 = await call('GET', '/api/state'); assert.equal(s2.company.freeOnly, false); assert.equal(s2.company.autonomy, 'permissioned'); assert.equal(s2.company.autopilot, true);
    assert.equal((await call('GET', '/api/launch/recipes')).recipes.length, 5);
    assert.ok((await call('GET', '/api/company/tools')).some((t) => t.name === 'crm.prospect.add'), 'company API is served by the same server');
    const bad = await fetch(base + '/api/company/settings', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }); assert.equal(bad.status, 403);
  } finally { server.close(); }
});
