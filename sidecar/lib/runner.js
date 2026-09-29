'use strict';
// Agents run from desks. Work moves along hallways. Nothing runs without a seat, a budget and capabilities.
const { id, assert } = require('./util');
const providers = require('./providers');
const guardrails = require('./guardrails');
const station = require('./station');
const integrations = require('./integrations');
const jobs = require('./jobs');
const memory = require('./memory');
const sites = require('./sites');
const comfy = require('./comfy');
const loop = require('./loop');
const activity = require('./activity');
const { roleOf } = require('./roles');

const MAX_HOPS = 12;
const kindLabel = (k) => (station.CONNECTOR_KINDS[k] || {}).label || k;

function outputContracts(state, agent) {
  const desk = agent.deskId && state.desks[agent.deskId]; if (!desk) return '';
  const lines = Object.values(state.hallways).filter((h) => h.from === 'room:' + desk.roomId && h.to.startsWith('connector:'))
    .map((h) => state.connectors[h.to.slice(10)]).filter((c) => c && integrations.adapterFor(c.kind) && integrations.adapterFor(c.kind).contract)
    .map((c) => `When your work is ready to hand to "${c.name}", end your reply with exactly one JSON object shaped like ${integrations.adapterFor(c.kind).contract} and nothing after it.`);
  return lines.join('\n');
}

// How long a deliverable may run. Output length is the biggest driver of wait time, so 'fast' is the default.
const SPEEDS = { fast: { tokens: 700, words: 260 }, balanced: { tokens: 1000, words: 380 }, thorough: { tokens: 1500, words: 650 } };
const speedOf = (state) => SPEEDS[(state.settings || {}).speed] || SPEEDS.fast;

function buildSystem(state, agent, caps, { pipeline = false } = {}) {
  const m = state.mission, local = state.settings && state.settings.provider && state.settings.provider.name === 'ollama';
  return [
    agent.persona,
    jobs.systemFor(agent, m, { local }),
    state.focus ? `World focus: ${state.focus}` : '',
    m ? `Goal: ${m.name}. Target: earn ${(m.targetCents / 100).toFixed(2)} USD of VERIFIED profit. Only ledger entries confirmed by a payment platform, ad platform or the bank count; anything you claim without proof is ignored.` : 'No goal is set yet.',
    memory.constraints(state),
    memory.block(state, { local }),
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
// Local models get a shorter history: prompt size is the biggest driver of response time.
function history(store, agentId) {
  const local = store.state.settings.provider.name === 'ollama';
  return store.state.transcripts[agentId].slice(local ? -6 : -12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, local ? 1800 : 6000) }));
}

// stateless: send only this prompt (job tasks carry their own context and the shared memory), not the whole chat history.
// That keeps prompts small, which is the second biggest driver of wait time after output length.
async function runAgent(store, agentId, task, { input, pipeline = false, maxTokens = 900, stateless = false, title } = {}) {
  const state = store.state;
  const agent = state.agents[agentId]; assert(agent, 'Agent not found', 404);
  assert(agent.deskId && state.desks[agent.deskId], `${agent.name} has no desk. Seat them at a desk to give them work.`);
  guardrails.assertBudget(state, agentId);
  const caps = station.effectiveCaps(state, agent);
  const prompt = input ? `${task}\n\nInput from the previous stage:\n${input}` : task;
  return activity.track(store, agentId, title || (pipeline ? 'Working the pipeline' : 'Answering you'), async () => {
    push(state, agentId, 'user', prompt);
    store.change('state');
    let last = 0;
    const onToken = (full) => { const now = Date.now(); if (now - last > 180) { last = now; store.emit('token', { agentId, text: full.slice(-1200) }); } }; // live text for the chat
    try {
      const res = await providers.complete(store, { agent, system: buildSystem(state, agent, caps, { pipeline }), purpose: 'agent', maxTokens,
        messages: stateless ? [{ role: 'user', content: String(prompt).slice(0, 12000) }] : history(store, agentId), onToken });
      guardrails.recordSpend(store, { agentId, cents: res.costCents, tokensIn: res.tokensIn, tokensOut: res.tokensOut, model: res.model });
      push(state, agentId, 'assistant', res.text);
      return res.text;
    } catch (e) {
      push(state, agentId, 'assistant', 'I could not finish that: ' + e.message);
      throw e;
    } finally { store.change('state'); }
  });
}

