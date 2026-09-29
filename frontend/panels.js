// Drawer panels: Journey, Worlds, Agents, Integrations, Money, Outbox, Inspect, Settings.
(() => {
'use strict';
const { h, usd, toast, api } = window.SOV, SOV = window.SOV;
const cap = (t) => t[0].toUpperCase() + t.slice(1);
const agentAtDesk = (S, id) => Object.values(S.agents).find((a) => a.deskId === id);
const roleLabel = (S, r) => (S.roles[r] ? S.roles[r].label : r);
const debounce = (fn, ms = 450) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function capChecks(S, allowed, current, onchange) {
  return h('div', {}, Object.keys(S.caps).filter((c) => allowed.includes(c)).map((c) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: current.includes(c), onchange: (e) => { const n = new Set(current); e.target.checked ? n.add(c) : n.delete(c); onchange([...n]); } }),
    h('span', {}, S.caps[c], S.directorOnly.includes(c) ? h('small', {}, 'Only the Director can use this') : null))));
}
const nodeName = (S, ref) => ref === 'inbox' ? 'Inbox' : ref === 'outbox' ? 'Outbox' : ref.startsWith('room:') ? (S.rooms[ref.slice(5)] || {}).name : (S.connectors[ref.slice(10)] || {}).name;

// ---------- Inspect ----------
const connDraft = {};
function inspectConnector(S, c) {
  const kind = S.connectorKinds[c.kind], d = connDraft[c.id] = connDraft[c.id] || { config: {}, secrets: {} };
  const statusPill = { ready: ['ok', 'Connected'], untested: ['warn', 'Saved, not tested'], error: ['bad', 'Error'], unconfigured: ['', 'Not set up'] }[c.status] || ['', c.status];
  const save = async () => { await api('PATCH', '/connectors/' + c.id, { config: d.config, secrets: d.secrets }); connDraft[c.id] = { config: {}, secrets: {} }; toast('Saved.'); };
  const fields = kind.fields.map((f) => f.secret
    ? SOV.field(f.label + (c.secretsSet[f.key] ? ' (saved)' : ''), h('input', { type: 'password', autocomplete: 'off', placeholder: c.secretsSet[f.key] ? '•••••••• leave blank to keep' : f.placeholder || '', value: d.secrets[f.key] || '', oninput: (e) => { d.secrets[f.key] = e.target.value; } }), f.help)
    : SOV.field(f.label + (f.optional ? ' (optional)' : ''), h('input', { type: 'text', placeholder: f.placeholder || '', value: d.config[f.key] !== undefined ? d.config[f.key] : (c.config[f.key] || ''), oninput: (e) => { d.config[f.key] = e.target.value; } }), f.help));
  const ventures = Object.values(S.ventures);
  const limit = parseInt(c.config.dailyLimit, 10) || 25;
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('strong', { style: 'font-size:15px' }, c.name), h('span', { class: 'pill ' + statusPill[0] }, statusPill[1])),
    h('p', { class: 'muted', style: 'margin:0' }, kind.blurb),
    c.lastError ? h('div', { class: 'card', style: 'border-color:var(--bad)' }, c.lastError) : null,
    SOV.field('Name', h('input', { type: 'text', value: c.name, maxlength: '32', onchange: (e) => api('PATCH', '/connectors/' + c.id, { name: e.target.value }).catch(() => SOV.refresh()) })),
    ...(c.kind === 'portal' ? [h('div', { class: 'card' }, h('strong', {}, 'Portal to “' + ((SOV.S.worlds.find((w) => w.id === c.config.targetWorld) || {}).name || 'a removed world') + '”'),
      h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Draw a hallway from a room into this gate and finished work is delivered to that world\'s Inbox (or its Director if the Inbox is not wired). The Director can also message that world directly.'))]
    : kind.live ? [
      ...fields,
      kind.oauth ? h('div', { class: 'card' }, h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Sign-in redirect URI to register with the provider:'), h('pre', {}, location.origin + '/oauth/callback'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary small', onclick: async () => { try { await save(); location.href = '/oauth/start?connector=' + c.id; } catch (_) {} } }, c.oauthConnected ? 'Reconnect' : 'Connect'),
          c.oauthConnected ? h('span', { class: 'pill ok' }, 'signed in') : h('span', { class: 'pill warn' }, 'not signed in'),
          c.oauthConnected ? h('button', { class: 'btn small', onclick: () => api('POST', `/connectors/${c.id}/disconnect`) }, 'Sign out') : null)) : null,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => save().catch(() => {}) }, 'Save'),
        h('button', { class: 'btn', onclick: async () => { try { await save(); const r = await api('POST', `/connectors/${c.id}/test`); toast(r.detail); } catch (_) { SOV.refresh(); } } }, 'Test connection'),
        kind.canSync ? h('button', { class: 'btn', onclick: async () => { try { const r = await api('POST', `/connectors/${c.id}/sync`); toast(r.summary.split('\n')[0]); SOV.openDrawer('outbox'); } catch (_) { SOV.refresh(); } } }, 'Sync now') : null),
      kind.mode !== 'sink' && kind.canSync && ['stripe', 'shopify', 'etsy', 'meta_ads', 'woocommerce', 'gumroad'].includes(c.kind) ? h('div', { class: 'stack' },
        SOV.field('Attribute revenue and costs to', h('select', { onchange: (e) => api('PATCH', '/connectors/' + c.id, { ventureId: e.target.value || null }), value: c.ventureId || '' }, h('option', { value: '' }, 'No venture (counts toward the mission)'), ventures.map((v) => h('option', { value: v.id }, v.name)))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.autoSync, onchange: (e) => api('PATCH', '/connectors/' + c.id, { autoSync: e.target.checked }) }), h('span', {}, 'Sync every 10 minutes', h('small', {}, 'Read-only. Feeds the verified ledger.'))),
        c.lastSyncAt ? h('div', { class: 'muted' }, 'Last sync ' + new Date(c.lastSyncAt).toLocaleString()) : null) : null,
      kind.contract ? h('div', {}, h('h3', {}, 'How agents hand work to this connector'), h('p', { class: 'muted', style: 'margin:0 0 4px' }, 'Draw a hallway from a room into this port. The last agent in that room ends its reply with JSON like this, and you approve each action.'), h('pre', {}, kind.contract)) : null,
      c.kind === 'email' ? h('div', { class: 'muted' }, `Sent today: ${c.sentToday} of ${limit}`) : null
    ] : [h('p', { class: 'muted' }, 'This is a placeholder port. Work sent here is queued in the Outbox until an adapter exists.')]),
    h('h3', {}, 'Access'), h('p', { class: 'muted', style: 'margin:0' }, `A hallway into this port is only allowed from rooms that have “${S.caps[kind.cap]}”.`),
    h('button', { class: 'btn danger', onclick: SOV.removeSelection }, 'Remove connector (deletes saved keys)'));
}

