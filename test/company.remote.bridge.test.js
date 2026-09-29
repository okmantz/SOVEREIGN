'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { fresh } = require('./helpers');
const journey = require('../sidecar/lib/journey');
const guardrails = require('../sidecar/lib/guardrails');
const bridge = require('../sidecar/lib/company/bridge');

const GOAL = { name: 'Sell a done-for-you invoice follow-up service to small dental clinics', targetCents: 100000, capitalCents: 20000, riskCents: 10000 };
async function running() { const { root, view } = fresh(); await journey.setGoal(view, GOAL).done; await journey.approveMilestones(view); journey.approveRoadmap(view); journey.completeSetup(view); return { root, view }; }

test('remote ↔ main app: station approvals and company approvals are ONE list; a phone approval runs the real executor; digest approvals close the mirror', async () => {
  const { root, view } = await running(); const co = bridge.companyFor(root); const v = bridge.ensureVenture(view);
  const a = co.permissions.queueApproval({ type: 'recommendation', venture_id: v.venture_id, summary: 'Just a note', payload: { action: 'NONE' } }); // mirrored into the station by the bridge
  const items = await co.remote.pending(); const mine = items.filter((i) => i.kind === 'company.approval'); assert.equal(mine.length, 1); assert.equal(mine[0].source, 'station'); assert.equal(mine[0].risk, 'medium'); assert.equal(items.filter((i) => i.summary === 'Just a note').length, 1); // never listed twice
  const r = await co.remote.act(mine[0].key, true, { actor: 'telegram:1' }); assert.equal(r.ok, true); assert.equal(co.permissions.getApproval(a.id).status, 'approved'); assert.equal((await co.remote.pending()).filter((i) => i.summary === 'Just a note').length, 0);
  const b = co.permissions.queueApproval({ type: 'recommendation', venture_id: v.venture_id, summary: 'Approved elsewhere', payload: { action: 'NONE' } }); await co.resolveApproval(b.id, true, 'digest');
  bridge.reconcileApprovals(view); const mirror = view.state.approvals.find((x) => x.kind === 'company.approval' && x.payload.approval_id === b.id); assert.equal(mirror.status, 'approved');
  const high = co.permissions.queueApproval({ type: 'venture_create', venture_id: v.venture_id, summary: 'Launch another business', payload: {} }); const hi = (await co.remote.pending()).find((i) => i.summary === 'Launch another business'); assert.equal(hi.risk, 'high');
  assert.equal((await co.remote.act(hi.key, true)).ok, false); assert.equal(co.permissions.getApproval(high.id).status, 'pending');
});
test('remote ↔ main app: Director plans and connector calls are graded; agents are listed with live state; STOP pauses the running plan and RESUME restores only what the phone paused', async () => {
  const { root, view } = await running(); const co = bridge.companyFor(root); bridge.ensureVenture(view);
  const plan = guardrails.requestApproval(view, { kind: 'director.plan', summary: 'Assign a task', detail: ['x'], payload: { actions: [] } });
  const listed = (await co.remote.pending()).find((i) => i.id === plan.id); assert.ok(listed); assert.equal(listed.risk, 'low');
  const agents = await co.remote.consoleState().then((s) => s.agents); assert.ok(agents.length >= 1); assert.ok(agents.every((a) => typeof a.name === 'string' && typeof a.working === 'boolean'));
  const rm = view.state.roadmap; assert.equal(rm.status, 'running'); assert.ok(!rm.paused);
  const s = await co.remote.stop('desktop', 'test'); assert.equal(s.plans_paused, 1); assert.equal(rm.paused, true); assert.equal(rm.pauseKind, 'remote'); assert.match(rm.pauseReason, /phone/);
  await co.remote.resume('desktop'); assert.equal(rm.paused, false); assert.equal(view.state.loopStop, null);
  rm.paused = true; rm.pauseKind = 'ceo'; await co.remote.resume('desktop'); assert.equal(rm.paused, true); // a CEO kill is never undone by a phone resume
  await bridge.tick(root); // the host beat runs pump() without error
});
