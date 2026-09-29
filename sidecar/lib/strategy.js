'use strict';
// The capital ladder. The Director does not marry one business idea: it starts with the cheapest, fastest route to real
// cash that fits the owner's capital, then reinvests verified profit into something bigger, stage by stage, until the goal.
// Numbers here are computed in code (targets, budgets), so a model can propose ideas but can never grant itself money.
const { money } = require('./util');
const ledger = require('./ledger');

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const nice = (cents) => { const d = cents / 100; if (d < 10) return Math.max(100, Math.round(cents / 100) * 100); return Math.round(Number(d.toPrecision(2)) * 100); };
const round5 = (c) => Math.round(c / 500) * 500;
const REINVEST = 0.6; // share of what is available that a later stage may commit

// The first stage is an experiment: small capital is used in full, larger capital only in part.
function firstBudget(cap, risk) {
  if (cap <= 0) return 0;
  const base = risk > 0 ? Math.min(cap, risk) : cap;
  return base <= 10000 ? base : Math.max(10000, round5(base * 0.5));
}
function stageCount(cap, target) {
  const base = Math.max(cap, 2000); if (target <= base * 2) return 1;
  return Math.max(2, Math.min(4, Math.ceil(Math.log10(target / base)) + 1));
}

function draft(world, { pathLabel, path } = {}) {
  const m = world.mission, cap = m.capitalCents || 0, target = m.targetCents, base = Math.max(cap, 2000), n = stageCount(cap, target);
  const stages = [];
  for (let i = 0; i < n; i++) {
    const t = i === n - 1 ? target : Math.min(target - 1, nice(base * Math.pow(target / base, (i + 1) / n)));
    const prev = stages.length ? stages[stages.length - 1].targetCents : 0;
    const first = i === 0, last = i === n - 1 && n > 1;
    stages.push({
      id: 'st' + (i + 1), path: first ? (path || null) : null,
      title: n === 1 ? `Build and prove: ${pathLabel || 'the business'}` : first ? `Bootstrap: ${pathLabel || 'first venture'}` : last ? 'Scale toward the goal' : 'Reinvest into what worked',
      thesis: first ? 'Get to the first verified cash with the smallest possible spend. Free and direct methods come before anything paid.'
        : last ? 'Use the accumulated profit on the biggest proven lever, or add a larger venture that shares the same audience.'
        : 'Put part of the profit back into the channel and offer that earned it. Add a second offer only if the first proved real demand.',
      targetCents: Math.max(t, prev + 100), budgetCents: first ? firstBudget(cap, m.riskCents || 0) : null
    });
  }
  stages[stages.length - 1].targetCents = target;
  return { stages, current: 0, rule: `Reinvest up to ${Math.round(REINVEST * 100)}% of what is available into the next stage, and only after verified profit reaches the stage target.` };
}

// A model may propose ideas (title, thesis, venture type, first-stage budget). Targets and every other budget stay in code.
function validate(raw, world, fallback, pathKeys = []) {
  try {
    const list = raw && Array.isArray(raw.stages) ? raw.stages : null;
    if (!list || list.length < 1 || list.length > 4) return fallback;
    const cap = world.mission.capitalCents || 0, base = draft(world, {}), out = [];
    // keep the fallback's staging depth when the model's differs wildly, but honour its ideas stage by stage
    list.forEach((e, i) => {
      const title = clip(e && e.title, 60); if (title.length < 3) throw new Error('bad stage title');
      const fb = fallback.stages[Math.min(i, fallback.stages.length - 1)];
      const target = list.length === fallback.stages.length ? fallback.stages[i].targetCents : (i === list.length - 1 ? world.mission.targetCents : base.stages[Math.min(i, base.stages.length - 1)].targetCents);
      out.push({ id: 'st' + (i + 1), title, thesis: clip(e.thesis, 240) || fb.thesis, path: pathKeys.includes(e.path) ? e.path : (i === 0 ? fallback.stages[0].path : null),
        targetCents: target, budgetCents: null });
    });
    for (let i = 1; i < out.length; i++) if (out[i].targetCents <= out[i - 1].targetCents) out[i].targetCents = out[i - 1].targetCents + 100;
    out[out.length - 1].targetCents = world.mission.targetCents;
    const asked = Math.round(Number(list[0].startBudgetCents));
    out[0].budgetCents = Math.max(0, Math.min(Number.isFinite(asked) ? asked : firstBudget(cap, world.mission.riskCents || 0), cap, world.mission.riskCents > 0 ? Math.max(world.mission.riskCents, 0) : cap));
    return { stages: out, current: 0, rule: fallback.rule };
  } catch (_) { return fallback; }
}

// The owner edited the goal numbers: keep the ideas, recompute targets and the first budget from the new numbers.
function refresh(world) {
  const s = world.strategy; if (!s || !world.mission) return;
  const d = draft(world, {});
  if (d.stages.length === s.stages.length) s.stages.forEach((st, i) => { st.targetCents = d.stages[i].targetCents; });
  s.stages[s.stages.length - 1].targetCents = world.mission.targetCents;
  if ((s.current || 0) === 0) s.stages[0].budgetCents = d.stages[0].budgetCents;
}

const current = (world) => world.strategy && world.strategy.stages ? world.strategy.stages[Math.min(world.strategy.current || 0, world.strategy.stages.length - 1)] || null : null;

// What a stage may commit: its own cap if it has one, otherwise a share of what is available now. Never more than is available.
function stageBudgetCents(world, st) {
  const m = world.mission, avail = Math.max(0, (m.capitalCents || 0) + ledger.progress(world).netCents);
  if (st && st.budgetCents != null) return Math.min(st.budgetCents, avail);
  return Math.min(avail, round5(avail * REINVEST));
}

// At the end of a roadmap the Director decides: move up, or run another cycle on the same stage.
function decision(world) {
  const s = world.strategy, st = current(world); if (!s || !st) return null;
  const net = ledger.progress(world).netCents, idx = s.current || 0, last = idx >= s.stages.length - 1, next = s.stages[idx + 1];
  if (net >= st.targetCents) {
    if (last) return { action: 'goal', reason: `Verified net profit is ${money(net)}. That reaches the stage target of ${money(st.targetCents)}, and this was the last stage.` };
    return { action: 'advance', reason: `Verified net profit is ${money(net)}, past this stage's ${money(st.targetCents)}. Move up to "${next.title}" and reinvest up to ${Math.round(REINVEST * 100)}% of what is available.` };
  }
  return { action: 'iterate', reason: net > 0
    ? `Verified net profit is ${money(net)} of this stage's ${money(st.targetCents)}. Run another cycle that doubles down on what earned before moving up.`
    : `No verified profit yet (${money(net)}). Nothing moves up until real, verified money comes in. Next cycle: read the numbers, double down, and stay inside the budget.` };
}
function advance(world) {
  const s = world.strategy; if (!s) return null;
  if (s.current < s.stages.length - 1) { s.stages[s.current].doneAt = Date.now(); s.current++; }
  return current(world);
}
const view = (world) => {
  const s = world.strategy; if (!s) return null;
  return { current: s.current || 0, rule: s.rule, stages: s.stages.map((st, i) => ({ ...st, status: i < (s.current || 0) ? 'done' : i === (s.current || 0) ? 'active' : 'next', budgetNowCents: i <= (s.current || 0) ? stageBudgetCents(world, st) : null })) };
};

module.exports = { draft, validate, refresh, current, stageBudgetCents, decision, advance, view, firstBudget, REINVEST };