function inspect() {
  const S = SOV.S, sel = SOV.sel;
  if (!sel) return h('div', { class: 'stack' }, h('h3', {}, 'How the station works'),
    h('p', {}, 'A room is a team and its capabilities are the ceiling for everyone in it. Every agent has their own desk. A hallway is an approved handoff lane. A connector is a port to the outside world.'),
    h('p', { class: 'muted' }, 'Pick a tool on the left, or click anything on the floor to inspect it. Double-click a room to rename it.'),
    h('button', { class: 'btn primary', onclick: sendToInbox }, 'Send a task through the Inbox'));
  if (sel.type === 'room') {
    const r = S.rooms[sel.id]; if (!r) return h('p', { class: 'muted' }, 'That room is gone.');
    const inRoom = Object.values(S.desks).filter((d) => d.roomId === r.id).length;
    const nameInput = h('input', { type: 'text', value: r.name, maxlength: '32', 'aria-label': 'Room name', onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      oninput: debounce((e) => { if (e.target.value.trim()) api('PATCH', '/rooms/' + r.id, { name: e.target.value }).catch(() => {}); }), onblur: (e) => { if (!e.target.value.trim()) e.target.value = r.name; } });
    const size = (k, label) => SOV.field(label, h('input', { type: 'number', min: '5', max: '24', value: r[k], onchange: (e) => api('PATCH', '/rooms/' + r.id, { [k]: +e.target.value }).catch(() => SOV.refresh()) }));
    return h('div', { class: 'stack' }, h('h3', {}, 'Room'), SOV.field('Name', nameInput),
      SOV.field('Type (changing it resets capabilities)', h('select', { onchange: (e) => api('PATCH', '/rooms/' + r.id, { kind: e.target.value }), value: r.kind }, Object.entries(S.roomKinds).map(([k, v]) => h('option', { value: k }, v.label)))),
      h('div', { class: 'row' }, size('w', 'Width'), size('h', 'Height')),
      h('p', { class: 'muted', style: 'margin:0' }, `${inRoom} desk${inRoom === 1 ? '' : 's'}. Rooms grow on their own when you add agents.`),
      h('h3', {}, 'What this room may ever do'), capChecks(S, Object.keys(S.caps), r.capabilities, (caps) => api('PATCH', '/rooms/' + r.id, { capabilities: caps })),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => SOV.openAgentEditor(null, { roomId: r.id }) }, 'Add agent here'), h('button', { class: 'btn', onclick: () => api('POST', '/desks', { roomId: r.id }).catch(() => {}) }, 'Add empty desk'), h('button', { class: 'btn danger', onclick: SOV.removeSelection }, 'Remove room')));
  }
  if (sel.type === 'desk') {
    const dk = S.desks[sel.id]; if (!dk) return h('p', { class: 'muted' }, 'That desk is gone.'); const room = S.rooms[dk.roomId], who = agentAtDesk(S, dk.id);
    return h('div', { class: 'stack' }, h('h3', {}, 'Desk in ' + room.name),
      SOV.field('Seated agent', h('select', { onchange: (e) => { const v = e.target.value; (v ? api('PATCH', '/agents/' + v, { deskId: dk.id }) : who ? api('PATCH', '/agents/' + who.id, { deskId: null }) : Promise.resolve()).catch(() => SOV.refresh()); }, value: who ? who.id : '' },
        h('option', { value: '' }, 'Empty'), Object.values(S.agents).filter((a) => !a.deskId || a.deskId === dk.id).map((a) => h('option', { value: a.id }, a.name)))),
      h('h3', {}, 'Grants at this desk'), h('p', { class: 'muted', style: 'margin:0' }, 'Limited to what the room allows and what the agent\'s role permits.'),
      capChecks(S, room.capabilities, dk.grants, (g) => api('PATCH', '/desks/' + dk.id, { grants: g })),
      h('button', { class: 'btn danger', onclick: SOV.removeSelection }, 'Remove desk'));
  }
  if (sel.type === 'agent') {
    const a = S.agents[sel.id]; if (!a) return h('p', { class: 'muted' }, 'That agent is gone.'); const t = (S.transcripts[a.id] || []).slice(-2);
    const room = a.deskId && S.rooms[S.desks[a.deskId].roomId];
    return h('div', { class: 'stack' }, h('div', { class: 'row' }, window.Avatar.canvas(a.avatar, 4, 0), h('div', {}, h('strong', { style: 'font-size:15px' }, a.name), h('div', { class: 'muted' }, roleLabel(S, a.role)), h('div', { class: 'muted' }, room ? 'Desk in ' + room.name : 'No desk'))),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { SOV.chatAgent = a.id; SOV.render(); document.getElementById('input').focus(); } }, 'Chat'), h('button', { class: 'btn', onclick: () => SOV.openAgentEditor(a) }, 'Edit look, role and persona'),
        !a.locked ? h('button', { class: 'btn danger', onclick: async () => { if (confirm('Remove ' + a.name + ' and their desk?')) { try { await api('DELETE', '/agents/' + a.id); SOV.sel = null; SOV.render(); } catch (_) {} } } }, 'Remove') : null),
      h('h3', {}, 'Can do right now'), h('p', { style: 'margin:0' }, a.caps.length ? a.caps.map((c) => S.caps[c]).join(' · ') : 'Nothing yet. Seat them at a desk in a room that grants capabilities.'),
      t.length ? [h('h3', {}, 'Latest'), t.map((m) => h('div', { class: 'msg ' + (m.role === 'user' ? 'me' : '') }, m.content.slice(0, 400)))] : null);
  }
  if (sel.type === 'hallway') {
    const hw = S.hallways[sel.id]; if (!hw) return h('p', { class: 'muted' }, 'That hallway is gone.');
    return h('div', { class: 'stack' }, h('h3', {}, 'Hallway'), h('p', { style: 'margin:0' }, nodeName(S, hw.from) + '  →  ' + nodeName(S, hw.to)),
      h('p', { class: 'muted', style: 'margin:0' }, 'Finished work from the first end is handed to the second automatically.'), h('button', { class: 'btn danger', onclick: SOV.removeSelection }, 'Remove hallway'));
  }
  if (sel.type === 'connector') { const c = S.connectors[sel.id]; return c ? inspectConnector(S, c) : h('p', { class: 'muted' }, 'That connector is gone.'); }
  return h('p', { class: 'muted' }, 'Nothing selected.');
}
function sendToInbox() {
  const t = h('textarea', { placeholder: 'Describe the work. It enters at the Inbox and follows your hallways.', rows: '4' });
  SOV.modal(h('div', { class: 'stack' }, h('h2', {}, 'Send work through the Inbox'), t, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
    if (!t.value.trim()) return; try { const r = await api('POST', '/run', { from: 'inbox', task: t.value }); SOV.closeModal(); SOV.openDrawer('outbox'); if (r.notes && r.notes.length) toast(r.notes[0]); } catch (_) {} } }, 'Send'), h('button', { class: 'btn', onclick: SOV.closeModal }, 'Cancel'))));
}
SOV.sendToInbox = sendToInbox;

// ---------- Agents ----------
function agentsPanel() {
  const S = SOV.S, list = Object.values(S.agents).sort((a, b) => (a.role === 'director' ? -1 : b.role === 'director' ? 1 : a.createdAt - b.createdAt));
  return h('div', { class: 'stack' }, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => SOV.openAgentEditor(null) }, 'New agent'), h('button', { class: 'btn', onclick: sendToInbox }, 'Send a task through the Inbox')),
    h('p', { class: 'sub' }, 'Each agent has a coded job with its own saved settings. Ask the Director in the chat to assign work, or give a task directly.'),
    list.map((a) => { const room = a.deskId && S.desks[a.deskId] && S.rooms[S.desks[a.deskId].roomId], job = S.jobs[a.role];
      return h('div', { class: 'card item', onclick: () => SOV.select({ type: 'agent', id: a.id }) }, window.Avatar.canvas(a.avatar, 2, 0),
        h('div', { style: 'min-width:0;flex:1' }, h('strong', {}, a.name, ' ', SOV.busy.has(a.id) ? h('span', { class: 'pill ok' }, 'working') : null), h('div', { class: 'muted' }, roleLabel(S, a.role) + (room ? ' · ' + room.name : ' · no desk')),
          job ? h('div', { class: 'muted', style: 'font-size:11.5px;margin-top:2px' }, job.summary) : null),
        a.role !== 'director' && job && job.tasks.length ? h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); SOV.openTaskModal(a); } }, 'Give a task') : null); }));
}

