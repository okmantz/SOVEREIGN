'use strict';
// The station model: rooms, desks, hallways, connectors.
// Product law (same spirit as the app that inspired this): the layout IS the permission + workflow graph.
//   room      = capability ceiling for the team inside it
//   desk      = the capability grants for whoever sits there (must fit inside the room)
//   hallway   = an authorized handoff lane between two nodes
//   connector = a port to the outside world (Stripe, email, ads...) that a hallway can reach
const { id, assert, clamp, int } = require('./util');
const { GRID } = require('./store');

const CAPS = {
  'web.search': 'Search the web',
  'web.fetch': 'Read web pages',
  'fs.workspace': 'Read and write files in its own workspace',
  'code.run': 'Run code in a sandbox',
  'email.draft': 'Draft emails',
  'email.send': 'Send emails (rate limited)',
  'ads.read': 'Read ad performance',
  'ads.spend': 'Spend ad budget',
  'payments.read': 'Read payments and balances',
  'payments.charge': 'Create charges or refunds',
  'station.edit': 'Create and edit agents, rooms, hallways (Director only)',
  'venture.create': 'Start and kill ventures (Director only)'
};
const DIRECTOR_ONLY = new Set(['station.edit', 'venture.create']);

const ROOM_KINDS = {
  bridge:   { label: 'Bridge',          color: '#e6b450', caps: ['station.edit', 'venture.create', 'fs.workspace', 'web.search'] },
  lab:      { label: 'Research lab',    color: '#4fb0d1', caps: ['web.search', 'web.fetch', 'fs.workspace'] },
  workshop: { label: 'Build shop',      color: '#8b7be0', caps: ['fs.workspace', 'code.run', 'web.fetch'] },
  market:   { label: 'Outreach floor',  color: '#e0785b', caps: ['email.draft', 'email.send', 'web.fetch', 'fs.workspace'] },
  vault:    { label: 'Ledger vault',    color: '#4fd1b5', caps: ['payments.read', 'ads.read', 'fs.workspace'] },
  review:   { label: 'Review chamber',  color: '#d1c44f', caps: ['fs.workspace', 'web.fetch'] },
  custom:   { label: 'Custom room',     color: '#7f8bbf', caps: ['fs.workspace'] }
};

// Which capability a hallway needs at its source to reach a connector kind.
const CONNECTOR_KINDS = {
  stripe: { label: 'Stripe',        cap: 'payments.read' },
  email:  { label: 'Email',         cap: 'email.send' },
  ads:    { label: 'Ad platform',   cap: 'ads.spend' },
  web:    { label: 'Web',           cap: 'web.fetch' },
  github: { label: 'GitHub',        cap: 'code.run' },
  mcp:    { label: 'MCP server',    cap: 'web.fetch' }
};

const MIN_ROOM = { w: 4, h: 3 };

// Fixed nodes: where human tasks enter and finished work lands.
const FIXED = {
  inbox:  { x: 1,              y: GRID.h - 5, w: 5, h: 4 },
  outbox: { x: GRID.w - 6,     y: GRID.h - 5, w: 5, h: 4 }
};

