'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fresh, until, scriptProvider } = require('./helpers');
const planner = require('../sidecar/lib/planner');
const journey = require('../sidecar/lib/journey');
const station = require('../sidecar/lib/station');
const integrations = require('../sidecar/lib/integrations');
const secrets = require('../sidecar/lib/secrets');

const GOAL = { name: 'Land 5 clients for my lead generation agency', targetCents: 500000, capitalCents: 50000, riskCents: 20000 };
const kinds = (rm) => planner.deriveRequirements(rm).map((r) => r.kind);
const rmFor = (goal, world = { kind: 'general' }) => { const t = planner.template(goal, world); return { milestones: t.milestones.map((m) => ({ ...m, tasks: m.tasks.map((x, i) => ({ ...x, id: m.key + i })) })) }; };

test('goals are classified into the right path', () => {
  const w = { kind: 'general' };
  assert.strictEqual(planner.classify('Make $5k/month selling digital planners on Etsy', w), 'ecommerce');
  assert.strictEqual(planner.classify('Land 5 clients for my lead generation agency', w), 'outreach');
  assert.strictEqual(planner.classify('Grow a newsletter to 5,000 subscribers', w), 'content');
  assert.strictEqual(planner.classify('Build a SaaS tool for invoicing', w), 'product');
  assert.strictEqual(planner.classify('Find a forex strategy for a prop firm', w), 'trading');
  assert.strictEqual(planner.classify('make money online', w), 'general');
  assert.strictEqual(planner.classify('make money online', { kind: 'trading' }), 'trading'); // the world's type breaks ties
});

test('only what the plan needs is required: no Etsy unless the goal is about Etsy', () => {
  assert.deepStrictEqual(kinds(rmFor('Land 5 clients for my agency')).sort(), ['email', 'stripe']);
  assert.ok(!kinds(rmFor('Land 5 clients for my agency')).includes('etsy'));
  assert.deepStrictEqual(kinds(rmFor('Sell planners on Etsy')), ['etsy']);
  assert.deepStrictEqual(kinds(rmFor('Sell planners on Shopify')), ['shopify']);
  assert.deepStrictEqual(kinds(rmFor('Find a forex strategy')), []); // trading needs no integrations at all
  const reqs = planner.deriveRequirements(rmFor('Land 5 clients for my agency'));
  assert.strictEqual(reqs.find((r) => r.kind === 'email').blocking, true);
  assert.strictEqual(reqs.find((r) => r.kind === 'stripe').blocking, false); // recommended, not forced
});

test('a model that returns garbage, or a broken plan, falls back to the standard milestones', async () => {
  const { view } = fresh(); view.state.settings.provider.name = 'openrouter'; view.state.mission = { name: GOAL.name, targetCents: 1 };
  for (const reply of ['sorry I cannot', '{"milestones":[{"title":"x"}]}', JSON.stringify({ milestones: [1, 2, 3].map((i) => ({ title: 'New thing ' + i, why: 'w', days: 3 })) })]) {
    const restore = scriptProvider(() => reply);
    try { await planner.draftMilestones(view); } finally { restore(); }
    const ms = view.state.journey.milestones;
    assert.deepStrictEqual(ms.map((m) => m.key), ['niche', 'pipeline', 'outreach', 'close'], 'standard outreach milestones: ' + reply.slice(0, 30));
  }
});

test('a valid model answer tailors milestones; kept ones inherit tasks, new ones get generic tasks', async () => {
  const { view } = fresh(); view.state.settings.provider.name = 'openrouter'; view.state.mission = { name: GOAL.name, targetCents: 1 };
  const restore = scriptProvider(() => JSON.stringify({ milestones: [
    { keep: 'niche', title: 'Pick a niche for dental clinics', why: 'Focus wins', days: 2 }, { keep: 'pipeline', title: 'Build the clinic lead list', why: 'Leads', days: 4 },
    { keep: 'outreach', title: 'Launch outreach', why: 'Reach', days: 6 }, { title: 'Record a short demo video', why: 'Shows the offer', days: 3 }] }));
  try { await planner.draftMilestones(view); } finally { restore(); }
  const ms = view.state.journey.milestones;
  assert.strictEqual(ms.length, 4); assert.strictEqual(ms[0].title, 'Pick a niche for dental clinics');
  assert.ok(ms[0].tasks.some((t) => t.task === 'market_scan')); assert.deepStrictEqual(ms[3].tasks.map((t) => t.role), ['researcher', 'ops']);
  assert.strictEqual(view.state.journey.adapted, true);
});

