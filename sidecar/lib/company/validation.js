'use strict';
const { round } = require('./util');

/** Idea → landing page → offer → traffic → leads → preorders → conversion → decision. */
function makeValidation(ctx) {
  const col = () => ctx.db.get('validation', {});

  function defaultThresholds(budget) {
    const k = Math.max(1, budget / 100);
    return { impressions: Math.round(500 * k), visitors: Math.round(20 * k), leads: Math.max(1, Math.round(5 * k)), purchases: 1 };
  }
  function start(venture_id, { budget, thresholds, days = 14 } = {}) {
    const s = ctx.settings();
    const b = budget || s.ventures.validation_budget;
    const rec = col()[venture_id] = {
      venture_id, budget: b, thresholds: { ...defaultThresholds(b), ...(thresholds || {}) },
      metrics: { impressions: 0, visitors: 0, leads: 0, purchases: 0 }, started: ctx.now(), days,
      baseline: ctx.ledger.summary({ venture_id }).acquisition_costs,
    };
    ctx.ventures.update(venture_id, { strategy: { ...ctx.ventures.get(venture_id).strategy, validation_budget: b } });
    ctx.db.save('validation'); ctx.emit('validation.started', { budget: b }, venture_id);
    return rec;
  }
  function record(venture_id, delta) {
    const r = col()[venture_id]; if (!r) throw new Error('validation not started');
    for (const k of Object.keys(r.metrics)) if (Number.isFinite(delta[k])) r.metrics[k] += delta[k];
    ctx.db.save('validation'); return r.metrics;
  }
  /** BUILD if all thresholds met · ITERATE if partly · KILL if failed · CONTINUE while budget/time remain. */
  function evaluate(venture_id) {
    const r = col()[venture_id]; if (!r) return { decision: 'NONE', reason: 'validation not started' };
    const v = ctx.ventures.get(venture_id);
    const met = {}; let n = 0;
    for (const k of Object.keys(r.thresholds)) { met[k] = r.metrics[k] >= r.thresholds[k]; if (met[k]) n++; }
    const spent = round(ctx.ledger.summary({ venture_id }).acquisition_costs - (r.baseline || 0));
    const burn = r.budget > 0 ? spent / r.budget : 0;
    const expired = ctx.now() - r.started > r.days * 86400000;
    const funnel = {
      visit_rate: r.metrics.impressions ? round(r.metrics.visitors / r.metrics.impressions, 4) : null,
      lead_rate: r.metrics.visitors ? round(r.metrics.leads / r.metrics.visitors, 4) : null,
      purchase_rate: r.metrics.leads ? round(r.metrics.purchases / r.metrics.leads, 4) : null,
    };
    const base = { met, met_count: n, of: 4, metrics: r.metrics, thresholds: r.thresholds, budget_used: round(burn, 3), spent, funnel };
    if (n === 4) return { ...base, decision: 'BUILD', reason: 'all validation thresholds met' };
    const s = ctx.settings();
    const earlyKill = burn >= s.kill.validation_budget_burn_kill && r.metrics.visitors < r.thresholds.visitors * 0.5;
    if (earlyKill) return { ...base, decision: 'KILL', reason: `${Math.round(burn * 100)}% of test budget used with under half the visitor threshold` };
    if (burn >= 1 || expired) {
      if (n >= 2 && v.validation_iterations < s.ventures.max_validation_iterations) {
        return { ...base, decision: 'ITERATE', reason: `${n}/4 thresholds met – change offer, price or channel and re-test` };
      }
      return { ...base, decision: 'KILL', reason: n >= 2 ? 'iteration limit reached' : `only ${n}/4 thresholds met` };
    }
    return { ...base, decision: 'CONTINUE', reason: 'test budget and time remain' };
  }
  /** After ITERATE: fresh test with a fresh (smaller-or-equal) budget; counters reset, iteration count rises. */
  function iterate(venture_id, { budget } = {}) {
    const v = ctx.ventures.get(venture_id);
    ctx.ventures.update(venture_id, { validation_iterations: v.validation_iterations + 1 });
    return start(venture_id, { budget: budget || col()[venture_id].budget });
  }
  return { start, record, evaluate, iterate, get: (id) => col()[id] || null, defaultThresholds };
}
module.exports = { makeValidation };