const overlaps = (a, b, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

function occupiedRects(state, ignoreId) {
  const r = [FIXED.inbox, FIXED.outbox];
  for (const room of Object.values(state.rooms)) if (room.id !== ignoreId) r.push(room);
  for (const c of Object.values(state.connectors)) if (c.id !== ignoreId) r.push({ x: c.x, y: c.y, w: 2, h: 2 });
  return r;
}

// Fill the band below the Bridge first (so pipelines read left to right), then fall back to the top.
function autoPlace(state, w, h) {
  const occ = occupiedRects(state);
  for (const startY of [7, 1])
    for (let y = startY; y <= GRID.h - h - 1; y++)
      for (let x = 1; x <= GRID.w - w - 1; x++) {
        const cand = { x, y, w, h };
        if (!occ.some((o) => overlaps(cand, o, 1))) return { x, y };
      }
  assert(false, 'The station floor is full. Remove or shrink a room first.');
}

function cleanCaps(list, fallback) {
  if (!Array.isArray(list)) return fallback.slice();
  return [...new Set(list.filter((c) => CAPS[c]))];
}

function createRoom(state, p) {
  const kind = ROOM_KINDS[p.kind] ? p.kind : 'custom';
  const w = clamp(int(p.w, 6), MIN_ROOM.w, 20), h = clamp(int(p.h, 4), MIN_ROOM.h, 14);
  let x = p.x, y = p.y;
  if (x == null || y == null) ({ x, y } = autoPlace(state, w, h));
  x = int(x); y = int(y);
  assert(x >= 0 && y >= 0 && x + w <= GRID.w && y + h <= GRID.h, 'Room must fit on the station floor.');
  assert(!occupiedRects(state).some((o) => overlaps({ x, y, w, h }, o)), 'That spot overlaps another room or dock.');
  const room = {
    id: id('room'), name: String(p.name || ROOM_KINDS[kind].label).slice(0, 32), kind, x, y, w, h,
    capabilities: cleanCaps(p.capabilities, ROOM_KINDS[kind].caps)
  };
  state.rooms[room.id] = room;
  return room;
}

function updateRoom(state, roomId, p) {
  const room = state.rooms[roomId]; assert(room, 'Room not found', 404);
  if (p.name != null) room.name = String(p.name).slice(0, 32);
  if (p.kind != null && ROOM_KINDS[p.kind] && p.kind !== room.kind) {
    room.kind = p.kind; room.capabilities = ROOM_KINDS[p.kind].caps.slice(); // preset resets the ceiling
  }
  if (p.capabilities != null) room.capabilities = cleanCaps(p.capabilities, room.capabilities);
  if (p.x != null || p.y != null) {
    const nx = int(p.x, room.x), ny = int(p.y, room.y);
    assert(nx >= 0 && ny >= 0 && nx + room.w <= GRID.w && ny + room.h <= GRID.h, 'Room must stay on the floor.');
    assert(!occupiedRects(state, room.id).some((o) => overlaps({ x: nx, y: ny, w: room.w, h: room.h }, o)), 'That spot overlaps another room.');
    const dx = nx - room.x, dy = ny - room.y;
    room.x = nx; room.y = ny;
    for (const d of Object.values(state.desks)) if (d.roomId === room.id) { d.x += dx; d.y += dy; }
  }
  // A room's ceiling shrinking must never leave a desk with grants the room doesn't allow.
  for (const d of Object.values(state.desks)) if (d.roomId === room.id) d.grants = d.grants.filter((g) => room.capabilities.includes(g));
  return room;
}

function deleteRoom(state, roomId) {
  assert(state.rooms[roomId], 'Room not found', 404);
  const room = state.rooms[roomId];
  assert(room.kind !== 'bridge' || Object.values(state.rooms).filter((r) => r.kind === 'bridge').length > 1,
    'The Bridge is where the Director sits. Keep at least one.');
  for (const d of Object.values(state.desks)) if (d.roomId === roomId) deleteDesk(state, d.id);
  for (const hw of Object.values(state.hallways)) if (hw.from === 'room:' + roomId || hw.to === 'room:' + roomId) delete state.hallways[hw.id];
  delete state.rooms[roomId];
}

function freeDeskSpot(state, room) {
  for (let y = room.y + 1; y < room.y + room.h - 1; y += 2)
    for (let x = room.x + 1; x + 1 < room.x + room.w; x += 3) {
      const cand = { x, y, w: 2, h: 1 };
      if (!Object.values(state.desks).some((d) => overlaps(cand, { x: d.x, y: d.y, w: 2, h: 1 }))) return { x, y };
    }
  return null;
}

function createDesk(state, p) {
  const room = state.rooms[p.roomId]; assert(room, 'Room not found', 404);
  let spot = (p.x != null && p.y != null) ? { x: int(p.x), y: int(p.y) } : freeDeskSpot(state, room);
  assert(spot, 'No space left in that room. Enlarge it or add another room.');
  assert(spot.x > room.x && spot.y > room.y && spot.x + 2 <= room.x + room.w && spot.y + 1 <= room.y + room.h - 0, 'Desks must sit inside the room.');
  assert(!Object.values(state.desks).some((d) => overlaps({ x: spot.x, y: spot.y, w: 2, h: 1 }, { x: d.x, y: d.y, w: 2, h: 1 })), 'A desk is already there.');
  // Director-only caps may sit on a desk grant; effectiveCaps() strips them for anyone but the Director.
  const deflt = room.capabilities.slice();
  const grants = Array.isArray(p.grants) ? p.grants.filter((g) => CAPS[g] && room.capabilities.includes(g)) : deflt;
  const desk = { id: id('desk'), roomId: room.id, x: spot.x, y: spot.y, grants };
  state.desks[desk.id] = desk;
  return desk;
}

function updateDesk(state, deskId, p) {
  const desk = state.desks[deskId]; assert(desk, 'Desk not found', 404);
  const room = state.rooms[desk.roomId];
  if (Array.isArray(p.grants)) desk.grants = p.grants.filter((g) => CAPS[g] && room.capabilities.includes(g));
  return desk;
}

function deleteDesk(state, deskId) {
  assert(state.desks[deskId], 'Desk not found', 404);
  for (const a of Object.values(state.agents)) if (a.deskId === deskId) a.deskId = null;
  delete state.desks[deskId];
}

function nodeExists(state, ref) {
  if (ref === 'inbox' || ref === 'outbox') return true;
  const [type, nid] = String(ref).split(':');
  return (type === 'room' && !!state.rooms[nid]) || (type === 'connector' && !!state.connectors[nid]);
}

function createHallway(state, p) {
  const { from, to } = p;
  assert(nodeExists(state, from) && nodeExists(state, to), 'Both ends of a hallway must exist.');
  assert(from !== to, 'A hallway needs two different ends.');
  assert(from !== 'outbox' && to !== 'inbox', 'Work flows from the Inbox toward the Outbox, not back.');
  assert(!Object.values(state.hallways).some((h) => h.from === from && h.to === to), 'That hallway already exists.');
  const hw = { id: id('hall'), from, to };
  state.hallways[hw.id] = hw;
  return hw;
}
function deleteHallway(state, hid) { assert(state.hallways[hid], 'Hallway not found', 404); delete state.hallways[hid]; }

function createConnector(state, p) {
  const kind = CONNECTOR_KINDS[p.kind] ? p.kind : null; assert(kind, 'Unknown connector kind.');
  let x = p.x, y = p.y;
  if (x == null || y == null) ({ x, y } = autoPlace(state, 2, 2));
  x = int(x); y = int(y);
  assert(x >= 0 && y >= 0 && x + 2 <= GRID.w && y + 2 <= GRID.h, 'Connector must sit on the floor.');
  assert(!occupiedRects(state).some((o) => overlaps({ x, y, w: 2, h: 2 }, o)), 'That spot is taken.');
  const c = { id: id('conn'), kind, name: String(p.name || CONNECTOR_KINDS[kind].label).slice(0, 32), x, y };
  state.connectors[c.id] = c;
  return c;
}
function deleteConnector(state, cid) {
  assert(state.connectors[cid], 'Connector not found', 404);
  for (const hw of Object.values(state.hallways)) if (hw.from === 'connector:' + cid || hw.to === 'connector:' + cid) delete state.hallways[hw.id];
  delete state.connectors[cid];
}

// What an agent may actually do = desk grants ∩ room ceiling ∩ agent ceiling. Director-only caps never leak.
function effectiveCaps(state, agent) {
  const desk = agent.deskId && state.desks[agent.deskId];
  if (!desk) return [];
  const room = state.rooms[desk.roomId];
  let caps = desk.grants.filter((c) => room.capabilities.includes(c));
  if (Array.isArray(agent.ceiling)) caps = caps.filter((c) => agent.ceiling.includes(c));
  if (agent.role !== 'director') caps = caps.filter((c) => !DIRECTOR_ONLY.has(c));
  return caps;
}

module.exports = {
  CAPS, DIRECTOR_ONLY, ROOM_KINDS, CONNECTOR_KINDS, FIXED, MIN_ROOM,
  autoPlace, createRoom, updateRoom, deleteRoom, createDesk, updateDesk, deleteDesk,
  createHallway, deleteHallway, createConnector, deleteConnector, nodeExists, effectiveCaps
};