function addOutbox(store, item) {
  const o = { id: id('out'), at: Date.now(), kind: 'deliverable', status: 'done', ...item };
  store.state.outbox.unshift(o);
  if (store.state.outbox.length > 300) { const keep = store.state.outbox.filter((x, i) => i < 300 || x.kind === 'sop'); store.state.outbox.length = 0; store.state.outbox.push(...keep); } // trim, but never lose an SOP
  store.change('outbox', { id: o.id });
  return o;
}

// One unit of job work: builds the prompt from the agent's coded job, runs it, files the result in the Outbox, and leaves a
// handoff in the team memory so the next agent builds on it. Job tasks are stateless: they carry their own context.
async function assign(store, { agentId, taskId, instructions, title, context, maxTokens, taskLabel, refId, light }) {
  const agent = store.state.agents[agentId]; assert(agent, 'Agent not found', 404);
  const sp = speedOf(store.state), t = jobs.spec(agent.role).tasks.find((x) => x.id === taskId), label = taskLabel || (t && t.label) || 'Working on a task', cfg = loop.config(store.state);
  const prompt = jobs.taskPrompt(agent, { taskId, instructions, context: { words: sp.words, ...(context || {}) } }), tokens = maxTokens || sp.tokens;
  // Execute
  let raw = await runAgent(store, agentId, prompt, { maxTokens: tokens, stateless: true, title: label });
  // Evaluate → revise → Learn. It repeats until the result passes or the revision limit is reached.
  const rounds = []; let accepted = true;
  for (let i = 0; ; i++) {
    const v = await loop.evaluate(store, { agent, spec: jobs.spec(agent.role), taskId, label, text: raw, light });
    rounds.push(v); if (v.pass) break;
    if (i >= cfg.maxRevisions) { accepted = false; break; }
    try { raw = await runAgent(store, agentId, loop.revisionPrompt(prompt, raw, v.gaps), { maxTokens: tokens, stateless: true, title: `Revising: ${label}` }); }
    catch (e) { if (e.status === 402 || e.status === 502) throw e; accepted = false; break; } // a failed revision keeps the earlier answer
  }
  loop.learn(store.state, { agent, label, rounds, accepted });
  const name = title || `${agent.name}: ${t ? t.label : 'task'}`;
  const rec = memory.record(store.state, { refId: refId || null, agentName: agent.name, role: agent.role, title: label, text: raw });
  let text = rec.clean || raw, images = [];
  const open = accepted ? [] : (rounds[rounds.length - 1].gaps || []);
  if (open.length) text += `\n\nOpen issues after ${cfg.maxRevisions} revision${cfg.maxRevisions === 1 ? '' : 's'}: ${open.join(' ')}`;
  if (comfy.available(store.state) && comfy.parseBlock(text).items.length) { // ComfyUI is connected and the agent asked for pictures
    try { const r = await activity.track(store, agentId, `Rendering images: ${label}`, () => comfy.fromReply(store, text)); text = r.text; images = r.images; } catch (e) { text += `\n\n(Image generation failed: ${e.message})`; }
  }
  const files = ['builder', 'developer', 'ecommerce_manager', 'designer'].includes(agent.role) ? sites.ingest(store, text) : []; // real files go to the site folder
  try { text = (await require('./company/bridge').runAgentTools(store, agent, text)).text; } catch (e) { text += `\n\n(Company tools could not run: ${e.message})`; }
  const o = addOutbox(store, { title: name, content: text, fromRoom: agent.name, meta: { agentId, taskId: taskId || null, handoff: rec.entry.text, loop: { checks: rounds.length, revisions: rounds.length - 1, passed: accepted && rounds[rounds.length - 1].pass, by: rounds[rounds.length - 1].by }, ...(images.length ? { images: images.map((i) => ({ name: i.name, url: `/sites/${store.id || store.defaultId}/${i.name}` })) } : {}), ...(files.length ? { files, preview: `/sites/${store.id || store.defaultId}/` } : {}) } });
  store.change('state');
  return { text, outboxId: o.id, handoff: rec.entry.text, revisions: rounds.length - 1 };
}

