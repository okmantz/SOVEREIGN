'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fresh, until, scriptProvider } = require('./helpers');
const loop = require('../sidecar/lib/loop');
const memory = require('../sidecar/lib/memory');
const runner = require('../sidecar/lib/runner');
const agents = require('../sidecar/lib/agents');
const journey = require('../sidecar/lib/journey');
const sop = require('../sidecar/lib/sop');

const GOAL = { name: 'Land 5 clients for my lead generation agency', targetCents: 500000, capitalCents: 5000, riskCents: 5000 };
const setup = (role, name = 'Agent') => { const { view, root } = fresh(); view.state.settings.provider.name = 'openrouter'; view.state.mission = { name: 'Sell planners', targetCents: 100000, capitalCents: 5000, riskCents: 5000 }; return { view, root, a: agents.createAgent(view.state, { name, role }) }; };
const GOOD = 'HANDOFF: plan ready\nA specific, useful plan with concrete steps. Post in three communities, message ten people, and track replies in a sheet. Total cost: $0.';
const OVER = 'HANDOFF: plan\nRun paid ads. Ads cost $100 per week.\nA Canva Pro subscription costs $13 a month.\nThe whole plan is effective for reaching buyers.';

test('instant checks catch a plan that costs more than the owner\'s budget, thin answers, and missing files', () => {
  const { view } = fresh(); const w = view.state; w.mission = { name: 'g', targetCents: 100000, capitalCents: 5000, riskCents: 5000 };
  const gaps = loop.checkCode(w, { taskId: null, text: OVER });
  assert.strictEqual(gaps.length, 1); assert.match(gaps[0], /\$100\.00 but the budget for this stage is \$50\.00/); assert.ok(!/13/.test(gaps[0]), 'the $13 tool fits and is not flagged');
  assert.deepStrictEqual(loop.checkCode(w, { text: GOOD }), [], 'a good answer passes');
  assert.deepStrictEqual(loop.checkCode(w, { text: 'Goal: earn $10,000 in sales. Sell the planner at $19. Revenue target is $5,000.\nA solid plan follows with detail about outreach and follow up across the week.' }), [], 'revenue, price and goal lines are not costs');
  assert.match(loop.checkCode(w, { text: 'HANDOFF: x\nok' })[0], /too thin/); assert.match(loop.checkCode(w, { text: 'I cannot help with that request, sorry about that, really.' })[0], /Do not decline/);
  assert.match(loop.checkCode(w, { taskId: 'store_site', text: 'Here is a long description of a website with lots of words but no files at all in it.' })[0], /index\.html/);
  assert.deepStrictEqual(loop.checkCode(w, { taskId: 'import_products', text: 'FILE: products.json\n```json\n{"products":[{"id":"p1","name":"A","price":9}]}\n```\nEach order is fulfilled by instant download from the checkout page.' }), []);
  assert.match(loop.checkCode(w, { taskId: 'import_products', text: 'FILE: products.json\n```json\n{"products":[]}\n```\nEach order is fulfilled by instant download from the checkout page.' })[0], /non-empty/);
  w.mission.capitalCents = 0; assert.ok(loop.checkCode(w, { text: 'The tool costs $5 a month. ' + GOOD }).length === 1, 'with $0 capital even $5 is over budget');
});

test('a result that breaks the budget is sent back with the exact problem, fixed, and the lesson is remembered', async () => {
  const { view, a } = setup('researcher'); const seen = []; let n = 0;
  const restore = scriptProvider(async (x) => { seen.push(x.messages[x.messages.length - 1].content); return ++n === 1 ? OVER : GOOD; });
  try {
    const r = await runner.assign(view, { agentId: a.id, taskId: 'market_scan', title: 't' });
    assert.strictEqual(n, 2, 'executed, evaluated, revised once'); assert.strictEqual(r.revisions, 1);
    assert.match(seen[1], /YOUR PREVIOUS ANSWER/); assert.match(seen[1], /budget for this stage is \$50\.00/); assert.match(seen[1], /FIX THESE/);
    const o = view.state.outbox.find((x) => x.id === r.outboxId); assert.ok(!/\$100/.test(o.content), 'the accepted result is the fixed one'); assert.deepStrictEqual({ r: o.meta.loop.revisions, p: o.meta.loop.passed }, { r: 1, p: true });
    assert.match(memory.block(view.state), /Lessons learned so far/); assert.match(memory.block(view.state), /needs \$100\.00/); assert.strictEqual(view.state.loopStats.revised, 1); assert.strictEqual(view.state.loopStats.accepted, 1);
  } finally { restore(); }
});

