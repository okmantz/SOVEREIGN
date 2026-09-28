'use strict';
// Agents run from desks. Work moves along hallways. Nothing runs without a seat, a budget and capabilities.
const { id, assert } = require('./util');
const providers = require('./providers');
const guardrails = require('./guardrails');
const station = require('./station');
const integrations = require('./integrations');
const { roleOf } = require('./roles');

const MAX_HOPS = 12;

function outputContracts(state, agent) {
  const desk = agent.deskId && state.desks[agent.deskId]; if (!desk) return '';
  const lines = Object.values(state.hallways).filter((h) => h.from === 'room:' + desk.roomId && h.to.startsWith('connector:'))
    .map((h) => state.connectors[h.to.slice(10)]).filter((c) => c && integrations.adapterFor(c.kind) && integrations.adapterFor(c.kind).contract)
    .map((c) => `When your work is ready to hand to "${c.name}", end your reply with exactly one JSON object shaped like ${integrations.adapterFor(c.kind).contract} and nothing after it.`);
  return lines.join('\n');
}

function buildSystem(state, agent, caps, { pipeline = false } = {}) {
  const m = state.mission;
  return [
    agent.persona,
    m ? `Station mission: earn ${(m.targetCents / 100).toFixed(2)} USD of VERIFIED profit. Only ledger entries confirmed by Stripe, Shopify, Etsy, ad platforms or the bank count; anything you claim without proof is ignored.` : 'No mission is set yet.',
    `Your role: ${roleOf(agent.role)}. Your capabilities right now: ${caps.length ? caps.join(', ') : 'none (you have no desk grants)'}.`,
    'Stay inside those capabilities. If a task needs one you lack, say so and name the room or desk that has it. Never invent revenue, customers or results.',
    pipeline ? outputContracts(state, agent) : ''
  ].filter(Boolean).join('\n\n');
}

function push(state, agentId, role, content) {
  const t = state.transcripts[agentId] || (state.transcripts[agentId] = []);
  t.push({ role, content, at: Date.now() });
  if (t.length > 60) t.splice(0, t.length - 60);
}

