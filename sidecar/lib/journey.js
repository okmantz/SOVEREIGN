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
const strategy = require('./strategy');
const memory = require('./memory');
const orchestrator = require('./orchestrator');
const sop = require('./sop');
const ledger = require('./ledger');
const loop = require('./loop');
const providers = require('./providers');
const guardrails = require('./guardrails');
const { money } = require('./util');
const { ROLES } = require('./roles');

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const J = (store) => store.state.journey;
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
    deadline: body.deadline ? clip(body.deadline, 10) : null, notes: clip(body.notes, 500), createdAt: (w.mission && w.mission.createdAt) || Date.now() };
  const first = !w.mission || w.journey.stage === 'goal';
  w.mission = mission;
  if (!first) { strategy.refresh(w); const rmx = w.roadmap; if (rmx && rmx.status === 'achieved' && !goalReached(w)) { rmx.status = 'done'; w.journey.achievedAt = null; store.change('state'); return { done: nextCycle(store).catch(() => {}), reset: false }; } store.change('state'); return { done: Promise.resolve(), reset: false }; } // editing numbers must not throw the plan away
  w.roadmap = null; w.strategy = null; w.journey.cycle = 0; w.journey.stage = 'milestones'; w.journey.milestones = [];
  return { done: bg(store, 'milestones', () => planner.draftMilestones(store)), reset: true };
}

// ---- stage 2: milestones
function generateMilestones(store) { assert(J(store).stage === 'milestones', 'Milestones are only drafted at that step.'); return bg(store, 'milestones', () => planner.draftMilestones(store)); }
function saveMilestones(store, list) { assert(J(store).stage === 'milestones', 'Milestones can only be edited at that step.'); planner.saveMilestones(store, list); store.change('state'); }
function approveMilestones(store) {
  assert(J(store).stage === 'milestones' && J(store).milestones.length, 'Draft milestones first.');
  J(store).stage = 'roadmap'; store.state.roadmap = null;
  return openRoadmap(store);
}
// The roadmap's structure is instant; the model's tailoring of task wording finishes in the background.
function openRoadmap(store) {
  J(store).notice = null; planner.buildRoadmapBase(store); store.change('state');
  const p = planner.tailorRoadmap(store).catch(() => {});
  perWorld(tailoring, store, () => ({})).p = p;
  return p;
}

// ---- stage 3: roadmap
function generateRoadmap(store) { assert(J(store).stage === 'roadmap', 'The roadmap is only drafted at that step.'); return openRoadmap(store); }
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
// A venture per stage gives the ledger something to attribute to, and the kill rule something to enforce. No budget, no venture.
function ensureVenture(store) {
  const w = store.state, st = strategy.current(w); if (!st) return;
  const budget = strategy.stageBudgetCents(w, st);
  if (budget <= 0 || (st.ventureId && w.ventures[st.ventureId])) return;
  const risk = w.mission.riskCents > 0 ? w.mission.riskCents : budget;
  const v = { id: 'vent_' + Math.random().toString(16).slice(2, 10), name: st.title.slice(0, 60), thesis: st.thesis.slice(0, 400), status: 'testing', budgetCents: budget, maxLossCents: Math.min(budget, risk), createdAt: Date.now() };
  w.ventures[v.id] = v; st.ventureId = v.id;
}
function completeSetup(store) {
  const w = store.state, rm = w.roadmap;
  assert(rm && J(store).stage === 'setup', 'Finish the roadmap first.');
  const actions = planner.deployActions(w);
  if (actions.length) director.applyPlan(store, actions); // pre-approved: the owner approved this roadmap and its team
  const now = store.state, st = strategy.current(now);
  now.roadmap.status = 'running'; now.roadmap.paused = false; now.roadmap.startedAt = Date.now(); now.journey.stage = 'run';
  ensureVenture(store);
  memory.setBrief(now, { brief: `${st ? `Stage ${now.strategy.current + 1} of ${now.strategy.stages.length}: "${st.title}". ${st.thesis} ` : ''}Budget ${money(memory.stageBudget(now))}. Independent tasks run at the same time; reviews and reports wait for the work they review. Stay inside the owner's constraints.` });
  sop.issue(store); // the plan, written up as an SOP, lands in the Outbox and flies through the rooms
  say(store, `The team is in place: ${now.roadmap.agents.map((a) => a.label).join(', ')}. The business SOP is in your Outbox. I'm starting on milestone “${now.roadmap.milestones[0].title}” and will keep every agent busy. I'll only come to you for approvals, keys and steps only you can do.`);
  store.change('state'); kick(store);
  return { deployed: actions.length };
}

