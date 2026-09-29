'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { mk } = require('./company.helpers');

test('ledger: only trusted sources are verified; webhook refs are idempotent', () => {
  const { co } = mk(); const v = co.ventures.create({ name: 'A', capital_allocated: 100 });
  co.ledger.record({ venture_id: v.venture_id, category: 'revenue', amount: 50, source: 'agent_claim' });
  co.ledger.record({ venture_id: v.venture_id, category: 'revenue', amount: 40, source: 'stripe', ref: 'evt_1' });
  co.ledger.record({ venture_id: v.venture_id, category: 'revenue', amount: 40, source: 'stripe', ref: 'evt_1' });
  const s = co.ledger.summary({ venture_id: v.venture_id });
  assert.equal(s.revenue, 40); assert.equal(s.unverified_entries, 1);
});
test('ledger: contribution profit waterfall + cash + reserves', () => {
  const { co } = mk(); const id = co.ventures.create({ name: 'B', capital_allocated: 500 }).venture_id;
  const r = (category, amount) => co.ledger.record({ venture_id: id, category, amount, source: 'measured' });
  r('capital_in', 500); r('revenue', 300); r('refund', 20); r('cogs', 50); r('software', 10); r('marketing', 60); r('ai_inference', 15); r('tax_reserve', 25);
  const s = co.ledger.summary({ venture_id: id });
  assert.equal(s.net_revenue, 280); assert.equal(s.contribution_profit, 145); assert.equal(s.cash, 645); assert.equal(s.available_cash, 620);
});
test('ledger: receivables become revenue only when settled with a trusted source', () => {
  const { co } = mk(); const id = co.ventures.create({ name: 'C' }).venture_id;
  const inv = co.ledger.invoice({ venture_id: id, kind: 'receivable', amount: 200, counterparty: 'X' });
  assert.equal(co.ledger.summary({ venture_id: id }).revenue, 0); assert.equal(co.ledger.summary({ venture_id: id }).receivable, 200);
  co.ledger.settle(inv.id, { source: 'bank' }); assert.equal(co.ledger.summary({ venture_id: id }).revenue, 200);
});
test('CFO: authorizes healthy spend, denies overspend, reserve breach and test-budget overrun', () => {
  const { co } = mk(); const id = co.ventures.create({ name: 'D', capital_allocated: 1000 }).venture_id; co.cfo.fund(id, 1000);
  assert.equal(co.cfo.evaluate({ venture_id: id, amount: 75, category: 'marketing' }).decision, 'AUTHORIZED');
  assert.equal(co.cfo.evaluate({ venture_id: id, amount: 5000 }).decision, 'DENIED');
  assert.equal(co.cfo.evaluate({ venture_id: id, amount: 900 }).decision, 'DENIED');       // breaches 15% reserve while unprofitable
  co.ventures.transition(id, 'RESEARCH'); co.ventures.transition(id, 'VALIDATION'); co.validation.start(id, { budget: 100 });
  assert.equal(co.cfo.evaluate({ venture_id: id, amount: 120, category: 'marketing' }).decision, 'DENIED');
});
test('allocator: winners get more (bounded), never below spend; kill releases capital; loss limit', () => {
  const { co } = mk(); co.setCapital(1000, 300);
  const a = co.ventures.create({ name: 'A', capital_allocated: 200 }); const b = co.ventures.create({ name: 'B', capital_allocated: 200 });
  for (const v of [a, b]) co.cfo.fund(v.venture_id, 200);
  for (const s of ['RESEARCH', 'VALIDATION', 'BUILD', 'LAUNCH', 'TRACTION']) co.ventures.transition(a.venture_id, s);
  co.ledger.record({ venture_id: a.venture_id, category: 'revenue', amount: 300, source: 'stripe', ref: 'r1' });
  co.ledger.record({ venture_id: a.venture_id, category: 'marketing', amount: 50, source: 'measured' });
  const plan = co.cfo.plan(); const pa = plan.proposals.find((p) => p.venture_id === a.venture_id); const pb = plan.proposals.find((p) => p.venture_id === b.venture_id);
  assert.ok(pa.to > pa.from && pa.to <= 300); assert.ok(pb.to < pb.from && pb.to >= 100);
  const res = co.cfo.applyPlan(plan); assert.ok(res.queued.length >= 1, 'increase needs approval in approval_only mode');
  co.ceo.killVenture(b.venture_id, 'test'); assert.ok(co.cfo.snapshot(b.venture_id).cash === 0);
});
test('validation: BUILD / CONTINUE / KILL / ITERATE', () => {
  const { co, day } = mk(); const id = co.ventures.create({ name: 'V', capital_allocated: 100 }).venture_id; co.cfo.fund(id, 100);
  co.ventures.transition(id, 'RESEARCH'); co.ventures.transition(id, 'VALIDATION'); co.validation.start(id, { budget: 100 });
  assert.equal(co.validation.evaluate(id).decision, 'CONTINUE');
  co.validation.record(id, { impressions: 600, visitors: 25, leads: 6, purchases: 1 }); assert.equal(co.validation.evaluate(id).decision, 'BUILD');
  const k = mk(); const kid = k.co.ventures.create({ name: 'K', capital_allocated: 100 }).venture_id; k.co.cfo.fund(kid, 100);
  k.co.ventures.transition(kid, 'RESEARCH'); k.co.ventures.transition(kid, 'VALIDATION'); k.co.validation.start(kid, { budget: 100 });
  k.co.ledger.record({ venture_id: kid, category: 'marketing', amount: 75, source: 'measured' });
  k.co.validation.record(kid, { impressions: 400, visitors: 5 }); assert.equal(k.co.validation.evaluate(kid).decision, 'KILL');
  const i = mk(); const iid = i.co.ventures.create({ name: 'I', capital_allocated: 100 }).venture_id; i.co.cfo.fund(iid, 100);
  i.co.ventures.transition(iid, 'RESEARCH'); i.co.ventures.transition(iid, 'VALIDATION'); i.co.validation.start(iid, { budget: 100, days: 7 });
  i.co.validation.record(iid, { impressions: 600, visitors: 30, leads: 1 }); i.day(8); assert.equal(i.co.validation.evaluate(iid).decision, 'ITERATE');
});
test('state machine: illegal transitions rejected; KILLED is terminal', () => {
  const { co } = mk(); const id = co.ventures.create({ name: 'S' }).venture_id;
  assert.throws(() => co.ventures.transition(id, 'LAUNCH')); co.ventures.transition(id, 'KILLED'); assert.throws(() => co.ventures.transition(id, 'RESEARCH')); assert.equal(co.ventures.canWork(id), false);
});
