// Sovereign UI core: state, worlds, the guide bar, canvas interaction, panel rail, floating build toolbar, chat. Panels and editors live in panels.js / editor.js.
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props, ...kids) {
  const el = document.createElement(tag); let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) { if (k == null || k === false) continue; el.append(k.nodeType ? k : document.createTextNode(String(k))); }
  if (value !== undefined) el.value = value;
  return el;
}
const usd = (c) => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
function toast(msg, kind) { const t = h('div', { class: kind || '' }, msg); $('#toast').append(t); setTimeout(() => t.remove(), 4200); }

const SOV = window.SOV = { S: null, sel: null, tool: 'select', drawer: 'journey', chatAgent: null, busy: new Map(), pulses: [], local: {}, stream: {}, world: null, goalPrompted: {}, introDone: false, h, $, usd, toast };

async function api(method, path, body) {
  let r; try { r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', ...(SOV.world ? { 'x-world': SOV.world } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
  catch (_) { toast('Lost contact with the Sovereign server. Is it still running?', 'error'); throw new Error('offline'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast(j.error || 'Something went wrong.', 'error'); throw new Error(j.error || 'failed'); }
  scheduleRefresh(); return j;
}
SOV.api = api;

// ---------- refresh + live events ----------
let rt = null; function scheduleRefresh() { clearTimeout(rt); rt = setTimeout(refresh, 50); }
async function refresh() {
  const S = await (await fetch('/api/state', { headers: SOV.world ? { 'x-world': SOV.world } : {} })).json();
  SOV.world = S.world.id; SOV.S = S; window.Scene.invalidate(); // the server falls back to a real world if ours was deleted
  const d = Object.values(SOV.S.agents).find((a) => a.role === 'director');
  if (!SOV.S.agents[SOV.chatAgent]) SOV.chatAgent = d && d.id;
  if (SOV.sel && ['room', 'desk', 'agent', 'hallway', 'connector'].includes(SOV.sel.type)) {
    const m = { room: 'rooms', desk: 'desks', agent: 'agents', hallway: 'hallways', connector: 'connectors' }[SOV.sel.type];
    if (!SOV.S[m][SOV.sel.id]) SOV.sel = null;
  }
  renderAll();
}
SOV.refresh = refresh;
const es = new EventSource('/api/events');
['state', 'ledger', 'approval', 'outbox'].forEach((t) => es.addEventListener(t, scheduleRefresh));
es.addEventListener('handoff', (e) => { const ev = JSON.parse(e.data), hw = SOV.S && SOV.S.hallways[ev.hallwayId], p = hw && window.Scene.hallPath(SOV.S, hw); if (p) SOV.pulses.push({ p, t0: performance.now(), dur: 1100 }); });
es.addEventListener('run.start', (e) => { SOV.busy.set(JSON.parse(e.data).agentId, Date.now()); renderChat(); });
es.addEventListener('run.done', (e) => { const id = JSON.parse(e.data).agentId; SOV.busy.delete(id); delete SOV.stream[id]; scheduleRefresh(); });
es.addEventListener('token', (e) => { const ev = JSON.parse(e.data); SOV.stream[ev.agentId] = ev.text; renderChat(); }); // live text while a local model is answering
es.addEventListener('notice', (e) => { const ev = JSON.parse(e.data); toast(ev.text, ev.kind === 'error' ? 'error' : ''); if (ev.kind === 'ok') scheduleRefresh(); });

// ---------- selection + drawer ----------
SOV.select = (sel, openInspect = true) => {
  SOV.sel = sel;
  if (sel && sel.type === 'agent') SOV.chatAgent = sel.id;
  if (sel && openInspect && SOV.drawer) SOV.drawer = 'inspect'; // never opens a closed panel: that would resize the canvas mid double-click
  renderAll();
};
SOV.openDrawer = (tab) => { SOV.drawer = tab; renderAll(); };
SOV.closeDrawer = () => { SOV.drawer = null; renderAll(); };

// ---------- canvas input ----------
const canvas = $('#world'); window.Scene.init(canvas);
let drag = null, linkFrom = null, hover = null, mouse = { px: 0, py: 0 }, roomKind = 'lab';
const dragRect = (d) => { const b = { x: Math.floor(mouse.px / window.Scene.T), y: Math.floor(mouse.py / window.Scene.T) }; const x = Math.min(d.start.x, b.x), y = Math.min(d.start.y, b.y); return { x, y, w: Math.abs(d.start.x - b.x) + 1, h: Math.abs(d.start.y - b.y) + 1 }; };
const refOf = (t) => t && (t.type === 'room' ? 'room:' + t.id : t.type === 'connector' ? 'connector:' + t.id : t.type === 'dock' ? t.id : null);
const deskRoom = (S, id) => S.rooms[S.desks[id].roomId];

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => { e.preventDefault(); window.Scene.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
let space = false;
canvas.addEventListener('pointerdown', async (e) => {
  const S = SOV.S; if (!S) return;
  const w = window.Scene.toWorld(e.clientX, e.clientY); mouse = w;
  const tile = { x: w.tx, y: w.ty }, t = window.Scene.hit(S, w.px, w.py), tool = SOV.tool;
  // Pan: middle or right button, Space held, or dragging empty floor with the Select tool.
  if (e.button === 1 || e.button === 2 || space || (tool === 'select' && (!t || t.type === 'dock'))) {
    canvas.setPointerCapture(e.pointerId); drag = { kind: 'pan', x: e.clientX, y: e.clientY, moved: false, clear: tool === 'select' && e.button === 0 && !space }; canvas.style.cursor = 'grabbing'; return;
  }
  if (e.button > 0) return;
  try {
    if (tool === 'room') { canvas.setPointerCapture(e.pointerId); drag = { kind: 'room', start: tile }; return; }
    if (tool === 'select') {
      SOV.select(t);
      if (t && t.type === 'room') { const r = S.rooms[t.id]; canvas.setPointerCapture(e.pointerId); drag = { kind: 'move', id: r.id, offX: tile.x - r.x, offY: tile.y - r.y, moved: false }; }
      return;
    }
    if (tool === 'desk') {
      if (!t || !['room', 'desk', 'agent'].includes(t.type)) return toast('Click inside a room to place a desk.');
      const room = t.type === 'room' ? S.rooms[t.id] : deskRoom(S, t.type === 'desk' ? t.id : S.agents[t.id].deskId);
      const r = await api('POST', '/desks', { roomId: room.id, x: tile.x, y: tile.y }); SOV.select({ type: 'desk', id: r.desk.id }); return;
    }
    if (tool === 'hallway') {
      const ref = refOf(t); if (!ref) { linkFrom = null; return toast('Click a room, connector, the Inbox or the Outbox.'); }
      if (!linkFrom) { linkFrom = ref; return; }
      const from = linkFrom; linkFrom = null; const r = await api('POST', '/hallways', { from, to: ref }); SOV.select({ type: 'hallway', id: r.hallway.id }); return;
    }
    if (tool === 'connector') { if (t && t.type !== 'hallway') return toast('Pick an empty spot on the floor.'); SOV.openConnectorPicker(tile); return; }
    if (tool === 'agent') {
      if (t && t.type === 'agent') return SOV.openAgentEditor(S.agents[t.id]);
      if (t && t.type === 'desk') return SOV.openAgentEditor(null, { deskId: t.id });
      if (t && t.type === 'room') return SOV.openAgentEditor(null, { roomId: t.id });
      toast('Click a room to add an agent there, an empty desk to seat one, or an agent to edit them.');
    }
  } catch (_) { /* the toast already explained */ }
});
canvas.addEventListener('pointermove', (e) => {
  const S = SOV.S; if (!S) return; const w = window.Scene.toWorld(e.clientX, e.clientY); mouse = w; hover = window.Scene.hit(S, w.px, w.py);
  if (drag && drag.kind === 'pan') { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true; window.Scene.panBy(dx, dy); drag.x = e.clientX; drag.y = e.clientY; return; }
  if (drag && drag.kind === 'move') {
    const r = S.rooms[drag.id], nx = w.tx - drag.offX, ny = w.ty - drag.offY;
    if (nx !== r.x || ny !== r.y) { const dx = nx - r.x, dy = ny - r.y; r.x = nx; r.y = ny; for (const d of Object.values(S.desks)) if (d.roomId === r.id) { d.x += dx; d.y += dy; } drag.moved = true; window.Scene.invalidate(); }
  }
  canvas.style.cursor = space ? 'grab' : SOV.tool === 'select' ? (hover && hover.type !== 'dock' ? 'pointer' : 'grab') : 'crosshair';
});
canvas.addEventListener('pointerup', async () => {
  if (!drag) return; const d = drag; drag = null;
  if (d.kind === 'pan') { if (!d.moved && d.clear) { SOV.sel = null; renderAll(); } return; }
  try {
    if (d.kind === 'room') {
      const r = dragRect(d), big = r.w > 2 || r.h > 2;
      const w = big ? Math.max(r.w, 5) : 8, hh = big ? Math.max(r.h, 4) : 5;
      const x = Math.max(0, Math.min(r.x, SOV.S.grid.w - w)), y = Math.max(0, Math.min(r.y, SOV.S.grid.h - hh));
      const res = await api('POST', '/rooms', { x, y, w, h: hh, kind: roomKind, name: SOV.S.roomKinds[roomKind].label });
      SOV.select({ type: 'room', id: res.room.id });
    } else if (d.kind === 'move' && d.moved) { const r = SOV.S.rooms[d.id]; await api('PATCH', '/rooms/' + d.id, { x: r.x, y: r.y }); }
  } catch (_) { refresh(); }
});
canvas.addEventListener('dblclick', (e) => {
  const S = SOV.S; if (!S || SOV.tool !== 'select') return; const w = window.Scene.toWorld(e.clientX, e.clientY), t = window.Scene.hit(S, w.px, w.py);
  if (t && (t.type === 'room' || t.type === 'connector')) SOV.openRename(t.type, t.id); else if (t && t.type === 'agent') SOV.openAgentEditor(S.agents[t.id]);
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') space = false; });
window.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.code === 'Space') { space = true; e.preventDefault(); }
  if (e.key === 'Escape') { if (!$('#modal').hidden) SOV.closeModal(); else { linkFrom = null; SOV.sel = null; SOV.drawer = null; renderAll(); } }
  if ((e.key === 'Delete' || e.key === 'Backspace') && SOV.sel && SOV.sel.type !== 'agent') SOV.removeSelection();
});
SOV.removeSelection = async () => {
  const sel = SOV.sel; if (!sel) return;
  const path = { room: '/rooms/', desk: '/desks/', hallway: '/hallways/', connector: '/connectors/' }[sel.type]; if (!path) return;
  if (!confirm('Remove this ' + sel.type + '?')) return;
  try { await api('DELETE', path + sel.id); SOV.sel = null; renderAll(); } catch (_) {}
};

// ---------- modal helpers ----------
SOV.closeModal = () => { const m = $('#modal'); m.hidden = true; m.replaceChildren(); if (SOV._onClose) { SOV._onClose(); SOV._onClose = null; } };
SOV.modal = (content, { wide = false, onClose } = {}) => {
  const m = $('#modal'); SOV._onClose = onClose || null;
  m.replaceChildren(h('div', { class: 'dialog' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' }, content)); m.hidden = false;
  const f = m.querySelector('input:not([type=hidden]),select,textarea'); if (f) f.focus();
};
$('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') SOV.closeModal(); });
SOV.field = (label, input, help) => h('label', { class: 'field' }, label, input, help ? h('small', {}, help) : null);

// ---------- tool rail ----------
const ICON = {
  select: '<path d="M5 3l14 8-6 2-2 6z"/>', room: '<rect x="3" y="5" width="18" height="14"/>', desk: '<rect x="4" y="10" width="16" height="6"/><path d="M8 10V6h8v4"/>',
  hallway: '<circle cx="5" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 12h10"/>', connector: '<path d="M12 3l9 9-9 9-9-9z"/>', agent: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>',
  inspect: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>', agents: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20v-2a5 5 0 0 1 10 0v2M15 15a4 4 0 0 1 6 3v2"/>',
  money: '<path d="M12 3v18M16.5 7.5C15.5 6 13.5 5.5 12 5.5c-2 0-4 1-4 3s2 2.5 4 3 4 1 4 3-2 3-4 3c-1.8 0-3.8-.6-4.8-2.2"/>', outbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 2h6l1-2h5"/>',
  journey: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>', worlds: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>', integrations: '<path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'
};
const svg = (inner) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = inner; return s; };
const TOOLS = [['select', 'Select', 'Click to inspect. Drag a room to move it, double-click to rename. Scroll to zoom, drag the floor to pan.'], ['room', 'Room', 'Drag on the floor to draw a room. Pick its type below.'],
  ['desk', 'Desk', 'Click inside a room to place a desk.'], ['hallway', 'Hallway', 'Click where work starts (room, Inbox, connector), then where it goes.'],
  ['connector', 'Connector', 'Click an empty spot to add a port to Stripe, email, Shopify and more.'], ['agent', 'Agent', 'Click a room to add an agent there, an empty desk to seat one, or an agent to edit.']];
const PANELS = [['journey', 'Journey'], ['worlds', 'Worlds'], ['agents', 'Agents'], ['integrations', 'Integrations'], ['money', 'Money'], ['outbox', 'Outbox'], ['inspect', 'Inspect'], ['settings', 'Settings']];
function renderRail() {
  const S = SOV.S, pending = S.approvals.filter((a) => a.status === 'pending').length, needs = S.journey.needsYou.length;
  const badge = { journey: needs, money: 0, outbox: S.outbox.length, agents: 0, worlds: S.worlds.length > 1 ? S.worlds.length : 0 };
  $('#rail').replaceChildren(...PANELS.map(([id, name]) => h('button', { class: 'tool', type: 'button', 'aria-pressed': String(SOV.drawer === id), title: name, onclick: () => { SOV.drawer = SOV.drawer === id ? null : id; renderAll(); } },
    svg(ICON[id]), name, badge[id] ? h('span', { class: 'dot' }, badge[id]) : null)));
}
// Build tools float over the canvas so the left rail can be all panels.
function renderToolbar() {
  $('#toolbar').replaceChildren(...TOOLS.map(([id, name, tip]) => h('button', { class: 'tb' + (SOV.tool === id ? ' on' : ''), type: 'button', 'aria-pressed': String(SOV.tool === id), title: name + ': ' + tip,
    onclick: () => { SOV.tool = id; linkFrom = null; renderAll(); } }, svg(ICON[id]), h('span', {}, name))));
}
function renderHint() {
  const el = $('#hint'), t = TOOLS.find((x) => x[0] === SOV.tool); el.replaceChildren(h('span', {}, t[2]));
  if (SOV.tool === 'room') el.append(h('label', { class: 'muted' }, 'Type ', h('select', { 'aria-label': 'Room type', onchange: (e) => { roomKind = e.target.value; }, value: roomKind },
    Object.entries(SOV.S.roomKinds).filter(([k]) => k !== 'bridge').map(([k, v]) => h('option', { value: k }, v.label)))));
}

// ---------- zoom controls ----------
(function zoomControls() {
  const box = h('div', { id: 'zoom' }, h('button', { class: 'btn small', 'aria-label': 'Zoom in', onclick: () => zoomCenter(1.25) }, '+'), h('button', { class: 'btn small', 'aria-label': 'Zoom out', onclick: () => zoomCenter(0.8) }, '−'),
    h('button', { class: 'btn small', onclick: () => window.Scene.fit() }, 'Fit'));
  function zoomCenter(f) { const r = canvas.getBoundingClientRect(); window.Scene.zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); }
  $('#view').append(box);
})();

// ---------- header, worlds, guide bar ----------
const STEPS = [['goal', 'Goal'], ['milestones', 'Milestones'], ['roadmap', 'Roadmap'], ['setup', 'Setup'], ['run', 'Run']];
SOV.STEPS = STEPS;
function renderHeader() {
  const S = SOV.S, p = S.progress, m = S.mission, mb = $('#mission-bar'), w = S.world;
  if (!m) mb.replaceChildren(h('span', { class: 'muted' }, 'No goal yet. Click to set one.'));
  else mb.replaceChildren(h('strong', {}, m.name), h('span', { class: 'bar', title: 'Verified net profit toward target' }, h('i', { style: `width:${p.pct}%` })), h('span', {}, `${usd(p.netCents)} / ${usd(p.targetCents)}`));
  $('#spend').textContent = `Model spend today ${usd(S.spentTodayCents)} of ${usd(S.settings.budgets.globalDailyCents)}`;
  $('#world-switch').replaceChildren(h('i', { class: 'wdot', style: `background:${w.color}` }), h('span', { class: 'wname' }, w.name), h('span', { class: 'muted' }, '▾'));
  $('#world-switch').style.display = ''; document.title = (S.worlds.length > 1 ? w.name + ' · ' : '') + 'Sovereign';
}
$('#mission-bar').addEventListener('click', () => { if (!SOV.S) return; if (!SOV.S.mission) SOV.openGoal(); else SOV.openDrawer('journey'); });

function closeWorldMenu() { const m = $('#world-menu'); if (m) m.remove(); document.removeEventListener('pointerdown', outside, true); }
function outside(e) { if (!e.target.closest('#world-menu') && !e.target.closest('#world-switch')) closeWorldMenu(); }
$('#world-switch').addEventListener('click', () => {
  if ($('#world-menu')) return closeWorldMenu();
  const S = SOV.S, r = $('#world-switch').getBoundingClientRect();
  const stageName = (s) => (STEPS.find((x) => x[0] === s) || [0, s])[1];
  const menu = h('div', { id: 'world-menu', role: 'menu', style: `left:${r.left}px;top:${r.bottom + 6}px` },
    ...S.worlds.map((w) => h('button', { role: 'menuitem', class: w.id === S.world.id ? 'on' : '', onclick: () => { closeWorldMenu(); if (w.id !== S.world.id) SOV.setWorld(w.id); } },
      h('i', { class: 'wdot', style: `background:${w.color}` }), h('span', { class: 'wm-name' }, w.name), h('small', {}, `${w.agents} agent${w.agents === 1 ? '' : 's'} · ${stageName(w.stage)}`))),
    h('hr'), h('button', { role: 'menuitem', onclick: () => { closeWorldMenu(); SOV.openWorldCreate(); } }, '+ New world'), h('button', { role: 'menuitem', onclick: () => { closeWorldMenu(); SOV.openDrawer('worlds'); } }, 'Manage worlds…'));
  document.body.append(menu); document.addEventListener('pointerdown', outside, true);
});
SOV.setWorld = async (id) => {
  SOV.world = id; try { localStorage.setItem('sov.world', id); } catch (_) {}
  SOV.sel = null; SOV.chatAgent = null; SOV.stream = {}; SOV.busy.clear(); window.Scene.invalidate(); await refresh(); window.Scene.fit();
};

function renderGuide() {
  const g = $('#guide'), S = SOV.S, j = S.journey, idx = STEPS.findIndex((x) => x[0] === j.stage), rm = j.roadmap, pr = j.progress;
  let msg, cta = 'Open plan', tone = '';
  const spin = () => h('i', { class: 'spinner', 'aria-hidden': 'true' });
  if (j.stage === 'goal') { msg = 'Start by setting your goal. The Director plans everything else.'; cta = 'Set goal'; }
  else if (j.stage === 'milestones') msg = j.busy ? [spin(), 'The Director is drafting milestones…'] : 'Review the milestones. Edit anything, then approve.';
  else if (j.stage === 'roadmap') msg = j.busy ? [spin(), 'The Director is building your roadmap…'] : 'Review the roadmap and approve it to continue.';
  else if (j.stage === 'setup') { const left = j.setup ? j.setup.requirements.filter((r) => r.blocking && r.status === 'needs_setup').length : 0; msg = left ? `Connect what the plan needs (${left} left), or skip and continue.` : 'Everything the plan needs is ready. Start the team when you are.'; cta = 'Set up'; }
  else if (rm && rm.paused) { msg = 'Paused. ' + (rm.pauseReason || ''); cta = 'Resume'; tone = 'warn'; }
  else if (j.needsYou.length) { msg = `${j.needsYou.length} thing${j.needsYou.length > 1 ? 's' : ''} need${j.needsYou.length > 1 ? '' : 's'} you. The team keeps going on everything else.`; cta = 'See what'; tone = 'warn'; }
  else if (rm && rm.status === 'done') { msg = 'The roadmap is complete.'; cta = 'Plan next phase'; }
  else msg = [spin(), `The team is working · ${pr.done} of ${pr.total} tasks done`];
  g.hidden = false; g.className = 'guide ' + tone;
  g.replaceChildren(h('div', { class: 'g-steps' }, STEPS.map(([id, label], i) => h('span', { class: 'g-step' + (i < idx || (id === 'run' && rm && rm.status === 'done') ? ' done' : i === idx ? ' on' : '') }, h('i', {}, i < idx ? '✓' : i + 1), label))),
    h('div', { class: 'g-msg' }, msg), ...(j.stage === 'run' && pr ? [h('span', { class: 'bar g-bar', title: pr.pct + '%' }, h('i', { style: `width:${pr.pct}%` }))] : []),
    h('button', { class: 'btn small primary', onclick: () => { if (j.stage === 'goal') SOV.openGoal(); else if (rm && rm.paused && j.stage === 'run') api('POST', '/journey/resume').catch(() => {}); else if (rm && rm.status === 'done') api('POST', '/journey/replan').then(() => SOV.openDrawer('journey')).catch(() => {}); else SOV.openDrawer('journey'); } }, cta));
}

// ---------- drawer ----------
const TITLES = { journey: 'Journey', worlds: 'Worlds', agents: 'Agents', integrations: 'Integrations', money: 'Money', outbox: 'Outbox', inspect: 'Inspect', settings: 'Settings' };
const wide = () => { try { return localStorage.getItem('sov.wide') === '1'; } catch (_) { return false; } };
function renderDrawer() {
  const d = $('#drawer');
  if (!SOV.drawer) { d.hidden = true; return; }
  const ae = document.activeElement;
  if (!d.hidden && ae && d.contains(ae) && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) { SOV.drawerDirty = true; return; }
  SOV.drawerDirty = false; d.hidden = false; d.classList.toggle('wide', wide());
  const body = h('div', { class: 'drawer-body' }, SOV.panels[SOV.drawer]());
  const shownKey = SOV.drawer + (SOV.drawer === 'journey' ? ':' + SOV.S.journey.stage : '') + ':' + SOV.S.world.id; // a new panel, stage or world starts at the top
  const top = d.querySelector('.drawer-body') && SOV._shown === shownKey ? d.querySelector('.drawer-body').scrollTop : 0; SOV._shown = shownKey;
  d.replaceChildren(h('div', { class: 'drawer-head' }, h('span', {}, TITLES[SOV.drawer]),
    h('span', { class: 'dh-btns' }, h('button', { 'aria-label': wide() ? 'Make the panel narrower' : 'Make the panel wider', title: wide() ? 'Narrower' : 'Wider', onclick: () => { try { localStorage.setItem('sov.wide', wide() ? '0' : '1'); } catch (_) {} SOV.drawerDirty = false; renderDrawer(); window.Scene.invalidate(); } }, wide() ? '⇥' : '⇤'),
      h('button', { 'aria-label': 'Close panel', onclick: SOV.closeDrawer }, '×'))), body);
  body.scrollTop = top;
}
$('#drawer').addEventListener('focusout', () => setTimeout(() => { if (SOV.drawerDirty) renderDrawer(); }, 200));

// ---------- chat ----------
const chat = $('#chat');
chat.replaceChildren(h('div', { class: 'strip', id: 'strip' }), h('div', { class: 'who', id: 'who' }), h('div', { id: 'approvals' }), h('div', { id: 'log', 'aria-live': 'polite' }),
  h('form', { id: 'composer', onsubmit: (e) => { e.preventDefault(); sendChat(); } },
    h('textarea', { id: 'input', rows: '2', placeholder: 'Message the selected agent…', 'aria-label': 'Message', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } } }),
    h('button', { class: 'btn primary', type: 'submit', id: 'send' }, 'Send')));