// ---- stage 5: run (autopilot)
// Tasks that do not depend on each other run at the same time, one per agent. The Director keeps idle agents busy with
// extra drafts and analysis, briefs the whole team after every milestone, and only stops for the owner when it must.
const DONE = orchestrator.DONE;
const running = new WeakMap(), flights = new WeakMap(), wakers = new WeakMap(), tailoring = new WeakMap();
const perWorld = (wm, store, make) => { const root = worlds.rootOf(store); let m = wm.get(root); if (!m) wm.set(root, m = new Map()); const wid = worlds.idOf(store); if (!m.has(wid)) m.set(wid, make()); return m.get(wid); };
const fl = (store) => perWorld(flights, store, () => new Map());
const sleepMs = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
const withTimeout = (p, ms) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timed out')), ms); if (t.unref) t.unref(); })]).finally(() => clearTimeout(t)); };

function wake(store) { const slot = perWorld(wakers, store, () => ({ fn: null })); if (slot.fn) { const f = slot.fn; slot.fn = null; f(); } }
function kick(store) {
  const root = worlds.rootOf(store), wid = worlds.idOf(store);
  const set = running.get(root) || running.set(root, new Set()).get(root);
  if (set.has(wid)) { wake(store); return; } // already running: nudge it so it looks again right now
  set.add(wid);
  pump(store).catch((e) => console.error('[autopilot]', e.message)).finally(() => set.delete(wid));
}
const slotLimit = (store) => { const st = store.state.settings, c = st.concurrency || {}; return Math.max(1, st.provider.name === 'ollama' ? c.ollama || 2 : c.other || 8); };

async function pump(store) {
  const t = perWorld(tailoring, store, () => ({})).p; if (t) await Promise.race([t, sleepMs(20000)]); // task wording first, but never wait long
  for (let i = 0; i < 100000; i++) {
    await sleepMs(0); // always yield to the event loop: the UI, timers and other worlds must never starve, however fast the model is
    const f = fl(store); let again = false; const rm = store.state.roadmap;
    if (rm && rm.status === 'running' && !rm.paused) {
      await settle(store);
      const r = await schedule(store);
      again = r.changed && !r.launched; // e.g. skipping a task unlocked others: look again straight away
    }
    if (again) continue;
    const cur = store.state.roadmap, watching = cur && cur.status === 'running' && !cur.paused && !f.size && cur.idleSince; // waiting out the grace period on the owner
    if (!f.size && !watching) break;
    const slot = perWorld(wakers, store, () => ({ fn: null }));
    if (watching) { await Promise.race([sleepMs(Math.min(5000, Math.max(50, ((store.state.settings.waitMinutes == null ? 10 : store.state.settings.waitMinutes) * 60000) - (Date.now() - cur.idleSince) + 20))), new Promise((r) => { slot.fn = r; })]); continue; } // a kick() (owner connected something) ends the wait at once
    await Promise.race([...[...f.values()].map((x) => x.done), new Promise((r) => { slot.fn = r; })]);
  }
}

const tasksOf = (rm) => rm.milestones.flatMap((m) => m.tasks.map((t) => ({ ms: m, t })));
const locate = (store, taskId) => {
  const rm = store.state.roadmap; if (!rm) return null;
  const hit = tasksOf(rm).find((x) => x.t.id === taskId); if (hit) return hit;
  const ex = (rm.extras || []).find((e) => e.id === taskId); return ex ? { ms: { title: 'Extra work' }, t: ex, extra: true } : null;
};
const deliverTarget = (world, kinds) => { for (const k of kinds || []) { const c = Object.values(world.connectors).find((x) => x.kind === k && x.status === 'ready'); if (c) return c; } return null; };
const blockedBy = (world, rm, t) => {
  for (const kind of t.requires) {
    const req = rm.requirements.find((r) => r.kind === kind);
    if (req && req.skipped) return { kind, skipped: true };
    if (!Object.values(world.connectors).some((c) => c.kind === kind && c.status === 'ready')) return { kind };
  }
  return null;
};
const seated = (w, role) => Object.values(w.agents).filter((a) => a.role === role && a.deskId && w.desks[a.deskId]);
const roomRef = (w, agentId) => { const a = w.agents[agentId], d = a && a.deskId && w.desks[a.deskId]; return d && w.rooms[d.roomId] ? 'room:' + d.roomId : null; };

