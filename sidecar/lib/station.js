'use strict';
// The station model: rooms, desks, hallways, connectors.
// Product law: the layout IS the permission + workflow graph.
//   room      = capability ceiling for the team inside it
//   desk      = the capability grants for whoever sits there (must fit inside the room)
//   hallway   = an authorized handoff lane between two nodes
//   connector = a port to the outside world (Stripe, email, Shopify...) that a hallway can reach
const { id, assert, clamp, int } = require('./util');
const { GRID } = require('./store');
const { roleCaps } = require('./roles');

const CAPS = {
  'web.search': 'Search the web',
  'web.fetch': 'Read web pages',
  'fs.workspace': 'Read and write files in its own workspace',
  'code.run': 'Run code in a sandbox',
  'email.draft': 'Draft emails',
  'email.send': 'Send emails (rate limited)',
  'social.post': 'Draft social posts',
  'calendar.read': 'Read the calendar',
  'calendar.write': 'Create calendar events',
  'drive.write': 'Create files in Google Drive',
  'notion.write': 'Create pages in Notion',
  'notify.send': 'Send notifications (Slack, Discord, Telegram)',
  'db.write': 'Add rows to Airtable and Google Sheets',
  'webhook.send': 'Send data to a webhook URL',
  'shop.read': 'Read Etsy, Shopify and WooCommerce orders',
  'shop.write': 'Edit store listings',
  'ads.read': 'Read ad performance',
  'ads.spend': 'Spend ad budget',
  'payments.read': 'Read payments and balances',
  'payments.charge': 'Create charges or refunds',
  'station.edit': 'Create and edit agents, rooms, hallways (Director only)',
  'venture.create': 'Start and kill ventures (Director only)'
};
const DIRECTOR_ONLY = new Set(['station.edit', 'venture.create']);

const ROOM_KINDS = {
  bridge:     { label: 'Bridge',          color: '#ffd24a', caps: ['station.edit', 'venture.create', 'fs.workspace', 'web.search', 'web.fetch', 'notify.send'] },
  lab:        { label: 'Research lab',    color: '#22e5ff', caps: ['web.search', 'web.fetch', 'fs.workspace', 'payments.read', 'shop.read', 'ads.read', 'drive.write', 'db.write', 'webhook.send', 'notify.send'] },
  workshop:   { label: 'Build shop',      color: '#9b7bff', caps: ['fs.workspace', 'code.run', 'web.fetch', 'webhook.send'] },
  market:     { label: 'Outreach floor',  color: '#ff9a3c', caps: ['email.draft', 'email.send', 'calendar.read', 'calendar.write', 'web.search', 'web.fetch', 'fs.workspace', 'drive.write', 'notify.send', 'db.write'] },
  studio:     { label: 'Content studio',  color: '#ff5ecf', caps: ['web.search', 'web.fetch', 'fs.workspace', 'drive.write', 'notion.write', 'calendar.write', 'social.post', 'notify.send', 'db.write'] },
  adbay:      { label: 'Ad bay',          color: '#ff4d6d', caps: ['ads.read', 'ads.spend', 'web.fetch', 'fs.workspace', 'notify.send'] },
  storefront: { label: 'Storefront',      color: '#7dff5a', caps: ['shop.read', 'shop.write', 'web.fetch', 'fs.workspace', 'drive.write', 'notify.send', 'db.write'] },
  support:    { label: 'Support desk',    color: '#5ab0ff', caps: ['email.draft', 'email.send', 'calendar.read', 'calendar.write', 'notion.write', 'drive.write', 'fs.workspace', 'notify.send'] },
  vault:      { label: 'Ledger vault',    color: '#00ff88', caps: ['payments.read', 'ads.read', 'shop.read', 'fs.workspace', 'notify.send', 'db.write', 'webhook.send'] },
  review:     { label: 'Review chamber',  color: '#d6ff3a', caps: ['fs.workspace', 'web.fetch', 'notify.send'] },
  custom:     { label: 'Custom room',     color: '#8fbf9f', caps: ['fs.workspace'] }
};

