'use strict';
// The Director is the first agent. It is the only one holding station.edit and venture.create.
// It proposes PLANS (batches of actions). A plan is dry-run first, then either applied (policy: auto)
// or filed as one approval card for the owner (policy: ask, the default). Plans apply atomically.
const { assert, money, int } = require('./util');
const station = require('./station');
const agents = require('./agents');
const guardrails = require('./guardrails');
const providers = require('./providers');
const runner = require('./runner');
const ledger = require('./ledger');
const { Store, GRID } = require('./store');

const ACTIONS = {
  create_room:      ['name', 'kind'],
  create_desk:      ['room'],
  create_agent:     ['name', 'role'],
  create_hallway:   ['from', 'to'],
  create_connector: ['kind'],
  create_venture:   ['name', 'thesis'],
  run_task:         ['room', 'task']
};

const getDirector = (state) => Object.values(state.agents).find((a) => a.role === 'director');

function ensureDirector(store) {
  const s = store.state;
  if (getDirector(s)) return getDirector(s);
  const bx = Math.floor((GRID.w - 8) / 2);
  const room = station.createRoom(s, { name: 'Bridge', kind: 'bridge', x: bx, y: 1, w: 8, h: 5 });
  const desk = station.createDesk(s, { roomId: room.id });
  const d = agents.createAgent(s, { name: 'Director', role: 'director', deskId: desk.id, _bootstrap: true });
  store.change('state');
  return d;
}

function validate(action) {
  assert(action && ACTIONS[action.type], 'Unknown action: ' + (action && action.type));
  for (const f of ACTIONS[action.type]) assert(action[f] != null && action[f] !== '', `${action.type} needs "${f}".`);
}

// Apply in order with ref resolution. Atomic: any failure restores the snapshot.
function applyPlan(store, actions, { dry = false } = {}) {
  const snapshot = JSON.stringify(store.state);
  const s = store.state;
  const dir = getDirector(s); assert(dir, 'No Director yet.');
  const caps = station.effectiveCaps(s, dir);
  const refs = {};
  const rs = (v) => refs[v] || v;
  const node = (n) => (n === 'inbox' || n === 'outbox') ? n : n.split(':')[0] + ':' + rs(n.split(':').slice(1).join(':'));
  const later = [];
  try {
    for (const a of actions) {
      validate(a);
      if (a.type !== 'run_task') assert(caps.includes('station.edit'), 'The Director needs a desk in a room that grants station.edit.');
      if (a.type === 'create_room') { const r = station.createRoom(s, a); if (a.ref) refs[a.ref] = r.id; }
      else if (a.type === 'create_desk') { const d = station.createDesk(s, { roomId: rs(a.room), grants: a.grants }); if (a.ref) refs[a.ref] = d.id; }
      else if (a.type === 'create_agent') { const ag = agents.createAgent(s, { ...a, role: a.role === 'director' ? 'custom' : a.role, deskId: a.desk ? rs(a.desk) : null }); if (a.ref) refs[a.ref] = ag.id; }
      else if (a.type === 'create_hallway') station.createHallway(s, { from: node(a.from), to: node(a.to) });
      else if (a.type === 'create_connector') {
        const near = a.near && s.rooms[rs(a.near)];
        let c; // "near" puts the port just below a room; if that spot is taken, fall back to auto-placement
        try { c = station.createConnector(s, near ? { ...a, x: near.x + 1, y: near.y + near.h + 2 } : a); }
        catch (_) { c = station.createConnector(s, { ...a, x: undefined, y: undefined }); }
        if (a.ref) refs[a.ref] = c.id;
      }
      else if (a.type === 'create_venture') {
        assert(caps.includes('venture.create'), 'The Director needs venture.create.');
        const v = { id: 'vent_' + Math.random().toString(16).slice(2, 10), name: String(a.name).slice(0, 60), thesis: String(a.thesis).slice(0, 400),
          status: 'testing', budgetCents: Math.max(0, int(a.budgetCents)), maxLossCents: Math.max(0, int(a.maxLossCents, int(a.budgetCents))), createdAt: Date.now() };
        s.ventures[v.id] = v; if (a.ref) refs[a.ref] = v.id;
      } else if (a.type === 'run_task') later.push({ room: rs(a.room), task: String(a.task) });
    }
  } catch (e) { store.state = JSON.parse(snapshot); throw e; }
  if (!dry) {
    store.change('state');
    for (const t of later) runner.dispatch(store, { start: t.room.startsWith('room:') ? t.room : 'room:' + t.room, task: t.task }).catch((e) => console.error('[director] run_task:', e.message));
  }
  return { refs };
}

function describe(actions) {
  const names = {}; for (const a of actions) if (a.ref && a.name) names[a.ref] = a.name;
  const nm = (v) => { if (v === 'inbox') return 'Inbox'; if (v === 'outbox') return 'Outbox'; const id = v.split(':').slice(1).join(':'); return names[id] || names[v] || v; };
  return actions.map((a) => ({
    create_room: () => `Room: ${a.name} (${a.kind})`, create_desk: () => `Desk in ${nm(a.room)}`,
    create_agent: () => `Agent: ${a.name}, ${a.role}${a.desk ? '' : ' (no desk yet)'}`, create_hallway: () => `Hallway: ${nm(a.from)} → ${nm(a.to)}`,
    create_connector: () => `Connector: ${a.name || a.kind}`, create_venture: () => `Venture: ${a.name}, loss limit ${money(int(a.maxLossCents, int(a.budgetCents)))}`,
    run_task: () => `Run now in ${nm(a.room)}: ${String(a.task).slice(0, 60)}`
  }[a.type]()));
}