function approvalCard(a) {
  const isPlan = a.kind === 'director.plan';
  return h('div', { class: 'card approval' }, h('strong', {}, a.summary),
    isPlan ? h('ul', {}, a.detail.map((l) => h('li', {}, l))) : h('pre', {}, a.detail.join('\n')),
    h('div', { class: 'row' }, h('button', { class: 'btn primary small', onclick: () => api('POST', `/approvals/${a.id}/approve`).then((r) => { if (r.approval.status === 'failed') toast('Approved, but it failed: ' + r.approval.error, 'error'); else toast('Approved.'); }).catch(() => {}) }, 'Approve'),
      h('button', { class: 'btn small', onclick: () => api('POST', `/approvals/${a.id}/reject`).catch(() => {}) }, 'Reject')));
}
function renderChat() {
  const S = SOV.S; if (!S) return;
  const agents = Object.values(S.agents).sort((a, b) => (a.role === 'director' ? -1 : b.role === 'director' ? 1 : a.createdAt - b.createdAt));
  const now = performance.now();
  $('#strip').replaceChildren(...agents.map((a) => h('button', { class: 'chip-agent' + (SOV.busy.has(a.id) ? ' working' : ''), type: 'button', 'aria-pressed': String(SOV.chatAgent === a.id), title: a.name, onclick: () => { SOV.chatAgent = a.id; SOV.select({ type: 'agent', id: a.id }, false); } },
    window.Avatar.canvas(a.avatar, 2, window.Avatar.frameFor(a.id, now, false)), h('span', {}, a.name))));
  const a = S.agents[SOV.chatAgent]; if (!a) return;
  const room = a.deskId && S.desks[a.deskId] && S.rooms[S.desks[a.deskId].roomId];
  $('#who').replaceChildren(window.Avatar.canvas(a.avatar, 3, 0), h('div', { style: 'flex:1;min-width:0' }, h('strong', {}, a.name), h('div', { class: 'muted' }, S.roles[a.role] ? S.roles[a.role].label : a.role), h('div', { class: 'muted' }, room ? 'Desk in ' + room.name : 'No desk'),
    SOV.busy.has(a.id) ? h('span', { class: 'pill ok' }, 'working') : null), h('button', { class: 'btn small', onclick: () => SOV.openAgentEditor(a) }, 'Edit'));
  $('#approvals').replaceChildren(...S.approvals.filter((x) => x.status === 'pending').map(approvalCard));
  const log = $('#log'), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const tr = (S.transcripts[a.id] || []).slice(-30); const items = tr.map((m) => h('div', { class: 'msg ' + (m.role === 'user' ? 'me' : '') }, m.content));
  for (const t of SOV.local[a.id] || []) items.push(h('div', { class: 'msg me' }, t));
  if (!items.length) items.push(h('div', { class: 'msg sys' }, a.role === 'director'
    ? (S.mission ? 'Ask me for a status report, or tell me to do something: “Tell Quill to draft five posts.” Work starts right away. Changes to the station wait for your approval.' : 'Set your goal and I will plan everything else.')
    : `Say hello to ${a.name}. ${a.caps.length ? 'They can: ' + a.caps.map((c) => S.caps[c].toLowerCase()).join(', ') + '.' : 'They have no desk permissions yet.'}`));
  if (SOV.busy.has(a.id)) items.push(SOV.stream[a.id] ? h('div', { class: 'msg live' }, SOV.stream[a.id]) : h('div', { class: 'msg sys' }, `${a.name} is working…`));
  log.replaceChildren(...items); if (atBottom) log.scrollTop = log.scrollHeight;
  const send = $('#send'); send.disabled = SOV.busy.has(a.id); $('#input').placeholder = `Message ${a.name}…`;
}
async function sendChat() {
  const S = SOV.S, a = S && S.agents[SOV.chatAgent], input = $('#input'), text = input.value.trim(); if (!a || !text) return;
  input.value = ''; (SOV.local[a.id] = SOV.local[a.id] || []).push(text); renderChat();
  try { await api('POST', a.role === 'director' ? '/director/message' : `/agents/${a.id}/chat`, { text }); }
  catch (_) { /* toast shown */ }
  finally { SOV.local[a.id] = (SOV.local[a.id] || []).filter((t) => t !== text); scheduleRefresh(); }
}

