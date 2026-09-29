'use strict';
// Worlds: separate stations, each with its own Director, rooms, agents, goal and roadmap. Portals (a connector kind)
// connect them so one world's work, or its Director, can hand things to another.
const { assert } = require('./util');
const station = require('./station');

const KINDS = {
  general:   { label: 'General',        color: '#00ff88', focus: '' },
  ecommerce: { label: 'E-commerce',     color: '#ffb020', focus: 'Run online stores: find products, write listings, drive traffic and fulfil orders.' },
  trading:   { label: 'Trading',        color: '#39c5ff', focus: 'Research, backtest and review trading strategies. Paper trade first and never promise returns.' },
  content:   { label: 'Content',        color: '#ff5ecf', focus: 'Build an audience and monetise it with content, email and offers.' },
  services:  { label: 'Services',       color: '#ff9a3c', focus: 'Sell a service to businesses through direct outreach and close deals.' },
  product:   { label: 'Product',        color: '#9b7bff', focus: 'Validate, build and launch a software or digital product.' }
};
const rootOf = (store) => store.root || store;
const idOf = (store) => store.id || store.defaultId;
const log = (e) => console.error('[worlds]', e.message);

function summary(root) {
  return Object.values(root.data.worlds).map((w) => ({
    id: w.id, name: w.name, kind: w.kind, color: w.color, focus: w.focus, agents: Object.keys(w.agents).length, rooms: Object.keys(w.rooms).length,
    stage: w.journey ? w.journey.stage : 'goal', goal: w.mission ? w.mission.name : null,
    links: Object.values(w.connectors).filter((c) => c.kind === 'portal' && c.config.targetWorld && root.data.worlds[c.config.targetWorld]).map((c) => c.config.targetWorld)
  }));
}

function create(root, { name, kind, focus }) {
  const n = String(name || '').trim().slice(0, 32); assert(n, 'Give the world a name.');
  const k = KINDS[kind] ? kind : 'general';
  const id = root.addWorld(n, { kind: k, color: KINDS[k].color, focus: String(focus || KINDS[k].focus).slice(0, 300) });
  require('./director').ensureDirector(root.forWorld(id));
  root.change('state', { worldId: id });
  return id;
}

function update(root, id, p) {
  const w = root.world(id); assert(w, 'World not found', 404);
  if (p.name != null) { const n = String(p.name).trim().slice(0, 32); assert(n, 'A world needs a name.'); w.name = n; }
  if (p.focus != null) w.focus = String(p.focus).slice(0, 300);
  if (p.kind && KINDS[p.kind]) { w.kind = p.kind; w.color = KINDS[p.kind].color; }
  root.change('state', { worldId: id });
  return w;
}

function remove(root, id) {
  assert(root.world(id), 'World not found', 404);
  assert(Object.keys(root.data.worlds).length > 1, 'You need at least one world.');
  const integrations = require('./integrations');
  for (const c of Object.values(root.world(id).connectors)) integrations.forget(c);
  root.removeWorld(id);
  for (const w of Object.values(root.data.worlds)) { // close portals that pointed at it
    for (const c of Object.values(w.connectors)) if (c.kind === 'portal' && c.config.targetWorld === id) station.deleteConnector(w, c.id);
  }
  if (root.defaultId === id) root.defaultId = Object.keys(root.data.worlds)[0];
  root.change('state', {});
}

const portalTo = (w, targetId) => Object.values(w.connectors).find((c) => c.kind === 'portal' && c.config.targetWorld === targetId);
function openPortal(root, fromId, toId) {
  const from = root.world(fromId), to = root.world(toId);
  if (portalTo(from, toId)) return portalTo(from, toId);
  const c = station.createConnector(from, { kind: 'portal', name: ('To ' + to.name).slice(0, 32) });
  c.config.targetWorld = toId; c.status = 'ready';
  return c;
}
// Two-way link: a portal in each world.
function connect(root, a, b) {
  assert(a !== b && root.world(a) && root.world(b), 'Pick two different worlds.');
  openPortal(root, a, b); openPortal(root, b, a);
  root.change('state', { worldId: a });
}
function disconnect(root, a, b) {
  for (const [x, y] of [[a, b], [b, a]]) { const w = root.world(x), c = w && portalTo(w, y); if (c) station.deleteConnector(w, c.id); }
  root.change('state', { worldId: a });
}
const isLinked = (root, fromId, toId) => !!portalTo(root.world(fromId), toId);

// Hand a piece of work to another world. If its Inbox is wired, it flows through that world's hallways;
// otherwise that world's Director receives it as a message. Runs in the background.
function deliver(store, targetId, text) {
  const root = rootOf(store), fromId = idOf(store), from = root.world(fromId), target = root.world(targetId);
  assert(target, 'That world no longer exists.', 404);
  const view = root.forWorld(targetId), note = `From world "${from.name}": ${text}`;
  const wired = Object.values(target.hallways).some((h) => h.from === 'inbox');
  if (wired) require('./runner').dispatch(view, { start: 'inbox', task: note }).catch(log);
  else require('./director').handleMessage(view, note).catch(log);
  return { mode: wired ? 'inbox' : 'director', world: target.name };
}

module.exports = { KINDS, summary, create, update, remove, connect, disconnect, isLinked, deliver, portalTo, rootOf, idOf };