async function execute(store, ref, agent) {
  const w = store.state, rm = w.roadmap, { ms, t } = ref, sp = runner.speedOf(w);
  const target = t.deliver && t.deliver.length ? deliverTarget(w, t.deliver) : null;
  let instructions = t.instructions || '';
  const ad = target && integrations.adapterFor(target.kind);
  if (ad && ad.contract) instructions += `\nEnd your reply with exactly one JSON object shaped like ${ad.contract} to hand this to "${target.name}".`;
  let previous = ref.extra ? orchestrator.recentInputs(rm) : orchestrator.inputsFor(rm, ms, t);
  if (['builder', 'ecommerce_manager', 'developer'].includes(agent.role)) { const sc = require('./sites').context(store); if (sc) previous = (previous ? previous + '\n\n' : '') + sc; }
  const r = await runner.assign(store, { agentId: agent.id, refId: t.id, taskId: t.task || undefined, instructions: instructions.trim(), title: `${ms.title} · ${t.title}`, taskLabel: t.title,
    context: { goal: rm.goal, milestone: ms.title, previous, words: sp.words }, maxTokens: sp.tokens, light: !!ref.extra });
  const after = locate(store, t.id); if (after) { after.t.result = r.text.slice(0, 1000); after.t.outboxId = r.outboxId; after.t.handoff = r.handoff; }
  if (target) await runner.sendToConnector(store, target, r.text, { soft: true });
}

// Start one task on one agent. Runs in the background; the pump is woken when it finishes.
function launch(store, ref, agent) {
  const { t } = ref, f = fl(store);
  t.status = 'running'; t.error = null; t.startedAt = Date.now(); t.agentId = agent.id; t.agentName = agent.name;
  const w = store.state, to = roomRef(w, agent.id); // show the inputs flowing in from the teammates this task builds on
  if (to && !ref.extra) for (const dep of new Set(orchestrator.inputTasks(w.roadmap, ref.ms, t).map((x) => x.agentId && roomRef(w, x.agentId)).filter(Boolean))) if (dep !== to) store.emit('handoff', { from: dep, to });
  store.change('state');
  const done = (async () => {
    try {
      await execute(store, ref, agent);
      const h = locate(store, t.id);
      if (h) { h.t.status = 'done'; h.t.finishedAt = Date.now(); }
      const from = roomRef(store.state, agent.id); if (from) store.emit('handoff', { from, to: 'outbox' }); // the deliverable lands in the Outbox
    } catch (e) {
      const h = locate(store, t.id), rm2 = store.state.roadmap; if (!h) return;
      h.t.error = e.message; h.t.attempts = (h.t.attempts || 0) + 1;
      if (e.status === 402 || e.status === 502) { // the model is down or a budget is hit: not the task's fault
        h.t.status = 'todo'; h.t.attempts -= 1;
        if (!rm2.paused) { rm2.paused = true; rm2.pauseKind = e.status === 402 ? 'budget' : 'model'; loop.stop(store.state, e.status === 402 ? 'Daily model budget reached: paused, resumes on its own' : 'The model could not be reached: paused, retrying shortly', e.status === 402 ? 'budget' : 'model'); rm2.resumeAt = Date.now() + (e.status === 402 ? 10 * 60000 : 90000); rm2.pauseReason = e.message; say(store, `I paused the plan: ${e.message}. I will try again on my own${e.status === 402 ? ' once the budget allows' : ' shortly'}.`); }
      } else h.t.status = h.t.attempts >= (h.extra ? 1 : 2) ? 'failed' : 'todo';
    } finally { f.delete(t.id); store.change('state'); }
  })();
  f.set(t.id, { done, agentId: agent.id });
}

async function schedule(store) {
  const w = store.state, rm = w.roadmap, f = fl(store), res = { launched: 0, changed: false };
  if (!rm) return res;
  let slots = slotLimit(store) - f.size;
  const busy = new Set([...f.values()].map((x) => x.agentId));
  if (requeueCarried(store)) res.changed = true;
  for (const x of rm.extras || []) { // carried tasks re-queued above, or any extra waiting for its specialist
    if (x.status !== 'todo' || slots <= 0) continue;
    const a = seated(w, x.role).find((y) => !busy.has(y.id)); if (!a) continue;
    const b = blockedBy(w, rm, x); if (b) continue;
    launch(store, { ms: { title: 'Carried over' }, t: x, extra: true }, a); busy.add(a.id); slots--; res.launched++;
  }
  for (const { ms, t } of orchestrator.eligible(rm)) {
    if (t.owner === 'human') { if (t.status !== 'needs_you') { t.status = 'needs_you'; res.changed = true; } continue; }
    const b = blockedBy(w, rm, t);
    if (b && b.skipped) { t.status = 'skipped'; t.reason = `Skipped because ${station.CONNECTOR_KINDS[b.kind].label} was not connected.`; res.changed = true; continue; }
    if (b) { if (t.status !== 'blocked' || t.blockedBy !== b.kind) { t.status = 'blocked'; t.blockedBy = b.kind; res.changed = true; } continue; }
    if (t.status === 'blocked') { t.status = 'todo'; t.blockedBy = null; res.changed = true; }
    if (slots <= 0) continue;
    const crew = seated(w, t.role);
    if (!crew.length) { t.status = 'failed'; t.attempts = 2; t.error = `There is no ${ROLES[t.role].label} on the team yet.`; res.changed = true; continue; }
    const agent = crew.find((a) => !busy.has(a.id)); if (!agent) continue; // that specialist is busy: the task waits its turn
    launch(store, { ms, t }, agent); busy.add(agent.id); slots--; res.launched++;
  }
  const planDone = rm.milestones.every((m) => m.tasks.every((t) => DONE.has(t.status)));
  if (slots > 0 && !planDone && w.settings.autoDelegate !== false) {
    const idle = Object.values(w.agents).filter((a) => a.role !== 'director' && a.deskId && w.desks[a.deskId] && !busy.has(a.id));
    res.launched += await delegate(store, idle, slots);
  }
  if (res.changed) store.change('state');
  return res;
}

