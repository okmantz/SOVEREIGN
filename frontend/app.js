(() => {
'use strict';
// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props, ...kids) {
  const el = document.createElement(tag); let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) { if (k == null || k === false) continue; el.append(k.nodeType ? k : document.createTextNode(String(k))); }
  if (value !== undefined) el.value = value;
  return el;
}
const usd = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
function toast(msg, kind) { const t = h('div', { class: kind || '' }, msg); $('#toast').append(t); setTimeout(() => t.remove(), 3800); }
async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.error || 'Something went wrong.', 'error'); throw new Error(j.error); }
  scheduleRefresh(); return j;
}

// ---------- state ----------
const T = 20; // px per tile
let S = null, tool = 'select', sel = null, tab = 'director', draft = '', roomKind = 'lab';
let linkFrom = null, drag = null, mouse = { x: 0, y: 0 }, needsPanel = false, newSecret = null;
const busy = new Map(), pulses = [];
const CONN_COLOR = { stripe: '#8b7be0', email: '#e0785b', ads: '#d1c44f', web: '#4fb0d1', github: '#c9c9d6', mcp: '#4fd1b5' };

let rt = null; function scheduleRefresh() { clearTimeout(rt); rt = setTimeout(refresh, 60); }
async function refresh() { S = await (await fetch('/api/state')).json(); renderAll(); }

const es = new EventSource('/api/events');
['state', 'ledger', 'approval', 'outbox'].forEach((t) => es.addEventListener(t, scheduleRefresh));
es.addEventListener('handoff', (e) => addPulse(JSON.parse(e.data)));
es.addEventListener('run.start', (e) => { busy.set(JSON.parse(e.data).agentId, Date.now()); renderPanel(); });
es.addEventListener('run.done', (e) => { busy.delete(JSON.parse(e.data).agentId); scheduleRefresh(); });

// ---------- geometry ----------
const nodeRect = (ref) => {
  if (ref === 'inbox' || ref === 'outbox') return S.fixed[ref];
  const [t, id] = ref.split(':'); if (t === 'room') return S.rooms[id];
  const c = S.connectors[id]; return c && { x: c.x, y: c.y, w: 2, h: 2 };
};
const center = (r) => ({ x: (r.x + r.w / 2) * T, y: (r.y + r.h / 2) * T });
function hallPath(hw) {
  const a = nodeRect(hw.from), b = nodeRect(hw.to); if (!a || !b) return null;
  const ca = center(a), cb = center(b);
  const vertFirst = Math.abs(cb.y - ca.y) > Math.abs(cb.x - ca.x); // keeps corridors out of neighbouring rooms
  return [ca, vertFirst ? { x: ca.x, y: cb.y } : { x: cb.x, y: ca.y }, cb];
}
const nodeName = (ref) => ref === 'inbox' ? 'Inbox' : ref === 'outbox' ? 'Outbox' : ref.startsWith('room:') ? (S.rooms[ref.slice(5)] || {}).name : (S.connectors[ref.slice(10)] || {}).name;
function addPulse(ev) { const hw = S.hallways[ev.hallwayId]; const p = hw && hallPath(hw); if (p) pulses.push({ p, t0: performance.now(), dur: 1100 }); }
const inRect = (x, y, r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
const tileOf = (e) => { const r = $('#world').getBoundingClientRect(); return { px: (e.clientX - r.left) / r.width * 960, py: (e.clientY - r.top) / r.height * 640 }; };
function distSeg(px, py, a, b) { const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy || 1; let t = ((px - a.x) * dx + (py - a.y) * dy) / l; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)); }
const agentAtDesk = (deskId) => Object.values(S.agents).find((a) => a.deskId === deskId);

function hit(px, py) {
  const tx = px / T, ty = py / T;
  for (const d of Object.values(S.desks)) { const a = agentAtDesk(d.id); if (a && px >= d.x * T + 2 && px < d.x * T + 38 && py >= d.y * T - 14 && py < d.y * T) return { type: 'agent', id: a.id }; }
  for (const d of Object.values(S.desks)) if (inRect(tx, ty, { x: d.x, y: d.y, w: 2, h: 1 })) return { type: 'desk', id: d.id };
  for (const c of Object.values(S.connectors)) if (inRect(tx, ty, { x: c.x, y: c.y, w: 2, h: 2 })) return { type: 'connector', id: c.id };
  for (const r of Object.values(S.rooms)) if (inRect(tx, ty, r)) return { type: 'room', id: r.id };
  for (const k of ['inbox', 'outbox']) if (inRect(tx, ty, S.fixed[k])) return { type: 'dock', id: k };
  for (const hw of Object.values(S.hallways)) { const p = hallPath(hw); if (p && (distSeg(px, py, p[0], p[1]) < 9 || distSeg(px, py, p[1], p[2]) < 9)) return { type: 'hallway', id: hw.id }; }
  return null;
}
const nodeRefOf = (hh) => hh && (hh.type === 'room' ? 'room:' + hh.id : hh.type === 'connector' ? 'connector:' + hh.id : hh.type === 'dock' ? hh.id : null);

// ---------- drawing ----------
const canvas = $('#world'), ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
const floor = document.createElement('canvas'); floor.width = 960; floor.height = 640;
(function buildFloor() { const f = floor.getContext('2d'); for (let y = 0; y < 32; y++) for (let x = 0; x < 48; x++) { f.fillStyle = (x + y) % 2 ? '#20284a' : '#232c52'; f.fillRect(x * T, y * T, T, T); } })();
const label = (t, x, y, color, size = 11, align = 'left') => { ctx.font = `600 ${size}px ui-monospace, Menlo, Consolas, monospace`; ctx.textAlign = align; ctx.fillStyle = color; ctx.fillText(t, x, y); };