// cap: what a hallway needs at its source room to reach this connector.
// mode: source = data comes in (sync), sink = actions go out (approved), both, stub = not wired yet.
const CONNECTOR_KINDS = {
  stripe:   { label: 'Stripe',           cap: 'payments.read',  mode: 'source', color: '#8b7bff', glyph: 'STR' },
  email:    { label: 'Email (Resend)',   cap: 'email.send',     mode: 'sink',   color: '#ff9a3c', glyph: 'MAIL' },
  calendar: { label: 'Google Calendar',  cap: 'calendar.write', mode: 'both',   color: '#6aa8ff', glyph: 'CAL' },
  drive:    { label: 'Google Drive',     cap: 'drive.write',    mode: 'both',   color: '#3ddc84', glyph: 'DRV' },
  notion:   { label: 'Notion',           cap: 'notion.write',   mode: 'sink',   color: '#e6efe9', glyph: 'NOT' },
  etsy:     { label: 'Etsy',             cap: 'shop.read',      mode: 'source', color: '#ff7a3c', glyph: 'ETSY' },
  shopify:  { label: 'Shopify',          cap: 'shop.read',      mode: 'source', color: '#95bf47', glyph: 'SHP' },
  meta_ads: { label: 'Facebook Ads',     cap: 'ads.read',       mode: 'source', color: '#4d8dff', glyph: 'ADS' },
  slack:    { label: 'Slack',            cap: 'notify.send',    mode: 'sink',   color: '#e8367f', glyph: 'SLK' },
  discord:  { label: 'Discord',          cap: 'notify.send',    mode: 'sink',   color: '#7f8cff', glyph: 'DSC' },
  telegram: { label: 'Telegram',         cap: 'notify.send',    mode: 'sink',   color: '#3fb6f0', glyph: 'TG' },
  airtable: { label: 'Airtable',         cap: 'db.write',       mode: 'sink',   color: '#2fc4ff', glyph: 'AIR' },
  sheets:   { label: 'Google Sheets',    cap: 'db.write',       mode: 'sink',   color: '#4bd37b', glyph: 'SHT' },
  woocommerce: { label: 'WooCommerce',   cap: 'shop.read',      mode: 'source', color: '#b57ad0', glyph: 'WOO' },
  gumroad:  { label: 'Gumroad',          cap: 'payments.read',  mode: 'source', color: '#ff90e8', glyph: 'GUM' },
  comfyui:  { label: 'ComfyUI',          cap: 'fs.workspace',   mode: 'sink',   color: '#ff8a3d', glyph: 'COMF' },
  webhook:  { label: 'Webhook',          cap: 'webhook.send',   mode: 'sink',   color: '#c9ff5a', glyph: 'HOOK' },
  portal:   { label: 'World portal',     cap: 'fs.workspace',   mode: 'sink',   color: '#ffffff', glyph: 'GATE' },
  web:      { label: 'Web',              cap: 'web.fetch',      mode: 'stub',   color: '#22e5ff', glyph: 'WEB' },
  mcp:      { label: 'MCP server',       cap: 'web.fetch',      mode: 'stub',   color: '#00ff88', glyph: 'MCP' },
  github:   { label: 'GitHub',           cap: 'code.run',       mode: 'stub',   color: '#c9d1d9', glyph: 'GIT' }
};
const CONNECTOR_ALIASES = { ads: 'meta_ads' }; // v0.1 name

const MIN_ROOM = { w: 5, h: 4 };
const MAX_ROOM = { w: 24, h: 14 };

const FIXED = {
  inbox:  { x: 1,          y: GRID.h - 5, w: 5, h: 4 },
  outbox: { x: GRID.w - 6, y: GRID.h - 5, w: 5, h: 4 }
};

// padX / padY leave breathing room; back walls are drawn above a room, so vertical gaps matter more.
const overlaps = (a, b, padX = 0, padY = padX) =>
  a.x < b.x + b.w + padX && a.x + a.w + padX > b.x && a.y < b.y + b.h + padY && a.y + a.h + padY > b.y;

function occupiedRects(state, ignoreId) {
  const r = [FIXED.inbox, FIXED.outbox];
  for (const room of Object.values(state.rooms)) if (room.id !== ignoreId) r.push(room);
  for (const c of Object.values(state.connectors)) if (c.id !== ignoreId) r.push({ x: c.x, y: c.y, w: 2, h: 2 });
  return r;
}

// Fill the band below the Bridge first so pipelines read left to right, then fall back to the top.
function autoPlace(state, w, h) {
  const occ = occupiedRects(state);
  for (const startY of [8, 2])
    for (let y = startY; y <= GRID.h - h - 1; y++)
      for (let x = 1; x <= GRID.w - w - 1; x++) {
        const cand = { x, y, w, h };
        if (!occ.some((o) => overlaps(cand, o, 1, 2))) return { x, y };
      }
  assert(false, 'The station floor is full. Remove or shrink a room first.');
}

function cleanCaps(list, fallback) {
  if (!Array.isArray(list)) return fallback.slice();
  return [...new Set(list.filter((c) => CAPS[c]))];
}