test('roadmap personalisation applies only valid task ids and caps lengths', async () => {
  const { view } = fresh(); view.state.settings.provider.name = 'openrouter';
  journey.setGoal(view, GOAL); await until(() => !view.state.journey.busy);
  let ids;
  const restore = scriptProvider((args) => { const m = /"tasks":(\[.*?\]),"rules"/s.exec(args.messages[0].content); ids = m ? JSON.parse(m[1]).map((t) => t.id) : []; return JSON.stringify({ summary: 'A two sentence plan.', tasks: [{ id: ids[0], instructions: 'Focus on dental clinics. ' + 'x'.repeat(900) }, { id: 'ghost', instructions: 'nope' }] }); });
  try { await journey.approveMilestones(view); } finally { restore(); }
  const rm = view.state.roadmap; const first = rm.milestones[0].tasks[0];
  assert.strictEqual(rm.summary, 'A two sentence plan.'); assert.match(first.instructions, /^Focus on dental clinics/); assert.ok(first.instructions.length <= 300);
  assert.ok(!JSON.stringify(rm).includes('nope'));
});

test('full guided journey with the offline model: goal → milestones → roadmap → setup → deploy → autopilot', async () => {
  const { root, view } = fresh(); const w = () => view.state;
  assert.strictEqual(w().journey.stage, 'goal');
  const r = journey.setGoal(view, GOAL); assert.strictEqual(w().journey.stage, 'milestones'); await r.done;
  assert.strictEqual(w().journey.milestones.length, 4);
  // the owner edits: rename one, add one; kept milestones keep their tasks
  const list = w().journey.milestones.map((m) => ({ id: m.id, title: m.title, why: m.why, days: m.days }));
  list[0].title = 'Choose a niche and offer'; list.push({ title: 'Ask happy clients for referrals', why: 'Cheap growth', days: 10 });
  journey.saveMilestones(view, list);
  assert.strictEqual(w().journey.milestones[0].tasks.length, 3); assert.strictEqual(w().journey.milestones[4].tasks.length, 2);
  await journey.approveMilestones(view); assert.strictEqual(w().journey.stage, 'roadmap'); assert.strictEqual(w().roadmap.status, 'draft');
  const rm = w().roadmap; assert.strictEqual(rm.milestones.length, 5);
  assert.ok(rm.agents.length >= 6);
  // remove a task; requirements and agents recompute
  const before = rm.agents.length; journey.removeTask(view, rm.milestones[3].tasks.find((t) => t.role === 'finance').id);
  assert.ok(w().roadmap.agents.length < before);
  assert.throws(() => journey.completeSetup(view), /Finish the roadmap first/);
  journey.approveRoadmap(view); assert.strictEqual(w().journey.stage, 'setup');
  const v = journey.view(w()); assert.deepStrictEqual(v.setup.requirements.map((x) => x.kind + ':' + x.status), ['email:needs_setup']);
  // deploy
  const { deployed } = journey.completeSetup(view); assert.ok(deployed > 10);
  assert.strictEqual(w().journey.stage, 'run');
  const roles = Object.values(w().agents).map((a) => a.role);
  for (const need of ['researcher', 'critic', 'lead_generator', 'copywriter', 'email_marketer', 'sales_closer', 'ops']) assert.ok(roles.includes(need), need);
  assert.ok(!roles.includes('ecommerce_manager'), 'agents the plan does not need are not created');
  assert.ok(Object.values(w().hallways).some((h) => h.from === 'inbox') && Object.values(w().hallways).some((h) => h.to === 'outbox'));
  assert.ok(!Object.values(w().connectors).some((c) => c.kind === 'etsy'), 'no Etsy connector for an outreach plan');
  // autopilot works until it needs the owner: the email step is blocked, everything else it can do gets done
  await until(() => journey.view(w()).needsYou.length > 0 && !journey.view(w()).progress.running.length);
  const done1 = journey.view(w()); assert.strictEqual(done1.needsYou[0].kind, 'blocked'); assert.strictEqual(done1.needsYou[0].connect, 'email');
  assert.ok(done1.progress.done >= 5, 'made real progress on its own'); assert.ok(w().outbox.length >= 5);
  assert.ok(root.data.settings.provider.name === 'mock');
  // the owner connects email → the blocked task runs and files an approval for the actual send
  const c = Object.values(w().connectors).find((x) => x.kind === 'email'); c.status = 'ready'; c.config = { from: 'a@b.co', fromName: 'A', dailyLimit: 20, footer: 'x', optOutLine: 'x', address: 'x' };
  secrets.set(`conn:${c.id}:apiKey`, 'k'.repeat(12));
  const orig = integrations.missing; integrations.missing = () => [];
  try { journey.kick(view); await until(() => journey.view(w()).needsYou.every((n) => n.kind !== 'blocked')); } finally { integrations.missing = orig; }
});