function draw(now) {
  requestAnimationFrame(draw);
  if (!S) return;
  ctx.drawImage(floor, 0, 0);
  // hallways
  for (const hw of Object.values(S.hallways)) {
    const p = hallPath(hw); if (!p) continue; const on = sel && sel.type === 'hallway' && sel.id === hw.id;
    ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
    ctx.strokeStyle = on ? '#e6b450' : '#34407a'; ctx.lineWidth = 16; ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y); ctx.lineTo(p[1].x, p[1].y); ctx.lineTo(p[2].x, p[2].y); ctx.stroke();
    ctx.strokeStyle = on ? '#f3d58f' : '#4a5aa3'; ctx.lineWidth = 2; ctx.setLineDash([6, 8]); ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y); ctx.lineTo(p[1].x, p[1].y); ctx.lineTo(p[2].x, p[2].y); ctx.stroke(); ctx.setLineDash([]);
  }
  // fixed docks
  for (const k of ['inbox', 'outbox']) {
    const r = S.fixed[k], col = k === 'inbox' ? '#4fd1b5' : '#e6b450';
    ctx.fillStyle = '#161c38'; ctx.fillRect(r.x * T, r.y * T, r.w * T, r.h * T);
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(r.x * T + 1, r.y * T + 1, r.w * T - 2, r.h * T - 2);
    ctx.fillStyle = col; ctx.globalAlpha = .22; ctx.fillRect(r.x * T + 8, r.y * T + 22, r.w * T - 16, r.h * T - 32); ctx.globalAlpha = 1;
    label(k === 'inbox' ? 'Inbox' : 'Outbox', r.x * T + 6, r.y * T - 4, col, 12);
    if (k === 'outbox' && S.outbox.length) label(String(S.outbox.length), (r.x + r.w) * T - 8, r.y * T + 16, col, 12, 'right');
  }
  // rooms
  for (const r of Object.values(S.rooms)) {
    const col = (S.roomKinds[r.kind] || S.roomKinds.custom).color, on = sel && sel.type === 'room' && sel.id === r.id;
    ctx.fillStyle = '#161c38'; ctx.fillRect(r.x * T, r.y * T, r.w * T, r.h * T);
    ctx.fillStyle = col; ctx.globalAlpha = .13; ctx.fillRect(r.x * T, r.y * T, r.w * T, r.h * T); ctx.globalAlpha = 1;
    ctx.strokeStyle = on ? '#fff' : col; ctx.lineWidth = on ? 3 : 2; ctx.strokeRect(r.x * T + 1, r.y * T + 1, r.w * T - 2, r.h * T - 2);
    label(r.name, r.x * T + 2, Math.max(11, r.y * T - 4), col, 12);
  }
  // connectors
  for (const c of Object.values(S.connectors)) {
    const col = CONN_COLOR[c.kind] || '#8f95b8', cx = (c.x + 1) * T, cy = (c.y + 1) * T, on = sel && sel.type === 'connector' && sel.id === c.id;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.PI / 4); ctx.fillStyle = '#161c38'; ctx.fillRect(-13, -13, 26, 26);
    ctx.strokeStyle = on ? '#fff' : col; ctx.lineWidth = 3; ctx.strokeRect(-13, -13, 26, 26); ctx.fillStyle = col; ctx.fillRect(-5, -5, 10, 10); ctx.restore();
    label(c.name, cx, cy + 34, col, 11, 'center');
  }
  // desks + agents
  const frame = Math.floor(now / 350);
  for (const d of Object.values(S.desks)) {
    const a = agentAtDesk(d.id), x = d.x * T, y = d.y * T, on = sel && sel.type === 'desk' && sel.id === d.id, isBusy = a && busy.has(a.id);
    if (a) { const bob = isBusy ? (frame % 2) : 0; window.Avatar.draw(ctx, a.avatar, x + 12, y - 12 + bob, 2, 0); }
    ctx.fillStyle = on ? '#6b78c4' : '#3a4478'; ctx.fillRect(x, y, 2 * T, T - 2);
    ctx.fillStyle = '#4d5aa0'; ctx.fillRect(x, y, 2 * T, 3);
    ctx.fillStyle = isBusy ? '#4fd1b5' : '#0e1226'; ctx.fillRect(x + 5, y + 6, 12, 8);
    if (a) {
      label(a.name, x + T, y + T + 9, sel && sel.type === 'agent' && sel.id === a.id ? '#fff' : '#c9cff0', 10, 'center');
      if (isBusy) { const dots = '.'.repeat(1 + (frame % 3)); ctx.fillStyle = '#e8e6f0'; ctx.fillRect(x + 28, y - 26, 18, 12); label(dots, x + 37, y - 20, '#14182b', 12, 'center'); }
    } else label('empty', x + T, y + T + 9, '#5c6596', 10, 'center');
  }
  // pulses moving along hallways
  for (let i = pulses.length - 1; i >= 0; i--) {
    const pu = pulses[i], t = (now - pu.t0) / pu.dur; if (t >= 1) { pulses.splice(i, 1); continue; }
    const segs = [[pu.p[0], pu.p[1]], [pu.p[1], pu.p[2]]], lens = segs.map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y)), total = lens[0] + lens[1] || 1;
    let d = t * total, k = 0; if (d > lens[0]) { d -= lens[0]; k = 1; }
    const [a, b] = segs[k], f = lens[k] ? d / lens[k] : 0;
    ctx.fillStyle = '#e6b450'; ctx.fillRect(a.x + (b.x - a.x) * f - 5, a.y + (b.y - a.y) * f - 5, 10, 10);
    ctx.fillStyle = '#fff'; ctx.fillRect(a.x + (b.x - a.x) * f - 2, a.y + (b.y - a.y) * f - 2, 4, 4);
  }
  // tool ghosts
  if (drag && drag.kind === 'room') {
    const r = dragRect(); ctx.strokeStyle = '#e6b450'; ctx.setLineDash([5, 4]); ctx.lineWidth = 2; ctx.strokeRect(r.x * T, r.y * T, r.w * T, r.h * T); ctx.setLineDash([]);
    label(`${r.w}×${r.h}`, r.x * T + 4, r.y * T + 14, '#e6b450');
  }
  if (tool === 'hallway' && linkFrom) {
    const a = nodeRect(linkFrom); if (a) { const c = center(a); ctx.strokeStyle = '#e6b450'; ctx.lineWidth = 3; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke(); ctx.setLineDash([]); }
  }
  if (tool === 'hallway') { const hh = nodeRefOf(hit(mouse.x, mouse.y)); if (hh) { const r = nodeRect(hh); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(r.x * T - 2, r.y * T - 2, r.w * T + 4, r.h * T + 4); } }
}
function dragRect() {
  const a = drag.start, b = { x: Math.floor(mouse.x / T), y: Math.floor(mouse.y / T) };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
}

