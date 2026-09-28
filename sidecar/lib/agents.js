'use strict';
const { id, assert } = require('./util');
const { ROLES, ALIASES, roleOf } = require('./roles');
const avatars = require('./avatars');
const station = require('./station');

function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

// Default look for a role, with a little variety so five Copywriters are not identical.
function defaultAvatar(role, seed) {
  const base = avatars.fromPreset(ROLES[roleOf(role)].preset);
  if (role === 'director') return base;
  const h = hash(seed);
  base.skin = avatars.PALETTE.skin[h % 6];
  return base;
}
function forceDirectorLook(av) { av.headwear = 'crown'; if (av.hatColor === '#0e1116') av.hatColor = '#c9a13a'; return av; }
function cleanFor(role, input, fallback) {
  const av = avatars.clean(input, fallback);
  return role === 'director' ? forceDirectorLook(av) : av.headwear === 'crown' ? { ...av, headwear: 'none' } : av;
}

function seat(state, agentId, deskId) {
  const agent = state.agents[agentId]; assert(agent, 'Agent not found', 404);
  if (deskId == null) { agent.deskId = null; return agent; }
  assert(state.desks[deskId], 'Desk not found', 404);
  const other = Object.values(state.agents).find((a) => a.deskId === deskId && a.id !== agentId);
  assert(!other, 'That desk already has ' + (other && other.name) + ' sitting at it.');
  agent.deskId = deskId;
  return agent;
}

// Every agent gets their own desk. Find a free spot in a room that fits the role; grow the room if it is full;
// open a new room of that kind if it cannot grow. Desks made here are marked auto and removed with the agent.
function placeAgent(state, agentId, preferRoomId) {
  const agent = state.agents[agentId]; assert(agent, 'Agent not found', 404);
  if (agent.deskId && state.desks[agent.deskId]) return state.desks[agent.deskId];
  const kind = ROLES[roleOf(agent.role)].room;
  const matching = () => Object.values(state.rooms).filter((r) => kind === 'custom' ? r.kind !== 'bridge' : r.kind === kind);
  const seatAt = (room) => { const desk = station.createDesk(state, { roomId: room.id, auto: true }); seat(state, agent.id, desk.id); return desk; };
  const pref = preferRoomId && state.rooms[preferRoomId]; // the user clicked a specific room: seat them there, growing it if needed
  if (pref) { do { if (station.freeDeskSpot(state, pref)) return seatAt(pref); } while (station.growRoom(state, pref)); assert(false, 'That room is full and cannot grow. Enlarge it or pick another room.'); }
  for (const room of matching()) if (station.freeDeskSpot(state, room)) return seatAt(room);
  for (const room of matching()) while (station.growRoom(state, room)) if (station.freeDeskSpot(state, room)) return seatAt(room);
  const kindKey = station.ROOM_KINDS[kind] ? kind : 'custom';
  const room = station.createRoom(state, { kind: kindKey, name: station.ROOM_KINDS[kindKey].label, w: 8, h: 5 });
  return seatAt(room);
}

function createAgent(state, p) {
  const role = ROLES[roleOf(p.role)] ? roleOf(p.role) : 'custom';
  const isFirst = Object.keys(state.agents).length === 0;
  if (role === 'director') assert(isFirst || p._bootstrap, 'There is only one Director.');
  const name = String(p.name || ROLES[role].label).trim().slice(0, 24) || ROLES[role].label;
  const agent = {
    id: id('agent'), name, role,
    persona: String(p.persona || ROLES[role].persona).slice(0, 2000),
    model: p.model ? String(p.model).slice(0, 80) : null, // null = use the station default
    avatar: cleanFor(role, p.avatar, defaultAvatar(role, name)),
    deskId: null, locked: role === 'director',
    ceiling: Array.isArray(p.ceiling) ? p.ceiling : null, // null = the role's own ceiling
    createdAt: Date.now()
  };
  state.agents[agent.id] = agent;
  state.transcripts[agent.id] = [];
  if (p.deskId) seat(state, agent.id, p.deskId);
  else if (!p.noDesk) { try { placeAgent(state, agent.id, p.roomId); } catch (e) { delete state.agents[agent.id]; delete state.transcripts[agent.id]; throw e; } }
  return agent;
}

function updateAgent(state, agentId, p) {
  const a = state.agents[agentId]; assert(a, 'Agent not found', 404);
  if (p.name != null) { const n = String(p.name).trim().slice(0, 24); assert(n, 'An agent needs a name.'); a.name = n; }
  if (p.persona != null) a.persona = String(p.persona).slice(0, 2000);
  if (p.model !== undefined) a.model = p.model ? String(p.model).slice(0, 80) : null;
  if (p.role != null && roleOf(p.role) !== a.role) {
    assert(!a.locked, 'The Director\'s role cannot change.');
    assert(ROLES[roleOf(p.role)] && roleOf(p.role) !== 'director', 'Pick one of the agent roles.');
    a.role = roleOf(p.role);
  }
  if (p.avatar) a.avatar = cleanFor(a.role, p.avatar, a.avatar);
  if (Array.isArray(p.ceiling) || p.ceiling === null) a.ceiling = p.ceiling;
  if (p.deskId !== undefined) { if (p.deskId) seat(state, a.id, p.deskId); else { seat(state, a.id, null); placeAgent(state, a.id); } }
  return a;
}

function deleteAgent(state, agentId) {
  const a = state.agents[agentId]; assert(a, 'Agent not found', 404);
  assert(!a.locked, 'The Director cannot be removed.');
  const desk = a.deskId && state.desks[a.deskId];
  if (desk && desk.auto) delete state.desks[desk.id];
  delete state.agents[agentId]; delete state.transcripts[agentId];
}

// Upgrade state written by older versions: legacy avatars, renamed roles, old connector kinds.
function migrate(state) {
  let changed = false;
  for (const a of Object.values(state.agents)) {
    if (ALIASES[a.role]) { a.role = ALIASES[a.role]; changed = true; }
    if (!ROLES[a.role]) { a.role = 'custom'; changed = true; }
    if (avatars.isLegacy(a.avatar)) { a.avatar = cleanFor(a.role, null, defaultAvatar(a.role, a.name)); changed = true; }
    if (a.ceiling && !a.ceiling.length) { a.ceiling = null; changed = true; }
  }
  for (const c of Object.values(state.connectors)) {
    if (station.CONNECTOR_ALIASES[c.kind]) { c.kind = station.CONNECTOR_ALIASES[c.kind]; changed = true; }
    if (!c.config) { Object.assign(c, { config: {}, status: 'unconfigured', lastError: null, lastSyncAt: null, cursor: null, ventureId: null, autoSync: true }); changed = true; }
  }
  const pol = state.settings.policy;
  if (pol.connectorWrites == null) { pol.connectorWrites = pol.firstOutreachApproval === false ? 'auto' : 'ask'; delete pol.firstOutreachApproval; changed = true; }
  if (!state.settings.ollama) { state.settings.ollama = { host: 'http://127.0.0.1:11434' }; changed = true; }
  if (!state.settings.openaiCompat) { state.settings.openaiCompat = { baseUrl: 'https://api.openai.com/v1' }; changed = true; }
  return changed;
}

module.exports = { ROLES, defaultAvatar, createAgent, updateAgent, deleteAgent, seat, placeAgent, migrate, cleanFor };
