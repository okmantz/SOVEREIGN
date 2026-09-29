'use strict';
const { round, DAY, uid } = require('./util');

/**
 * The CEO manages the business, not tasks. Policy is deterministic and data-driven (the model only helps with
 * discovery/research/copy elsewhere), so decisions are explainable, testable, and can't be talked out of a kill rule.
 * CEO → CFO → budget engine → permission engine → action.
 */
function makeCeo(ctx) {
  const RECS = () => ctx.db.get('recommendations', []);
  const ACTIVE_STATES = ['IDEA', 'RESEARCH', 'VALIDATION', 'BUILD', 'LAUNCH', 'TRACTION', 'PROFITABLE', 'SCALING', 'DECLINE', 'RESTRUCTURE', 'PIVOT'];

  /** Recompute venture KPIs from the verified ledger + CRM. */
  function refresh(id) {
    const v = ctx.ventures.get(id);
    const s = ctx.ledger.summary({ venture_id: id }); const m = ctx.ledger.monthly(id);
    const cust = ctx.crm.customers(id); const live = cust.filter((c) => !c.churned);
    const mrr = live.reduce((a, c) => a + c.mrr, 0);
    const churn = cust.length ? Math.max(0.05, cust.filter((c) => c.churned).length / cust.length) : 0.08;
    const arpa = live.length ? (mrr > 0 ? mrr / live.length : s.net_revenue / Math.max(1, cust.length)) : 0;
    const gm = s.gross_margin ?? 1;
    const dailyGross = m.total_costs / 30;
    return ctx.ventures.update(id, {
      revenue: s.net_revenue, expenses: s.total_costs, profit: s.contribution_profit, customers: live.length, mrr: round(mrr),
      cac: cust.length ? round(s.acquisition_costs / cust.length) : null,
      ltv: arpa > 0 ? round(arpa * Math.min(36, 1 / churn) * gm) : null,
      runway_days: dailyGross > 0 ? Math.floor(s.available_cash / dailyGross) : null,
      kpis: { ...v.kpis, monthly_profit: m.contribution_profit, monthly_revenue: m.net_revenue, contribution_margin: s.contribution_margin },
    });
  }

  // ---- kill rules: no vote, no LLM, no roadmap can override ----
  function killVenture(id, reason, rule = false) {
    const v = ctx.ventures.get(id); if (!v || !v.active) return null;
    ctx.ventures.transition(id, 'KILLED', reason); ctx.cfo.release(id); ctx.directives.cancelFor(id);
    ctx.memory.remember(id, 'strategy', `KILLED: ${reason}`, { profit: v.profit, revenue: v.revenue });
    ctx.emit(rule ? 'kill.rule' : 'kill.ceo', { reason, name: v.name }, id); return v;
  }
  function enforceKillRules() {
    const killed = [];
    for (const v0 of ctx.ventures.list({ activeOnly: true })) {
      const v = refresh(v0.venture_id); const kc = v.kill_conditions;
      const limit = kc.max_loss > 0 ? kc.max_loss : v.capital_allocated * ctx.settings().kill.max_loss_pct;
      const loss = -v.profit;
      if (limit > 0 && loss >= limit) { killVenture(v.venture_id, `verified loss $${round(loss)} reached limit $${round(limit)}`, true); killed.push(v.venture_id); continue; }
      if (['LAUNCH', 'TRACTION'].includes(v.status) && v.launched_at && v.revenue <= 0 && (ctx.now() - v.launched_at) / DAY > kc.max_days_no_revenue) {
        killVenture(v.venture_id, `no verified revenue ${kc.max_days_no_revenue} days after launch`, true); killed.push(v.venture_id);
      }
    }
    const pl = ctx.cfo.portfolioLoss();
    if (pl.breached) {
      ctx.autopilot && ctx.autopilot.pause(`portfolio loss limit reached ($${pl.loss} ≥ $${pl.max_loss})`);
      for (const v of ctx.ventures.list({ activeOnly: true })) if (v.profit < 0) { killVenture(v.venture_id, 'portfolio loss limit', true); killed.push(v.venture_id); }
    }
    return killed;
  }

  // ---- the twelve questions, answered from data ----
  function answers(id) {
    const v = refresh(id); const opp = v.opportunity_id ? ctx.opportunities.get(v.opportunity_id) : null;
    const val = ctx.validation.get(id); const why = ctx.crm.whyNotGrowing(id); const snap = ctx.cfo.snapshot(id);
    const ratio = v.cac && v.ltv ? round(v.ltv / v.cac, 2) : null;
    const growthOk = ratio !== null && ratio >= 3 && snap.profit > 0;
    return {
      what_business: v.name, worth_pursuing: opp && opp.scorecard ? { score: opp.scorecard.score, confidence: opp.scorecard.confidence } : 'unscored',
      cost_to_test: val ? { budget: val.budget, thresholds: val.thresholds } : { budget: v.strategy.validation_budget || ctx.settings().ventures.validation_budget },
      revenue_model: v.model ? `${v.model.label} at $${v.model.price} ${v.model.unit}` : 'undefined',
      mvp: v.strategy.mvp || 'not defined', first_customers: ctx.crm.conversionBy('source', id).slice(0, 3),
      preventing_revenue: v.revenue > 0 ? 'n/a – revenue exists' : why.blocker, agents_next: v.next_action,
      profitable: { verified_profit: v.profit, monthly_profit: snap.profit, is_profitable: snap.profit > 0 },
      increase_spending: growthOk ? `yes – LTV/CAC ${ratio} with positive contribution` : ratio !== null ? `no – LTV/CAC ${ratio}` : 'unknown – not enough customer data',
      pivot: v.status === 'LAUNCH' && v.launched_at && (ctx.now() - v.launched_at) / DAY > 30 && v.revenue <= 0,
      shut_down: v.profit < 0 && -v.profit >= 0.7 * (v.kill_conditions.max_loss || Infinity),
    };
  }

  // ---- per-stage review ----
  const task = (role, t, description, priority = 'normal') => ({ role, task: t, description, priority });
  function review(id) {
    const v = refresh(id); const s = ctx.settings(); const days = ctx.ventures.daysInState(v); const m = ctx.ledger.monthly(id);
    const goal = v.goal_monthly_profit; const opp = v.opportunity_id ? ctx.opportunities.get(v.opportunity_id) : null;
    const d = (action, reason, next_action = null, extra = {}) => ({ venture_id: id, status: v.status, action, reason, next_action, ...extra });
    switch (v.status) {
      case 'IDEA': return d('ADVANCE', 'start research', task('Research', 'Research market, competitors and pricing', `Validate demand for: ${v.name}. Collect competitor count, pricing, and 5 pieces of demand evidence.`), { to: 'RESEARCH' });
      case 'RESEARCH': {
        const sc = opp && opp.scorecard;
        if (sc && sc.score < 40) return d('KILL', `opportunity score ${sc.score} is below 40`);
        if (sc && sc.score >= s.ventures.min_opportunity_score && sc.confidence !== 'low' && v.model) return d('ADVANCE', `score ${sc.score} (${sc.confidence} confidence)`, null, { to: 'VALIDATION' });
        return d('CONTINUE', 'need a confident scorecard and a chosen business model', task('Research', 'Measure competition and pick the business model', 'Count direct competitors, record their pricing, and recommend one of the generated business models.'));
      }
      case 'VALIDATION': {
        if (!ctx.validation.get(id)) return d('ADVANCE_SELF', 'start validation test', null, { to: 'VALIDATION', start_validation: true });
        const r = ctx.validation.evaluate(id);
        if (r.decision === 'BUILD') return d('ADVANCE', r.reason, null, { to: 'BUILD', validation: r });
        if (r.decision === 'KILL') return d('KILL', r.reason, null, { validation: r });
        if (r.decision === 'ITERATE') return d('ITERATE', r.reason, task('Copywriter', 'Test a new offer/price/channel', 'Change one variable (offer, price or channel) and re-run the validation test.'), { validation: r });
        const t = r.metrics.visitors < r.thresholds.visitors ? task('Marketing', 'Drive validation traffic', `Need ${r.thresholds.visitors - r.metrics.visitors} more visitors. Use direct outreach and small paid tests within the test budget.`)
          : r.metrics.leads < r.thresholds.leads ? task('Copywriter', 'Improve landing page conversion', `Visitors are arriving but only ${r.metrics.leads}/${r.thresholds.leads} leads. Improve headline, offer and CTA.`)
            : task('Sales', 'Convert leads to preorders', 'Follow up with every lead; ask for a preorder.');
        return d('CONTINUE', r.reason, t, { validation: r });
      }
      case 'BUILD':
        if (v.deployed_url && (ctx.deploy.monitors().find((x) => x.venture_id === id) || {}).up) return d('ADVANCE', 'deployed and verified', null, { to: 'LAUNCH' });
        return d('CONTINUE', 'MVP not deployed yet', task('Developer', 'Build and deploy the MVP', `Ship the smallest product that delivers: ${v.strategy.mvp || v.name}. Tests must pass; deploy must verify.`, 'high'));
      case 'LAUNCH':
        if (v.customers >= 1 || v.revenue > 0) return d('ADVANCE', 'first customer / revenue', null, { to: 'TRACTION' });
        if (days > 30) return d('PIVOT', `30+ days since launch with no revenue`, ctx.crm.whyNotGrowing(id).findings[0] ? task('Sales', ctx.crm.whyNotGrowing(id).findings[0].fix, ctx.crm.whyNotGrowing(id).findings[0].detail) : null);
        return d('CONTINUE', 'acquiring first customers', task('Sales', 'Acquire first customers', `Blocker: ${ctx.crm.whyNotGrowing(id).blocker}. Work the funnel.`, 'high'));
      case 'TRACTION':
        if (m.contribution_profit > 0 && m.net_revenue >= goal * 0.25) return d('ADVANCE', 'positive monthly contribution', null, { to: 'PROFITABLE' });
        if (days > 60 && m.contribution_profit <= 0) return d('PIVOT', '60+ days in traction without profit');
        return d('CONTINUE', 'growing toward profitability', task('Marketing', 'Scale the best-converting channel', (ctx.memory.lessons(id)[0] || 'Double down on the channel with the lowest CAC.')));
      case 'PROFITABLE':
        if (m.contribution_profit < 0) return d('ADVANCE', 'monthly contribution turned negative', null, { to: 'DECLINE' });
        if (m.contribution_profit >= goal) return d('SCALE', `monthly profit $${round(m.contribution_profit)} ≥ goal $${goal}`, task('Marketing', 'Scale acquisition', 'Increase spend on channels with LTV/CAC ≥ 3.'));
        return d('CONTINUE', 'profitable; optimizing', task('Analyst', 'Optimize pricing and churn', 'Find the largest contribution-margin lever.'));
      case 'SCALING': {
        const prev = v.kpis.prev_monthly_profit; ctx.ventures.update(id, { kpis: { ...v.kpis, prev_monthly_profit: m.contribution_profit } });
        if (m.contribution_profit < 0 || (prev !== undefined && m.contribution_profit < prev * 0.7)) return d('ADVANCE', 'profit falling while scaling', null, { to: 'DECLINE' });
        return d('CONTINUE', 'scaling', task('Marketing', 'Continue scaling', 'Hold spend at LTV/CAC ≥ 3.'));
      }
      case 'DECLINE':
        return days > 60 ? d('KILL', 'in decline 60+ days') : d('ADVANCE', 'cut costs and restructure', task('Finance', 'Cut spend 50% and fix churn', 'Pause paid channels; keep only profitable ones.'), { to: 'RESTRUCTURE' });
      case 'RESTRUCTURE':
        if (m.contribution_profit > 0) return d('ADVANCE', 'restructure worked', null, { to: 'PROFITABLE' });
        return days > 45 ? d('KILL', 'restructure did not restore profit in 45 days') : d('CONTINUE', 'restructuring');
      case 'PIVOT': {
        const tried = v.model && v.model.type; const alt = (opp ? opp.models : []).find((x) => x.type !== tried);
        return d('ADVANCE', alt ? `retry with ${alt.label}` : 'return to research', null, { to: 'RESEARCH', new_model: alt || null });
      }
      default: return d('NONE', 'inactive');
    }
  }

  const HUMAN_ALWAYS = new Set(['PIVOT', 'SCALE']);
  const HUMAN_APPROVAL_ONLY = new Set(['BUILD', 'LAUNCH']);
  function needsHuman(dec, v) {
    if (HUMAN_ALWAYS.has(dec.action)) return true;
    if (dec.action === 'KILL') return v.revenue > 0;
    if (dec.to && HUMAN_APPROVAL_ONLY.has(dec.to) && ctx.settings().autonomy === 'approval_only') return true;
    return false;
  }
  function recommend(dec, summary) {
    const dup = RECS().find((r) => r.status === 'open' && r.venture_id === dec.venture_id && r.action === (dec.to || dec.action));
    if (dup) return dup;
    const a = ctx.permissions.queueApproval({ type: 'recommendation', venture_id: dec.venture_id, summary, payload: { action: dec.action, to: dec.to, new_model: dec.new_model } });
    const r = { id: uid('rec'), venture_id: dec.venture_id, action: dec.to || dec.action, summary, reason: dec.reason, approval_id: a.id, status: 'open', created: ctx.now() };
    RECS().push(r); ctx.db.save('recommendations'); return r;
  }
  function execute(dec, { human = false } = {}) {
    const id = dec.venture_id; const v = ctx.ventures.get(id); if (!v || !v.active) return { skipped: 'inactive' };
    if (dec.start_validation) { ctx.validation.start(id, { budget: v.strategy.validation_budget }); return { started: 'validation' }; }
    if (dec.action === 'KILL') { killVenture(id, dec.reason); return { killed: true }; }
    if (dec.action === 'ITERATE') { ctx.validation.iterate(id); ctx.ventures.transition(id, 'RESEARCH', dec.reason); ctx.ventures.transition(id, 'VALIDATION', 're-test'); }
    if (dec.action === 'SCALE') { ctx.ventures.transition(id, 'SCALING', dec.reason); }
    else if (dec.to && dec.to !== v.status) {
      if (dec.new_model) ctx.ventures.update(id, { model: dec.new_model });
      ctx.ventures.transition(id, dec.to, dec.reason);
      if (dec.to === 'VALIDATION' && !ctx.validation.get(id)) ctx.validation.start(id, { budget: v.strategy.validation_budget });
    }
    if (dec.next_action) { const cur = ctx.ventures.get(id).status; ctx.ventures.update(id, { next_action: dec.next_action }); ctx.directives.add({ venture_id: id, ...dec.next_action }); void cur; }
    return { applied: dec.action, to: ctx.ventures.get(id).status };
  }

  /** One management pass over the whole portfolio. Safe to call repeatedly. */
  function tick() {
    const report = { killed: enforceKillRules(), decisions: [], recommended: [], discover: null };
    for (const v of ctx.ventures.list({ activeOnly: true })) {
      let dec; try { dec = review(v.venture_id); } catch (e) { report.decisions.push({ venture_id: v.venture_id, error: e.message }); continue; }
      if (needsHuman(dec, ctx.ventures.get(v.venture_id))) { const r = recommend(dec, `${v.name}: ${dec.action}${dec.to ? ` → ${dec.to}` : ''} — ${dec.reason}`); report.recommended.push(r.id); }
      else { try { execute(dec); } catch (e) { dec.error = e.message; } }
      report.decisions.push({ venture_id: v.venture_id, action: dec.action, to: dec.to, reason: dec.reason, error: dec.error });
      const bs = budgetSignal(v.venture_id); if (bs) report.recommended.push(bs.id);
    }
    report.discover = discover();
    return report;
  }

  /** Should we increase / decrease spending? LTV/CAC and contribution decide. */
  function budgetSignal(id) {
    const v = ctx.ventures.get(id); if (!v || !v.cac || !v.ltv) return null;
    const ratio = v.ltv / v.cac; const snap = ctx.cfo.snapshot(id);
    if (ratio >= 3 && snap.profit > 0 && ['TRACTION', 'PROFITABLE', 'SCALING'].includes(v.status)) {
      const to = round(v.capital_allocated * 1.5);
      return recommend({ venture_id: id, action: 'INCREASE_BUDGET', reason: `LTV/CAC ${round(ratio, 1)} with positive contribution` }, `${v.name}: increase allocation $${v.capital_allocated} → $${to} (LTV/CAC ${round(ratio, 1)})`);
    }
    if (ratio < 1 && ctx.ledger.summary({ venture_id: id }).acquisition_costs >= 50) ctx.directives.add({ venture_id: id, role: 'Marketing', task: 'Pause paid acquisition', description: `LTV/CAC is ${round(ratio, 2)} – paid channels lose money.`, priority: 'high' });
    return null;
  }

  /** Opportunity Discovery → Business Selection. Creates (or proposes) a venture when there is a free slot and budget. */
  function discover() {
    const s = ctx.settings();
    const open = ctx.ventures.list({ activeOnly: true }).length;
    if (open >= s.ventures.max_active) return { skipped: 'max active ventures reached' };
    const plan = ctx.cfo.plan(); const budget = s.ventures.validation_budget;
    if (plan.unallocated < budget) return { skipped: `unallocated capital $${plan.unallocated} < test budget $${budget}` };
    const cand = ctx.opportunities.list({ status: 'scored' }).find((o) => o.scorecard.score >= s.ventures.min_opportunity_score && o.scorecard.confidence !== 'low');
    if (!cand) return { skipped: 'no scored opportunity clears the bar with at least medium confidence' };
    const models = cand.models.length ? cand.models : ctx.opportunities.generateModels(cand.id);
    const payload = { opportunity_id: cand.id, model_type: models[0].type, budget };
    if (s.autonomy === 'approval_only') {
      const a = ctx.permissions.queueApproval({ type: 'venture_create', summary: `Launch validation for "${cand.title}" as ${models[0].label}, test budget $${budget} (score ${cand.scorecard.score})`, payload });
      ctx.opportunities.setStatus(cand.id, 'proposed'); return { proposed: a.id };
    }
    return { created: createFromOpportunity(payload).venture_id };
  }
  function createFromOpportunity({ opportunity_id, model_type, budget }) {
    const o = ctx.opportunities.get(opportunity_id); const model = (o.models.length ? o.models : ctx.opportunities.generateModels(opportunity_id)).find((m) => m.type === model_type) || o.models[0];
    const v = ctx.ventures.create({ name: o.title.slice(0, 80), type: model.type === 'leadgen' ? 'service' : model.type, capital_allocated: budget, opportunity_id, model,
      strategy: { validation_budget: budget, mvp: `Landing page + ${model.label} offer at $${model.price} ${model.unit}` } });
    ctx.cfo.fund(v.venture_id, budget); ctx.opportunities.setStatus(opportunity_id, 'ventured');
    ctx.memory.remember(v.venture_id, 'market', `Opportunity: ${o.problem}`, { evidence: o.evidence.length, score: o.scorecard && o.scorecard.score });
    return v;
  }

  /** Called when a human resolves an approval. */
  async function onApproval(a) {
    if (a.status !== 'approved') { const r = RECS().find((x) => x.approval_id === a.id); if (r) { r.status = 'rejected'; ctx.db.save('recommendations'); } if (a.type === 'venture_create') ctx.opportunities.setStatus(a.payload.opportunity_id, 'scored'); return { rejected: true }; }
    const r = RECS().find((x) => x.approval_id === a.id); if (r) { r.status = 'approved'; ctx.db.save('recommendations'); }
    if (a.type === 'tool') return ctx.tools.executeApproval(a.id);
    if (a.type === 'venture_create') return { venture: createFromOpportunity(a.payload).venture_id };
    if (a.type === 'capital_increase') { ctx.cfo.setAllocation(a.payload.venture_id, a.payload.to, 'approved increase'); return { ok: true }; }
    if (a.type === 'recommendation') {
      const p = a.payload;
      if (p.action === 'INCREASE_BUDGET') { const v = ctx.ventures.get(a.venture_id); ctx.cfo.setAllocation(a.venture_id, round(v.capital_allocated * 1.5), 'CEO recommendation approved'); return { ok: true }; }
      if (p.action === 'PIVOT') { ctx.ventures.transition(a.venture_id, 'PIVOT', 'approved pivot'); return { ok: true }; }
      return execute({ venture_id: a.venture_id, ...p, reason: 'approved by founder' }, { human: true });
    }
    return { ok: true };
  }
  return { refresh, review, answers, tick, execute, enforceKillRules, killVenture, discover, createFromOpportunity, onApproval, recommend, budgetSignal, ACTIVE_STATES, recommendations: () => RECS() };
}
module.exports = { makeCeo };