// Idle agents get useful extra work rather than waiting. A connected model writes precise instructions from the team memory;
// offline, the standard task wording is used. Extras are drafts and analysis only: nothing here sends, posts or spends.
async function delegate(store, idle, slots) {
  const w = store.state, rm = w.roadmap; if (!idle.length || slots <= 0) return 0;
  rm.extras = rm.extras || [];
  if (rm.extras.filter((x) => !x.carried).length >= 4 + (Object.keys(w.agents).length - 1) * 2) return 0; // a ceiling on speculative work
  if (guardrails.spentToday(w) >= w.settings.budgets.globalDailyCents * 0.7) return 0;
  const early = !orchestrator.decisionReady(rm), picks = [];
  const doneExtras = memory.ensure(w).extrasDone = memory.ensure(w).extrasDone || [];
  for (const a of idle) { if (picks.length >= slots) break; const p = orchestrator.pickExtra(rm, a, { early, done: doneExtras }); if (p) picks.push({ agent: a, pick: p }); }
  if (!picks.length) return 0;
  if (!providers.isOffline(store) && Date.now() - (rm.delegatedAt || 0) > 20000) {
    rm.delegatedAt = Date.now();
    try {
      const j = await withTimeout(planner.askDirector(store, 'You are the Director. Give each idle agent precise instructions for the extra work below. Reply with JSON only.',
        JSON.stringify({ goal: rm.goal, work: picks.map((x, i) => ({ id: 'a' + i, agent: x.agent.name, role: x.agent.role, task: x.pick.title })),
          rules: ['Return {"assignments":[{"id":"","instructions":""}]}', 'One or two sentences each, specific to the goal, using the team memory and the owner\'s budget.', 'These are drafts and analysis only. Nothing is sent, posted or bought.'] }), 500, 'Delegating extra work'), 15000);
      for (const e of Array.isArray(j && j.assignments) ? j.assignments : []) { const x = picks[Number(String(e.id).slice(1))]; if (x && e.instructions) x.pick.instructions = clip(e.instructions, 400); }
    } catch (_) { /* the standard wording is fine */ }
  }
  for (const { agent, pick } of picks) {
    const x = { id: id('x'), key: pick.key, role: agent.role, task: pick.task, title: pick.title, instructions: pick.instructions, status: 'todo', owner: 'agent', requires: [], optional: [], deliver: [], attempts: 0, extra: true, createdAt: Date.now() };
    rm.extras.push(x); doneExtras.push(agent.role + ':' + pick.key); if (doneExtras.length > 120) doneExtras.splice(0, doneExtras.length - 120); launch(store, { ms: { title: 'Extra work' }, t: x, extra: true }, agent);
  }
  return picks.length;
}