test('a human step waits for the owner without stopping the agents, and finishing it moves the plan on', async () => {
  const { view } = fresh(); const w = () => view.state;
  await journey.setGoal(view, { ...GOAL, name: 'Make $3,000 a month selling digital planners on Etsy' }).done;
  await journey.approveMilestones(view); journey.approveRoadmap(view);
  assert.deepStrictEqual(journey.view(w()).setup.requirements.map((r) => r.kind), ['etsy']);
  journey.skipRequirement(view, 'etsy', true); // the owner will connect it later
  journey.completeSetup(view);
  await until(() => journey.view(w()).needsYou.some((n) => n.kind === 'human'));
  const human = journey.view(w()).needsYou.find((n) => n.kind === 'human'); assert.match(human.title, /Create your Etsy store/);
  assert.strictEqual(w().roadmap.milestones[0].status, 'done', 'earlier milestones finished without the owner');
  journey.completeTask(view, human.taskId);
  await until(() => w().roadmap.milestones.find((m) => m.key === 'traffic').status !== 'todo');
  await until(() => w().roadmap.status === 'done' || w().roadmap.milestones.every((m) => m.status === 'done'));
  const sales = w().roadmap.milestones.find((m) => m.key === 'sales').tasks[0];
  assert.strictEqual(sales.status, 'skipped'); assert.match(sales.reason, /Etsy was not connected/);
});

test('editing the goal after planning updates the numbers without discarding the plan', async () => {
  const { view } = fresh(); await journey.setGoal(view, GOAL).done; await journey.approveMilestones(view);
  const ids = view.state.roadmap.milestones.map((m) => m.id);
  const r = journey.setGoal(view, { ...GOAL, targetCents: 900000 }); assert.strictEqual(r.reset, false);
  assert.deepStrictEqual(view.state.roadmap.milestones.map((m) => m.id), ids); assert.strictEqual(view.state.mission.targetCents, 900000);
});

test('the autopilot pauses (instead of burning money) when the model is unreachable or the budget is hit', async () => {
  const { view } = fresh(); const w = () => view.state; view.state.settings.provider.name = 'ollama';
  await journey.setGoal(view, GOAL).done; view.state.settings.provider.name = 'openrouter'; // planning falls back to templates on garbage
  const restore1 = scriptProvider(() => 'nope'); await journey.approveMilestones(view); restore1(); journey.approveRoadmap(view);
  const restore = scriptProvider(() => { const e = new Error('Could not reach Ollama at http://127.0.0.1:11434. Is it running?'); e.status = 502; throw e; });
  try { journey.completeSetup(view); await until(() => w().roadmap.paused); } finally { restore(); }
  assert.match(w().roadmap.pauseReason, /Could not reach Ollama/);
  assert.ok(w().roadmap.milestones[0].tasks.every((t) => t.status !== 'failed'), 'a down model is not the task\'s fault');
  const restore2 = scriptProvider(() => 'fine'); try { journey.resume(view); await until(() => journey.view(w()).progress.done >= 2); } finally { restore2(); }
  assert.strictEqual(w().roadmap.paused, false);
});
