'use strict';
// The guided journey: goal → milestones → roadmap → setup → run. After the owner approves the roadmap, the Director
// deploys only the agents and integrations the plan needs, then works through the tasks on its own, asking the owner
// only for approvals, keys and the few steps that are genuinely human.
const { id, assert } = require('./util');
const planner = require('./planner');
const runner = require('./runner');
const director = require('./director');
const integrations = require('./integrations');
const station = require('./station');
const worlds = require('./worlds');
const { ROLES } = require('./roles');

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const J = (store) => store.state.journey;
const tasksOf = (rm) => rm.milestones.flatMap((m) => m.tasks.map((t) => ({ ms: m, t })));
const locate = (store, taskId) => { const rm = store.state.roadmap; return rm ? tasksOf(rm).find((x) => x.t.id === taskId) || null : null; };
const say = (store, text) => director.noteDirector(store, text);

// Run slow planning in the background; the UI shows the spinner from journey.busy and refreshes on change.
function bg(store, label, fn) {
  const j = J(store); j.busy = label; j.notice = null; store.change('state');
  const done = Promise.resolve().then(fn).catch((e) => { store.state.journey.notice = e.message; })
    .finally(() => { store.state.journey.busy = null; store.change('state'); });
  return done;
}

// ---- stage 1: goal
function setGoal(store, body) {
  const w = store.state;
  const name = clip(body.name, 160); assert(name.length >= 4, 'Describe your goal in a sentence.');
  const target = Math.round(Number(body.targetCents)); assert(target > 0, 'Set a profit target above zero.');
  const mission = { name, targetCents: target, capitalCents: Math.max(0, Math.round(Number(body.capitalCents)) || 0), riskCents: Math.max(0, Math.round(Number(body.riskCents)) || 0),
    deadline: body.deadline ? clip(body.deadline, 10) : null, createdAt: (w.mission && w.mission.createdAt) || Date.now() };
  const first = !w.mission || w.journey.stage === 'goal';
  w.mission = mission;
  if (!first) { store.change('state'); return { done: Promise.resolve(), reset: false }; } // editing numbers must not throw the plan away
  w.roadmap = null; w.journey.stage = 'milestones'; w.journey.milestones = [];
  return { done: bg(store, 'milestones', () => planner.draftMilestones(store)), reset: true };
}

// ---- stage 2: milestones
function generateMilestones(store) { assert(J(store).stage === 'milestones', 'Milestones are only drafted at that step.'); return bg(store, 'milestones', () => planner.draftMilestones(store)); }
function saveMilestones(store, list) { assert(J(store).stage === 'milestones', 'Milestones can only be edited at that step.'); planner.saveMilestones(store, list); store.change('state'); }
function approveMilestones(store) {
  assert(J(store).stage === 'milestones' && J(store).milestones.length, 'Draft milestones first.');
  J(store).stage = 'roadmap'; store.state.roadmap = null;
  return bg(store, 'roadmap', () => planner.buildRoadmap(store));
}

// ---- stage 3: roadmap
function generateRoadmap(store) { assert(J(store).stage === 'roadmap', 'The roadmap is only drafted at that step.'); return bg(store, 'roadmap', () => planner.buildRoadmap(store)); }
function backToMilestones(store) { assert(J(store).stage === 'roadmap', 'Nothing to go back from.'); J(store).stage = 'milestones'; store.state.roadmap = null; store.change('state'); }
function refreshPlan(rm) { rm.requirements = planner.deriveRequirements(rm, rm.requirements); rm.agents = planner.neededAgents(rm); }
function removeTask(store, taskId) {
  const rm = store.state.roadmap; assert(rm && J(store).stage === 'roadmap', 'Tasks can only be removed while reviewing the roadmap.');
  const hit = locate(store, taskId); assert(hit, 'Task not found', 404);
  assert(hit.ms.tasks.length > 1 || rm.milestones.length > 1, 'A roadmap needs at least one task.');
  hit.ms.tasks = hit.ms.tasks.filter((t) => t.id !== taskId);
  rm.milestones = rm.milestones.filter((m) => m.tasks.length);
  refreshPlan(rm); store.change('state');
}
function approveRoadmap(store) {
  const rm = store.state.roadmap; assert(rm && J(store).stage === 'roadmap' && !J(store).busy, 'There is no roadmap to approve yet.');
  rm.status = 'approved'; rm.approvedAt = Date.now(); J(store).stage = 'setup'; J(store).notice = null; store.change('state');
}

