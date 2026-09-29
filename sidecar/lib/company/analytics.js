'use strict';
const { uid, round, DAY } = require('./util');

function makeAnalytics(ctx) {
  const A = () => ctx.db.get('agentstats', {});

  // ---- agent performance ----
  function recordTask({ agent_id, task_id, ok, cost = 0, tokens = 0, ms = 0, quality = null, rework = false, revenue_generated = 0, revenue_influenced = 0 }) {
    const s = A()[agent_id] = A()[agent_id] || { agent_id, completed: 0, failed: 0, cost: 0, tokens: 0, ms: 0, quality_sum: 0, quality_n: 0, rework: 0, revenue_generated: 0, revenue_influenced: 0 };
    s[ok ? 'completed' : 'failed']++; s.cost += cost; s.tokens += tokens; s.ms += ms; if (rework) s.rework++;
    if (quality !== null) { s.quality_sum += quality; s.quality_n++; }
    s.revenue_generated += revenue_generated; s.revenue_influenced += revenue_influenced;
    ctx.db.save('agentstats');
    ctx.permissions.recordOutcome(agent_id, ok);   // feeds the trust system
  }
  function agentReport() {
    return Object.values(A()).map((s) => {
      const n = s.completed + s.failed;
      return { agent_id: s.agent_id, tasks_completed: s.completed, tasks_failed: s.failed, success_rate: n ? round(s.completed / n, 3) : null,
        cost: round(s.cost), tokens: s.tokens, avg_ms: n ? Math.round(s.ms / n) : null, quality: s.quality_n ? round(s.quality_sum / s.quality_n, 2) : null,
        rework_rate: s.completed ? round(s.rework / s.completed, 3) : null, revenue_generated: round(s.revenue_generated), revenue_influenced: round(s.revenue_influenced),
        roi: s.cost > 0 ? round((s.revenue_generated - s.cost) / s.cost, 2) : null, trust_tier: ctx.permissions.tier(s.agent_id) };
    }).sort((a, b) => (b.revenue_generated - b.cost) - (a.revenue_generated - a.cost));
  }
  /** Give more work to what actually works: weighted pick among candidates. */
  function pickAgent(candidates) {
    const rep = Object.fromEntries(agentReport().map((r) => [r.agent_id, r]));
    const w = candidates.map((id) => { const r = rep[id]; return r && r.success_rate !== null ? 0.2 + r.success_rate * (1 + (r.quality || 0.5) / 2) : 1; });
    const total = w.reduce((a, b) => a + b, 0); let x = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) { x -= w[i]; if (x <= 0) return candidates[i]; }
    return candidates[candidates.length - 1];
  }

  // ---- CEO dashboard ----
  function dashboard() {
    const led = ctx.ledger.summary();
    const vs = ctx.ventures.list();
    const active = vs.filter((v) => v.active);
    const st = agentReport();
    const evs = ctx.db.get('events', []).filter((e) => e.ts > ctx.now() - 30 * DAY);
    const p = ctx.db.get('portfolio', { total_capital: 0 });
    const perVenture = vs.map((v) => ({ venture_id: v.venture_id, name: v.name, status: v.status, profit: ctx.ledger.summary({ venture_id: v.venture_id }).contribution_profit }));
    const pipe = active.reduce((a, v) => { const x = ctx.crm.pipeline(v.venture_id); return { leads: a.leads + x.leads, qualified: a.qualified + (x.qualified || 0), customers: a.customers + x.customers }; }, { leads: 0, qualified: 0, customers: 0 });
    return {
      portfolio: { capital: p.total_capital, revenue: led.net_revenue, expenses: led.total_costs, profit: led.contribution_profit, cash: led.available_cash, unverified_entries: led.unverified_entries },
      ventures: perVenture, pipeline: pipe,
      system: { agents: st.length, tasks: st.reduce((s, r) => s + r.tasks_completed + r.tasks_failed, 0), failed: st.reduce((s, r) => s + r.tasks_failed, 0),
        ai_cost: led.ai_costs, pending_approvals: ctx.permissions.pending().length, autopilot_paused: ctx.db.get('autopilot', {}).paused || null },
      recent_events: evs.length,
    };
  }

  /** "What happened while you were away?" – built only from recorded events and the verified ledger. */
  function briefing(since = ctx.now() - DAY) {
    const evs = ctx.db.get('events', []).filter((e) => e.ts >= since);
    const n = (t) => evs.filter((e) => e.type === t).length;
    const led = ctx.ledger.summary({ since });
    const attention = [];
    for (const e of evs) if (/^(alert|deploy\.down|payment\.failed|webhook\.failed|autopilot\.paused|kill\.)/.test(e.type)) attention.push({ type: e.type, venture_id: e.venture_id, detail: e.data });
    for (const v of ctx.ventures.list({ activeOnly: true })) {
      const risks = ctx.crm.retentionRisks(v.venture_id); if (risks.length) attention.push({ type: 'retention', venture_id: v.venture_id, detail: `${risks.length} customers at risk` });
    }
    return {
      since, done: { opportunities_found: evs.filter((e) => e.type === 'opportunity.found').reduce((s, e) => s + (e.data.count || 0), 0),
        ventures_created: n('venture.created'), tested: n('validation.started'), launched: n('venture.launch'), leads: n('crm.lead'),
        sales: n('crm.won'), revenue: led.net_revenue, expenses: led.total_costs, profit: led.contribution_profit },
      attention, recommendations: ctx.db.get('recommendations', []).filter((r) => r.status === 'open'),
      pending_approvals: ctx.permissions.pending(),
    };
  }
  return { recordTask, agentReport, pickAgent, dashboard, briefing };
}
module.exports = { makeAnalytics };