// ---------- Money ----------
let newSecret = null;
function money() {
  const S = SOV.S, p = S.progress, ventures = Object.values(S.ventures);
  const stat = (l, v, cls) => h('div', { class: 'stat' }, h('span', {}, l), h('b', { class: cls || '' }, v));
  return h('div', { class: 'stack' }, h('h3', {}, S.mission ? S.mission.name : 'No goal set'),
    S.mission ? h('div', { class: 'card' }, h('div', { class: 'bar', style: 'margin-bottom:8px' }, h('i', { style: `width:${p.pct}%` })), stat('Verified net profit', usd(p.netCents), p.netCents >= 0 ? 'pos' : 'neg'), stat('Target', usd(p.targetCents)), stat('Verified revenue', usd(p.revenueCents)), stat('Verified costs', usd(p.costCents)),
      p.claimedCents ? stat('Unverified claims (not counted)', usd(p.claimedCents), 'neg') : null) : h('button', { class: 'btn primary', onclick: SOV.openGoal }, 'Set your goal'),
    S.mission ? h('button', { class: 'btn small', onclick: SOV.openGoal }, 'Edit goal') : null,
    h('h3', {}, 'Ventures'), ventures.length ? ventures.map((v) => { const pl = S.pnl[v.id]; return h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', {}, v.name), h('span', { class: 'pill ' + (v.status === 'killed' ? 'bad' : 'warn') }, v.status)),
      h('div', { class: 'muted' }, v.thesis), stat('Net', usd(pl.net), pl.net >= 0 ? 'pos' : 'neg'), stat('Loss limit', usd(v.maxLossCents))); }) : h('p', { class: 'muted' }, 'The Director proposes ventures once your agents are in place.'),
    h('h3', {}, 'Recent ledger'), S.ledger.length ? S.ledger.slice(0, 15).map((e) => h('div', { class: 'stat' }, h('span', {}, (e.type === 'revenue' ? '+ ' : '− ') + e.source + (e.note ? ' · ' + e.note : ''), ' ', h('span', { class: 'pill ' + (e.verified ? 'ok' : 'bad') }, e.verified ? 'verified' : 'unverified')), h('b', {}, usd(e.amountCents)))) : h('p', { class: 'muted' }, 'Nothing yet. Model costs appear automatically. Revenue appears when Stripe, Shopify or Etsy report it.'),
    h('h3', {}, 'Custom payment source'), h('p', { class: 'muted', style: 'margin:0' }, 'For anything without a built-in connector, post signed events to /api/ingest/<source>.'),
    newSecret ? h('div', {}, h('p', { class: 'muted' }, 'Copy this now. It is shown once.'), h('pre', {}, newSecret), h('p', { class: 'muted' }, 'Sign the raw body with HMAC-SHA256 and send it in the x-sovereign-signature header.'), h('pre', {}, '{"ventureId":"vent_…","type":"revenue","amountCents":4900,"ref":"ch_123"}')) : null,
    h('button', { class: 'btn', onclick: async () => { try { const r = await api('POST', '/secrets/ingest'); newSecret = r.secret; SOV.render(); } catch (_) {} } }, S.settings.ingestSecretSet ? 'Replace ingest secret' : 'Create ingest secret'));
}

// ---------- Outbox ----------
function outbox() {
  const S = SOV.S, download = (o) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([o.content], { type: 'text/markdown' })); a.download = 'business-sop.md'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
  const items = S.outbox.slice(), pin = items.findIndex((o) => o.kind === 'sop'); if (pin > 0) items.unshift(items.splice(pin, 1)[0]); // the SOP always sits at the top
  return h('div', { class: 'stack' }, S.outbox.length ? items.map((o) => { const sop = o.kind === 'sop';
    return h('div', { class: 'card' + (sop ? ' sop-card' : '') }, h('div', { class: 'row' }, h('strong', {}, sop ? '📄 ' + o.title : o.title), h('span', { class: 'pill ' + (o.status === 'blocked' ? 'bad' : 'ok') }, sop ? 'SOP' : o.status)),
      h('div', { class: 'muted' }, new Date(o.at).toLocaleString() + (o.fromRoom ? ' · ' + o.fromRoom : '')),
      sop ? h('details', { open: true }, h('summary', {}, 'Read the SOP'), h('pre', {}, String(o.content))) : h('pre', {}, String(o.content).slice(0, 1400)),
      o.meta && o.meta.files ? h('div', { class: 'row' }, h('span', { class: 'chip' }, 'built ' + o.meta.files.length + ' file' + (o.meta.files.length > 1 ? 's' : '')), h('a', { class: 'btn small primary', href: o.meta.preview, target: '_blank', rel: 'noopener' }, 'Open the site')) : null,
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(o.content).then(() => toast('Copied.')) }, 'Copy'),
        sop ? [h('button', { class: 'btn small', onclick: () => download(o) }, 'Download .md'), h('button', { class: 'btn small', onclick: () => { SOV.closeDrawer(); api('POST', '/sop/replay').catch(() => {}); } }, 'Replay the flight')] : null)); }) : h('p', { class: 'muted' }, 'Finished work lands here as real results, not chat scrollback.'));
}