// ---- stage 4: setup
function skipRequirement(store, kind, skipped) {
  const rm = store.state.roadmap; assert(rm, 'No roadmap yet.');
  const r = rm.requirements.find((x) => x.kind === kind); assert(r, 'That integration is not part of this plan.', 404);
  r.skipped = !!skipped;
  if (rm.status === 'running') kick(store);
  store.change('state');
}
function setupView(world) {
  const rm = world.roadmap; if (!rm) return null;
  const reqs = rm.requirements.map((r) => {
    const conn = Object.values(world.connectors).find((c) => c.kind === r.kind);
    return { ...r, label: station.CONNECTOR_KINDS[r.kind].label, status: planner.requirementStatus(world, r), connectorId: conn ? conn.id : null, connectorStatus: conn ? conn.status : null };
  });
  const provider = world.settings.provider;
  return { requirements: reqs, agents: rm.agents.map((a) => ({ ...a, exists: Object.values(world.agents).some((x) => x.role === a.role) })),
    needsSource: planner.roadmapNeedsSource(rm), sourceReady: planner.hasRevenueSource(world), provider: { name: provider.name, model: provider.model, offline: provider.name === 'mock' } };
}
function completeSetup(store) {
  const w = store.state, rm = w.roadmap;
  assert(rm && J(store).stage === 'setup', 'Finish the roadmap first.');
  const actions = planner.deployActions(w);
  if (actions.length) director.applyPlan(store, actions); // pre-approved: the owner approved this roadmap and its team
  const now = store.state;
  now.roadmap.status = 'running'; now.roadmap.paused = false; now.roadmap.startedAt = Date.now(); now.journey.stage = 'run';
  say(store, `The team is in place: ${now.roadmap.agents.map((a) => a.label).join(', ')}. I'm starting on milestone “${now.roadmap.milestones[0].title}”. I'll only come to you for approvals, keys and steps only you can do.`);
  store.change('state'); kick(store);
  return { deployed: actions.length };
}

// ---- stage 5: run (autopilot)
const running = new WeakMap(); // root store → the set of world ids whose loop is active
function kick(store) {
  const root = worlds.rootOf(store), wid = worlds.idOf(store);
  const set = running.get(root) || running.set(root, new Set()).get(root);
  if (set.has(wid)) return;
  set.add(wid);
  loop(store).catch((e) => console.error('[autopilot]', e.message)).finally(() => set.delete(wid));
}
async function loop(store) { for (let i = 0; i < 300; i++) { if (!(await step(store))) break; } }

const deliverTarget = (world, kinds) => { for (const k of kinds || []) { const c = Object.values(world.connectors).find((x) => x.kind === k && x.status === 'ready'); if (c) return c; } return null; };
const blockedBy = (world, rm, t) => {
  for (const kind of t.requires) {
    const req = rm.requirements.find((r) => r.kind === kind);
    if (req && req.skipped) return { kind, skipped: true };
    if (!Object.values(world.connectors).some((c) => c.kind === kind && c.status === 'ready')) return { kind };
  }
  return null;
};

async function execute(store, taskId) {
  const hit = locate(store, taskId), w = store.state, rm = w.roadmap, { ms, t } = hit;
  const agent = Object.values(w.agents).find((a) => a.role === t.role);
  assert(agent, `There is no ${ROLES[t.role].label} on the team yet.`);
  const target = deliverTarget(w, t.deliver);
  let instructions = t.instructions || '';
  const ad = target && integrations.adapterFor(target.kind);
  if (ad && ad.contract) instructions += `\nEnd your reply with exactly one JSON object shaped like ${ad.contract} to hand this to "${target.name}".`;
  const prior = tasksOf(rm).filter((x) => x.t.status === 'done' && x.t.result).slice(-2).map((x) => `- ${x.t.title}: ${x.t.result.slice(0, 500)}`).join('\n');
  const r = await runner.assign(store, { agentId: agent.id, taskId: t.task || undefined, instructions: instructions.trim(), title: `${ms.title} · ${t.title}`, context: { goal: rm.goal, milestone: ms.title, previous: prior }, maxTokens: 1100 });
  const after = locate(store, taskId); if (after) { after.t.result = r.text.slice(0, 700); after.t.outboxId = r.outboxId; }
  if (target) await runner.sendToConnector(store, target, r.text, { soft: true });
}