// ---------- boot ----------
function renderAll() {
  const S = SOV.S; if (!S) return;
  renderHeader(); renderGuide(); renderRail(); renderToolbar(); renderHint(); renderDrawer(); renderChat();
  // After the intro, and only if no goal is saved yet, ask for it. Once saved it never appears again.
  if (SOV.introDone && !S.mission && S.journey.stage === 'goal' && !SOV.goalPrompted[S.world.id] && $('#modal').hidden) { SOV.goalPrompted[S.world.id] = true; SOV.openGoal(); }
}
SOV.render = renderAll;
function frame(now) {
  requestAnimationFrame(frame);
  if (!SOV.S) return;
  window.Scene.render(now, SOV.S, { sel: SOV.sel, tool: SOV.tool, linkFrom, drag, dragRect, mouse, hover, busy: SOV.busy, pulses: SOV.pulses, chatAgent: SOV.chatAgent });
}
(async function boot() {
  const first = await (await fetch('/api/state')).json();
  try { // a reinstall gets a new install id: forget everything the browser remembered about the old one
    if (localStorage.getItem('sov.install') !== first.installId) { for (const k of Object.keys(localStorage)) if (k.startsWith('sov.')) localStorage.removeItem(k); localStorage.setItem('sov.install', first.installId); }
    const w = localStorage.getItem('sov.world'); if (w && first.worlds.some((x) => x.id === w)) SOV.world = w;
  } catch (_) { /* storage blocked: default world */ }
  await refresh(); requestAnimationFrame(frame);
  await window.Intro.play(!!SOV.S.settings.intro);
  SOV.introDone = true; renderAll(); window.Scene.fit();
})();
})();