// ---------- Settings ----------
let draft = null;
const fresh = () => { const st = SOV.S.settings; draft = { provider: st.provider.name, model: st.provider.model, ollamaHost: st.ollama.host, keepAlive: st.ollama.keepAlive, numCtx: st.ollama.numCtx, par: st.concurrency.ollama, parOther: st.concurrency.other, speed: st.speed || 'fast', autoDelegate: st.autoDelegate !== false, autoContinue: st.autoContinue !== false, waitMinutes: st.waitMinutes == null ? 10 : st.waitMinutes, intro: st.intro, baseUrl: st.openaiCompat.baseUrl, key: '', policy: { ...st.policy }, budgets: { ...st.budgets }, models: null }; };
function settings() {
  const S = SOV.S, st = S.settings; if (!draft) fresh();
  const d = draft, rerender = () => { SOV.drawerDirty = false; SOV.render(); };
  const providerLabels = { mock: 'Offline demo (no key)', openrouter: 'OpenRouter', ollama: 'Ollama (local models)', openai: 'OpenAI-compatible' };
  const saveAll = async () => {
    if (d.key) await api('POST', '/secrets', { name: d.provider === 'openai' ? 'openai' : 'openrouter', value: d.key });
    await api('POST', '/settings', { provider: { name: d.provider, model: d.model }, ollama: { host: d.ollamaHost, keepAlive: d.keepAlive, numCtx: d.numCtx }, concurrency: { ollama: d.par, other: d.parOther }, speed: d.speed, autoDelegate: d.autoDelegate, autoContinue: d.autoContinue, waitMinutes: d.waitMinutes, intro: d.intro, openaiCompat: { baseUrl: d.baseUrl },
      policy: { directorStructure: d.policy.directorStructure, connectorWrites: d.policy.connectorWrites }, budgets: d.budgets });
    d.key = '';
  };
  const providerBox = [];
  if (d.provider === 'ollama') {
    providerBox.push(SOV.field('Ollama address', h('input', { type: 'text', value: d.ollamaHost, placeholder: 'http://127.0.0.1:11434', oninput: (e) => { d.ollamaHost = e.target.value; } }), 'Where Ollama is running. Use another machine\'s address for a remote box.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { try { const r = await api('GET', '/ollama/models?host=' + encodeURIComponent(d.ollamaHost)); d.models = r.models; if (r.models.length && !r.models.includes(d.model)) d.model = r.models[0]; toast(r.models.length ? `Found ${r.models.length} model${r.models.length > 1 ? 's' : ''}.` : 'Ollama is running but has no models. Run: ollama pull llama3.1'); rerender(); } catch (_) {} } }, 'Detect models')),
      d.models && d.models.length ? SOV.field('Installed models', h('select', { onchange: (e) => { d.model = e.target.value; rerender(); }, value: d.model }, d.models.map((m) => h('option', { value: m }, m)))) : null,
      SOV.field('Model', h('input', { type: 'text', value: d.model, placeholder: 'llama3.1', oninput: (e) => { d.model = e.target.value; } }), 'Type any model name you have pulled, or use Detect models.'),
      h('h3', {}, 'Ollama speed'),
      h('p', { class: 'settings-note', style: 'margin:0' }, 'Answers stream in as they are written and the model stays loaded between calls. Smaller models and a smaller context window respond faster; the first call after a cold start is always the slowest.'),
      h('div', { class: 'row' },
        SOV.field('Keep model loaded', h('select', { onchange: (e) => { d.keepAlive = e.target.value; }, value: d.keepAlive }, ['5m', '30m', '1h', '4h', '24h'].map((v) => h('option', { value: v }, v)))),
        SOV.field('Context size', h('select', { onchange: (e) => { d.numCtx = +e.target.value; }, value: String(d.numCtx) }, [2048, 4096, 8192, 16384].map((v) => h('option', { value: String(v) }, v + ' tokens')))),
        SOV.field('Agents at once', h('input', { type: 'number', min: '1', max: '8', value: d.par, onchange: (e) => { d.par = +e.target.value; } }))),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { try { await saveAll(); const r = await api('POST', '/ollama/warm'); toast(r.warmed ? 'Model is loading into memory.' : 'Could not reach Ollama to warm the model.', r.warmed ? '' : 'error'); } catch (_) {} } }, 'Warm up model now')));
  } else if (d.provider === 'openrouter') {
    providerBox.push(SOV.field('OpenRouter key' + (st.keys.openrouter ? ' (saved)' : ''), h('input', { type: 'password', autocomplete: 'off', placeholder: 'sk-or-…', value: d.key, oninput: (e) => { d.key = e.target.value; } })),
      SOV.field('Model', h('input', { type: 'text', value: d.model, placeholder: 'provider/model-name', oninput: (e) => { d.model = e.target.value; } }), 'Copy a model ID from openrouter.ai/models.'));
  } else if (d.provider === 'openai') {
    providerBox.push(SOV.field('Base URL', h('input', { type: 'text', value: d.baseUrl, oninput: (e) => { d.baseUrl = e.target.value; } }), 'OpenAI, LM Studio (http://localhost:1234/v1), vLLM, Groq, Together, and similar.'),
      SOV.field('API key' + (st.keys.openai ? ' (saved)' : ''), h('input', { type: 'password', autocomplete: 'off', value: d.key, oninput: (e) => { d.key = e.target.value; } }), 'Leave blank for local servers that need no key.'),
      SOV.field('Model', h('input', { type: 'text', value: d.model, oninput: (e) => { d.model = e.target.value; } })));
  } else providerBox.push(h('p', { class: 'muted', style: 'margin:0' }, 'The offline demo model needs nothing and does no real work. Pick a real provider for real results.'));

  return h('div', { class: 'stack' }, h('h3', {}, 'Model provider'),
    SOV.field('Provider', h('select', { onchange: (e) => { d.provider = e.target.value; if (e.target.value === 'mock') d.model = 'mock-1'; else if (e.target.value === 'ollama') d.model = d.models && d.models[0] || 'llama3.1'; else if (d.model === 'mock-1' || d.model === 'llama3.1') d.model = ''; rerender(); }, value: d.provider }, S.providerNames.map((n) => h('option', { value: n }, providerLabels[n] || n)))),
    ...providerBox,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { await saveAll(); toast('Settings saved.'); } catch (_) {} } }, 'Save'),
      h('button', { class: 'btn', onclick: async () => { try { await saveAll(); toast('Testing the model…'); const r = await api('POST', '/provider/test'); toast(`Model replied in ${(r.ms / 1000).toFixed(1)}s (${r.model}): ${r.reply}`); } catch (_) {} } }, 'Save and test')),
    h('h3', {}, 'Speed and autonomy'),
    SOV.field('Output length', h('select', { onchange: (e) => { d.speed = e.target.value; }, value: d.speed }, h('option', { value: 'fast' }, 'Fast (short, dense deliverables)'), h('option', { value: 'balanced' }, 'Balanced'), h('option', { value: 'thorough' }, 'Thorough (longest, slowest)')), 'Waiting time is mostly output length. Fast is the default.'),
    h('div', { class: 'row' }, SOV.field('Agents at once (cloud models)', h('input', { type: 'number', min: '1', max: '16', value: d.parOther, onchange: (e) => { d.parOther = +e.target.value; } }), 'How many agents may call the model at the same time.')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.autoDelegate, onchange: (e) => { d.autoDelegate = e.target.checked; } }), h('span', {}, 'The Director keeps idle agents busy', h('small', {}, 'Hands out extra drafts and analysis. Never sends, posts or spends.'))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.autoContinue, onchange: (e) => { d.autoContinue = e.target.checked; } }), h('span', {}, 'Keep working until the goal is reached', h('small', {}, 'When a round finishes, the Director plans the next one. Stops only when verified profit reaches the target.'))),
    SOV.field('Move on if only you can unblock a step, after (minutes)', h('input', { type: 'number', min: '0', max: '240', value: d.waitMinutes, onchange: (e) => { d.waitMinutes = +e.target.value; } }), 'The step stays on your Needs-you list and runs as soon as you have done it.'),
    h('h3', {}, 'Guardrails'),
    SOV.field('Director structural changes', h('select', { onchange: (e) => { d.policy.directorStructure = e.target.value; }, value: d.policy.directorStructure }, h('option', { value: 'ask' }, 'Ask me first (recommended)'), h('option', { value: 'auto' }, 'Let the Director apply plans')), 'Assigning work to agents never needs approval. Creating or removing agents, rooms and hallways does.'),
    SOV.field('Emails, messages, pages, files, rows and events', h('select', { onchange: (e) => { d.policy.connectorWrites = e.target.value; }, value: d.policy.connectorWrites }, h('option', { value: 'ask' }, 'Ask me before each one (recommended)'), h('option', { value: 'auto' }, 'Send automatically'))),
    h('div', { class: 'row' }, SOV.field('Station budget per day (USD)', h('input', { type: 'number', min: '0', value: d.budgets.globalDailyCents / 100, onchange: (e) => { d.budgets.globalDailyCents = Math.round(e.target.value * 100); } }), 'Spans every world.'),
      SOV.field('Per agent per day (USD)', h('input', { type: 'number', min: '0', value: d.budgets.perAgentDailyCents / 100, onchange: (e) => { d.budgets.perAgentDailyCents = Math.round(e.target.value * 100); } }))),
    h('button', { class: 'btn', onclick: async () => { try { await saveAll(); toast('Guardrails saved.'); } catch (_) {} } }, 'Save guardrails'),
    h('h3', {}, 'Interface'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: d.intro, onchange: (e) => { d.intro = e.target.checked; } }), h('span', {}, 'Play the opening sequence at startup', h('small', {}, 'Click or press any key skips it.'))),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { try { await saveAll(); } catch (_) {} } }, 'Save'), h('button', { class: 'btn', onclick: () => window.Intro.play(true) }, 'Replay intro')),
    h('h3', {}, 'Your data'),
    h('p', { class: 'settings-note', style: 'margin:0' }, 'Everything is stored in the data folder inside this project, including saved keys. Deleting the project folder removes it all.'),
    h('button', { class: 'btn danger', onclick: async () => {
      if (window.prompt('This erases every world, agent, saved key and result on this computer and starts over. Type RESET to confirm.') !== 'RESET') return;
      try { await api('POST', '/reset', { confirm: 'RESET' }); for (const k of Object.keys(localStorage)) if (k.startsWith('sov.')) localStorage.removeItem(k); location.reload(); } catch (_) {} } }, 'Start fresh (erase everything)'));
}
SOV.resetSettingsDraft = () => { draft = null; };