function createRoom(state, p) {
  const kind = ROOM_KINDS[p.kind] ? p.kind : 'custom';
  const w = clamp(int(p.w, 8), MIN_ROOM.w, MAX_ROOM.w), h = clamp(int(p.h, 5), MIN_ROOM.h, MAX_ROOM.h);
  let x = p.x, y = p.y;
  if (x == null || y == null) ({ x, y } = autoPlace(state, w, h));
  x = int(x); y = int(y);
  assert(x >= 0 && y >= 0 && x + w <= GRID.w && y + h <= GRID.h, 'Room must fit on the station floor.');
  assert(!occupiedRects(state).some((o) => overlaps({ x, y, w, h }, o)), 'That spot overlaps another room, connector or dock.');
  const room = {
    id: id('room'), name: String(p.name || ROOM_KINDS[kind].label).trim().slice(0, 32) || ROOM_KINDS[kind].label, kind, x, y, w, h,
    capabilities: cleanCaps(p.capabilities, ROOM_KINDS[kind].caps)
  };
  state.rooms[room.id] = room;
  return room;
}

function updateRoom(state, roomId, p) {
  const room = state.rooms[roomId]; assert(room, 'Room not found', 404);
  if (p.name != null) { const n = String(p.name).trim().slice(0, 32); assert(n, 'A room needs a name.'); room.name = n; }
  if (p.kind != null && ROOM_KINDS[p.kind] && p.kind !== room.kind) {
    room.kind = p.kind; room.capabilities = ROOM_KINDS[p.kind].caps.slice(); // preset resets the ceiling
  }
  if (p.capabilities != null) room.capabilities = cleanCaps(p.capabilities, room.capabilities);
  const nw = p.w != null ? clamp(int(p.w, room.w), MIN_ROOM.w, MAX_ROOM.w) : room.w;
  const nh = p.h != null ? clamp(int(p.h, room.h), MIN_ROOM.h, MAX_ROOM.h) : room.h;
  if (p.x != null || p.y != null || nw !== room.w || nh !== room.h) {
    const nx = int(p.x, room.x), ny = int(p.y, room.y);
    assert(nx >= 0 && ny >= 0 && nx + nw <= GRID.w && ny + nh <= GRID.h, 'Room must stay on the floor.');
    assert(!occupiedRects(state, room.id).some((o) => overlaps({ x: nx, y: ny, w: nw, h: nh }, o)), 'That spot overlaps another room.');
    for (const d of Object.values(state.desks)) if (d.roomId === room.id)
      assert(d.x + 2 <= nx + nw && d.y + 1 <= ny + nh, 'Shrinking would cut off a desk. Move or remove it first.');
    const dx = nx - room.x, dy = ny - room.y;
    room.x = nx; room.y = ny; room.w = nw; room.h = nh;
    for (const d of Object.values(state.desks)) if (d.roomId === room.id) { d.x += dx; d.y += dy; }
  }
  // A room's ceiling shrinking must never leave a desk with grants the room does not allow.
  for (const d of Object.values(state.desks)) if (d.roomId === room.id) d.grants = d.grants.filter((g) => room.capabilities.includes(g));
  return room;
}

function deleteRoom(state, roomId) {
  const room = state.rooms[roomId]; assert(room, 'Room not found', 404);
  assert(room.kind !== 'bridge' || Object.values(state.rooms).filter((r) => r.kind === 'bridge').length > 1,
    'The Bridge is where the Director sits. Keep at least one.');
  for (const d of Object.values(state.desks)) if (d.roomId === roomId) deleteDesk(state, d.id);
  for (const hw of Object.values(state.hallways)) if (hw.from === 'room:' + roomId || hw.to === 'room:' + roomId) delete state.hallways[hw.id];
  delete state.rooms[roomId];
}

// Desks are 2x1 tiles. The agent sits behind the desk, so rows are 3 tiles apart and the first row starts 2 tiles down.
function freeDeskSpot(state, room) {
  for (let y = room.y + 2; y + 1 <= room.y + room.h - 1; y += 3)
    for (let x = room.x + 1; x + 2 <= room.x + room.w - 1; x += 3) {
      const cand = { x, y, w: 2, h: 1 };
      if (!Object.values(state.desks).some((d) => overlaps(cand, { x: d.x, y: d.y, w: 2, h: 1 }))) return { x, y };
    }
  return null;
}