test('it stops revising after the limit, delivers the best result, and says what is still wrong', async () => {
  const { view, a } = setup('researcher'); let n = 0; view.state.settings.loop = { evaluate: 'smart', maxRevisions: 2, maxRounds: 0 };
  const restore = scriptProvider(async () => { n++; return OVER; });
  try {
    const r = await runner.assign(view, { agentId: a.id, taskId: 'market_scan', title: 't' });
    assert.strictEqual(n, 3, 'one attempt plus two revisions, then it stops'); const o = view.state.outbox.find((x) => x.id === r.outboxId);
    assert.match(o.content, /Open issues after 2 revisions/); assert.strictEqual(o.meta.loop.passed, false); assert.strictEqual(view.state.loopStats.gaveUp, 1);
  } finally { restore(); }
  const { view: v0, a: a0 } = setup('researcher'); v0.state.settings.loop = { evaluate: 'smart', maxRevisions: 0, maxRounds: 0 }; let m = 0;
  const r0 = scriptProvider(async () => { m++; return OVER; }); try { await runner.assign(v0, { agentId: a0.id, taskId: 'market_scan', title: 't' }); assert.strictEqual(m, 1, 'zero revisions means one attempt'); } finally { r0(); }
});

test('the model judge reviews work that matters, revises on real gaps, and ignores nitpicks and a broken judge', async () => {
  const run = async (judgeReply, { role = 'copywriter', mode = 'smart', light = false } = {}) => {
    const { view, a } = setup(role); view.state.settings.loop = { evaluate: mode, maxRevisions: 1, maxRounds: 0 }; let agentCalls = 0, judgeCalls = 0; const prompts = [];
    const restore = scriptProvider(async (x) => { if (x.json) { judgeCalls++; return typeof judgeReply === 'function' ? judgeReply(judgeCalls) : judgeReply; } agentCalls++; prompts.push(x.messages[x.messages.length - 1].content); return GOOD + ' v' + agentCalls; });
    try { const r = await runner.assign(view, { agentId: a.id, taskId: role === 'copywriter' ? 'landing_page' : 'market_scan', title: 't', light }); return { view, agentCalls, judgeCalls, prompts, r }; } finally { restore(); }
  };
  let x = await run(JSON.stringify({ verdict: 'revise', score: 4, gaps: ['The headline is generic. Name the buyer and the result.'], lesson: 'Headlines must name the buyer and the outcome.' }));
  assert.strictEqual(x.agentCalls, 2); assert.strictEqual(x.judgeCalls, 2, 'the revised result is judged again'); assert.match(x.prompts[1], /headline is generic/); assert.match(memory.block(x.view.state), /Headlines must name the buyer/);
  x = await run((n) => JSON.stringify(n === 1 ? { verdict: 'revise', score: 5, gaps: ['Add a price.'] } : { verdict: 'pass', score: 9 })); assert.strictEqual(x.agentCalls, 2);
  x = await run(JSON.stringify({ verdict: 'revise', score: 9, gaps: ['Tiny wording nit.'] })); assert.strictEqual(x.agentCalls, 1, 'a high score with nitpicks is a pass');
  x = await run('this is not json at all'); assert.strictEqual(x.agentCalls, 1, 'a broken judge never blocks real work');
  x = await run(JSON.stringify({ verdict: 'pass', score: 9 })); assert.strictEqual(x.judgeCalls, 1); assert.strictEqual(x.view.state.loopStats.passedFirst, 1);
  x = await run('{}', { role: 'researcher' }); assert.strictEqual(x.judgeCalls, 0, 'smart mode spends no model call on research drafts');
  x = await run('{}', { role: 'researcher', mode: 'always' }); assert.strictEqual(x.judgeCalls, 1, '"always" judges everything');
  x = await run('{}', { mode: 'off' }); assert.strictEqual(x.judgeCalls, 0, '"off" keeps only the free checks');
  x = await run('{}', { light: true }); assert.strictEqual(x.judgeCalls, 0, 'extra work gets only the free checks');
});

