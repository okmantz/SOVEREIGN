'use strict';
// Agents run from desks. Work moves along hallways. Nothing runs without a seat, a budget and capabilities.
const { id, assert } = require('./util');
const providers = require('./providers');
const guardrails = require('./guardrails');
const station = require('./station');

const MAX_HOPS = 12;

function buildSystem(state, agent, caps) {
  const m = state.mission;
  return [
    agent.persona,
    m ? `Station mission: earn ${(m.targetCents / 100).toFixed(2)} USD of VERIFIED profit. Only ledger entries confirmed by Stripe/bank/ad connectors count; anything you claim without proof is ignored.` : 'No mission is set yet.',
    `Your role: ${agent.role}. Your capabilities right now: ${caps.length ? caps.join(', ') : 'none (you have no desk grants)'}.`,
    'Stay inside those capabilities. If a task needs one you lack, say so and name the room or desk that has it. Never invent revenue, customers or results.'
  ].join('\n\n');
}

function push(state, agentId, role, content) {
  const t = state.transcripts[agentId] || (state.transcripts[agentId] = []);
  t.push({ role, content, at: Date.now() });
  if (t.length > 60) t.splice(0, t.length - 60);
}

async function runAgent(store, agentId, task, { input } = {}) {
  const state = store.state;
  const agent = state.agents[agentId]; assert(agent, 'Agent not found', 404);
  assert(agent.deskId && state.desks[agent.deskId], `${agent.name} has no desk. Seat them at a desk to give them work.`);
  guardrails.assertBudget(state, agentId);
  const caps = station.effectiveCaps(state, agent);
  const prompt = input ? `${task}\n\nInput from the previous stage:\n${input}` : task;
  store.emit('run.start', { agentId });
  push(state, agentId, 'user', prompt);
  try {
    const res = await providers.complete(store, { agent, system: buildSystem(state, agent, caps), purpose: 'agent',
      messages: state.transcripts[agentId].slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })) });
    guardrails.recordSpend(store, { agentId, cents: res.costCents, tokensIn: res.tokensIn, tokensOut: res.tokensOut, model: res.model });
    push(state, agentId, 'assistant', res.text);
    return res.text;
  } finally {
    store.emit('run.done', { agentId });
    store.change('state');
  }
}

function addOutbox(store, item) {
  const o = { id: id('out'), at: Date.now(), kind: 'deliverable', status: 'done', ...item };
  store.state.outbox.unshift(o);
  if (store.state.outbox.length > 300) store.state.outbox.length = 300;
  store.change('outbox', { id: o.id });
  return o;
}

const seatedIn = (state, roomId) =>
  Object.values(state.agents).filter((a) => a.deskId && state.desks[a.deskId] && state.desks[a.deskId].roomId === roomId);
const label = (state, ref) => ref === 'inbox' ? 'Inbox' : ref === 'outbox' ? 'Outbox'
  : ref.startsWith('room:') ? (state.rooms[ref.slice(5)] || {}).name : (state.connectors[ref.slice(10)] || {}).name;

// Start at 'inbox', a connector, or a room. Follow hallways; deliver to the Outbox.
async function dispatch(store, { start, task, input }) {
  const state = store.state;
  const notes = [];
  async function visit(ref, text, hops, path) {
    if (hops > MAX_HOPS) { notes.push('Stopped: hallway chain too long.'); return; }
    if (path.includes(ref)) { notes.push('Stopped: loop at ' + label(state, ref)); return; }
    if (ref === 'outbox') {
      addOutbox(store, { title: 'Finished: ' + task.slice(0, 60), content: text, fromRoom: label(state, path[path.length - 1]) });
      return;
    }
    if (ref.startsWith('connector:')) return visitConnector(ref, text, path);
    const room = state.rooms[ref.slice(5)]; if (!room) return;
    const crew = seatedIn(state, room.id);
    if (!crew.length) { addOutbox(store, { kind: 'note', status: 'blocked', title: room.name + ' has nobody at a desk', content: 'Work reached this room but no agent is seated here. Seat an agent at a desk.' }); return; }
    const outs = await Promise.all(crew.map((a) => runAgent(store, a.id, task, { input: text })));
    const out = outs.length > 1 ? outs.map((o, i) => `${crew[i].name}: ${o}`).join('\n\n---\n\n') : outs[0];
    const next = Object.values(state.hallways).filter((h) => h.from === ref);
    if (!next.length) { addOutbox(store, { kind: 'note', title: room.name + ' finished (no hallway out)', content: out, fromRoom: room.name }); return; }
    await Promise.all(next.map((h) => { store.emit('handoff', { from: ref, to: h.to, hallwayId: h.id }); return visit(h.to, out, hops + 1, [...path, ref]); }));
  }
  async function visitConnector(ref, text, path) {
    const c = state.connectors[ref.slice(10)]; if (!c) return;
    const need = station.CONNECTOR_KINDS[c.kind].cap;
    const src = path[path.length - 1];
    const srcRoom = src && src.startsWith('room:') ? state.rooms[src.slice(5)] : null;
    if (srcRoom && !srcRoom.capabilities.includes(need)) {
      addOutbox(store, { kind: 'note', status: 'blocked', title: `Blocked: ${srcRoom.name} → ${c.name}`, content: `${srcRoom.name} does not have "${need}". Add it to the room (and a desk) to open this hallway.` });
      return;
    }
    const gated = c.kind === 'email' || c.kind === 'ads' || need === 'payments.charge';
    if (gated && state.settings.policy.firstOutreachApproval) {
      guardrails.requestApproval(store, { kind: 'connector.call', summary: `Send to ${c.name}?`, detail: [text.slice(0, 300)], payload: { connectorId: c.id, text } });
      return;
    }
    addOutbox(store, { kind: 'connector-request', status: 'queued', title: 'Queued for ' + c.name, content: text });
  }
  const startRef = start === 'inbox' || start.startsWith('connector:') || start.startsWith('room:') ? start : 'room:' + start;
  if (startRef === 'inbox' || startRef.startsWith('connector:')) {
    const first = Object.values(state.hallways).filter((h) => h.from === startRef);
    assert(first.length, startRef === 'inbox' ? 'Nothing is connected to the Inbox yet. Draw a hallway from it to a room.' : 'That connector has no hallway out.');
    await Promise.all(first.map((h) => { store.emit('handoff', { from: startRef, to: h.to, hallwayId: h.id }); return visit(h.to, task + (input ? '\n\n' + input : ''), 1, [startRef]); }));
  } else await visit(startRef, task + (input ? '\n\n' + input : ''), 0, []);
  return { notes };
}

guardrails.registerExecutor('connector.call', async (store, payload) => {
  const c = store.state.connectors[payload.connectorId]; assert(c, 'Connector was removed.');
  // v0.1: connectors are stubs. v0.2 will call the real adapter here (see docs/ROADMAP.md).
  addOutbox(store, { kind: 'connector-request', status: 'approved (stub)', title: 'Approved for ' + c.name, content: payload.text });
  return { stub: true };
});

module.exports = { runAgent, dispatch, addOutbox, seatedIn, buildSystem };