// After a milestone the Director rewrites the team's standing brief, so later work follows what was actually decided.
async function directorSync(store, ms) {
  const w = store.state, rm = w.roadmap, m = memory.ensure(w); if (m.synced.includes(ms.id)) return; m.synced.push(ms.id);
  const next = rm.milestones.find((x) => x.status !== 'done'), st = strategy.current(w);
  const fallback = `${st ? `Stage "${st.title}". ` : ''}Finished: ${rm.milestones.filter((x) => x.status === 'done').map((x) => x.title).join('; ')}.${next ? ` Now: ${next.title}.` : ''} Budget ${money(memory.stageBudget(w))}. Build on the decisions below.`;
  let done = false;
  if (!providers.isOffline(store)) {
    try {
      const j = await withTimeout(planner.askDirector(store, 'You are the Director. Update the standing brief every agent will read. Reply with JSON only.',
        JSON.stringify({ justFinished: ms.title, next: next ? next.title : null, progress: rm.milestones.map((x) => ({ title: x.title, status: x.status })), handoffs: m.handoffs.slice(-8).map((h) => ({ agent: h.agent, title: h.title, text: h.text })),
          rules: ['Return {"brief":"","decisions":[""],"spendPlan":[{"item":"","costCents":0}]}', 'brief: two or three sentences, under 500 characters: what is decided, what matters next, what to avoid.', 'decisions: up to 3 firm choices (niche, offer, price, channel) taken from the handoffs. Do not invent any.', 'spendPlan: only spending the team actually needs, each with an exact cost. The total must stay inside the stage budget. Leave empty if nothing needs money.'] }), 700, 'Briefing the team'), 25000);
      if (j && (j.brief || (j.decisions && j.decisions.length))) { memory.setBrief(w, { brief: j.brief || fallback, decisions: j.decisions, spend: j.spendPlan }); done = true; }
    } catch (_) { /* fall through to the plain brief */ }
  }
  if (!done) memory.setBrief(w, { brief: fallback });
}

// The one real stop condition: verified net profit has reached the target.
const goalReached = (w) => !!w.mission && w.mission.targetCents > 0 && ledger.progress(w).netCents >= w.mission.targetCents;

// Milestone bookkeeping, goal check, and the Director's call when a cycle's work is finished.
async function settle(store) {
  const w = store.state, rm = w.roadmap; if (!rm) return;
  if (rm.status === 'running' && goalReached(w)) { achieve(store); return; }
  const finished = []; let changed = false;
  const open = () => rm.milestones.findIndex((x) => !x.tasks.every((t) => DONE.has(t.status)));
  rm.milestones.forEach((ms, i) => {
    if (ms.tasks.every((t) => DONE.has(t.status))) { if (ms.status !== 'done') { ms.status = 'done'; ms.finishedAt = Date.now(); finished.push(ms); changed = true; } return; }
    const live = i === open() || ms.tasks.some((t) => ['running', 'done', 'needs_you', 'blocked', 'failed'].includes(t.status)), want = live ? 'active' : 'todo';
    if (ms.status !== want) { ms.status = want; changed = true; }
  });
  const all = rm.milestones.every((x) => x.status === 'done');
  for (const ms of finished) {
    const next = rm.milestones.find((x) => x.status !== 'done');
    say(store, `Milestone “${ms.title}” is done.${next ? ` Next up: “${next.title}”.` : ''}`);
    if (!all) await directorSync(store, ms);
  }
  if (!all && rm.status === 'running' && !fl(store).size) changed = workAround(store) || changed;
  else if (rm.idleSince) rm.idleSince = null;
  if (all && rm.status === 'running' && !fl(store).size) { rm.decision = strategy.decision(w); changed = true; if (changed) store.change('state'); await nextCycle(store); return; }
  if (changed) store.change('state');
}

// Nothing is running and everything left waits on the owner (a connection, a key, a step of theirs). After a grace period the Director
// stops waiting: it moves those items to the owner's list, marks them skipped in the plan, and carries on with the next round.
// They stay visible under "Needs you", and the moment the connection exists the task is re-queued on its own.
function workAround(store) {
  const w = store.state, rm = w.roadmap, waiting = [];
  // Work that could start right now means the team is not stuck. Work that is only "todo" behind a blocked step does not count.
  const runnable = orchestrator.eligible(rm).some(({ t }) => t.status === 'todo' && t.owner !== 'human' && !blockedBy(w, rm, t) && seated(w, t.role).length);
  if (runnable) { rm.idleSince = null; return false; }
  for (const ms of rm.milestones) for (const t of ms.tasks) if (['blocked', 'needs_you'].includes(t.status) || (t.status === 'failed' && (t.attempts || 0) >= 2)) waiting.push({ ms, t });
  if (!waiting.length) return false;
  if (!rm.idleSince) { rm.idleSince = Date.now(); return true; }
  const grace = w.settings.waitMinutes == null ? 10 : Math.max(0, Number(w.settings.waitMinutes)); if (Date.now() - rm.idleSince < grace * 60000) return false;
  w.carry = w.carry || [];
  for (const { ms, t } of waiting) {
    if (!w.carry.some((c) => c.title === t.title)) w.carry.push({ id: id('c'), title: t.title, milestone: ms.title, role: t.role, task: t.task, instructions: t.instructions || '', requires: t.requires || [], deliver: t.deliver || [], owner: t.owner, kind: t.owner === 'human' ? 'human' : t.status === 'failed' ? 'failed' : 'blocked', connect: t.blockedBy || (t.requires || [])[0] || null, detail: t.error || '', at: Date.now() });
    t.status = 'skipped'; t.reason = 'Moved on: waiting for you. It stays in your Needs-you list and runs as soon as you have done it.';
  }
  say(store, `I am not going to sit idle. ${waiting.length} item${waiting.length > 1 ? 's' : ''} need${waiting.length > 1 ? '' : 's'} you (${waiting.map((x) => x.t.title).join('; ')}), so I have moved on and kept ${waiting.length > 1 ? 'them' : 'it'} on your list. The team keeps working.`);
  rm.idleSince = null; return true;
}