// ---------- shared helpers for the new panels ----------
const kindLabel = (S, k) => (S.connectorKinds[k] || {}).label || k;
const busyCard = (text) => h('div', { class: 'card row' }, h('i', { class: 'spinner' }), h('span', {}, text));
const redraw = () => { SOV.drawerDirty = false; SOV.render(); };
async function openConnector(kind) {
  try {
    let c = Object.values(SOV.S.connectors).find((x) => x.kind === kind);
    if (!c) { const r = await api('POST', '/connectors', { kind }); c = r.connector; }
    await SOV.refresh(); SOV.drawer = 'inspect'; SOV.select({ type: 'connector', id: c.id });
  } catch (_) { /* toast shown */ }
}
const stepper = (S) => { const idx = SOV.STEPS.findIndex((x) => x[0] === S.journey.stage); return h('div', { class: 'stepper' }, SOV.STEPS.map(([id, label], i) => h('div', { class: 'st' + (i < idx ? ' done' : i === idx ? ' on' : ''), 'data-n': String(i + 1) }, label))); };
const STATUS = { todo: ['', 'queued'], running: ['st-running', 'working'], done: ['st-done', 'done'], skipped: ['', 'skipped'], blocked: ['st-fail', 'waiting'], needs_you: ['st-running', 'your step'], failed: ['st-fail', 'failed'] };
function taskRow(S, t, { editable = false, run = false } = {}) {
  const st = STATUS[t.status] || STATUS.todo;
  return h('div', {}, h('div', { class: 'trow' }, h('span', { class: 'chip' }, roleLabel(S, t.role)), h('span', { class: 'tt' }, t.title),
    ...t.requires.map((k) => h('span', { class: 'chip req', title: 'Needs this connected to run' }, kindLabel(S, k))), t.owner === 'human' ? h('span', { class: 'chip human' }, 'you') : null,
    run && t.agentName && ['running', 'done'].includes(t.status) ? h('span', { class: 'chip', title: 'Who did or is doing this' }, t.agentName) : null,
    run ? h('span', { class: 'pill ' + (t.status === 'done' ? 'ok' : t.status === 'failed' || t.status === 'blocked' ? 'bad' : t.status === 'running' || t.status === 'needs_you' ? 'warn' : ''), title: t.reason || t.error || '' }, st[1]) : null,
    editable ? h('button', { class: 'rx', 'aria-label': 'Remove this task', title: 'Remove this task', onclick: () => api('POST', `/journey/task/${t.id}/remove`).catch(() => {}) }, '×') : null),
    run && t.result ? h('details', { class: 'res' }, h('summary', {}, 'Result'), h('pre', {}, t.result), h('button', { class: 'btn small', onclick: () => SOV.openDrawer('outbox') }, 'Open the Outbox')) : null);
}
function msCard(S, ms, opts) {
  return h('div', { class: 'ms ' + (ms.status === 'done' ? 'done' : ms.status === 'active' ? 'active' : '') },
    h('div', { class: 'ms-head' }, h('strong', {}, ms.title), h('span', { class: 'chip' }, `~${ms.days} days`), opts.run ? h('span', { class: 'pill ' + (ms.status === 'done' ? 'ok' : ms.status === 'active' ? 'warn' : '') }, ms.status === 'todo' ? 'later' : ms.status) : null),
    ms.why ? h('div', { class: 'muted', style: 'margin:2px 0 0;font-size:12px' }, ms.why) : null, ms.tasks.map((t) => taskRow(S, t, opts)));
}

// ---------- strategy, memory, site (Journey helpers) ----------
function ladderCard(S) {
  const st = S.journey.strategy; if (!st) return null;
  return h('div', {}, h('h3', {}, 'The Director\'s strategy: a capital ladder'), h('p', { class: 'sub', style: 'margin:0 0 6px' }, st.rule),
    h('div', { class: 'ladder' }, st.stages.map((x, i) => h('div', { class: 'rung ' + x.status }, h('div', { class: 'row' }, h('b', {}, `${i + 1}. ${x.title}`), h('span', { class: 'pill ' + (x.status === 'active' ? 'ok' : x.status === 'done' ? '' : 'warn') }, x.status === 'active' ? 'now' : x.status === 'done' ? 'done' : 'next')),
      h('div', { class: 'muted', style: 'font-size:12px;margin:2px 0' }, x.thesis), h('div', { style: 'font-size:12px' }, `Move up at ${usd(x.targetCents)} verified profit` + (x.budgetNowCents != null ? ` · budget ${usd(x.budgetNowCents)}` : ' · budget set from verified profit'))))));
}
function memoryCard(S) {
  const m = S.journey.memory; if (!m) return null; const has = m.brief || m.decisions.length || m.handoffs.length;
  const note = h('input', { type: 'text', placeholder: 'Add a rule the whole team must follow…', maxlength: '300', 'aria-label': 'Team rule' });
  const add = async () => { if (!note.value.trim()) return; try { await api('POST', '/memory/note', { text: note.value }); note.value = ''; } catch (_) {} };
  note.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  return h('div', {}, h('h3', {}, 'Team memory (every agent reads this)'),
    h('div', { class: 'card' }, m.brief ? h('div', { class: 'mem-line' }, h('b', {}, 'Brief: '), m.brief) : null,
      ...m.decisions.slice().reverse().map((d) => h('div', { class: 'mem-line' }, '✓ ', d.text, ' ', h('small', {}, d.by))),
      m.spendPlan && m.spendPlan.items.length ? h('div', { class: 'mem-line' }, h('b', {}, `Spend plan ${usd(m.spendPlan.totalCents)} of ${usd(m.spendPlan.budgetCents)}: `), m.spendPlan.items.map((i) => `${i.item} ${usd(i.costCents)}`).join(' · ')) : null,
      !has ? h('div', { class: 'muted' }, 'Fills as the team works: decisions, handoffs and the spend plan.') : null,
      h('div', { class: 'mem-line' }, h('small', {}, `Available to spend now: ${usd(m.budget.availableCents)} · this stage: ${usd(m.budget.stageCents)}`))),
    m.ownerNotes.length ? h('div', { class: 'card', style: 'margin-top:6px' }, h('strong', { style: 'font-size:12px' }, 'Your rules'), ...m.ownerNotes.map((n) => h('div', { class: 'mem-line' }, n.text, ' ', h('button', { class: 'rx', style: 'background:none;border:0;color:var(--muted);cursor:pointer', 'aria-label': 'Remove rule', onclick: () => api('POST', '/memory/note/remove', { text: n.text }).catch(() => {}) }, '×')))) : null,
    h('div', { class: 'row', style: 'margin-top:6px' }, note, h('button', { class: 'btn small', onclick: add }, 'Add rule')));
}
function siteCard(S) {
  const site = S.site; if (!site) return null; const prods = site.products || [], draft = {};
  return h('div', {}, h('h3', {}, 'Your website (built for free)'),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('a', { class: 'btn small primary', href: site.preview, target: '_blank', rel: 'noopener' }, 'Open live preview'), h('span', { class: 'muted' }, `${site.files.length} file${site.files.length === 1 ? '' : 's'}: ${site.files.slice(0, 6).join(', ')}`)),
      site.folder ? h('div', { class: 'muted', style: 'margin:6px 0;font-size:12px' }, 'Saved in: ', h('code', {}, site.folder)) : null,
      h('p', { class: 'muted', style: 'margin:6px 0;font-size:12px' }, 'To put it online for free: drag that folder onto Cloudflare Pages (Direct Upload) or Netlify Drop, or push it to a GitHub Pages repo. Free hosts serve static files only, so checkout is a hosted payment page: paste a link per product below (a payment link, Gumroad, Etsy or a Shopify checkout).'),
      prods.length ? [h('strong', { style: 'font-size:12px' }, 'Buy links'), ...prods.map((p) => h('div', { class: 'row', style: 'margin:4px 0' }, h('span', { style: 'min-width:110px;font-size:12px' }, p.name + (p.price ? ' · $' + p.price : '')), h('input', { type: 'text', placeholder: 'https://… checkout link', value: (site.links || {})[p.id] || '', 'aria-label': 'Buy link for ' + p.name, oninput: (e) => { draft[p.id] = e.target.value; } }))),
        h('button', { class: 'btn small', onclick: async () => { try { await api('POST', '/site/links', { links: { ...(site.links || {}), ...draft } }); toast('Buy links saved. Refresh the preview.'); } catch (_) {} } }, 'Save buy links')]
        : h('div', { class: 'row', style: 'margin-top:6px' }, h('input', { type: 'text', placeholder: 'https://… your checkout link', value: (site.links || {}).main || '', 'aria-label': 'Main buy link', oninput: (e) => { draft.main = e.target.value; } }), h('button', { class: 'btn small', onclick: async () => { try { await api('POST', '/site/links', { links: { ...(site.links || {}), ...draft } }); toast('Saved. Refresh the preview.'); } catch (_) {} } }, 'Save'))));
}