// ---------- canvas input ----------
canvas.addEventListener('pointerdown', async (e) => {
  if (!S) return; canvas.setPointerCapture(e.pointerId);
  const { px, py } = tileOf(e); mouse = { x: px, y: py };
  const tile = { x: Math.floor(px / T), y: Math.floor(py / T) }, hh = hit(px, py);
  try {
    if (tool === 'room') { drag = { kind: 'room', start: tile }; return; }
    if (tool === 'select') {
      sel = hh && hh.type !== 'dock' ? hh : null; if (sel) tab = 'inspect';
      if (hh && hh.type === 'room') { const r = S.rooms[hh.id]; drag = { kind: 'move', id: r.id, offX: tile.x - r.x, offY: tile.y - r.y, moved: false }; }
      renderAll(); return;
    }
    if (tool === 'desk') {
      if (!hh || !['room', 'desk', 'agent'].includes(hh.type)) return toast('Click inside a room to place a desk.');
      const room = hh.type === 'room' ? S.rooms[hh.id] : S.rooms[S.desks[hh.type === 'desk' ? hh.id : S.agents[hh.id].deskId].roomId];
      const r = await api('POST', '/desks', { roomId: room.id, x: tile.x, y: tile.y }); sel = { type: 'desk', id: r.desk.id }; tab = 'inspect'; return;
    }
    if (tool === 'hallway') {
      const ref = nodeRefOf(hh); if (!ref) { linkFrom = null; return toast('Click a room, connector, the Inbox or the Outbox.'); }
      if (!linkFrom) { linkFrom = ref; return; }
      const from = linkFrom; linkFrom = null;
      const r = await api('POST', '/hallways', { from, to: ref }); sel = { type: 'hallway', id: r.hallway.id }; tab = 'inspect'; return;
    }
    if (tool === 'connector') { if (hh) return toast('Pick an empty spot on the floor.'); openConnectorModal(tile); return; }
    if (tool === 'agent') {
      if (hh && hh.type === 'agent') return openAgentModal(S.agents[hh.id]);
      if (hh && hh.type === 'desk') return openAgentModal(null, hh.id);
      toast('Click an empty desk to seat a new agent, or an agent to edit them.');
    }
  } catch (_) { /* toast already shown */ }
});
canvas.addEventListener('pointermove', (e) => {
  const { px, py } = tileOf(e); mouse = { x: px, y: py }; if (!S) return;
  if (drag && drag.kind === 'move') {
    const r = S.rooms[drag.id], nx = Math.floor(px / T) - drag.offX, ny = Math.floor(py / T) - drag.offY;
    if (nx !== r.x || ny !== r.y) { const dx = nx - r.x, dy = ny - r.y; r.x = nx; r.y = ny; for (const d of Object.values(S.desks)) if (d.roomId === r.id) { d.x += dx; d.y += dy; } drag.moved = true; }
  }
  const hh = hit(px, py); canvas.style.cursor = tool === 'select' ? (hh ? 'pointer' : 'default') : 'crosshair';
});
canvas.addEventListener('pointerup', async () => {
  if (!drag) return; const d = drag; drag = null;
  try {
    if (d.kind === 'room') {
      const r = dragRect(); const w = Math.max(r.w, 6), hgt = Math.max(r.h, 4);
      const res = await api('POST', '/rooms', { x: r.x, y: r.y, w, h: hgt, kind: roomKind, name: S.roomKinds[roomKind].label });
      sel = { type: 'room', id: res.room.id }; tab = 'inspect';
    } else if (d.kind === 'move' && d.moved) { const r = S.rooms[d.id]; await api('PATCH', '/rooms/' + d.id, { x: r.x, y: r.y }); }
  } catch (_) { refresh(); }
});
window.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.key === 'Escape') { linkFrom = null; sel = null; renderAll(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel) removeSelection();
});
async function removeSelection() {
  if (!sel || sel.type === 'agent') return;
  const path = { room: '/rooms/', desk: '/desks/', hallway: '/hallways/', connector: '/connectors/' }[sel.type]; if (!path) return;
  if (!confirm('Remove this ' + sel.type + '?')) return;
  try { await api('DELETE', path + sel.id); sel = null; } catch (_) {}
}

