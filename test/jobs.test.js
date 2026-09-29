'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fresh, until } = require('./helpers');
const jobs = require('../sidecar/lib/jobs');
const agents = require('../sidecar/lib/agents');
const director = require('../sidecar/lib/director');
const runner = require('../sidecar/lib/runner');
const { ROLES } = require('../sidecar/lib/roles');

test('every role has a coded job: summary, duties, deliverables, quality bar and a task library', () => {
  for (const role of Object.keys(ROLES)) {
    const j = jobs.spec(role);
    assert.ok(j.summary && j.does.length && j.deliver.length && j.quality.length, role);
    if (role !== 'director') assert.ok(j.tasks.length >= 1 && j.tasks.every((t) => t.id && t.prompt.length > 30), role + ' tasks');
  }
});

test('a Content Manager ships with real defaults, saves validated settings, and uses them in its prompt', () => {
  const { view } = fresh();
  const cm = agents.createAgent(view.state, { name: 'Editor', role: 'content_manager' });
  assert.strictEqual(cm.settings.postsPerWeek, 5); assert.strictEqual(cm.settings.platforms, 'blog, LinkedIn, X');
  agents.updateAgent(view.state, cm.id, { settings: { postsPerWeek: '3', platforms: 'newsletter', callToAction: 'Book a call', bogus: 'x', contentPillars: 'a'.repeat(5000) } });
  assert.strictEqual(cm.settings.postsPerWeek, 3); assert.ok(!('bogus' in cm.settings)); assert.strictEqual(cm.settings.contentPillars.length, 1500);
  const sys = runner.buildSystem(view.state, cm, ['fs.workspace']);
  assert.match(sys, /YOUR JOB: Plan and ship a content calendar/); assert.match(sys, /Platforms: newsletter/); assert.match(sys, /Posts per week: 3/); assert.match(sys, /Book a call/);
  const prompt = jobs.taskPrompt(cm, { taskId: 'content_calendar', context: { goal: 'Grow a newsletter' } });
  assert.match(prompt, /two-week content calendar/); assert.match(prompt, /Goal: Grow a newsletter/);
  agents.updateAgent(view.state, cm.id, { role: 'copywriter' });
  assert.ok('brandVoice' in cm.settings && !('postsPerWeek' in cm.settings), 'changing role swaps in that role\'s settings');
});

test('select settings reject values outside the options', () => {
  assert.strictEqual(jobs.cleanSettings('critic', { riskAppetite: 'reckless' }).riskAppetite, 'balanced');
  assert.strictEqual(jobs.cleanSettings('critic', { riskAppetite: 'bold' }).riskAppetite, 'bold');
});

test('the Director tells an agent to work by name: no approval, the result lands in the Outbox', async () => {
  const { view } = fresh();
  agents.createAgent(view.state, { name: 'Quill', role: 'copywriter' });
  const r = await director.handleMessage(view, 'Tell Quill to write three headline options for a planner');
  assert.strictEqual(r.applied, true); assert.strictEqual(view.state.approvals.filter((a) => a.status === 'pending').length, 0);
  await until(() => view.state.outbox.some((o) => o.fromRoom === 'Quill' && /three headline options/.test(view.state.transcripts[o.meta.agentId].map((m) => m.content).join(' '))));
});

test('assigning validates the agent and the task, and removing an agent is structural so it waits for approval', () => {
  const { view } = fresh();
  agents.createAgent(view.state, { name: 'Quill', role: 'copywriter' });
  assert.throws(() => director.propose(view, [{ type: 'assign_task', agent: 'Nobody', instructions: 'x' }]), /no agent called "Nobody"/);
  assert.throws(() => director.propose(view, [{ type: 'assign_task', agent: 'Quill', task: 'kpi_report' }]), /has no task "kpi_report"/);
  const r = director.propose(view, [{ type: 'remove_agent', agent: 'Quill' }]);
  assert.strictEqual(r.applied, false); assert.ok(r.approvalId);
  assert.ok(Object.values(view.state.agents).some((a) => a.name === 'Quill'), 'still there until approved');
});

test('the Director can tune another agent\'s saved settings immediately', () => {
  const { view } = fresh();
  const a = agents.createAgent(view.state, { name: 'Editor', role: 'content_manager' });
  director.propose(view, [{ type: 'update_agent', agent: 'Editor', settings: { postsPerWeek: 9 } }]);
  assert.strictEqual(a.settings.postsPerWeek, 9);
});
