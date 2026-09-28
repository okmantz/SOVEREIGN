'use strict';
// Budgets and approvals live in code, never in prompts.
const { id, assert, today } = require('./util');
const ledger = require('./ledger');

function spentToday(state, agentId) {
  const d = today();
  return state.spend.filter((s) => s.day === d && (!agentId || s.agentId === agentId)).reduce((t, s) => t + s.cents, 0);
}

function assertBudget(state, agentId) {
  const b = state.settings.budgets;
  assert(spentToday(state) < b.globalDailyCents, 'Daily station budget reached. Raise it in Settings or wait until tomorrow.', 402);
  if (agentId) assert(spentToday(state, agentId) < b.perAgentDailyCents, 'This agent hit its daily budget.', 402);
}

function recordSpend(store, { agentId, cents, tokensIn = 0, tokensOut = 0, model = '' }) {
  store.state.spend.push({ id: id('spend'), at: Date.now(), day: today(), agentId, cents, tokensIn, tokensOut, model });
  if (store.state.spend.length > 5000) store.state.spend.splice(0, store.state.spend.length - 5000);
  // Model cost is a verified cost: the harness measured it. (Rounded up to whole cents in the ledger.)
  if (cents > 0) ledger.add(store, { type: 'cost', amountCents: Math.max(1, Math.ceil(cents)), source: 'harness.model', ref: 'spend_' + store.state.spend.at(-1).id, note: model });
}

const executors = {};
const registerExecutor = (kind, fn) => { executors[kind] = fn; };

function requestApproval(store, { kind, summary, detail = [], payload }) {
  const a = { id: id('appr'), kind, summary, detail, payload, status: 'pending', at: Date.now() };
  store.state.approvals.push(a);
  store.change('approval', { id: a.id });
  return a;
}

async function resolveApproval(store, approvalId, approve) {
  const a = store.state.approvals.find((x) => x.id === approvalId);
  assert(a, 'Approval not found', 404);
  assert(a.status === 'pending', 'That request was already handled.');
  if (!approve) { a.status = 'rejected'; a.resolvedAt = Date.now(); store.change('approval', { id: a.id }); return a; }
  a.status = 'approved'; a.resolvedAt = Date.now();
  try {
    assert(executors[a.kind], 'No handler for ' + a.kind);
    a.result = (await executors[a.kind](store, a.payload, a)) || null;
  } catch (e) { a.status = 'failed'; a.error = e.message; }
  store.change('approval', { id: a.id });
  return a;
}

module.exports = { spentToday, assertBudget, recordSpend, requestApproval, resolveApproval, registerExecutor };