// Carried items whose connection now exists go back into the team's queue.
function requeueCarried(store) {
  const w = store.state, rm = w.roadmap; if (!rm || !w.carry || !w.carry.length) return false;
  let changed = false;
  for (const c of w.carry.slice()) {
    if (c.owner === 'human' || c.kind === 'failed') continue;
    if (c.requires.length && c.requires.some((k) => !Object.values(w.connectors).some((x) => x.kind === k && x.status === 'ready'))) continue;
    rm.extras = rm.extras || [];
    rm.extras.push({ id: id('x'), key: 'carry', role: c.role, task: c.task, title: c.title, instructions: c.instructions, status: 'todo', owner: 'agent', requires: c.requires, optional: [], deliver: c.deliver, attempts: 0, extra: true, carried: true, createdAt: Date.now() });
    w.carry = w.carry.filter((x) => x.id !== c.id); changed = true;
  }
  return changed;
}
const resolveCarry = (store, cid, how) => { const w = store.state, c = (w.carry || []).find((x) => x.id === cid); assert(c, 'That item is not on your list.', 404); w.carry = w.carry.filter((x) => x.id !== cid); if (how === 'retry' && c.role) { requeueForce(store, c); } store.change('state'); kick(store); };
function requeueForce(store, c) { const rm = store.state.roadmap; if (!rm) return; (rm.extras = rm.extras || []).push({ id: id('x'), key: 'carry', role: c.role, task: c.task, title: c.title, instructions: c.instructions, status: 'todo', owner: 'agent', requires: c.requires, optional: [], deliver: c.deliver, attempts: 0, extra: true, carried: true, createdAt: Date.now() }); }

function achieve(store) {
  const w = store.state, rm = w.roadmap, p = ledger.progress(w);
  rm.status = 'achieved'; rm.paused = false; w.journey.achievedAt = Date.now(); rm.decision = { action: 'goal', reason: `Verified net profit is ${money(p.netCents)}, which reaches the ${money(p.targetCents)} target.` };
  loop.stop(w, 'Goal reached', 'goal');
  say(store, `Goal reached. ${rm.decision.reason} The team is standing down. You can raise the target in Edit goal and I will carry on from here.`);
  store.change('state');
}

// A cycle's summary, kept so the owner (and the Director) can see what each round produced.
function archive(w) {
  const rm = w.roadmap; if (!rm) return;
  const done = rm.milestones.flatMap((m) => m.tasks).filter((t) => t.status === 'done').length;
  (w.cycles = w.cycles || []).push({ n: (w.journey.cycle || 0) + 1, stage: rm.stage || null, milestones: rm.milestones.map((m) => m.title), tasksDone: done, extras: (rm.extras || []).filter((x) => x.status === 'done').length, netCents: ledger.progress(w).netCents, at: Date.now(), decision: rm.decision ? rm.decision.action : null });
  if (w.cycles.length > 30) w.cycles.splice(0, w.cycles.length - 30);
}