const seatedIn = (state, roomId) =>
  Object.values(state.agents).filter((a) => a.deskId && state.desks[a.deskId] && state.desks[a.deskId].roomId === roomId);
const label = (state, ref) => !ref ? '' : ref === 'inbox' ? 'Inbox' : ref === 'outbox' ? 'Outbox'
  : ref.startsWith('room:') ? (state.rooms[ref.slice(5)] || {}).name : (state.connectors[ref.slice(10)] || {}).name;

// Hand text to a connector: a portal to another world, a read-only sync, or an action that waits for approval.
// soft = do not clutter the Outbox with "not set up" notes (used for optional deliveries).
async function sendToConnector(store, c, text, { soft = false } = {}) {
  const state = store.state, a = integrations.adapterFor(c.kind);
  if (c.kind === 'portal') {
    const tw = c.config.targetWorld; assert(tw, 'This portal is not linked to a world yet.');
    const r = require('./worlds').deliver(store, tw, text);
    addOutbox(store, { kind: 'note', title: `Sent to world “${r.world}”`, content: text, fromRoom: c.name });
    return { status: 'sent' };
  }
  if (!a) { if (!soft) addOutbox(store, { kind: 'connector-request', status: 'queued', title: 'Queued for ' + c.name, content: text }); return { status: 'queued' }; }
  const missing = integrations.missing(c);
  if (missing.length) { if (!soft) addOutbox(store, { kind: 'note', status: 'blocked', title: `${c.name} is not set up`, content: 'Still needed: ' + missing.join(', ') + '. Open the connector to finish setup.' }); return { status: 'blocked' }; }
  if (a.sync && !a.perform) {
    const r = await integrations.sync(store, c.id);
    addOutbox(store, { kind: 'note', title: c.name + ' synced', content: r.summary, fromRoom: c.name });
    return { status: 'synced', summary: r.summary };
  }
  let action;
  try { action = integrations.parseAction(c, text); }
  catch (e) { if (!soft) addOutbox(store, { kind: 'note', status: 'blocked', title: `${c.name} could not act`, content: e.message }); return { status: 'blocked', error: e.message }; }
  if (state.settings.policy.connectorWrites === 'auto') {
    const r = await integrations.perform(store, c.id, action);
    addOutbox(store, { kind: 'connector-action', title: r.detail, content: integrations.previewAction(c, action) + (r.url ? '\n\n' + r.url : ''), fromRoom: c.name });
    return { status: 'done' };
  }
  guardrails.requestApproval(store, { kind: 'connector.call', summary: `${c.name}: approve this action?`, detail: [integrations.previewAction(c, action)], payload: { connectorId: c.id, action } });
  return { status: 'approval' };
}

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
    const meta = station.CONNECTOR_KINDS[c.kind];
    const src = path[path.length - 1];
    const srcRoom = src && src.startsWith('room:') ? state.rooms[src.slice(5)] : null;
    if (srcRoom && !srcRoom.capabilities.includes(meta.cap)) {
      addOutbox(store, { kind: 'note', status: 'blocked', title: `Blocked: ${srcRoom.name} → ${c.name}`, content: `${srcRoom.name} does not have "${station.CAPS[meta.cap]}". Turn it on for the room (and its desks) to open this hallway.` });
      return;
    }
    const r = await sendToConnector(store, c, text);
    if (r.status === 'synced' && outgoing(ref).length) await forward(ref, r.summary, hops, path);
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

module.exports = { runAgent, assign, sendToConnector, dispatch, addOutbox, seatedIn, buildSystem, kindLabel, speedOf, SPEEDS };