async function step(store) {
  const w = store.state, rm = w.roadmap;
  if (!rm || rm.status !== 'running' || rm.paused) return false;
  const ms = rm.milestones.find((m) => m.status !== 'done');
  if (!ms) { rm.status = 'done'; say(store, 'Every milestone is complete. Open Money to see what was verified, or plan the next phase.'); store.change('state'); return false; }
  ms.status = 'active';
  for (const t of ms.tasks) {
    if (['done', 'skipped', 'running'].includes(t.status) || (t.status === 'failed' && t.attempts >= 2)) continue;
    if (t.owner === 'human') { if (t.status !== 'needs_you') { t.status = 'needs_you'; store.change('state'); } continue; }
    const b = blockedBy(w, rm, t);
    if (b && b.skipped) { t.status = 'skipped'; t.reason = `Skipped because ${station.CONNECTOR_KINDS[b.kind].label} was not connected.`; store.change('state'); return true; }
    if (b) { if (t.status !== 'blocked' || t.blockedBy !== b.kind) { t.status = 'blocked'; t.blockedBy = b.kind; store.change('state'); } continue; }
    t.status = 'running'; t.error = null; store.change('state');
    try { await execute(store, t.id); const h = locate(store, t.id); if (h) { h.t.status = 'done'; h.t.finishedAt = Date.now(); } store.change('state'); return true; }
    catch (e) {
      const h = locate(store, t.id), rm2 = store.state.roadmap; if (!h) return false;
      h.t.error = e.message; h.t.attempts = (h.t.attempts || 0) + 1;
      if (e.status === 402 || e.status === 502) { h.t.status = 'todo'; h.t.attempts -= 1; rm2.paused = true; rm2.pauseReason = e.message; say(store, `I paused the plan: ${e.message}`); store.change('state'); return false; }
      h.t.status = h.t.attempts >= 2 ? 'failed' : 'todo'; store.change('state'); return true;
    }
  }
  if (ms.tasks.every((t) => ['done', 'skipped'].includes(t.status))) {
    ms.status = 'done'; const next = rm.milestones.find((m) => m.status !== 'done');
    say(store, `Milestone “${ms.title}” is done.${next ? ` Next up: “${next.title}”.` : ''}`); store.change('state'); return true;
  }
  return false; // waiting on the owner (a human step, a missing key, or a failure)
}

function pause(store) { const rm = store.state.roadmap; assert(rm && rm.status === 'running', 'Nothing is running.'); rm.paused = true; rm.pauseReason = 'Paused by you.'; store.change('state'); }
function resume(store) { const rm = store.state.roadmap; assert(rm && rm.status === 'running', 'Nothing to resume.'); rm.paused = false; rm.pauseReason = null; for (const x of tasksOf(rm)) if (x.t.status === 'failed' && x.t.attempts >= 2 && !x.t.error) x.t.attempts = 0; store.change('state'); kick(store); }
function retryTask(store, taskId) { const h = locate(store, taskId); assert(h, 'Task not found', 404); h.t.status = 'todo'; h.t.attempts = 0; h.t.error = null; store.state.roadmap.paused = false; store.change('state'); kick(store); }
function completeTask(store, taskId) { const h = locate(store, taskId); assert(h && h.t.owner === 'human', 'Only your own steps can be marked done.'); h.t.status = 'done'; h.t.finishedAt = Date.now(); store.change('state'); kick(store); }
function skipTask(store, taskId) { const h = locate(store, taskId); assert(h, 'Task not found', 404); h.t.status = 'skipped'; h.t.reason = 'Skipped by you.'; store.change('state'); kick(store); }
// New phase: plan again toward the same goal, keeping the team and rooms already built.
function replan(store) {
  const w = store.state; assert(w.mission, 'Set a goal first.');
  w.roadmap = null; w.journey.stage = 'milestones'; w.journey.milestones = [];
  return bg(store, 'milestones', () => planner.draftMilestones(store));
}
function tickAll(root) { for (const w of Object.values(root.data.worlds)) if (w.roadmap && w.roadmap.status === 'running' && !w.roadmap.paused) kick(root.forWorld(w.id)); }

// Everything the UI needs, computed from state.
function view(world) {
  const j = world.journey, rm = world.roadmap;
  const out = { stage: j.stage, busy: j.busy, notice: j.notice, path: j.path || null, pathLabel: j.pathLabel || null, adapted: !!j.adapted,
    milestones: (j.milestones || []).map((m) => ({ id: m.id, key: m.key, title: m.title, why: m.why, days: m.days, tasks: m.tasks.length })), roadmap: rm, setup: null, progress: null, needsYou: [] };
  if (rm) {
    const all = tasksOf(rm), done = all.filter((x) => ['done', 'skipped'].includes(x.t.status)).length;
    out.progress = { done, total: all.length, pct: all.length ? Math.round((done / all.length) * 100) : 0, running: all.filter((x) => x.t.status === 'running').map((x) => x.t.id) };
    out.setup = setupView(world);
    for (const { ms, t } of all) {
      if (t.status === 'needs_you') out.needsYou.push({ taskId: t.id, kind: 'human', title: t.title, milestone: ms.title, detail: t.instructions || 'This step is yours.' });
      else if (t.status === 'blocked') out.needsYou.push({ taskId: t.id, kind: 'blocked', title: t.title, milestone: ms.title, connect: t.blockedBy, detail: `Connect ${station.CONNECTOR_KINDS[t.blockedBy].label} to run this task.` });
      else if (t.status === 'failed') out.needsYou.push({ taskId: t.id, kind: 'failed', title: t.title, milestone: ms.title, detail: t.error || 'This task failed.' });
    }
  }
  return out;
}

module.exports = { setGoal, generateMilestones, saveMilestones, approveMilestones, generateRoadmap, backToMilestones, removeTask, approveRoadmap, skipRequirement, completeSetup, pause, resume, retryTask, completeTask, skipTask, replan, kick, tickAll, view, step, loop };
