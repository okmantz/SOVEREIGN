// Drawer panels: Inspect (rooms, desks, agents, hallways, connectors), Agents, Money, Outbox, Settings.
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
    ...(kind.live ? [
      ...fields,
      kind.oauth ? h('div', { class: 'card' }, h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Sign-in redirect URI to register with the provider:'), h('pre', {}, location.origin + '/oauth/callback'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary small', onclick: async () => { try { await save(); location.href = '/oauth/start?connector=' + c.id; } catch (_) {} } }, c.oauthConnected ? 'Reconnect' : 'Connect'),
          c.oauthConnected ? h('span', { class: 'pill ok' }, 'signed in') : h('span', { class: 'pill warn' }, 'not signed in'),
          c.oauthConnected ? h('button', { class: 'btn small', onclick: () => api('POST', `/connectors/${c.id}/disconnect`) }, 'Sign out') : null)) : null,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => save().catch(() => {}) }, 'Save'),
        h('button', { class: 'btn', onclick: async () => { try { await save(); const r = await api('POST', `/connectors/${c.id}/test`); toast(r.detail); } catch (_) { SOV.refresh(); } } }, 'Test connection'),
        kind.canSync ? h('button', { class: 'btn', onclick: async () => { try { const r = await api('POST', `/connectors/${c.id}/sync`); toast(r.summary.split('\n')[0]); SOV.openDrawer('outbox'); } catch (_) { SOV.refresh(); } } }, 'Sync now') : null),
      kind.mode !== 'sink' && kind.canSync && ['stripe', 'shopify', 'etsy', 'meta_ads'].includes(c.kind) ? h('div', { class: 'stack' },
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
  return h('div', { class: 'stack' }, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => SOV.openAgentEditor(null) }, 'New agent'), h('button', { class: 'btn', onclick: sendToInbox }, 'Send a task')),
    h('p', { class: 'muted', style: 'margin:0' }, 'Every agent gets their own desk automatically, in a room that fits their role.'),
    list.map((a) => { const room = a.deskId && S.desks[a.deskId] && S.rooms[S.desks[a.deskId].roomId];
      return h('button', { class: 'card item', onclick: () => SOV.select({ type: 'agent', id: a.id }) }, window.Avatar.canvas(a.avatar, 2, 0),
        h('div', { style: 'min-width:0' }, h('strong', {}, a.name, ' ', SOV.busy.has(a.id) ? h('span', { class: 'pill ok' }, 'working') : null), h('div', { class: 'muted' }, roleLabel(S, a.role) + (room ? ' · ' + room.name : ' · no desk')))); }));
}

// ---------- Money ----------
let newSecret = null;
function money() {
  const S = SOV.S, p = S.progress, ventures = Object.values(S.ventures);
  const stat = (l, v, cls) => h('div', { class: 'stat' }, h('span', {}, l), h('b', { class: cls || '' }, v));
  return h('div', { class: 'stack' }, h('h3', {}, S.mission ? S.mission.name : 'No mission set'),
    S.mission ? h('div', { class: 'card' }, h('div', { class: 'bar', style: 'margin-bottom:8px' }, h('i', { style: `width:${p.pct}%` })), stat('Verified net profit', usd(p.netCents), p.netCents >= 0 ? 'pos' : 'neg'), stat('Target', usd(p.targetCents)), stat('Verified revenue', usd(p.revenueCents)), stat('Verified costs', usd(p.costCents)),
      p.claimedCents ? stat('Unverified claims (not counted)', usd(p.claimedCents), 'neg') : null) : h('button', { class: 'btn primary', onclick: SOV.openMission }, 'Set a mission'),
    S.mission ? h('button', { class: 'btn small', onclick: SOV.openMission }, 'Edit mission') : null,
    h('h3', {}, 'Ventures'), ventures.length ? ventures.map((v) => { const pl = S.pnl[v.id]; return h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', {}, v.name), h('span', { class: 'pill ' + (v.status === 'killed' ? 'bad' : 'warn') }, v.status)),
      h('div', { class: 'muted' }, v.thesis), stat('Net', usd(pl.net), pl.net >= 0 ? 'pos' : 'neg'), stat('Loss limit', usd(v.maxLossCents))); }) : h('p', { class: 'muted' }, 'The Director proposes ventures once your agents are in place.'),
    h('h3', {}, 'Recent ledger'), S.ledger.length ? S.ledger.slice(0, 15).map((e) => h('div', { class: 'stat' }, h('span', {}, (e.type === 'revenue' ? '+ ' : '− ') + e.source + (e.note ? ' · ' + e.note : ''), ' ', h('span', { class: 'pill ' + (e.verified ? 'ok' : 'bad') }, e.verified ? 'verified' : 'unverified')), h('b', {}, usd(e.amountCents)))) : h('p', { class: 'muted' }, 'Nothing yet. Model costs appear automatically. Revenue appears when Stripe, Shopify or Etsy report it.'),
    h('h3', {}, 'Custom payment source'), h('p', { class: 'muted', style: 'margin:0' }, 'For anything without a built-in connector, post signed events to /api/ingest/<source>.'),
    newSecret ? h('div', {}, h('p', { class: 'muted' }, 'Copy this now. It is shown once.'), h('pre', {}, newSecret), h('p', { class: 'muted' }, 'Sign the raw body with HMAC-SHA256 and send it in the x-sovereign-signature header.'), h('pre', {}, '{"ventureId":"vent_…","type":"revenue","amountCents":4900,"ref":"ch_123"}')) : null,
    h('button', { class: 'btn', onclick: async () => { try { const r = await api('POST', '/secrets/ingest'); newSecret = r.secret; SOV.render(); } catch (_) {} } }, S.settings.ingestSecretSet ? 'Replace ingest secret' : 'Create ingest secret'));
}