// ---------- tools ----------
const ICONS = {
  select: '<path d="M5 3l14 8-6 2-2 6z"/>', room: '<rect x="3" y="5" width="18" height="14"/>', desk: '<rect x="4" y="10" width="16" height="6"/><path d="M8 10V6h8v4"/>',
  hallway: '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 12h10"/>', connector: '<path d="M12 3l9 9-9 9-9-9z"/>', agent: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>'
};
const TOOLS = [['select', 'Select', 'Click things to inspect them. Drag a room to move it.'], ['room', 'Room', 'Drag on the floor to draw a room.'],
  ['desk', 'Desk', 'Click inside a room to place a desk.'], ['hallway', 'Hallway', 'Click a start (room, Inbox, connector), then an end.'],
  ['connector', 'Connector', 'Click an empty spot to add a port to Stripe, email, ads and more.'], ['agent', 'Agent', 'Click an empty desk to seat a new agent, or click an agent to edit.']];
function renderTools() {
  const nav = $('#tools'); nav.replaceChildren(...TOOLS.map(([id, name]) => h('button', { class: 'tool', type: 'button', 'aria-pressed': String(tool === id), title: name,
    onclick: () => { tool = id; linkFrom = null; renderTools(); renderHint(); } }, svgIcon(ICONS[id]), name)));
}
function svgIcon(inner) { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = inner; return s; }
function renderHint() {
  const el = $('#hint'); const t = TOOLS.find((x) => x[0] === tool); el.replaceChildren(h('span', {}, t[2]));
  if (tool === 'room' && S) el.append(h('label', { class: 'muted' }, 'Type ', h('select', { 'aria-label': 'Room type', onchange: (e) => { roomKind = e.target.value; }, value: roomKind },
    Object.entries(S.roomKinds).filter(([k]) => k !== 'bridge').map(([k, v]) => h('option', { value: k }, v.label)))));
}

// ---------- header + overlays ----------
function renderHeader() {
  const p = S.progress, m = S.mission, mb = $('#mission-bar');
  if (!m) mb.replaceChildren(h('span', { class: 'muted' }, 'No mission yet. Set a profit target.'));
  else mb.replaceChildren(h('strong', {}, m.name), h('span', { class: 'bar', title: 'Verified net profit toward target' }, h('i', { style: `width:${p.pct}%` })),
    h('span', {}, `${usd(p.netCents)} / ${usd(p.targetCents)}`));
  $('#spend').textContent = `Model spend today ${usd(S.spentTodayCents)} of ${usd(S.settings.budgets.globalDailyCents)}`;
  const e = $('#empty');
  if (!m && !S.__skipEmpty) { e.hidden = false; e.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Wake the Director'), h('p', { class: 'muted' }, 'Give Sovereign a profit target. The Director designs the crew, rooms and hallways, and asks you before anything structural or expensive.'),
    h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'btn primary', onclick: openMissionModal }, 'Set a mission'), h('button', { class: 'btn', onclick: () => { S.__skipEmpty = true; e.hidden = true; } }, 'Build by hand')))); }
  else e.hidden = true;
}
$('#mission-bar').addEventListener('click', () => { if (!S) return; if (!S.mission) openMissionModal(); else { tab = 'money'; renderAll(); } });

// ---------- modals ----------
function closeModal() { $('#modal').hidden = true; $('#modal').replaceChildren(); }
function modal(...content) { const m = $('#modal'); m.replaceChildren(h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, ...content)); m.hidden = false; const f = m.querySelector('input,select,textarea,button'); if (f) f.focus(); }
$('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') closeModal(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
const field = (lbl, input) => h('label', { class: 'field' }, lbl, input);

function openMissionModal() {
  const m = S.mission || {}; const ids = {};
  const num = (k, lbl, v) => field(lbl, ids[k] = h('input', { type: 'number', min: '0', step: '1', value: v }));
  modal(h('h2', {}, 'Set your mission'),
    h('div', { class: 'stack' },
      field('Mission name', ids.name = h('input', { type: 'text', value: m.name || 'First $10k', maxlength: '80' })),
      h('div', { class: 'row' }, num('target', 'Verified profit target (USD)', m.targetCents ? m.targetCents / 100 : 10000), num('capital', 'Starting capital (USD)', m.capitalCents ? m.capitalCents / 100 : 500)),
      num('risk', 'Most you will lose before everything stops (USD)', m.riskCents ? m.riskCents / 100 : 500),
      h('p', { class: 'muted' }, 'Only revenue confirmed by a connected payment source counts. The Director proposes; you approve.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
        await api('POST', '/mission', { name: ids.name.value, targetCents: Math.round(ids.target.value * 100), capitalCents: Math.round(ids.capital.value * 100), riskCents: Math.round(ids.risk.value * 100) });
        closeModal(); tab = 'director'; toast('The Director is drafting a plan.'); }}, S.mission ? 'Update mission' : 'Wake the Director'), h('button', { class: 'btn', onclick: closeModal }, 'Cancel'))));
}

function openConnectorModal(tile) {
  let kind = 'stripe'; const nm = h('input', { type: 'text', value: 'Stripe', maxlength: '32' });
  const sel2 = h('select', { onchange: (e) => { kind = e.target.value; nm.value = S.connectorKinds[kind].label; } }, Object.entries(S.connectorKinds).map(([k, v]) => h('option', { value: k }, v.label)));
  modal(h('h2', {}, 'Add a connector'), h('div', { class: 'stack' }, field('Service', sel2), field('Name', nm),
    h('p', { class: 'muted' }, 'A hallway into a connector is only allowed from rooms that have the matching capability. Email and ad hallways always ask you first.'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { const r = await api('POST', '/connectors', { kind, name: nm.value, x: tile.x, y: tile.y }); sel = { type: 'connector', id: r.connector.id }; tab = 'inspect'; closeModal(); } catch (_) {} } }, 'Add connector'), h('button', { class: 'btn', onclick: closeModal }, 'Cancel'))));
}