async function runAgent(store, agentId, task, { input, pipeline = false } = {}) {
  const state = store.state;
  const agent = state.agents[agentId]; assert(agent, 'Agent not found', 404);
  assert(agent.deskId && state.desks[agent.deskId], `${agent.name} has no desk. Seat them at a desk to give them work.`);
  guardrails.assertBudget(state, agentId);
  const caps = station.effectiveCaps(state, agent);
  const prompt = input ? `${task}\n\nInput from the previous stage:\n${input}` : task;
  store.emit('run.start', { agentId });
  push(state, agentId, 'user', prompt);
  store.change('state');
  try {
    const res = await providers.complete(store, { agent, system: buildSystem(state, agent, caps, { pipeline }), purpose: 'agent',
      messages: state.transcripts[agentId].slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })) });
    guardrails.recordSpend(store, { agentId, cents: res.costCents, tokensIn: res.tokensIn, tokensOut: res.tokensOut, model: res.model });
    push(state, agentId, 'assistant', res.text);
    return res.text;
  } catch (e) {
    push(state, agentId, 'assistant', 'I could not finish that: ' + e.message);
    throw e;
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
const label = (state, ref) => !ref ? '' : ref === 'inbox' ? 'Inbox' : ref === 'outbox' ? 'Outbox'
  : ref.startsWith('room:') ? (state.rooms[ref.slice(5)] || {}).name : (state.connectors[ref.slice(10)] || {}).name;

// Start at 'inbox', a connector, or a room. Follow hallways; deliver to the Outbox.
async function dispatch(store, { start, task, input }) {
  const state = store.state;
  const notes = [];
  const outgoing = (ref) => Object.values(state.hallways).filter((h) => h.from === ref);
  async function forward(ref, text, hops, path) {
    await Promise.all(outgoing(ref).map((h) => { store.emit('handoff', { from: ref, to: h.to, hallwayId: h.id }); return visit(h.to, text, hops + 1, [...path, ref]); }));
  }
  async function visit(ref, text, hops, path) {
    if (hops > MAX_HOPS) { notes.push('Stopped: hallway chain too long.'); return; }
    if (path.includes(ref)) { notes.push('Stopped: loop at ' + label(state, ref)); return; }
    if (ref === 'outbox') { addOutbox(store, { title: 'Finished: ' + task.slice(0, 60), content: text, fromRoom: label(state, path[path.length - 1]) }); return; }
    if (ref.startsWith('connector:')) return visitConnector(ref, text, hops, path);
    const room = state.rooms[ref.slice(5)]; if (!room) return;
    const crew = seatedIn(state, room.id);
    if (!crew.length) { addOutbox(store, { kind: 'note', status: 'blocked', title: room.name + ' has nobody at a desk', content: 'Work reached this room but no agent is seated here. Add an agent to this room.' }); return; }
    const outs = await Promise.all(crew.map((a) => runAgent(store, a.id, task, { input: text, pipeline: true })));
    const out = outs.length > 1 ? outs.map((o, i) => `${crew[i].name}: ${o}`).join('\n\n---\n\n') : outs[0];
    if (!outgoing(ref).length) { addOutbox(store, { kind: 'note', title: room.name + ' finished (no hallway out)', content: out, fromRoom: room.name }); return; }
    await forward(ref, out, hops, path);
  }
  async function visitConnector(ref, text, hops, path) {
    const c = state.connectors[ref.slice(10)]; if (!c) return;
    const meta = station.CONNECTOR_KINDS[c.kind], a = integrations.adapterFor(c.kind);
    const src = path[path.length - 1];
    const srcRoom = src && src.startsWith('room:') ? state.rooms[src.slice(5)] : null;
    if (srcRoom && !srcRoom.capabilities.includes(meta.cap)) {
      addOutbox(store, { kind: 'note', status: 'blocked', title: `Blocked: ${srcRoom.name} → ${c.name}`, content: `${srcRoom.name} does not have "${station.CAPS[meta.cap]}". Turn it on for the room (and its desks) to open this hallway.` });
      return;
    }
    if (!a) { addOutbox(store, { kind: 'connector-request', status: 'queued', title: 'Queued for ' + c.name, content: text }); return; }
    const missing = integrations.missing(c);
    if (missing.length) { addOutbox(store, { kind: 'note', status: 'blocked', title: `${c.name} is not set up`, content: 'Still needed: ' + missing.join(', ') + '. Open the connector on the station to finish setup.' }); return; }
    // Sources feed data in. Reaching one runs a read-only sync and passes the summary along.
    if (a.sync && !a.perform) {
      const r = await integrations.sync(store, c.id);
      addOutbox(store, { kind: 'note', title: c.name + ' synced', content: r.summary, fromRoom: c.name });
      if (outgoing(ref).length) await forward(ref, r.summary, hops, path);
      return;
    }
    let action;
    try { action = integrations.parseAction(c, text); }
    catch (e) { addOutbox(store, { kind: 'note', status: 'blocked', title: `${c.name} could not act`, content: e.message }); return; }
    if (state.settings.policy.connectorWrites === 'auto') {
      const r = await integrations.perform(store, c.id, action);
      addOutbox(store, { kind: 'connector-action', title: r.detail, content: integrations.previewAction(c, action) + (r.url ? '\n\n' + r.url : ''), fromRoom: c.name });
      return;
    }
    guardrails.requestApproval(store, { kind: 'connector.call', summary: `${c.name}: approve this action?`, detail: [integrations.previewAction(c, action)], payload: { connectorId: c.id, action } });
  }
  const startRef = start === 'inbox' || start.startsWith('connector:') || start.startsWith('room:') ? start : 'room:' + start;
  const base = task + (input ? '\n\n' + input : '');
  if (startRef === 'inbox' || startRef.startsWith('connector:')) {
    assert(outgoing(startRef).length, startRef === 'inbox' ? 'Nothing is connected to the Inbox yet. Draw a hallway from it to a room.' : 'That connector has no hallway out.');
    let text = base;
    if (startRef.startsWith('connector:')) {
      const c = state.connectors[startRef.slice(10)]; assert(c, 'Connector not found', 404);
      const a = integrations.adapterFor(c.kind);
      if (a && a.sync) text = (await integrations.sync(store, c.id)).summary + '\n\n' + base;
    }
    await forward(startRef, text, 0, []);
  } else await visit(startRef, base, 0, []);
  return { notes };
}

guardrails.registerExecutor('connector.call', async (store, payload) => {
  const c = store.state.connectors[payload.connectorId]; assert(c, 'Connector was removed.');
  const r = await integrations.perform(store, c.id, payload.action);
  addOutbox(store, { kind: 'connector-action', title: r.detail, content: integrations.previewAction(c, payload.action) + (r.url ? '\n\n' + r.url : ''), fromRoom: c.name });
  return { detail: r.detail };
});

module.exports = { runAgent, dispatch, addOutbox, seatedIn, buildSystem };