// ---------- Journey ----------
let msDraft = null, msSig = '';
function syncMs(S) { const sig = S.journey.milestones.map((m) => [m.id, m.title, m.why, m.days].join('~')).join('|'); if (sig !== msSig || !msDraft) { msDraft = S.journey.milestones.map((m) => ({ id: m.id, title: m.title, why: m.why, days: m.days })); msSig = sig; } }
function journeyPanel() {
  const S = SOV.S, j = S.journey, rm = j.roadmap, kids = [stepper(S)];
  if (j.notice) kids.push(h('div', { class: 'card', style: 'border-color:var(--amber)' }, j.notice));
  if (j.stage === 'goal') {
    kids.push(h('h3', {}, 'Step 1 · Your goal'), h('p', {}, 'Tell Sovereign what you want to earn. The Director does the planning and only asks you for approvals, keys and steps only you can do.'), h('button', { class: 'btn primary', onclick: SOV.openGoal }, 'Set your goal'));
  } else if (j.stage === 'milestones') {
    kids.push(h('h3', {}, 'Step 2 · Milestones'), h('p', { class: 'sub' }, S.mission.name));
    if (j.busy === 'milestones') kids.push(busyCard('The Director is drafting milestones for your goal…'));
    else {
      syncMs(S);
      kids.push(h('p', { class: 'sub' }, j.adapted ? 'Tailored to your goal by your connected model. Edit anything.' : `Standard ${j.pathLabel || ''} plan for this kind of goal. Connect a real model in Settings and the Director will tailor it to your goal. Edit anything.`),
        ...msDraft.map((m, i) => h('div', { class: 'ms' }, h('div', { class: 'msedit' },
          h('input', { type: 'text', value: m.title, maxlength: '80', 'aria-label': 'Milestone title', oninput: (e) => { m.title = e.target.value; } }),
          h('input', { type: 'number', min: '1', max: '90', value: m.days, 'aria-label': 'Target days', title: 'Target days', oninput: (e) => { m.days = +e.target.value; } }),
          h('button', { class: 'btn small', 'aria-label': 'Remove milestone', onclick: () => { msDraft.splice(i, 1); redraw(); } }, '×'),
          h('textarea', { 'aria-label': 'Why this milestone matters', placeholder: 'Why this milestone matters', oninput: (e) => { m.why = e.target.value; } }, m.why)))),
        ladderCard(S),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { msDraft.push({ title: 'New milestone', why: '', days: 7 }); redraw(); } }, 'Add a milestone'),
          h('button', { class: 'btn', onclick: () => api('POST', '/journey/milestones/generate').catch(() => {}) }, 'Ask the Director to redraft')),
        h('button', { class: 'btn primary', onclick: async () => { try { await api('POST', '/journey/milestones/save', { milestones: msDraft }); await api('POST', '/journey/milestones/approve'); } catch (_) { SOV.refresh(); } } }, 'Approve milestones and build the roadmap →'));
    }
  } else if (j.stage === 'roadmap') {
    kids.push(h('h3', {}, 'Step 3 · Roadmap'));
    if (j.busy === 'roadmap' || !rm) kids.push(busyCard('The Director is building your roadmap…'));
    else {
      const needs = rm.requirements;
      kids.push(rm.tailoring ? busyCard('The Director is tailoring each task to your goal. You can already read and approve the plan.') : null, h('div', { class: 'card' }, rm.summary), ...rm.milestones.map((m) => msCard(S, m, { editable: true })),
        h('h3', {}, 'What this plan needs from you'),
        needs.length ? h('div', { class: 'row' }, needs.map((r) => h('span', { class: 'chip ' + (r.blocking ? 'req' : ''), title: r.why }, kindLabel(S, r.kind) + (r.blocking ? ' (needed)' : ' (recommended)')))) : h('p', { class: 'sub' }, 'No integrations. This plan needs nothing but the model.'),
        h('p', { class: 'settings-note', style: 'margin:0' }, 'Nothing is asked for that a task does not use. Remove a task above and its requirement goes with it.'),
        h('h3', {}, 'The team the Director will create'), h('div', { class: 'row' }, rm.agents.map((a) => h('span', { class: 'chip' }, a.label))),
        h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn', onclick: () => api('POST', '/journey/roadmap/back').catch(() => {}) }, '← Milestones'), h('button', { class: 'btn', onclick: () => api('POST', '/journey/roadmap/generate').catch(() => {}) }, 'Redraft'),
          h('button', { class: 'btn primary', onclick: () => api('POST', '/journey/roadmap/approve').catch(() => {}) }, 'Approve roadmap →')));
    }
  } else if (j.stage === 'setup' && rm) {
    const su = j.setup, blockingLeft = su.requirements.filter((r) => r.blocking && r.status === 'needs_setup');
    kids.push(h('h3', {}, 'Step 4 · Get ready'), h('p', { class: 'sub' }, 'Only what this plan uses. Connect it now, or skip and the tasks that need it wait while everything else runs.'));
    kids.push(h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', {}, 'Model'), su.provider.offline ? h('span', { class: 'pill warn' }, 'offline demo') : h('span', { class: 'pill ok' }, su.provider.name + ' · ' + su.provider.model)),
      su.provider.offline ? h('p', { class: 'muted', style: 'margin:6px 0' }, 'The offline demo model runs the whole plan but writes placeholder text. Connect Ollama, OpenRouter or another model for real work.') : null,
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => SOV.openDrawer('settings') }, su.provider.offline ? 'Choose a model' : 'Model settings'), !su.provider.offline ? h('button', { class: 'btn small', onclick: async () => { try { toast('Testing the model…'); const r = await api('POST', '/provider/test'); toast(`Replied in ${(r.ms / 1000).toFixed(1)}s`); } catch (_) {} } }, 'Test speed') : null)));
    for (const r of su.requirements) kids.push(h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', {}, r.label), h('span', { class: 'pill ' + (r.status === 'ready' ? 'ok' : r.status === 'skipped' ? '' : r.blocking ? 'warn' : '') }, r.status === 'ready' ? 'connected' : r.status === 'skipped' ? 'skipped' : r.blocking ? 'needed' : 'recommended')),
      h('div', { class: 'muted', style: 'margin:4px 0 8px' }, r.why), h('div', { class: 'row' },
        r.status !== 'ready' ? h('button', { class: 'btn small primary', onclick: () => openConnector(r.kind) }, r.connectorId ? 'Finish setup' : 'Set up ' + r.label) : h('button', { class: 'btn small', onclick: () => openConnector(r.kind) }, 'Open'),
        r.status !== 'ready' ? h('button', { class: 'btn small', onclick: () => api('POST', '/journey/requirement', { kind: r.kind, skipped: r.status !== 'skipped' }).catch(() => {}) }, r.status === 'skipped' ? 'Undo skip' : 'Skip for now') : null)));
    if (su.needsSource && !su.sourceReady) kids.push(h('div', { class: 'card' }, h('strong', {}, 'Where will you get paid?'), h('p', { class: 'muted', style: 'margin:4px 0 8px' }, 'Only revenue confirmed by a payment source counts toward your goal. Connect the one you will actually use; you can do this any time.'),
      h('div', { class: 'row' }, ['stripe', 'gumroad', 'shopify', 'etsy', 'woocommerce'].map((k) => h('button', { class: 'btn small', onclick: () => openConnector(k) }, kindLabel(S, k))))));
    kids.push(h('h3', {}, 'The team'), h('div', { class: 'row' }, su.agents.map((a) => h('span', { class: 'chip' }, a.label + (a.exists ? ' ✓' : ' (new)')))),
      h('button', { class: 'btn primary', style: 'margin-top:10px', onclick: async () => { try { await api('POST', '/journey/setup/complete'); toast('The Director is deploying the team.'); } catch (_) {} } }, blockingLeft.length ? 'Deploy the team and start anyway →' : 'Deploy the team and start →'),
      blockingLeft.length ? h('p', { class: 'settings-note', style: 'margin:0' }, `Tasks needing ${blockingLeft.map((r) => r.label).join(', ')} will wait until you connect ${blockingLeft.length > 1 ? 'them' : 'it'}. Everything else runs.`) : null);
  } else if (j.stage === 'run' && rm) {
    const pr = j.progress, paused = rm.paused;
    if (j.achieved) kids.push(h('div', { class: 'card banner-ok' }, h('strong', {}, 'Goal reached'), h('p', { style: 'margin:4px 0 0' }, j.decision ? j.decision.reason : 'Verified profit reached the target.'), h('p', { class: 'muted', style: 'margin:4px 0 0' }, 'Raise the target in Edit goal and the Director carries on from here.')));
    else if (rm.status === 'done' && j.decision) kids.push(h('div', { class: 'card' }, h('strong', {}, 'Round complete. The goal is not reached yet.'), h('p', { style: 'margin:4px 0 0' }, j.decision.reason)));
    if (j.busy === 'cycle') kids.push(busyCard('Goal not reached yet. The Director is planning the next round…'));
    kids.push(h('h3', {}, j.achieved ? 'Goal reached' : rm.status === 'done' ? 'Round complete' : 'Step 5 · Running' + (j.cycle ? ` · round ${j.cycle + 1}` : '')),
      h('div', { class: 'card' }, h('div', { class: 'bar', style: 'margin-bottom:8px' }, h('i', { style: `width:${pr.pct}%` })), h('div', { class: 'row' }, h('strong', {}, `${pr.done} of ${pr.total} tasks done`),
        rm.status === 'running' || (paused && rm.status !== 'achieved') ? (paused ? h('button', { class: 'btn small primary', onclick: () => api('POST', '/journey/resume').catch(() => {}) }, 'Resume') : h('button', { class: 'btn small', onclick: () => api('POST', '/journey/pause').catch(() => {}) }, 'Pause')) : null,
        rm.status === 'done' && !j.achieved ? h('button', { class: 'btn small primary', onclick: () => api('POST', '/journey/replan', { advance: !!(j.decision && j.decision.action === 'advance') }).catch(() => {}) }, 'Plan the next phase') : null),
        paused && rm.pauseReason ? h('div', { class: 'muted', style: 'margin-top:6px' }, rm.pauseReason) : null));
    if (j.needsYou.length) kids.push(h('h3', {}, 'Needs you'), ...j.needsYou.map((n) => h('div', { class: 'card needs' }, h('strong', {}, n.title), h('div', { class: 'muted', style: 'margin:3px 0 8px' }, n.milestone + ' · ' + n.detail),
      h('div', { class: 'row' }, n.kind === 'human' ? h('button', { class: 'btn small primary', onclick: () => api('POST', n.carry ? `/journey/carry/${n.carry}/done` : `/journey/task/${n.taskId}/done`).catch(() => {}) }, 'I did this') : null,
        n.kind === 'blocked' && n.connect ? h('button', { class: 'btn small primary', onclick: () => openConnector(n.connect) }, 'Connect ' + kindLabel(S, n.connect)) : null,
        n.kind === 'failed' ? h('button', { class: 'btn small primary', onclick: () => api('POST', n.carry ? `/journey/carry/${n.carry}/retry` : `/journey/task/${n.taskId}/retry`).catch(() => {}) }, 'Retry') : null,
        n.carry ? h('button', { class: 'btn small', onclick: () => api('POST', `/journey/carry/${n.carry}/done`).catch(() => {}) }, 'Dismiss') : h('button', { class: 'btn small', onclick: () => api('POST', `/journey/task/${n.taskId}/skip`).catch(() => {}) }, 'Skip')))));
    kids.push(ladderCard(S), memoryCard(S), siteCard(S));
    if (j.extras && j.extras.length) kids.push(h('h3', {}, 'Extra work the Director handed out'), h('p', { class: 'sub', style: 'margin:0 0 4px' }, 'Idle agents get useful drafts and analysis so nobody waits.'),
      h('div', { class: 'card' }, ...j.extras.slice(0, 8).map((x) => h('div', { class: 'trow' }, h('span', { class: 'chip' }, roleLabel(S, x.role)), h('span', { class: 'tt' }, x.title), x.agentName ? h('span', { class: 'chip' }, x.agentName) : null, h('span', { class: 'pill ' + (x.status === 'done' ? 'ok' : x.status === 'failed' ? 'bad' : x.status === 'running' ? 'warn' : '') }, x.status === 'running' ? 'working' : x.status)))));
    if (j.cycles && j.cycles.length) kids.push(h('h3', {}, 'Earlier rounds'), h('div', { class: 'card' }, ...j.cycles.map((c) => h('div', { class: 'mem-line' }, h('b', {}, 'Round ' + c.n), ` · ${c.tasksDone} tasks + ${c.extras} extras · net ${usd(c.netCents)}`, c.decision ? h('small', {}, ' · then: ' + c.decision) : null))));
    kids.push(h('h3', {}, 'Roadmap'), ...rm.milestones.map((m) => msCard(S, m, { run: true })),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn small', onclick: SOV.openGoal }, 'Edit goal'), h('button', { class: 'btn small', onclick: () => { if (confirm('Plan another round toward the same goal? Your team, rooms and team memory stay.')) api('POST', '/journey/replan').catch(() => {}); } }, 'Re-plan')));
  }
  return h('div', { class: 'stack' }, ...kids);
}