function swatches(list, current, onpick) { return h('div', { class: 'swatches' }, list.map((c) => h('button', { class: 'sw', type: 'button', style: `background:${c}`, 'aria-label': c, 'aria-pressed': String(c === current), onclick: () => onpick(c) }))); }
function avatarCanvas(av, scale, cls) { const c = h('canvas', { width: 8 * scale + 4, height: 14 * scale + 4, class: cls || '' }); const x = c.getContext('2d'); window.Avatar.draw(x, av, 2, 2 + 2 * scale, scale, 0); return c; }

function openAgentModal(agent, deskId) {
  const isDir = agent && agent.role === 'director';
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];
  const d = agent ? { ...agent, avatar: { ...agent.avatar } } : { name: '', role: 'researcher', persona: S.roles.researcher.persona, model: null, deskId: deskId || null,
    avatar: { skin: rnd(S.palette.skin), hair: rnd(S.palette.hair), hairStyle: Math.floor(Math.random() * 4), outfit: rnd(S.palette.outfit), accessory: 'none' } };
  const freeDesks = Object.values(S.desks).filter((x) => !agentAtDesk(x.id) || x.id === d.deskId);
  const body = h('div', { class: 'stack' });
  function paint() {
    const pv = avatarCanvas(d.avatar, 8, 'preview');
    body.replaceChildren(
      h('div', { class: 'row' }, pv, h('div', { class: 'stack', style: 'flex:1' },
        field('Name', h('input', { type: 'text', maxlength: '24', value: d.name, placeholder: 'Agent name', oninput: (e) => { d.name = e.target.value; } })),
        field('Role', h('select', { disabled: isDir, onchange: (e) => { d.role = e.target.value; d.persona = S.roles[d.role].persona; paint(); }, value: d.role },
          Object.entries(S.roles).filter(([k]) => k !== 'director' || isDir).map(([k, v]) => h('option', { value: k }, v.label)))))),
      field('Persona and instructions', h('textarea', { oninput: (e) => { d.persona = e.target.value; } }, d.persona)),
      h('div', { class: 'row' }, field('Model', h('input', { type: 'text', value: d.model || '', placeholder: 'Station default', oninput: (e) => { d.model = e.target.value || null; } })),
        field('Desk', h('select', { onchange: (e) => { d.deskId = e.target.value || null; }, value: d.deskId || '' }, h('option', { value: '' }, 'No desk yet'),
          freeDesks.map((x) => h('option', { value: x.id }, `${S.rooms[x.roomId].name} · desk`))))),
      h('div', {}, h('div', { class: 'muted' }, 'Skin'), swatches(S.palette.skin, d.avatar.skin, (c) => { d.avatar.skin = c; paint(); })),
      h('div', {}, h('div', { class: 'muted' }, 'Hair'), swatches(S.palette.hair, d.avatar.hair, (c) => { d.avatar.hair = c; paint(); })),
      h('div', {}, h('div', { class: 'muted' }, 'Outfit'), swatches(S.palette.outfit, d.avatar.outfit, (c) => { d.avatar.outfit = c; paint(); })),
      h('div', { class: 'row' }, field('Hair style', h('select', { onchange: (e) => { d.avatar.hairStyle = +e.target.value; paint(); }, value: String(d.avatar.hairStyle) }, ['Short', 'Long', 'Spiky', 'Cap'].map((n, i) => h('option', { value: i }, n)))),
        field('Accessory', h('select', { disabled: isDir, onchange: (e) => { d.avatar.accessory = e.target.value; paint(); }, value: isDir ? 'crown' : d.avatar.accessory }, S.accessories.filter((a) => a !== 'crown' || isDir).map((a) => h('option', { value: a }, a[0].toUpperCase() + a.slice(1)))))),
      isDir ? h('p', { class: 'muted' }, 'The Director is the first agent. You can restyle them, but not remove them or change their role. They alone can edit the station.') : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          const payload = { name: d.name || S.roles[d.role].label, role: d.role, persona: d.persona, model: d.model, avatar: d.avatar, deskId: d.deskId };
          try { if (agent) await api('PATCH', '/agents/' + agent.id, payload); else { const r = await api('POST', '/agents', payload); sel = { type: 'agent', id: r.agent.id }; tab = 'inspect'; } closeModal(); } catch (_) {} } }, agent ? 'Save agent' : 'Create agent'),
        h('button', { class: 'btn', onclick: () => { const r = ['researcher', 'builder', 'outreach', 'finance', 'critic']; d.avatar = { skin: rnd(S.palette.skin), hair: rnd(S.palette.hair), hairStyle: Math.floor(Math.random() * 4), outfit: rnd(S.palette.outfit), accessory: isDir ? 'crown' : rnd(['none', 'glasses', 'headset', 'visor']) }; paint(); } }, 'Randomize look'),
        agent && !isDir ? h('button', { class: 'btn danger', onclick: async () => { if (confirm('Remove ' + agent.name + '?')) { try { await api('DELETE', '/agents/' + agent.id); sel = null; closeModal(); } catch (_) {} } } }, 'Remove') : null,
        h('button', { class: 'btn', onclick: closeModal }, 'Cancel')));
  }
  paint(); modal(h('h2', {}, agent ? 'Edit ' + agent.name : 'New agent'), body);
}