// The Director does not stop when the plan is finished: the goal is not reached, so it plans the next round. It moves up the capital
// ladder only when verified profit says so, and otherwise doubles down. It stops for the owner only when it must (see stall guard).
async function nextCycle(store) {
  const w = store.state, rm = w.roadmap, j = w.journey;
  archive(w);
  const offline = providers.isOffline(store), auto = w.settings.autoContinue !== false;
  if (offline || !auto) { // the offline demo model cannot earn anything, so looping would only spin
    rm.status = 'done'; loop.stop(w, offline ? 'Offline demo model: it cannot earn, so the loop stops after one round' : 'Auto-continue is off', 'setting'); say(store, `Every milestone is complete.${rm.decision ? ' ' + rm.decision.reason : ''} ${offline ? 'You are on the offline demo model, so I stop here. Connect a real model and I keep going until the goal is met.' : 'Auto-continue is off. Press "Plan the next phase" to carry on.'}`); store.change('state'); return;
  }
  const real = rm.milestones.flatMap((m) => m.tasks).filter((t) => t.status === 'done' && t.owner !== 'human').length;
  j.stall = real ? 0 : (j.stall || 0) + 1;
  if (j.stall >= 2) { // two rounds with nothing finished means the team is stuck on something only the owner can fix
    loop.stop(w, 'Two rounds finished nothing: it needs something from you', 'owner');
    rm.status = 'done'; rm.paused = true; rm.pauseKind = 'owner'; rm.pauseReason = 'The last two rounds finished no work. Something the team needs (a connection, a key, a step of yours) is missing. Fix it and press Resume.'; say(store, `I paused: ${rm.pauseReason}`); store.change('state'); return;
  }
  const cap = loop.config(w).maxRounds;
  if (cap > 0 && (j.cycle || 0) + 1 >= cap) { rm.status = 'done'; loop.stop(w, `Your cap of ${cap} round${cap === 1 ? '' : 's'} was reached`, 'cap'); say(store, `I have run the ${cap} round${cap === 1 ? '' : 's'} you allowed, so I stop here. Raise the cap in Settings and press Plan the next phase to carry on.`); store.change('state'); return; }
  const d = rm.decision || strategy.decision(w), up = d && d.action === 'advance';
  say(store, `${d ? d.reason : 'The goal is not reached yet.'} ${up ? 'Moving up a stage.' : 'Starting another round.'} I keep the team working until the goal is met.`);
  rm.status = 'cycling'; j.busy = 'cycle'; store.change('state');
  await sleepMs(250); // a beat between rounds keeps a very fast model from churning
  try {
    const learned = await loop.reflect(store, { decision: d, round: (j.cycle || 0) + 1 }).catch(() => []); // Learn: what to do differently next round
    if (learned.length) say(store, `What I learned: ${learned.join(' ')}`);
    if (up) strategy.advance(w);
    j.cycle = (j.cycle || 0) + 1;
    ensureVenture(store);
    await planner.draftMilestones(store);
    planner.buildRoadmapBase(store); const rm2 = store.state.roadmap;
    await Promise.race([planner.tailorRoadmap(store), sleepMs(25000)]);
    rm2.status = 'running'; rm2.paused = false; rm2.startedAt = Date.now(); rm2.approvedAt = Date.now();
    const actions = planner.deployActions(store.state);
    if (actions.length) director.applyPlan(store, actions);
    const st = strategy.current(store.state); memory.setBrief(store.state, { brief: `Round ${j.cycle + 1}${st ? `, stage "${st.title}"` : ''}. ${d ? d.reason : ''} Budget ${money(memory.stageBudget(store.state))}. Do not repeat finished work; build on the decisions and handoffs.` });
    sop.issue(store, { announce: false }); // a fresh SOP for the new round lands in the Outbox
    say(store, `Round ${j.cycle + 1} is planned: ${rm2.milestones.map((m) => m.title).join(' → ')}.`);
  } catch (e) {
    const cur = store.state.roadmap || rm; cur.status = 'running'; cur.paused = true; cur.pauseKind = 'model'; cur.resumeAt = Date.now() + 90000; cur.pauseReason = `I could not plan the next round: ${e.message}`; say(store, cur.pauseReason);
  } finally { j.busy = null; store.change('state'); }
}