// ---------- Worlds ----------
function worldGraph(S) {
  const ns = 'http://www.w3.org/2000/svg', el = (t, a, txt) => { const e = document.createElementNS(ns, t); for (const k in a) e.setAttribute(k, a[k]); if (txt) e.textContent = txt; return e; };
  const svg = el('svg', { viewBox: '0 0 320 210', class: 'wgraph', role: 'img', 'aria-label': 'Map of your worlds and the portals between them' }), n = S.worlds.length, pos = {};
  S.worlds.forEach((w, i) => { const a = (i / n) * Math.PI * 2 - Math.PI / 2; pos[w.id] = n === 1 ? [160, 96] : [160 + Math.cos(a) * 100, 96 + Math.sin(a) * 66]; });
  const seen = new Set();
  for (const w of S.worlds) for (const t of w.links) { const k = [w.id, t].sort().join('|'); if (seen.has(k) || !pos[t]) continue; seen.add(k); svg.append(el('line', { x1: pos[w.id][0], y1: pos[w.id][1], x2: pos[t][0], y2: pos[t][1], stroke: '#1a8a4a', 'stroke-width': '2', 'stroke-dasharray': '5 4' })); }
  for (const w of S.worlds) {
    const [x, y] = pos[w.id], on = w.id === S.world.id, g = el('g', { class: 'wn', tabindex: '0', role: 'button', 'aria-label': 'Switch to ' + w.name });
    g.append(el('circle', { cx: x, cy: y, r: on ? 24 : 20, fill: w.color, 'fill-opacity': '.18', stroke: w.color, 'stroke-width': on ? '3' : '1.5' }), el('circle', { cx: x, cy: y, r: '7', fill: w.color }), el('text', { x, y: y + 38 }, w.name.length > 14 ? w.name.slice(0, 13) + '…' : w.name));
    g.addEventListener('click', () => SOV.setWorld(w.id)); g.addEventListener('keydown', (e) => { if (e.key === 'Enter') SOV.setWorld(w.id); }); svg.append(g);
  }
  return svg;
}
function worldsPanel() {
  const S = SOV.S, stageName = (s) => (SOV.STEPS.find((x) => x[0] === s) || [0, s])[1];
  return h('div', { class: 'stack' }, h('p', { class: 'sub' }, 'A world is a whole station of its own: its own Director, rooms, agents, goal and roadmap. Connect worlds with portals so one can hand work to another, for example an e-commerce world feeding a trading world.'),
    worldGraph(S), h('button', { class: 'btn primary', onclick: SOV.openWorldCreate }, '+ New world'),
    ...S.worlds.map((w) => { const others = S.worlds.filter((x) => x.id !== w.id && !w.links.includes(x.id)); let pick = others[0] && others[0].id;
      return h('div', { class: 'card wcard' + (w.id === S.world.id ? ' on' : '') }, h('i', { class: 'wdot', style: `background:${w.color};margin-top:5px` }),
        h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'row' }, h('strong', {}, w.name), h('span', { class: 'chip' }, (S.worldKinds[w.kind] || {}).label || w.kind), w.id === S.world.id ? h('span', { class: 'pill ok' }, 'viewing') : null),
          h('div', { class: 'muted' }, `${w.agents} agent${w.agents === 1 ? '' : 's'} · ${w.rooms} room${w.rooms === 1 ? '' : 's'} · ${stageName(w.stage)}`), w.goal ? h('div', { style: 'margin:3px 0' }, w.goal) : h('div', { class: 'muted' }, 'No goal yet'),
          w.links.length ? h('div', { class: 'row', style: 'margin:6px 0' }, h('span', { class: 'muted' }, 'Portals to:'), w.links.map((id) => { const t = S.worlds.find((x) => x.id === id); return t ? h('span', { class: 'chip' }, t.name, ' ', h('button', { class: 'rx', style: 'background:none;border:0;color:var(--muted);cursor:pointer', 'aria-label': 'Disconnect from ' + t.name, title: 'Close this portal', onclick: () => api('POST', '/worlds/disconnect', { a: w.id, b: id }).catch(() => {}) }, '×')) : null; })) : null,
          h('div', { class: 'row' }, w.id !== S.world.id ? h('button', { class: 'btn small primary', onclick: () => SOV.setWorld(w.id) }, 'Switch here') : null,
            others.length ? [h('select', { 'aria-label': 'World to connect to', style: 'width:auto', onchange: (e) => { pick = e.target.value; }, value: pick }, others.map((x) => h('option', { value: x.id }, x.name))), h('button', { class: 'btn small', onclick: () => api('POST', '/worlds/connect', { a: w.id, b: pick }).then(() => toast('Portals opened in both worlds.')).catch(() => {}) }, 'Connect')] : null,
            h('button', { class: 'btn small', onclick: () => SOV.openWorldEdit(w) }, 'Edit'),
            S.worlds.length > 1 ? h('button', { class: 'btn small danger', onclick: async () => { if (confirm(`Delete the world “${w.name}” with all its agents, rooms and saved keys? This cannot be undone.`)) { try { await api('DELETE', '/worlds/' + w.id); if (w.id === S.world.id) SOV.world = null; await SOV.refresh(); } catch (_) {} } } }, 'Delete') : null))); }));
}