// ---------- side panel ----------
const TABS = [['director', 'Director'], ['inspect', 'Inspect'], ['crew', 'Crew'], ['money', 'Money'], ['outbox', 'Outbox'], ['settings', 'Settings']];
function renderTabs() {
  const pending = S.approvals.filter((a) => a.status === 'pending').length;
  $('#tabs').replaceChildren(...TABS.map(([id, name]) => h('button', { class: 'tab', role: 'tab', 'aria-selected': String(tab === id), onclick: () => { tab = id; renderAll(); } },
    name, id === 'director' && pending ? h('span', { class: 'dot' }, pending) : null, id === 'outbox' && S.outbox.length ? h('span', { class: 'dot', style: 'background:#4fd1b5' }, S.outbox.length) : null)));
}
function renderPanel() {
  if (!S) return; const ae = document.activeElement;
  if (ae && $('#panel').contains(ae) && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) { needsPanel = true; return; }
  needsPanel = false; const p = $('#panel'); const top = p.scrollTop;
  p.replaceChildren(({ director: pDirector, inspect: pInspect, crew: pCrew, money: pMoney, outbox: pOutbox, settings: pSettings })[tab]());
  p.scrollTop = top;
}
$('#panel').addEventListener('focusout', () => setTimeout(() => { if (needsPanel) renderPanel(); }, 150));

const director = () => Object.values(S.agents).find((a) => a.role === 'director');
function approvalCard(a) {
  return h('div', { class: 'card approval' }, h('strong', {}, a.summary), h('ul', {}, a.detail.map((l) => h('li', {}, l))),
    h('div', { class: 'row' }, h('button', { class: 'btn primary small', onclick: () => api('POST', `/approvals/${a.id}/approve`).then(() => toast('Approved.')).catch(() => {}) }, 'Approve'),
      h('button', { class: 'btn small', onclick: () => api('POST', `/approvals/${a.id}/reject`).catch(() => {}) }, 'Reject')));
}
function pDirector() {
  const d = director(), t = (S.transcripts[d.id] || []).slice(-10), pending = S.approvals.filter((a) => a.status === 'pending'), thinking = busy.has(d.id);
  const input = h('textarea', { placeholder: 'Ask the Director for a plan, a new venture, a status report…', oninput: (e) => { draft = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } }, draft);
  async function send() { const text = draft.trim(); if (!text) return; draft = ''; input.value = ''; try { await api('POST', '/director/message', { text }); } catch (_) {} }
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, avatarCanvas(d.avatar, 3), h('div', {}, h('strong', {}, d.name), h('div', { class: 'muted' }, thinking ? 'Thinking…' : 'Ready'))),
    pending.map(approvalCard),
    h('div', {}, t.length ? t.map((m) => h('div', { class: 'msg ' + (m.role === 'user' ? 'me' : '') }, m.content)) : h('p', { class: 'muted' }, S.mission ? 'The Director will post its plan here.' : 'Set a mission and the Director will draft your crew and station.')),
    input, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: send }, 'Send'),
      ['Propose a new venture', 'How are we doing against the target?'].map((q) => h('button', { class: 'btn small', onclick: () => { draft = q; send(); } }, q))));
}

