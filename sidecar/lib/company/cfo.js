'use strict';
const { round, clamp, DAY } = require('./util');

const STAGE_WEIGHT = { IDEA: 0.5, RESEARCH: 0.5, VALIDATION: 1, BUILD: 1.5, LAUNCH: 1.5, TRACTION: 2,
  PROFITABLE: 3, SCALING: 3, DECLINE: 0.5, RESTRUCTURE: 0.5, PIVOT: 0.5 };

/** Treasury. The CEO never touches money directly: CEO → CFO → budget engine → permission engine → action. */
function makeCfo(ctx) {
  const pf = () => ctx.db.get('portfolio', { total_capital: 0, max_loss: null });

  function snapshot(venture_id) {
    const v = ctx.ventures.get(venture_id);
    const s = ctx.ledger.summary({ venture_id });
    const m = ctx.ledger.monthly(venture_id);
    const dailyGross = m.total_costs / 30;
    return {
      cash: s.available_cash, allocated: v ? v.capital_allocated : 0,
      monthly_revenue: m.net_revenue, monthly_expenses: m.total_costs, profit: m.contribution_profit,
      lifetime_profit: s.contribution_profit, spent: s.total_costs,
      runway_days: dailyGross > 0 ? Math.floor(s.available_cash / dailyGross) : null,
    };
  }

  /** Every expenditure gets evaluated. Returns AUTHORIZED | DENIED with the numbers behind it. */
  function evaluate({ venture_id, amount, category = 'other_opex', purpose = '' }) {
    const v = ctx.ventures.get(venture_id);
    const cfg = ctx.settings().cfo;
    if (!v || !v.active) return { decision: 'DENIED', reason: 'venture is not active' };
    if (!(amount >= 0)) return { decision: 'DENIED', reason: 'invalid amount' };
    const snap = snapshot(venture_id);
    const out = (decision, reason) => ({ decision, reason, purpose, category, amount, snapshot: snap });
    if (amount === 0) return out('AUTHORIZED', 'no spend');
    if (category === 'marketing' && v.strategy && v.strategy.ads_frozen && v.status !== 'VALIDATION') return out('DENIED', 'ad spend is frozen: LTV/CAC is below the guardrail floor');
    if (amount > snap.cash) return out('DENIED', `insufficient cash ($${snap.cash} available)`);
    const floor = v.capital_allocated * cfg.reserve_pct;
    if (v.capital_allocated > 0 && snap.cash - amount < floor && snap.profit <= 0) {
      return out('DENIED', `would breach the ${cfg.reserve_pct * 100}% venture reserve ($${round(floor)})`);
    }
    if (v.status === 'VALIDATION' && category === 'marketing') {
      const budget = v.strategy.validation_budget || ctx.settings().ventures.validation_budget;
      const rec = ctx.validation && ctx.validation.get(venture_id);
      const used = ctx.ledger.summary({ venture_id }).acquisition_costs - (rec ? rec.baseline || 0 : 0);
      if (used + amount > budget) return out('DENIED', `exceeds validation test budget ($${budget})`);
    }
    const dailyAfter = (snap.monthly_expenses + amount) / 30;
    const runwayAfter = dailyAfter > 0 ? (snap.cash - amount) / dailyAfter : Infinity;
    if (snap.profit <= 0 && runwayAfter < cfg.min_runway_days) {
      return out('DENIED', `runway would fall to ${Math.floor(runwayAfter)} days (min ${cfg.min_runway_days}) while unprofitable`);
    }
    return out('AUTHORIZED', 'within budget, reserve and runway rules');
  }

  function fund(venture_id, amount, memo = 'capital allocation') {
    return ctx.ledger.record({ venture_id, category: 'capital_in', amount, source: 'harness', memo });
  }

  // ---- Capital allocator ------------------------------------------------
  function setCapital(total, max_loss) {
    const p = pf(); p.total_capital = total; if (max_loss !== undefined) p.max_loss = max_loss; ctx.db.save('portfolio');
    return p;
  }
  const committed = () => ctx.ventures.list().reduce((s, v) => {
    const spent = ctx.ledger.summary({ venture_id: v.venture_id }).total_costs;
    return s + (v.active ? v.capital_allocated : Math.min(spent, v.capital_allocated));
  }, 0);

  function plan() {
    const cfg = ctx.settings().cfo; const p = pf();
    const active = ctx.ventures.list({ activeOnly: true });
    const reserve = p.total_capital * cfg.reserve_pct;
    const experiments = p.total_capital * cfg.experiments_pct;
    const killedSunk = ctx.ventures.list().filter((v) => !v.active)
      .reduce((s, v) => s + Math.min(ctx.ledger.summary({ venture_id: v.venture_id }).total_costs, v.capital_allocated), 0);
    const investable = Math.max(0, p.total_capital - reserve - experiments - killedSunk);
    const weights = active.map((v) => {
      const s = ctx.ledger.summary({ venture_id: v.venture_id });
      const roi = s.total_costs > 0 ? s.contribution_profit / s.total_costs : 0;
      return (STAGE_WEIGHT[v.status] || 1) * (1 + clamp(roi, -0.5, 1));
    });
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const proposals = active.map((v, i) => {
      const spent = ctx.ledger.summary({ venture_id: v.venture_id }).total_costs;
      let target = investable * weights[i] / sum;
      const cur = v.capital_allocated;
      if (cur > 0) target = clamp(target, cur * 0.5, cur * 1.5);   // no wild swings
      target = Math.max(target, spent);                          // never below what is already spent
      return { venture_id: v.venture_id, name: v.name, from: round(cur), to: round(target), delta: round(target - cur) };
    }).filter((x) => Math.abs(x.delta) >= 1);
    const after = active.reduce((s, v) => s + v.capital_allocated, 0) + proposals.reduce((s, x) => s + x.delta, 0);
    return { total: p.total_capital, reserve: round(reserve), experiments: round(experiments), investable: round(investable),
      unallocated: round(p.total_capital - reserve - experiments - killedSunk - after), proposals };
  }
  /** Decreases apply immediately (safe). Increases need approval unless autonomy is permissioned and small. */
  function applyPlan(pl = plan()) {
    const applied = [], queued = [];
    const s = ctx.settings();
    for (const x of pl.proposals) {
      if (x.delta <= 0 || (s.autonomy === 'permissioned' && x.delta <= s.caps.per_day)) {
        setAllocation(x.venture_id, x.to, 'rebalance'); applied.push(x);
      } else {
        queued.push(ctx.permissions.queueApproval({ type: 'capital_increase', venture_id: x.venture_id,
          summary: `Increase ${x.name} allocation $${x.from} → $${x.to}`, payload: x }));
      }
    }
    return { applied, queued };
  }
  function setAllocation(venture_id, to, memo) {
    const v = ctx.ventures.get(venture_id); const delta = round(to - v.capital_allocated);
    if (delta > 0) ctx.ledger.record({ venture_id, category: 'capital_in', amount: delta, source: 'harness', memo });
    else if (delta < 0) ctx.ledger.record({ venture_id, category: 'capital_out', amount: -delta, source: 'harness', memo });
    ctx.ventures.update(venture_id, { capital_allocated: to });
    ctx.emit('capital.allocated', { to, delta }, venture_id);
  }
  /** Killed ventures release their unspent capital back to the pool. */
  function release(venture_id) {
    const v = ctx.ventures.get(venture_id);
    const s = ctx.ledger.summary({ venture_id });
    if (s.cash > 0) ctx.ledger.record({ venture_id, category: 'capital_out', amount: s.cash, source: 'harness', memo: 'released on kill' });
    ctx.ventures.update(venture_id, { capital_allocated: Math.min(v.capital_allocated, s.total_costs) });
  }
  /** Hard portfolio loss limit – no vote. */
  function portfolioLoss() {
    const loss = ctx.ventures.list().reduce((s, v) => s + Math.max(0, -ctx.ledger.summary({ venture_id: v.venture_id }).contribution_profit), 0);
    const p = pf();
    return { loss: round(loss), max_loss: p.max_loss, breached: p.max_loss != null && loss >= p.max_loss };
  }
  function taxReserveSuggestion(venture_id) {
    const s = ctx.ledger.summary({ venture_id });
    const want = Math.max(0, s.contribution_profit) * ctx.settings().cfo.tax_reserve_rate;
    return round(Math.max(0, want - s.reserves));
  }
  function decide(request) { // convenience: the example flow from the spec
    const r = evaluate(request);
    ctx.emit(`cfo.${r.decision.toLowerCase()}`, { amount: request.amount, reason: r.reason }, request.venture_id);
    return r;
  }
  return { snapshot, evaluate, decide, fund, setCapital, plan, applyPlan, setAllocation, release, portfolioLoss, taxReserveSuggestion, committed };
}
module.exports = { makeCfo };