function createDesk(state, p) {
  const room = state.rooms[p.roomId]; assert(room, 'Room not found', 404);
  const spot = (p.x != null && p.y != null) ? { x: int(p.x), y: int(p.y) } : freeDeskSpot(state, room);
  assert(spot, 'No space left in that room. Enlarge it or add another room.');
  assert(spot.x >= room.x + 1 && spot.y >= room.y + 1 && spot.x + 2 <= room.x + room.w && spot.y + 1 <= room.y + room.h, 'Desks must sit inside the room.');
  assert(!Object.values(state.desks).some((d) => overlaps({ x: spot.x, y: spot.y, w: 2, h: 1 }, { x: d.x, y: d.y, w: 2, h: 2 })), 'A desk is already there.');
  // Director-only caps may sit on a desk grant; effectiveCaps() strips them for anyone but the Director.
  const grants = Array.isArray(p.grants) ? p.grants.filter((g) => CAPS[g] && room.capabilities.includes(g)) : room.capabilities.slice();
  const desk = { id: id('desk'), roomId: room.id, x: spot.x, y: spot.y, grants, auto: !!p.auto };
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

// Make a room bigger so one more desk fits: try wider first, then taller. Returns true if it grew.
function growRoom(state, room) {
  for (const [dw, dh] of [[3, 0], [0, 3]]) {
    const w = room.w + dw, h = room.h + dh;
    if (w > MAX_ROOM.w || h > MAX_ROOM.h || room.x + w > GRID.w || room.y + h > GRID.h) continue;
    if (occupiedRects(state, room.id).some((o) => overlaps({ x: room.x, y: room.y, w, h }, o))) continue;
    room.w = w; room.h = h; return true;
  }
  return false;
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

const kindOf = (k) => (CONNECTOR_KINDS[k] ? k : CONNECTOR_ALIASES[k] || null);

function createConnector(state, p) {
  const kind = kindOf(p.kind); assert(kind, 'Unknown connector kind.');
  let x = p.x, y = p.y;
  if (x == null || y == null) ({ x, y } = autoPlace(state, 2, 2));
  x = int(x); y = int(y);
  assert(x >= 0 && y >= 0 && x + 2 <= GRID.w && y + 2 <= GRID.h, 'Connector must sit on the floor.');
  assert(!occupiedRects(state).some((o) => overlaps({ x, y, w: 2, h: 2 }, o)), 'That spot is taken.');
  const c = { id: id('conn'), kind, name: String(p.name || CONNECTOR_KINDS[kind].label).trim().slice(0, 32), x, y,
    config: {}, status: 'unconfigured', lastError: null, lastSyncAt: null, cursor: null, ventureId: null, autoSync: true };
  state.connectors[c.id] = c;
  return c;
}
function updateConnectorBasics(state, cid, p) {
  const c = state.connectors[cid]; assert(c, 'Connector not found', 404);
  if (p.name != null) { const n = String(p.name).trim().slice(0, 32); assert(n, 'A connector needs a name.'); c.name = n; }
  if (p.x != null || p.y != null) {
    const nx = int(p.x, c.x), ny = int(p.y, c.y);
    assert(nx >= 0 && ny >= 0 && nx + 2 <= GRID.w && ny + 2 <= GRID.h, 'Connector must sit on the floor.');
    assert(!occupiedRects(state, c.id).some((o) => overlaps({ x: nx, y: ny, w: 2, h: 2 }, o)), 'That spot is taken.');
    c.x = nx; c.y = ny;
  }
  return c;
}
function deleteConnector(state, cid) {
  assert(state.connectors[cid], 'Connector not found', 404);
  for (const hw of Object.values(state.hallways)) if (hw.from === 'connector:' + cid || hw.to === 'connector:' + cid) delete state.hallways[hw.id];
  delete state.connectors[cid];
}

// What an agent may actually do = desk grants ∩ room ceiling ∩ role/agent ceiling. Director-only caps never leak.
function effectiveCaps(state, agent) {
  const desk = agent.deskId && state.desks[agent.deskId];
  if (!desk) return [];
  const room = state.rooms[desk.roomId];
  let caps = desk.grants.filter((c) => room.capabilities.includes(c));
  const ceiling = roleCaps(agent);
  if (Array.isArray(ceiling)) caps = caps.filter((c) => ceiling.includes(c));
  if (agent.role !== 'director') caps = caps.filter((c) => !DIRECTOR_ONLY.has(c));
  return caps;
}

module.exports = {
  CAPS, DIRECTOR_ONLY, ROOM_KINDS, CONNECTOR_KINDS, CONNECTOR_ALIASES, FIXED, MIN_ROOM, kindOf,
  autoPlace, createRoom, updateRoom, deleteRoom, createDesk, updateDesk, deleteDesk, freeDeskSpot, growRoom,
  createHallway, deleteHallway, createConnector, updateConnectorBasics, deleteConnector, nodeExists, effectiveCaps
};