test('the offline demo model is never evaluated or revised', async () => {
  const { view } = fresh(); const a = agents.createAgent(view.state, { name: 'A', role: 'researcher' }); view.state.mission = { name: 'g', targetCents: 100000, capitalCents: 100, riskCents: 100 };
  const r = await runner.assign(view, { agentId: a.id, taskId: 'market_scan', title: 't' }); assert.strictEqual(r.revisions, 0);
});

test('lessons reach later agents, and a round that falls short is reflected on before the next one', async () => {
  const { view } = fresh(); const w = () => view.state; w().settings.waitMinutes = 0; const sys = [];
  const restore = scriptProvider(async (x) => { if (x.json) return /reviewing a finished round/.test(x.system) ? JSON.stringify({ lessons: ['Direct outreach beat drafts; lead with a named prospect.', 'Skip generic research.'] }) : '{}'; sys.push(x.system); return GOOD; });
  try {
    view.state.settings.provider.name = 'openrouter'; await journey.setGoal(view, GOAL).done; await journey.approveMilestones(view); journey.approveRoadmap(view); journey.completeSetup(view);
    await until(() => (w().cycles || []).length >= 1 && (w().memory.lessons || []).length >= 2, 15000);
    assert.ok(w().memory.lessons.some((l) => /named prospect/.test(l.text) && l.by === 'Director'));
    await until(() => sys.some((s) => /Lessons learned so far/.test(s) && /named prospect/.test(s)), 15000);
    assert.match(journey.view(w()).loop.lessons[0].text, /./); assert.ok(journey.view(w()).loop.conditions.length >= 6);
  } finally { restore(); }
});

test('a round cap stops the loop with a clear reason, and the SOP documents the loop and its stopping conditions', async () => {
  const { view } = fresh(); const w = () => view.state; w().settings.waitMinutes = 0; w().settings.loop = { evaluate: 'off', maxRevisions: 1, maxRounds: 1 };
  const restore = scriptProvider(async (x) => (x.json ? '{}' : GOOD));
  try {
    view.state.settings.provider.name = 'openrouter'; await journey.setGoal(view, GOAL).done; await journey.approveMilestones(view); journey.approveRoadmap(view); journey.completeSetup(view);
    await until(() => w().roadmap.status === 'done' && w().loopStop, 15000);
    assert.strictEqual(w().loopStop.kind, 'cap'); assert.match(w().loopStop.reason, /cap of 1 round/); assert.strictEqual(w().journey.cycle || 0, 0, 'no second round was started');
  } finally { restore(); }
  const doc = sop.build(w(), 1); for (const need of ['The autonomous loop', 'Goal → Plan → Execute → Evaluate → Learn → Repeat', 'It stops only when', 'Verified profit reaches your target', 'Your cap of 1 round is reached', 'revised at most 1 time']) assert.ok(doc.includes(need), need);
});

test('settings: evaluation mode, revisions and round cap are validated', async () => {
  const { start } = require('../sidecar/index'); const { server, port, root } = await start({ persist: false, port: 0, autopilot: false });
  const post = (b) => fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    assert.strictEqual((await post({ loop: { evaluate: 'always', maxRevisions: 9, maxRounds: -4 } })).status, 200); const l = root.data.settings.loop;
    assert.deepStrictEqual({ e: l.evaluate, r: l.maxRevisions, c: l.maxRounds }, { e: 'always', r: 3, c: 0 }, 'clamped to sane values');
    await post({ loop: { evaluate: 'bogus' } }); assert.strictEqual(root.data.settings.loop.evaluate, 'always', 'unknown modes are ignored');
    assert.deepStrictEqual(loop.config({ settings: {} }), { evaluate: 'smart', maxRevisions: 1, maxRounds: 0 }, 'sensible defaults for older saves');
  } finally { server.close(); }
});

test('the same lesson is not written down twice, round after round', async () => {
  const { view } = fresh(); view.state.mission = { name: 'g', targetCents: 100000, capitalCents: 5000, riskCents: 5000 };
  for (let r = 1; r <= 3; r++) await loop.reflect(view, { decision: { action: 'iterate' }, round: r });
  assert.strictEqual(view.state.memory.lessons.length, 1); assert.doesNotMatch(view.state.memory.lessons[0].text, /Round \d/);
});
