'use strict';
const { uid, round, DAY } = require('./util');

/** 0 Read · 1 Draft · 2 Auto-execute low-risk · 3 Financially constrained · 4 Human approval */
const LEVEL = { READ: 0, DRAFT: 1, AUTO_LOW: 2, FINANCIAL: 3, HUMAN: 4 };

function makePermissions(ctx) {
  const trust = () => ctx.db.get('trust', {});
  const spend = () => ctx.db.get('spend', []);
  const approvals = () => ctx.db.get('approvals', []);
  const drafts = () => ctx.db.get('drafts', []);

  /** Capability is earned: NEW → read-only → low-risk → financial authority (never level 4). */
  function tier(agentId) {
    const t = trust()[agentId] || { success: 0, fail: 0 };
    if (Number.isInteger(t.override)) return Math.min(3, t.override);
    const cfg = ctx.settings().trust; const n = t.success + t.fail;
    const rate = n ? t.success / n : 0;
    if (t.success >= cfg.tier3_successes && rate >= cfg.min_rate_high) return 3;
    if (t.success >= cfg.tier2_successes && rate >= cfg.min_rate_high) return 2;
    if (t.success >= cfg.tier1_successes && rate >= cfg.min_rate_tier1) return 1;
    return 0;
  }
  function recordOutcome(agentId, ok) {
    const t = trust(); t[agentId] = t[agentId] || { success: 0, fail: 0 };
    t[agentId][ok ? 'success' : 'fail']++; ctx.db.save('trust');
  }
  const demote = (agentId, weight = 5) => { const t = trust(); t[agentId] = t[agentId] || { success: 0, fail: 0 }; t[agentId].fail += weight; delete t[agentId].override; ctx.db.save('trust'); };
  /** Human grant, capped at tier 3: level 4 can never be granted. */
  const grant = (agentId, level) => { const t = trust(); t[agentId] = t[agentId] || { success: 0, fail: 0 }; t[agentId].override = Math.max(0, Math.min(3, level)); ctx.db.save('trust'); };

  function spentSince(agentId, since) {
    return spend().filter((s) => s.ts >= since && (!agentId || s.agent_id === agentId)).reduce((a, s) => a + s.amount, 0);
  }
  function commitSpend(agentId, ventureId, amount, memo = '') {
    if (!(amount > 0)) return;
    spend().push({ ts: ctx.now(), agent_id: agentId, venture_id: ventureId, amount: round(amount), memo });
    ctx.db.save('spend');
  }

  function authorize(req) {
    const { agent_id, venture_id, cost = 0, irreversible = false } = req;
    let level = req.level;
    if (!Number.isInteger(level) || level < 0 || level > 4) return { decision: 'deny', reason: 'invalid permission level', tier: 0 };
    const a = tier(agent_id);
    if (venture_id && level > 0) {
      const v = ctx.ventures.get(venture_id);
      if (!v || !v.active) return { decision: 'deny', reason: 'venture is not active', tier: a };
    }
    if (level === LEVEL.READ) return { decision: 'allow', reason: 'read-only', tier: a };
    if (irreversible || level === LEVEL.HUMAN) return { decision: 'approve', reason: 'irreversible or level-4 action needs a human', tier: a };
    if (level === LEVEL.DRAFT) return { decision: 'draft', reason: 'drafts are prepared, not executed', tier: a };
    const s = ctx.settings();
    if (s.autonomy === 'approval_only') return { decision: 'approve', reason: 'autonomy is approval_only', tier: a };
    if (cost > 0) level = Math.max(level, LEVEL.FINANCIAL);
    if (level === LEVEL.AUTO_LOW) {
      return a >= 2 ? { decision: 'allow', reason: 'low-risk, agent trusted', tier: a }
        : { decision: 'approve', reason: `agent trust tier ${a} < 2`, tier: a };
    }
    // level 3: financially constrained
    if (a < 3) return { decision: 'approve', reason: `agent trust tier ${a} < 3 for spending`, tier: a };
    const caps = s.caps;
    if (cost > caps.per_action) return { decision: 'approve', reason: `$${cost} exceeds per-action cap $${caps.per_action}`, tier: a };
    if (spentSince(null, ctx.now() - DAY) + cost > caps.per_day) return { decision: 'deny', reason: `daily cap $${caps.per_day} reached`, tier: a };
    if (spentSince(null, ctx.now() - 30 * DAY) + cost > caps.per_month) return { decision: 'deny', reason: `monthly cap $${caps.per_month} reached`, tier: a };
    return { decision: 'allow', reason: 'within spend caps', tier: a };
  }

  function queueApproval(item) {
    const a = { id: uid('appr'), status: 'pending', created: ctx.now(), ...item };
    approvals().push(a); ctx.db.save('approvals');
    ctx.emit('approval.requested', { summary: a.summary }, a.venture_id);
    return a;
  }
  function queueDraft(item) {
    const d = { id: uid('draft'), created: ctx.now(), ...item };
    drafts().push(d); ctx.db.save('drafts'); return d;
  }
  const pending = () => approvals().filter((a) => a.status === 'pending');
  const getApproval = (id) => approvals().find((a) => a.id === id) || null;
  function resolve(id, approve, note = '') {
    const a = getApproval(id);
    if (!a || a.status !== 'pending') throw new Error('approval not found or already resolved');
    a.status = approve ? 'approved' : 'rejected'; a.resolved = ctx.now(); a.note = note;
    ctx.db.save('approvals');
    ctx.emit(`approval.${a.status}`, { summary: a.summary }, a.venture_id);
    return a;
  }

  return { LEVEL, authorize, tier, recordOutcome, demote, grant, commitSpend, spentSince, queueApproval, queueDraft, pending, resolve, getApproval, drafts: () => drafts() };
}
module.exports = { makePermissions, LEVEL };