const capList = (caps) => caps.length ? caps.map((c) => S.caps[c]).join(' · ') : 'None';
function capChecks(all, current, onchange, dirOnly) {
  return h('div', {}, Object.keys(S.caps).filter((c) => all.includes(c) || all === Object.keys(S.caps)).map((c) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: current.includes(c), onchange: (e) => { const n = new Set(current); e.target.checked ? n.add(c) : n.delete(c); onchange([...n]); } }),
    h('span', {}, S.caps[c], S.directorOnly.includes(c) ? h('small', {}, 'Only the Director can use this') : null))));
}
function pInspect() {
  if (!sel) return h('div', { class: 'stack' }, h('h3', {}, 'How the station works'),
    h('p', {}, 'A room is a team, and its capabilities are the ceiling for everyone inside. A desk grants what its agent can do. A hallway is an approved handoff lane. A connector is a port to the outside world.'),
    h('p', { class: 'muted' }, 'Pick a tool on the left, or click anything on the floor to inspect it. Run work by drawing hallways from the Inbox, then use Crew to send a task.'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => sendToInbox() }, 'Send a task through the Inbox')));
  if (sel.type === 'room') { const r = S.rooms[sel.id]; if (!r) return h('p', { class: 'muted' }, 'That room is gone.');
    return h('div', { class: 'stack' }, h('h3', {}, 'Room'),
      field('Name', h('input', { type: 'text', value: r.name, maxlength: '32', onchange: (e) => api('PATCH', '/rooms/' + r.id, { name: e.target.value }) })),
      field('Type (changing it resets capabilities)', h('select', { onchange: (e) => api('PATCH', '/rooms/' + r.id, { kind: e.target.value }), value: r.kind }, Object.entries(S.roomKinds).map(([k, v]) => h('option', { value: k }, v.label)))),
      h('h3', {}, 'What this room may ever do'), capChecks(Object.keys(S.caps), r.capabilities, (caps) => api('PATCH', '/rooms/' + r.id, { capabilities: caps })),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => api('POST', '/desks', { roomId: r.id }) }, 'Add desk'), h('button', { class: 'btn danger', onclick: removeSelection }, 'Remove room'))); }
  if (sel.type === 'desk') { const dk = S.desks[sel.id]; if (!dk) return h('p', { class: 'muted' }, 'That desk is gone.'); const room = S.rooms[dk.roomId], who = agentAtDesk(dk.id);
    return h('div', { class: 'stack' }, h('h3', {}, 'Desk in ' + room.name),
      field('Seated agent', h('select', { onchange: async (e) => { try { if (e.target.value) await api('PATCH', '/agents/' + e.target.value, { deskId: dk.id }); else if (who) await api('PATCH', '/agents/' + who.id, { deskId: null }); } catch (_) {} }, value: who ? who.id : '' },
        h('option', { value: '' }, 'Empty'), Object.values(S.agents).filter((a) => !a.deskId || a.deskId === dk.id).map((a) => h('option', { value: a.id }, a.name)))),
      h('h3', {}, 'Grants at this desk'), h('p', { class: 'muted' }, 'Limited to what the room allows.'), capChecks(room.capabilities, dk.grants, (g) => api('PATCH', '/desks/' + dk.id, { grants: g })),
      h('button', { class: 'btn danger', onclick: removeSelection }, 'Remove desk')); }
  if (sel.type === 'agent') { const a = S.agents[sel.id]; if (!a) return h('p', { class: 'muted' }, 'That agent is gone.'); const t = (S.transcripts[a.id] || []).slice(-2); const task = h('input', { type: 'text', placeholder: 'Give ' + a.name + ' a task' });
    return h('div', { class: 'stack' }, h('div', { class: 'row' }, avatarCanvas(a.avatar, 4), h('div', {}, h('strong', {}, a.name), h('div', { class: 'muted' }, S.roles[a.role].label + (a.deskId ? ' · ' + S.rooms[S.desks[a.deskId].roomId].name : ' · no desk')))),
      h('button', { class: 'btn', onclick: () => openAgentModal(a) }, 'Edit look, role and persona'),
      h('h3', {}, 'Can do right now'), h('p', {}, capList(a.caps)),
      h('h3', {}, 'Run a task'), h('div', { class: 'row' }, task, h('button', { class: 'btn primary', onclick: async () => { if (!task.value) return; try { await api('POST', `/agents/${a.id}/run`, { task: task.value }); task.value = ''; } catch (_) {} } }, 'Run')),
      t.length ? [h('h3', {}, 'Latest'), t.map((m) => h('div', { class: 'msg ' + (m.role === 'user' ? 'me' : '') }, m.content.slice(0, 500)))] : null); }
  if (sel.type === 'hallway') { const hw = S.hallways[sel.id]; if (!hw) return h('p', { class: 'muted' }, 'That hallway is gone.');
    return h('div', { class: 'stack' }, h('h3', {}, 'Hallway'), h('p', {}, nodeName(hw.from) + ' → ' + nodeName(hw.to)), h('p', { class: 'muted' }, 'Finished work in the first room is handed to the second automatically.'), h('button', { class: 'btn danger', onclick: removeSelection }, 'Remove hallway')); }
  if (sel.type === 'connector') { const c = S.connectors[sel.id]; if (!c) return h('p', { class: 'muted' }, 'That connector is gone.'); const k = S.connectorKinds[c.kind];
    return h('div', { class: 'stack' }, h('h3', {}, c.name), h('p', {}, k.label + ' connector'), h('p', { class: 'muted' }, `Only rooms with “${S.caps[k.cap]}” can send work here. Real adapters ship in v0.2; today this queues to the Outbox after your approval.`), h('button', { class: 'btn danger', onclick: removeSelection }, 'Remove connector')); }
  return h('p', { class: 'muted' }, 'Nothing selected.');
}
function sendToInbox() {
  const t = h('textarea', { placeholder: 'Describe the work. It enters at the Inbox and follows your hallways.' });
  modal(h('h2', {}, 'Send work through the Inbox'), h('div', { class: 'stack' }, t, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { if (!t.value.trim()) return; try { const r = await api('POST', '/run', { from: 'inbox', task: t.value }); closeModal(); tab = 'outbox'; if (r.notes && r.notes.length) toast(r.notes[0]); } catch (_) {} } }, 'Send'), h('button', { class: 'btn', onclick: closeModal }, 'Cancel'))));
}

function pCrew() {
  return h('div', { class: 'stack' }, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => openAgentModal(null) }, 'New agent'), h('button', { class: 'btn', onclick: sendToInbox }, 'Send a task')),
    Object.values(S.agents).map((a) => h('button', { class: 'card', style: 'text-align:left;cursor:pointer;display:flex;gap:10px;align-items:center;width:100%', onclick: () => { sel = { type: 'agent', id: a.id }; tab = 'inspect'; renderAll(); } },
      avatarCanvas(a.avatar, 3), h('div', {}, h('strong', {}, a.name, ' ', busy.has(a.id) ? h('span', { class: 'chip ok' }, 'working') : null), h('div', { class: 'muted' }, S.roles[a.role].label + (a.deskId ? ' · ' + S.rooms[S.desks[a.deskId].roomId].name : ' · no desk'))))));
}