// ---------- Integrations ----------
const CATS = [['payments', 'Get paid and verify revenue', ['stripe', 'gumroad']], ['stores', 'Online stores', ['shopify', 'etsy', 'woocommerce']], ['ads', 'Advertising', ['meta_ads']], ['messaging', 'Messages and email', ['email', 'slack', 'discord', 'telegram']],
  ['productivity', 'Docs, sheets and calendars', ['notion', 'drive', 'calendar', 'sheets', 'airtable']], ['automation', 'Automation', ['webhook']]];
let iFilter = 'all', iQuery = '';
function integrationsPanel() {
  const S = SOV.S, reqs = Object.fromEntries(((S.journey.roadmap && S.journey.roadmap.requirements) || []).map((r) => [r.kind, r]));
  const shown = new Set(CATS.flatMap((c) => c[2])), ready = (k) => Object.values(S.connectors).some((c) => c.kind === k && c.status === 'ready'), has = (k) => Object.values(S.connectors).some((c) => c.kind === k);
  const match = (k) => { const m = S.connectorKinds[k]; if (!m) return false; if (iQuery && !(m.label + ' ' + m.blurb).toLowerCase().includes(iQuery.toLowerCase())) return false;
    return { all: true, plan: !!reqs[k], connected: ready(k), reads: m.mode !== 'sink', acts: m.mode !== 'source' }[iFilter]; };
  const card = (k) => { const m = S.connectorKinds[k], r = reqs[k];
    return h('div', { class: 'card icard' }, h('div', { class: 'row' }, h('strong', { style: `color:${m.color}` }, m.label), ready(k) ? h('span', { class: 'pill ok' }, 'connected') : has(k) ? h('span', { class: 'pill warn' }, 'set up') : null,
      r ? h('span', { class: 'pill warn' }, r.blocking ? 'needed for your plan' : 'recommended for your plan') : null),
      h('div', { class: 'muted', style: 'margin:3px 0 6px;font-size:12px' }, m.blurb), h('div', { class: 'row' }, h('span', { class: 'pill' }, m.mode === 'source' ? 'reads data' : m.mode === 'sink' ? 'takes actions' : 'reads + acts'),
        h('button', { class: 'btn small' + (r && !ready(k) ? ' primary' : ''), onclick: () => openConnector(k) }, has(k) ? 'Open' : 'Add')));
  };
  const kids = [h('p', { class: 'sub' }, 'Every integration is a port on your station. Reads feed the verified ledger. Anything that sends, posts or writes waits for your approval unless you turn that off in Settings. Keys stay on this computer.'),
    h('input', { type: 'text', placeholder: 'Search integrations…', 'aria-label': 'Search integrations', value: iQuery, oninput: (e) => { iQuery = e.target.value; clearTimeout(integrationsPanel.t); integrationsPanel.t = setTimeout(() => { SOV.drawerDirty = false; SOV.render(); const i = document.querySelector('#drawer input[type=text]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); } }),
    h('div', { class: 'filters' }, [['all', 'All'], ['plan', 'For your plan'], ['connected', 'Connected'], ['reads', 'Reads data'], ['acts', 'Takes actions']].map(([id, l]) => h('button', { type: 'button', 'aria-pressed': String(iFilter === id), onclick: () => { iFilter = id; redraw(); } }, l)))];
  let any = false;
  for (const [, label, kinds] of CATS) { const list = kinds.filter(match); if (!list.length) continue; any = true; kids.push(h('h3', {}, label), h('div', { class: 'igrid' }, list.map(card))); }
  const later = Object.keys(S.connectorKinds).filter((k) => !shown.has(k) && k !== 'portal' && match(k) && !S.connectorKinds[k].live);
  if (later.length && iFilter === 'all') kids.push(h('h3', {}, 'Placeholders (no adapter yet)'), h('p', { class: 'sub' }, 'These ports exist so you can lay out your station. Work sent to them is queued in the Outbox.'), h('div', { class: 'igrid' }, later.map(card)));
  if (!any && !later.length) kids.push(h('p', { class: 'muted' }, iFilter === 'plan' ? 'Your plan does not need any integrations yet, or you have not built a roadmap.' : 'Nothing matches.'));
  return h('div', { class: 'stack' }, ...kids);
}

SOV.panels = { journey: journeyPanel, worlds: worldsPanel, agents: agentsPanel, integrations: integrationsPanel, money, outbox, inspect, settings };
})();