function pause(store) { const rm = store.state.roadmap; assert(rm && rm.status === 'running', 'Nothing is running.'); loop.stop(store.state, 'Paused by you', 'owner'); rm.paused = true; rm.pauseKind = 'owner'; rm.pauseReason = 'Paused by you.'; store.change('state'); }
function resume(store) { const rm = store.state.roadmap; assert(rm && rm.status === 'running', 'Nothing to resume.'); rm.paused = false; rm.pauseReason = null; rm.pauseKind = null; store.state.loopStop = null; store.state.journey.stall = 0; for (const x of tasksOf(rm)) if (x.t.status === 'failed' && x.t.attempts >= 2 && !x.t.error) x.t.attempts = 0; store.change('state'); kick(store); }
function retryTask(store, taskId) { const h = locate(store, taskId); assert(h, 'Task not found', 404); h.t.status = 'todo'; h.t.attempts = 0; h.t.error = null; store.state.roadmap.paused = false; store.change('state'); kick(store); }
function completeTask(store, taskId) { const h = locate(store, taskId); assert(h && h.t.owner === 'human', 'Only your own steps can be marked done.'); h.t.status = 'done'; h.t.finishedAt = Date.now(); store.change('state'); kick(store); }
function skipTask(store, taskId) { const h = locate(store, taskId); assert(h, 'Task not found', 404); h.t.status = 'skipped'; h.t.reason = 'Skipped by you.'; store.change('state'); kick(store); }
// New phase: plan again, keeping the team, the rooms and the team memory. With advance, the Director moves up the capital ladder.
function replan(store, { advance = false } = {}) {
  const w = store.state; assert(w.mission, 'Set a goal first.');
  if (advance) { assert(w.strategy && w.strategy.current < w.strategy.stages.length - 1, 'There is no higher stage to move up to.'); strategy.advance(w); }
  if (w.roadmap) archive(w);
  w.journey.cycle = (w.journey.cycle || 0) + 1; w.journey.stall = 0; w.journey.achievedAt = null;
  w.roadmap = null; w.journey.stage = 'milestones'; w.journey.milestones = [];
  return bg(store, 'milestones', () => planner.draftMilestones(store));
}
// Every 20 seconds: restart anything that should be running, and un-pause what stopped for a temporary reason (a model outage or a daily budget).
function tickAll(root) {
  for (const w of Object.values(root.data.worlds)) {
    const rm = w.roadmap; if (!rm || rm.status !== 'running') continue;
    const view = root.forWorld(w.id);
    if (rm.paused && ['model', 'budget'].includes(rm.pauseKind) && Date.now() >= (rm.resumeAt || 0)) {
      if (rm.pauseKind === 'budget' && guardrails.spentToday(w) >= w.settings.budgets.globalDailyCents) { rm.resumeAt = Date.now() + 10 * 60000; continue; }
      rm.paused = false; rm.pauseReason = null; rm.pauseKind = null; view.change('state');
    }
    if (!rm.paused) kick(view);
  }
}

// Everything the UI needs, computed from state.
function view(world) {
  const j = world.journey, rm = world.roadmap;
  const out = { stage: j.stage, busy: j.busy, notice: j.notice, path: j.path || null, pathLabel: j.pathLabel || null, adapted: !!j.adapted,
    milestones: (j.milestones || []).map((m) => ({ id: m.id, key: m.key, title: m.title, why: m.why, days: m.days, tasks: m.tasks.length })), roadmap: rm, setup: null, progress: null, needsYou: [],
    strategy: strategy.view(world), memory: memory.view(world), loop: loop.view(world), cycles: (world.cycles || []).slice(-8).reverse(), achieved: !!(rm && rm.status === 'achieved'), decision: rm ? rm.decision || null : null, cycle: j.cycle || 0,
    extras: rm ? (rm.extras || []).slice(-12).reverse().map((x) => ({ id: x.id, title: x.title, role: x.role, status: x.status, agentName: x.agentName || null, startedAt: x.startedAt || null })) : [] };
  if (rm) {
    const all = tasksOf(rm), done = all.filter((x) => ['done', 'skipped'].includes(x.t.status)).length;
    out.progress = { done, total: all.length, pct: all.length ? Math.round((done / all.length) * 100) : 0, running: all.filter((x) => x.t.status === 'running').map((x) => x.t.id), runningExtras: (rm.extras || []).filter((x) => x.status === 'running').length };
    out.setup = setupView(world);
    for (const { ms, t } of all) {
      if (t.status === 'needs_you') out.needsYou.push({ taskId: t.id, kind: 'human', title: t.title, milestone: ms.title, detail: t.instructions || 'This step is yours.' });
      else if (t.status === 'blocked') out.needsYou.push({ taskId: t.id, kind: 'blocked', title: t.title, milestone: ms.title, connect: t.blockedBy, detail: `Connect ${station.CONNECTOR_KINDS[t.blockedBy].label} to run this task.` });
      else if (t.status === 'failed') out.needsYou.push({ taskId: t.id, kind: 'failed', title: t.title, milestone: ms.title, detail: t.error || 'This task failed.' });
    }
  }
  for (const c of w0carry(world)) out.needsYou.push({ taskId: 'carry:' + c.id, kind: c.kind === 'human' ? 'human' : c.kind, title: c.title, milestone: c.milestone + ' (moved on)', connect: c.connect, carry: c.id, detail: c.kind === 'human' ? (c.instructions || 'This step is yours.') : c.kind === 'blocked' && c.connect ? `Connect ${station.CONNECTOR_KINDS[c.connect].label} and the team runs this on its own.` : (c.detail || 'This task failed.') });
  return out;
}
const w0carry = (world) => world.carry || [];

module.exports = { resolveCarry, workAround, goalReached, nextCycle, achieve, setGoal, generateMilestones, saveMilestones, approveMilestones, generateRoadmap, backToMilestones, removeTask, approveRoadmap, skipRequirement, completeSetup, pause, resume, retryTask, completeTask, skipTask, replan, kick, tickAll, view, pump, schedule, settle, delegate };
