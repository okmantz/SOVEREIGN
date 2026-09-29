'use strict';
const { DAY } = require('./util');

const EVERY = { minute: 60000, five_min: 5 * 60000, hourly: 3600000, nightly: DAY, weekly: 7 * DAY };

/**
 * SOVEREIGN AUTOPILOT. Law 8: it stops instead of burning money — repeated failures or a breached loss limit pause it
 * with a plain reason; resume() is a human action.
 */
function makeAutopilot(ctx) {
  const st = () => ctx.db.get('autopilot', { last: {}, paused: null, failures: 0, log: [] });
  let timer = null;

  const jobs = {
    /** Every minute: due sequence steps become drafts, approved mail goes out (within the daily limit and send window), retainer cycles are scheduled and produced. */
    async minute() { const r = await ctx.lifecycle.tick(); try { r.remote = await ctx.remote.pump(); } catch { /* push must never stop the loop */ } return r; },
    async five_min() {
      const mon = await ctx.deploy.checkMonitors();
      const recentFails = ctx.db.get('events', []).filter((e) => e.type === 'tool.failed' && e.ts > ctx.now() - 5 * 60000).length;
      if (recentFails >= 5) ctx.emit('alert', { msg: `${recentFails} tool failures in 5 minutes` });
      const out = { monitors: mon.length, tool_failures: recentFails };
      // subscription events without a public webhook: renewals, cancellations, failed payments (needs the Stripe key; a no-op without it)
      if (ctx.settings().stripe.poll_events) { try { out.stripe = await ctx.payments.pollEvents(); } catch (e) { out.stripe = { error: e.message }; ctx.emit('alert', { msg: `Stripe event poll failed: ${e.message}` }); } }
      if (ctx.tunnel) out.tunnel = await ctx.tunnel.ensure();
      return out;
    },
    async hourly() {
      let follow = 0, risks = 0;
      for (const v of ctx.ventures.list({ activeOnly: true })) {
        for (const r of ctx.crm.retentionRisks(v.venture_id).slice(0, 5)) { ctx.directives.add({ venture_id: v.venture_id, role: 'Support', task: `Retention: ${r.name || r.customer_id}`, description: `${r.reasons.join(', ')} → ${r.action}`, priority: 'high' }); risks++; }
        const stale = ctx.crm.prospects(v.venture_id).filter((p) => !['won', 'lost', 'new'].includes(p.status) && p.last_contact && ctx.now() - p.last_contact > 3 * DAY);
        if (stale.length) { ctx.directives.add({ venture_id: v.venture_id, role: 'Sales', task: 'Follow up stale prospects', description: `${stale.length} prospects untouched 3+ days` }); follow++; }
      }
      const changed = await ctx.browser.watchCompetitors();
      const lifecycle = await ctx.lifecycle.scan(); // churn-save, testimonial ask, upsell offers
      return { retention_risks: risks, follow_ups: follow, competitor_changes: changed.length, lifecycle };
    },
    async nightly() {
      const ceo = ctx.ceo.tick();
      const digest = ctx.lifecycle.notifyDigest(); for (const v of ctx.ventures.list({ activeOnly: true })) { try { ctx.pages.refreshStatus(v.venture_id); } catch { /* no workspace yet */ } }
      for (const v of ctx.ventures.list({ activeOnly: true })) ctx.memory.learn(v.venture_id);
      const plan = ctx.cfo.plan(); const applied = ctx.cfo.applyPlan(plan);
      const priorities = ctx.directives.list({ status: 'open' }).sort((a, b) => (b.priority === 'high') - (a.priority === 'high')).slice(0, 10).map((d) => `${d.role}: ${d.task}`);
      ctx.db.set('priorities', { ts: ctx.now(), priorities });
      return { digest, killed: ceo.killed.length, decisions: ceo.decisions.length, recommended: ceo.recommended.length, rebalanced: applied.applied.length, capital_requests: applied.queued.length, priorities: priorities.length };
    },
    async weekly() {
      const s = ctx.settings(); const queries = (s.autopilot.scan_queries || []); let scan = null;
      if (queries.length) scan = await ctx.opportunities.scan({ queries });
      for (const v of ctx.ventures.list({ activeOnly: true })) {
        const m = ctx.ledger.monthly(v.venture_id);
        ctx.memory.remember(v.venture_id, 'financial', `Weekly review: revenue $${m.net_revenue}, costs $${m.total_costs}, contribution $${m.contribution_profit} (30d)`, m);
        const a = ctx.ceo.answers(v.venture_id); ctx.memory.remember(v.venture_id, 'strategy', `Weekly CEO review: profitable=${a.profitable.is_profitable}; spending: ${a.increase_spending}`, a);
        const tax = ctx.cfo.taxReserveSuggestion(v.venture_id); if (tax > 0) ctx.emit('alert', { msg: `Suggested tax reserve for ${v.name}: $${tax}` }, v.venture_id);
      }
      for (const o of ctx.opportunities.list({ status: 'new' }).slice(0, 5)) await ctx.opportunities.research(o.id).catch(() => {});
      return { scan, ventures: ctx.ventures.list({ activeOnly: true }).length };
    },
  };

  async function runJob(name) {
    const s = st(); const t0 = ctx.now();
    try {
      const r = await jobs[name](); s.last[name] = ctx.now(); s.failures = 0;
      s.log = [...s.log.slice(-49), { job: name, ts: t0, ok: true, result: r }]; ctx.db.save('autopilot'); return { ok: true, result: r };
    } catch (e) {
      try { ctx.trail.log('job.failed', { job: name, error: e.message }); } catch { /* receipt is best effort */ }
      s.last[name] = ctx.now(); s.failures++; s.log = [...s.log.slice(-49), { job: name, ts: t0, ok: false, error: e.message }]; ctx.db.save('autopilot');
      if (s.failures >= 3) pause(`${s.failures} consecutive job failures (last: ${name}: ${e.message})`);
      return { ok: false, error: e.message };
    }
  }
  function pause(reason) { const s = st(); s.paused = reason; ctx.db.save('autopilot'); ctx.emit('autopilot.paused', { reason }); }
  function resume() { const s = st(); s.paused = null; s.failures = 0; ctx.db.save('autopilot'); }
  const status = () => { const s = st(); return { paused: s.paused, last: s.last, log: s.log.slice(-10), enabled: ctx.settings().autopilot.enabled }; };

  /** Run whatever is due. Call from a timer, or manually. */
  async function tick() {
    const s = st(); if (s.paused) return { skipped: s.paused };
    const ran = [];
    for (const [name, every] of Object.entries(EVERY)) {
      if (ctx.now() - (s.last[name] || 0) >= every) { ran.push({ job: name, ...(await runJob(name)) }); if (st().paused) break; }
    }
    return { ran };
  }
  function start(intervalMs = 60000) { if (timer) return; timer = setInterval(() => { if (ctx.settings().autopilot.enabled) tick().catch(() => {}); }, intervalMs); timer.unref(); }
  const stop = () => { clearInterval(timer); timer = null; };
  return { tick, runJob, pause, resume, status, start, stop, jobs, EVERY };
}
module.exports = { makeAutopilot };
