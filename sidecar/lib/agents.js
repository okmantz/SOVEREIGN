'use strict';
const { id, assert } = require('./util');

const ROLES = {
  director:   { label: 'Director',   persona: 'You are the Director of Sovereign. You own the profit target. You design the crew, the rooms and the hallways, launch small ventures, read the verified ledger, and kill what does not earn. You are decisive, numerate and allergic to vanity metrics. You propose plans; the owner approves anything structural or expensive.' },
  researcher: { label: 'Researcher', persona: 'You find real demand: who pays, how much, where they gather, what they already buy. You cite sources and separate evidence from guesses.' },
  builder:    { label: 'Builder',    persona: 'You ship the smallest working thing: landing page, offer, product, automation. You prefer boring and finished over clever and late.' },
  outreach:   { label: 'Outreach',   persona: 'You write direct outreach and ad copy that a real person would reply to. Short, specific, honest. You never invent claims, and you respect opt-outs and sending limits.' },
  ops:        { label: 'Operator',   persona: 'You fulfil orders, answer customers and keep delivery on time. You escalate anything legal, financial or unusual.' },
  finance:    { label: 'Finance',    persona: 'You reconcile the ledger. Only verified entries count as revenue. You flag any venture past its loss limit and report unit economics plainly.' },
  critic:     { label: 'Critic',     persona: 'You attack plans before money is spent: weak demand, platform-policy risk, legal exposure, cost blowouts. You approve, reject or send back with specific fixes.' },
  custom:     { label: 'Custom',     persona: 'You are a specialist. Follow your persona and stay inside your permissions.' }
};

const PALETTE = {
  skin:   ['#f2d0b0', '#e0ac82', '#c68a5f', '#8d5a3c', '#5e3b26'],
  hair:   ['#1c1c24', '#5a3a22', '#a4682e', '#d9b25a', '#c9c9d6', '#b8462f', '#3f6bd1'],
  outfit: ['#e6b450', '#4fb0d1', '#8b7be0', '#e0785b', '#4fd1b5', '#d1c44f', '#7f8bbf', '#d15f8c']
};
const ACCESSORIES = ['none', 'glasses', 'headset', 'visor', 'crown'];

function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function randomAvatar(seed) {
  const h = hash(seed);
  return {
    skin: PALETTE.skin[h % 5], hair: PALETTE.hair[(h >> 3) % 7], hairStyle: (h >> 6) % 4,
    outfit: PALETTE.outfit[(h >> 9) % 8], accessory: ACCESSORIES[(h >> 12) % 4] // never crown; that is the Director's
  };
}
function cleanAvatar(a, fallback) {
  if (!a || typeof a !== 'object') return fallback;
  const hex = (v, list, d) => (/^#[0-9a-f]{6}$/i.test(v) ? v : d);
  return {
    skin: hex(a.skin, 0, fallback.skin), hair: hex(a.hair, 0, fallback.hair), outfit: hex(a.outfit, 0, fallback.outfit),
    hairStyle: Number.isInteger(a.hairStyle) ? Math.abs(a.hairStyle) % 4 : fallback.hairStyle,
    accessory: ACCESSORIES.includes(a.accessory) ? a.accessory : fallback.accessory
  };
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

function createAgent(state, p) {
  const role = ROLES[p.role] ? p.role : 'custom';
  const isFirst = Object.keys(state.agents).length === 0;
  if (role === 'director') assert(isFirst || p._bootstrap, 'There is only one Director.');
  const name = String(p.name || ROLES[role].label).slice(0, 24);
  const base = randomAvatar(name + role);
  let avatar = cleanAvatar(p.avatar, base);
  if (role === 'director') avatar.accessory = 'crown';
  else if (avatar.accessory === 'crown') avatar.accessory = 'none';
  const agent = {
    id: id('agent'), name, role,
    persona: String(p.persona || ROLES[role].persona).slice(0, 2000),
    model: p.model ? String(p.model).slice(0, 80) : null, // null = use the station default
    avatar, deskId: null, locked: role === 'director',
    ceiling: Array.isArray(p.ceiling) ? p.ceiling : null, createdAt: Date.now()
  };
  state.agents[agent.id] = agent;
  state.transcripts[agent.id] = [];
  if (p.deskId) seat(state, agent.id, p.deskId);
  return agent;
}

function updateAgent(state, agentId, p) {
  const a = state.agents[agentId]; assert(a, 'Agent not found', 404);
  if (p.name != null) a.name = String(p.name).slice(0, 24);
  if (p.persona != null) a.persona = String(p.persona).slice(0, 2000);
  if (p.model !== undefined) a.model = p.model ? String(p.model).slice(0, 80) : null;
  if (p.role != null && p.role !== a.role) {
    assert(!a.locked, 'The Director\'s role cannot change.');
    assert(ROLES[p.role] && p.role !== 'director', 'Pick one of the crew roles.');
    a.role = p.role;
  }
  if (p.avatar) {
    a.avatar = cleanAvatar(p.avatar, a.avatar);
    if (a.role === 'director') a.avatar.accessory = 'crown';
    else if (a.avatar.accessory === 'crown') a.avatar.accessory = 'none';
  }
  if (Array.isArray(p.ceiling) || p.ceiling === null) a.ceiling = p.ceiling;
  if (p.deskId !== undefined) seat(state, a.id, p.deskId);
  return a;
}

function deleteAgent(state, agentId) {
  const a = state.agents[agentId]; assert(a, 'Agent not found', 404);
  assert(!a.locked, 'The Director cannot be removed.');
  delete state.agents[agentId]; delete state.transcripts[agentId];
}

module.exports = { ROLES, PALETTE, ACCESSORIES, randomAvatar, createAgent, updateAgent, deleteAgent, seat };