// ---------- Outbox ----------
function outbox() {
  const S = SOV.S;
  return h('div', { class: 'stack' }, S.outbox.length ? S.outbox.map((o) => h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', {}, o.title), h('span', { class: 'pill ' + (o.status === 'blocked' ? 'bad' : 'ok') }, o.status)),
    h('div', { class: 'muted' }, new Date(o.at).toLocaleString() + (o.fromRoom ? ' · ' + o.fromRoom : '')), h('pre', {}, String(o.content).slice(0, 1400)),
    h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(o.content).then(() => toast('Copied.')) }, 'Copy'))) : h('p', { class: 'muted' }, 'Finished work lands here as real results, not chat scrollback.'));
}

// ---------- Settings ----------
let draft = null;
const fresh = () => { const st = SOV.S.settings; draft = { provider: st.provider.name, model: st.provider.model, ollamaHost: st.ollama.host, baseUrl: st.openaiCompat.baseUrl, key: '', policy: { ...st.policy }, budgets: { ...st.budgets }, models: null }; };
function settings() {
  const S = SOV.S, st = S.settings; if (!draft) fresh();
  const d = draft, rerender = () => { SOV.drawerDirty = false; SOV.render(); };
  const providerLabels = { mock: 'Offline demo (no key)', openrouter: 'OpenRouter', ollama: 'Ollama (local models)', openai: 'OpenAI-compatible' };
  const saveAll = async () => {
    if (d.key) await api('POST', '/secrets', { name: d.provider === 'openai' ? 'openai' : 'openrouter', value: d.key });
    await api('POST', '/settings', { provider: { name: d.provider, model: d.model }, ollama: { host: d.ollamaHost }, openaiCompat: { baseUrl: d.baseUrl },
      policy: { directorStructure: d.policy.directorStructure, connectorWrites: d.policy.connectorWrites }, budgets: d.budgets });
    d.key = '';
  };
  const providerBox = [];
  if (d.provider === 'ollama') {
    providerBox.push(SOV.field('Ollama address', h('input', { type: 'text', value: d.ollamaHost, placeholder: 'http://127.0.0.1:11434', oninput: (e) => { d.ollamaHost = e.target.value; } }), 'Where Ollama is running. Use another machine\'s address for a remote box.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { try { const r = await api('GET', '/ollama/models?host=' + encodeURIComponent(d.ollamaHost)); d.models = r.models; if (r.models.length && !r.models.includes(d.model)) d.model = r.models[0]; toast(r.models.length ? `Found ${r.models.length} model${r.models.length > 1 ? 's' : ''}.` : 'Ollama is running but has no models. Run: ollama pull llama3.1'); rerender(); } catch (_) {} } }, 'Detect models')),
      d.models && d.models.length ? SOV.field('Installed models', h('select', { onchange: (e) => { d.model = e.target.value; rerender(); }, value: d.model }, d.models.map((m) => h('option', { value: m }, m)))) : null,
      SOV.field('Model', h('input', { type: 'text', value: d.model, placeholder: 'llama3.1', oninput: (e) => { d.model = e.target.value; } }), 'Type any model name you have pulled, or use Detect models.'));
  } else if (d.provider === 'openrouter') {
    providerBox.push(SOV.field('OpenRouter key' + (st.keys.openrouter ? ' (saved)' : ''), h('input', { type: 'password', autocomplete: 'off', placeholder: 'sk-or-…', value: d.key, oninput: (e) => { d.key = e.target.value; } })),
      SOV.field('Model', h('input', { type: 'text', value: d.model, placeholder: 'provider/model-name', oninput: (e) => { d.model = e.target.value; } }), 'Copy a model ID from openrouter.ai/models.'));
  } else if (d.provider === 'openai') {
    providerBox.push(SOV.field('Base URL', h('input', { type: 'text', value: d.baseUrl, oninput: (e) => { d.baseUrl = e.target.value; } }), 'OpenAI, LM Studio (http://localhost:1234/v1), vLLM, Groq, Together, and similar.'),
      SOV.field('API key' + (st.keys.openai ? ' (saved)' : ''), h('input', { type: 'password', autocomplete: 'off', value: d.key, oninput: (e) => { d.key = e.target.value; } }), 'Leave blank for local servers that need no key.'),
      SOV.field('Model', h('input', { type: 'text', value: d.model, oninput: (e) => { d.model = e.target.value; } })));
  } else providerBox.push(h('p', { class: 'muted', style: 'margin:0' }, 'The offline demo model needs nothing and does no real work. Pick a real provider for real results.'));

  const kinds = Object.entries(S.connectorKinds).sort((a, b) => (b[1].live - a[1].live));
  return h('div', { class: 'stack' }, h('h3', {}, 'Model provider'),
    SOV.field('Provider', h('select', { onchange: (e) => { d.provider = e.target.value; if (e.target.value === 'mock') d.model = 'mock-1'; else if (e.target.value === 'ollama') d.model = d.models && d.models[0] || 'llama3.1'; else if (d.model === 'mock-1' || d.model === 'llama3.1') d.model = ''; rerender(); }, value: d.provider }, S.providerNames.map((n) => h('option', { value: n }, providerLabels[n] || n)))),
    ...providerBox,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { await saveAll(); toast('Settings saved.'); } catch (_) {} } }, 'Save'),
      h('button', { class: 'btn', onclick: async () => { try { await saveAll(); const r = await api('POST', '/provider/test'); toast(`Model replied (${r.model}): ${r.reply}`); } catch (_) {} } }, 'Save and test')),
    h('h3', {}, 'Guardrails'),
    SOV.field('Director structural changes', h('select', { onchange: (e) => { d.policy.directorStructure = e.target.value; }, value: d.policy.directorStructure }, h('option', { value: 'ask' }, 'Ask me first (recommended)'), h('option', { value: 'auto' }, 'Let the Director apply plans'))),
    SOV.field('Emails, Notion pages, Drive files, calendar events', h('select', { onchange: (e) => { d.policy.connectorWrites = e.target.value; }, value: d.policy.connectorWrites }, h('option', { value: 'ask' }, 'Ask me before each one (recommended)'), h('option', { value: 'auto' }, 'Send automatically'))),
    h('div', { class: 'row' }, SOV.field('Station budget per day (USD)', h('input', { type: 'number', min: '0', value: d.budgets.globalDailyCents / 100, onchange: (e) => { d.budgets.globalDailyCents = Math.round(e.target.value * 100); } })),
      SOV.field('Per agent per day (USD)', h('input', { type: 'number', min: '0', value: d.budgets.perAgentDailyCents / 100, onchange: (e) => { d.budgets.perAgentDailyCents = Math.round(e.target.value * 100); } }))),
    h('button', { class: 'btn', onclick: async () => { try { await saveAll(); toast('Guardrails saved.'); } catch (_) {} } }, 'Save guardrails'),
    h('h3', {}, 'Integrations'), h('p', { class: 'muted', style: 'margin:0' }, 'Add a port to your station, then open it to paste keys or sign in. Reads feed the verified ledger. Writes always wait for you unless you turn that off above.'),
    kinds.map(([k, m]) => { const n = Object.values(S.connectors).filter((c) => c.kind === k).length;
      return h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', { style: `color:${m.color}` }, m.label), m.live ? h('span', { class: 'pill' }, m.mode === 'source' ? 'reads data' : m.mode === 'sink' ? 'takes actions' : 'reads + acts') : h('span', { class: 'pill warn' }, 'placeholder'), n ? h('span', { class: 'pill ok' }, n + ' on station') : null),
        h('div', { class: 'muted', style: 'margin:4px 0 8px' }, m.blurb), h('button', { class: 'btn small', onclick: async () => { try { const r = await api('POST', '/connectors', { kind: k }); SOV.select({ type: 'connector', id: r.connector.id }); } catch (_) {} } }, n ? 'Add another' : 'Add to station')); }));
}
SOV.resetSettingsDraft = () => { draft = null; };

SOV.panels = { inspect, agents: agentsPanel, money, outbox, settings };
})();