function summarize(actions) {
  const c = {}; for (const a of actions) c[a.type] = (c[a.type] || 0) + 1;
  const bits = [];
  if (c.create_agent) bits.push(`${c.create_agent} agent${c.create_agent > 1 ? 's' : ''}`);
  if (c.create_room) bits.push(`${c.create_room} room${c.create_room > 1 ? 's' : ''}`);
  if (c.create_hallway) bits.push(`${c.create_hallway} hallway${c.create_hallway > 1 ? 's' : ''}`);
  if (c.create_connector) bits.push(`${c.create_connector} connector${c.create_connector > 1 ? 's' : ''}`);
  if (c.create_venture) bits.push(`${c.create_venture} venture${c.create_venture > 1 ? 's' : ''}`);
  return 'Director plan: ' + (bits.join(', ') || 'a few changes');
}

// Dry-run on a throwaway copy so a plan that cannot fit never reaches the approval card.
function dryRun(store, actions) {
  const copy = new Store({ persist: false });
  copy.state = JSON.parse(JSON.stringify(store.state));
  applyPlan(copy, actions, { dry: true });
}

function propose(store, actions) {
  actions.forEach(validate);
  dryRun(store, actions);
  if (store.state.settings.policy.directorStructure === 'auto') { applyPlan(store, actions); return { applied: true }; }
  const a = guardrails.requestApproval(store, { kind: 'director.plan', summary: summarize(actions), detail: describe(actions), payload: { actions } });
  return { applied: false, approvalId: a.id };
}
guardrails.registerExecutor('director.plan', async (store, payload) => { applyPlan(store, payload.actions); return { applied: payload.actions.length }; });

function directorSystem(state) {
  const p = ledger.progress(state);
  const rooms = Object.values(state.rooms).map((r) => `${r.id}="${r.name}"[${r.kind}]`).join('; ') || 'none';
  const crew = Object.values(state.agents).map((a) => `${a.name}(${a.role})`).join(', ');
  const vs = Object.values(state.ventures).map((v) => `${v.name}[${v.status}] net ${money(ledger.pnl(state, v.id).net)}`).join('; ') || 'none';
  return [
    getDirector(state).persona,
    state.mission ? `Mission: ${state.mission.name}. Target ${money(p.targetCents)} verified profit; verified net so far ${money(p.netCents)}. Capital ${money(state.mission.capitalCents)}, loss limit ${money(state.mission.riskCents)}.` : 'No mission set.',
    `Rooms: ${rooms}\nCrew: ${crew}\nVentures: ${vs}`,
    `Reply with ONLY JSON: {"say": string, "actions": Action[]}. Actions (use "ref" names to refer to things created earlier in the same plan):
create_room {ref?, name, kind: lab|workshop|market|vault|review|custom, w?, h?, capabilities?}
create_desk {ref?, room, grants?}
create_agent {ref?, name, role: researcher|builder|outreach|ops|finance|critic|custom, persona?, model?, desk?}
create_hallway {from, to}  // ends are "inbox", "outbox", "room:<ref|id>", "connector:<ref|id>"
create_connector {ref?, kind: stripe|email|ads|web|github|mcp, name?, near?: <room ref|id>}
create_venture {name, thesis, budgetCents, maxLossCents}
run_task {room, task}
Rules: small experiments before scale; every venture has a loss limit; only verified ledger entries count; the owner approves your plans.`
  ].join('\n\n');
}

function parseReply(text) {
  try {
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return { say: String(j.say || ''), actions: Array.isArray(j.actions) ? j.actions : [] };
  } catch (_) { return { say: text, actions: [] }; }
}

function log(state, dirId, role, content) {
  const t = state.transcripts[dirId] || (state.transcripts[dirId] = []);
  t.push({ role, content, at: Date.now() }); if (t.length > 80) t.splice(0, t.length - 80);
}

async function handleMessage(store, text) {
  const dir = ensureDirector(store);
  guardrails.assertBudget(store.state, dir.id);
  log(store.state, dir.id, 'user', text);
  store.emit('run.start', { agentId: dir.id });
  try {
    const res = await providers.complete(store, { agent: dir, purpose: 'director', system: directorSystem(store.state),
      messages: store.state.transcripts[dir.id].slice(-10).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })) });
    guardrails.recordSpend(store, { agentId: dir.id, cents: res.costCents, tokensIn: res.tokensIn, tokensOut: res.tokensOut, model: res.model });
    const { say, actions } = parseReply(res.text);
    log(store.state, dir.id, 'assistant', say);
    let outcome = { applied: false, approvalId: null, error: null };
    if (actions.length) {
      try { outcome = { ...outcome, ...propose(store, actions) }; }
      catch (e) { outcome.error = e.message; log(store.state, dir.id, 'assistant', `My plan didn't fit: ${e.message}. Tell me what to change and I'll re-plan.`); }
    }
    return { say, ...outcome };
  } finally { store.emit('run.done', { agentId: dir.id }); store.change('state'); }
}

module.exports = { ensureDirector, getDirector, handleMessage, applyPlan, propose, validate, describe, ACTIONS };
