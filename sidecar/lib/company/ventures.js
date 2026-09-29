'use strict';
const { uid, round, DAY } = require('./util');

const STATES = ['IDEA', 'RESEARCH', 'VALIDATION', 'BUILD', 'LAUNCH', 'TRACTION', 'PROFITABLE', 'SCALING',
  'DECLINE', 'RESTRUCTURE', 'PIVOT', 'KILLED'];
const TRANSITIONS = {
  IDEA: ['RESEARCH', 'KILLED'],
  RESEARCH: ['VALIDATION', 'KILLED'],
  VALIDATION: ['BUILD', 'RESEARCH', 'KILLED'],          // RESEARCH = iterate on offer/model
  BUILD: ['LAUNCH', 'KILLED'],
  LAUNCH: ['TRACTION', 'PIVOT', 'KILLED'],
  TRACTION: ['PROFITABLE', 'PIVOT', 'KILLED'],
  PROFITABLE: ['SCALING', 'PIVOT', 'DECLINE', 'KILLED'],
  SCALING: ['PROFITABLE', 'DECLINE', 'KILLED'],
  DECLINE: ['RESTRUCTURE', 'PIVOT', 'KILLED'],
  RESTRUCTURE: ['TRACTION', 'PROFITABLE', 'KILLED'],
  PIVOT: ['RESEARCH', 'VALIDATION', 'KILLED'],
  KILLED: [],
};
const TYPES = ['saas', 'ecommerce', 'agency', 'content', 'digital_product', 'api', 'service', 'other'];

function makeVentures(ctx) {
  const all = () => ctx.db.get('ventures', {});

  function create(o) {
    if (!o || !o.name) throw new Error('venture needs a name');
    const type = TYPES.includes(o.type) ? o.type : 'other';
    const capital = Number(o.capital_allocated) || 0;
    const v = {
      venture_id: uid('venture'), name: o.name, type, status: 'IDEA',
      capital_allocated: capital, revenue: 0, expenses: 0, profit: 0, customers: 0, mrr: 0,
      cac: null, ltv: null, runway_days: null,
      goal: o.goal || '$1,000/month profit', goal_monthly_profit: Number(o.goal_monthly_profit) || 1000,
      kill_conditions: {
        max_loss: capital, max_days_no_revenue: ctx.settings().kill.max_days_no_revenue,
        validation_budget_burn_kill: ctx.settings().kill.validation_budget_burn_kill, ...(o.kill_conditions || {}),
      },
      strategy: o.strategy || {}, kpis: o.kpis || {}, next_action: null,
      opportunity_id: o.opportunity_id || null, model: o.model || null,
      lead_token: uid('tok'), validation_iterations: 0, deployed_url: null,
      created_at: ctx.now(), state_entered_at: ctx.now(), launched_at: null, history: [], active: true,
    };
    all()[v.venture_id] = v; ctx.db.save('ventures');
    ctx.emit('venture.created', { name: v.name, type }, v.venture_id);
    return v;
  }
  const get = (id) => all()[id] || null;
  const list = ({ activeOnly } = {}) => Object.values(all()).filter((v) => !activeOnly || v.active);

  function update(id, patch) {
    const v = get(id); if (!v) throw new Error(`unknown venture ${id}`);
    for (const k of ['name', 'strategy', 'kpis', 'next_action', 'capital_allocated', 'goal', 'goal_monthly_profit',
      'kill_conditions', 'model', 'deployed_url', 'validation_iterations', 'launched_at',
      'revenue', 'expenses', 'profit', 'customers', 'mrr', 'cac', 'ltv', 'runway_days']) {
      if (k in patch) v[k] = patch[k];
    }
    ctx.db.save('ventures'); return v;
  }

  function transition(id, to, reason = '') {
    const v = get(id); if (!v) throw new Error(`unknown venture ${id}`);
    if (!STATES.includes(to)) throw new Error(`unknown state ${to}`);
    if (!TRANSITIONS[v.status].includes(to)) throw new Error(`illegal transition ${v.status} → ${to}`);
    v.history.push({ from: v.status, to, reason, ts: ctx.now() });
    v.status = to; v.state_entered_at = ctx.now();
    if (to === 'LAUNCH') v.launched_at = ctx.now();
    if (to === 'KILLED') { v.active = false; v.next_action = null; }
    ctx.db.save('ventures');
    ctx.emit(`venture.${to.toLowerCase()}`, { reason }, id);
    return v;
  }
  /** The CEO must never keep working a dead business just because tasks remain. */
  const canWork = (id) => { const v = get(id); return Boolean(v && v.active && v.status !== 'KILLED'); };
  const daysInState = (v) => (ctx.now() - v.state_entered_at) / DAY;

  return { create, get, list, update, transition, canWork, daysInState, STATES, TRANSITIONS, TYPES, round };
}
module.exports = { makeVentures, STATES, TRANSITIONS, TYPES };