function pMoney() {
  const p = S.progress, ventures = Object.values(S.ventures);
  const stat = (l, v, cls) => h('div', { class: 'stat' }, h('span', {}, l), h('b', { class: cls || '' }, v));
  const secretBox = newSecret ? h('div', {}, h('p', { class: 'muted' }, 'Copy this now. It is shown once.'), h('pre', {}, newSecret),
    h('p', { class: 'muted' }, 'POST signed events to /api/ingest/stripe (or paypal, shopify, ads.meta, ads.google, bank) with header x-sovereign-signature = hex HMAC-SHA256 of the raw body using this secret.'),
    h('pre', {}, '{"ventureId":"vent_…","type":"revenue","amountCents":4900,"ref":"ch_123"}')) : null;
  return h('div', { class: 'stack' }, h('h3', {}, S.mission ? S.mission.name : 'No mission set'),
    S.mission ? h('div', { class: 'card' }, h('div', { class: 'bar', style: 'margin-bottom:8px' }, h('i', { style: `width:${p.pct}%` })), stat('Verified net profit', usd(p.netCents), p.netCents >= 0 ? 'pos' : 'neg'), stat('Target', usd(p.targetCents)), stat('Verified revenue', usd(p.revenueCents)), stat('Verified costs', usd(p.costCents)),
      p.claimedCents ? stat('Unverified claims (not counted)', usd(p.claimedCents), 'neg') : null) : h('button', { class: 'btn primary', onclick: openMissionModal }, 'Set a mission'),
    S.mission ? h('button', { class: 'btn small', onclick: openMissionModal }, 'Edit mission') : null,
    h('h3', {}, 'Ventures'), ventures.length ? ventures.map((v) => { const pl = S.pnl[v.id]; return h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', {}, v.name), h('span', { class: 'chip ' + (v.status === 'killed' ? 'bad' : 'gold') }, v.status)),
      h('div', { class: 'muted' }, v.thesis), stat('Net', usd(pl.net), pl.net >= 0 ? 'pos' : 'neg'), stat('Loss limit', usd(v.maxLossCents))); }) : h('p', { class: 'muted' }, 'The Director will propose ventures once the crew is staffed.'),
    h('h3', {}, 'Recent ledger'), S.ledger.length ? S.ledger.slice(0, 15).map((e) => h('div', { class: 'stat' }, h('span', {}, (e.type === 'revenue' ? '+ ' : '− ') + e.source + (e.note ? ' · ' + e.note : ''), ' ', h('span', { class: 'chip ' + (e.verified ? 'ok' : 'bad') }, e.verified ? 'verified' : 'unverified')), h('b', {}, usd(e.amountCents)))) : h('p', { class: 'muted' }, 'Nothing yet. Model costs appear here automatically; revenue appears when a connected source reports it.'),
    h('h3', {}, 'Connect a payment source'), secretBox, h('button', { class: 'btn', onclick: async () => { try { const r = await api('POST', '/secrets/ingest'); newSecret = r.secret; renderPanel(); } catch (_) {} } }, S.settings.ingestSecretSet ? 'Replace ingest secret' : 'Create ingest secret'));
}

function pOutbox() {
  return h('div', { class: 'stack' }, S.outbox.length ? S.outbox.map((o) => h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', {}, o.title), h('span', { class: 'chip ' + (o.status === 'blocked' ? 'bad' : 'ok') }, o.status)),
    h('div', { class: 'muted' }, new Date(o.at).toLocaleString() + (o.fromRoom ? ' · ' + o.fromRoom : '')), h('div', { class: 'msg' }, o.content.slice(0, 1200)),
    h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(o.content).then(() => toast('Copied.')) }, 'Copy'))) : h('p', { class: 'muted' }, 'Finished work lands here as real results, not chat scrollback.'));
}

function pSettings() {
  const st = S.settings, ids = {};
  return h('div', { class: 'stack' }, h('h3', {}, 'Model provider'),
    field('Provider', ids.prov = h('select', { value: st.provider.name }, S.providerNames.map((n) => h('option', { value: n }, { mock: 'Offline demo (no key)', openrouter: 'OpenRouter', ollama: 'Ollama (local)' }[n] || n)))),
    field('Default model', ids.model = h('input', { type: 'text', value: st.provider.model })),
    field('OpenRouter key ' + (st.keys.openrouter ? '(saved)' : ''), ids.key = h('input', { type: 'password', placeholder: 'sk-or-…', autocomplete: 'off' })),
    h('h3', {}, 'Guardrails'),
    field('Director structural changes', ids.dir = h('select', { value: st.policy.directorStructure }, h('option', { value: 'ask' }, 'Ask me first (recommended)'), h('option', { value: 'auto' }, 'Let the Director apply plans'))),
    h('label', { class: 'check' }, ids.out = h('input', { type: 'checkbox', checked: st.policy.firstOutreachApproval }), h('span', {}, 'Ask before anything is sent through email or ad connectors')),
    h('div', { class: 'row' }, field('Station budget per day (USD)', ids.g = h('input', { type: 'number', min: '0', value: st.budgets.globalDailyCents / 100 })), field('Per agent per day (USD)', ids.a = h('input', { type: 'number', min: '0', value: st.budgets.perAgentDailyCents / 100 }))),
    h('button', { class: 'btn primary', onclick: async () => { try {
      if (ids.key.value) await api('POST', '/secrets', { name: 'openrouter', value: ids.key.value });
      await api('POST', '/settings', { provider: { name: ids.prov.value, model: ids.model.value }, policy: { directorStructure: ids.dir.value, firstOutreachApproval: ids.out.checked }, budgets: { globalDailyCents: Math.round(ids.g.value * 100), perAgentDailyCents: Math.round(ids.a.value * 100) } });
      ids.key.value = ''; toast('Settings saved.'); } catch (_) {} } }, 'Save settings'));
}

// ---------- boot ----------
function renderAll() { renderHeader(); renderTools(); renderHint(); renderTabs(); renderPanel(); }
(function logo() { const c = $('#logo').getContext('2d'); c.fillStyle = '#e6b450'; [[1, 8, 16, 4], [1, 3, 2, 6], [8, 1, 2, 8], [15, 3, 2, 6], [4, 5, 2, 3], [12, 5, 2, 3]].forEach((r) => c.fillRect(...r)); c.fillStyle = '#fff'; c.fillRect(8, 1, 2, 2); })();
refresh().then(() => { requestAnimationFrame(draw); });
})();
