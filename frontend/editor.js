// Modals: agent editor (presets + fine-tuning), mission, rename, connector picker.
(() => {
'use strict';
const SOV = window.SOV, { h, api, toast } = SOV;
const cap = (t) => t[0].toUpperCase() + t.slice(1);
const swatchRow = (list, current, onpick) => h('div', { class: 'swatches' }, list.map((c) => h('button', { class: 'sw', type: 'button', style: `background:${c}`, 'aria-label': c, 'aria-pressed': String(c === current), onclick: () => onpick(c) })));

SOV.openAgentEditor = (agent, opts = {}) => {
  const S = SOV.S, A = S.avatars, isDir = !!agent && agent.role === 'director';
  const presetOf = (role) => ({ ...A.presets[S.roles[role].preset].cfg, preset: S.roles[role].preset });
  const d = agent ? { name: agent.name, role: agent.role, persona: agent.persona, model: agent.model, deskId: agent.deskId || '', avatar: { ...agent.avatar } }
    : { name: '', role: 'researcher', persona: S.roles.researcher.persona, model: null, deskId: opts.deskId || '', avatar: presetOf('researcher') };
  let touchedLook = !!agent, frame = 0;
  const preview = h('div', { class: 'preview-box' }), body = h('div', {});
  const paintPreview = () => preview.replaceChildren(window.Avatar.canvas(d.avatar, 8, frame));
  const tick = setInterval(() => { frame = frame === 0 ? 1 : 0; paintPreview(); }, 520);
  const set = (k, v) => { d.avatar[k] = v; delete d.avatar.preset; touchedLook = true; paint(); };
  const freeDesks = Object.values(S.desks).filter((x) => !Object.values(S.agents).some((a) => a.deskId === x.id) || (agent && agent.deskId === x.id));
  const roomHint = opts.roomId && S.rooms[opts.roomId];
  const selectOpt = (key, label) => SOV.field(label, h('select', { disabled: isDir && key === 'headwear', onchange: (e) => set(key, e.target.value), value: isDir && key === 'headwear' ? 'crown' : d.avatar[key] },
    A.options[key].filter((o) => o !== 'crown' || isDir).map((o) => h('option', { value: o }, cap(o)))));
  const groups = {}; for (const [k, r] of Object.entries(S.roles)) if (k !== 'director' || isDir) (groups[r.group] = groups[r.group] || []).push([k, r.label]);

  function paint() {
    paintPreview();
    body.replaceChildren(
      h('div', { class: 'editor' },
        h('div', { class: 'stack' }, preview,
          SOV.field('Name', h('input', { type: 'text', maxlength: '24', value: d.name, placeholder: 'Agent name', oninput: (e) => { d.name = e.target.value; } })),
          SOV.field('Role', h('select', { disabled: isDir, onchange: (e) => { const old = S.roles[d.role]; d.role = e.target.value; if (d.persona === old.persona) d.persona = S.roles[d.role].persona; if (!touchedLook) d.avatar = presetOf(d.role); paint(); }, value: d.role },
            Object.entries(groups).map(([g, list]) => h('optgroup', { label: g }, list.map(([k, l]) => h('option', { value: k }, l)))))),
          SOV.field('Desk', h('select', { onchange: (e) => { d.deskId = e.target.value; }, value: d.deskId },
            h('option', { value: '' }, agent ? 'Keep current desk' : roomHint ? `New desk in ${roomHint.name}` : 'New desk (automatic)'), freeDesks.map((x) => h('option', { value: x.id }, `${S.rooms[x.roomId].name} · empty desk`))),
            'Every agent gets their own desk. Automatic picks a room that fits the role and grows it if needed.'),
          SOV.field('Model override', h('input', { type: 'text', value: d.model || '', placeholder: 'Station default', oninput: (e) => { d.model = e.target.value || null; } }))),
        h('div', { class: 'stack' },
          h('div', {}, h('strong', {}, 'Characters'), h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Start from a look, then fine-tune below.')),
          h('div', { class: 'presets' }, Object.entries(A.presets).map(([k, p]) => h('button', { class: 'preset', type: 'button', title: p.blurb, 'aria-pressed': String(d.avatar.preset === k),
            onclick: () => { d.avatar = { ...p.cfg, preset: k }; if (isDir) d.avatar.headwear = 'crown'; touchedLook = true; paint(); } }, window.Avatar.canvas(p.cfg, 3, 0), p.label))),
          h('strong', {}, 'Fine-tune'),
          h('div', { class: 'grid2' }, selectOpt('head', 'Head'), selectOpt('hair', 'Hair'), selectOpt('facial', 'Facial hair'), selectOpt('eyewear', 'Eyewear'), selectOpt('headwear', 'Headwear'), selectOpt('outfit', 'Outfit'), selectOpt('accessory', 'Accessory')),
          h('div', { class: 'grid2' },
            h('div', {}, h('div', { class: 'muted' }, 'Skin'), swatchRow(A.palette.skin, d.avatar.skin, (c) => set('skin', c))),
            h('div', {}, h('div', { class: 'muted' }, 'Hair'), swatchRow(A.palette.hair, d.avatar.hairColor, (c) => set('hairColor', c))),
            h('div', {}, h('div', { class: 'muted' }, 'Outfit'), swatchRow(A.palette.outfit, d.avatar.outfitColor, (c) => set('outfitColor', c))),
            h('div', {}, h('div', { class: 'muted' }, 'Accent'), swatchRow(A.palette.accent, d.avatar.accent, (c) => set('accent', c))),
            h('div', {}, h('div', { class: 'muted' }, 'Hat and helmet'), swatchRow(A.palette.outfit, d.avatar.hatColor, (c) => set('hatColor', c)))))),
      h('div', { style: 'margin-top:12px' }, SOV.field('Persona and instructions', h('textarea', { rows: '3', oninput: (e) => { d.persona = e.target.value; } }, d.persona))),
      isDir ? h('p', { class: 'muted' }, 'The Director is the first agent. You can restyle them, but not remove them or change their role. They alone can edit the station.') : null,
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn primary', onclick: save }, agent ? 'Save agent' : 'Create agent'),
        h('button', { class: 'btn', onclick: () => { const rnd = (l) => l[Math.floor(Math.random() * l.length)], o = A.options, pl = A.palette;
          d.avatar = { head: 'human', hair: rnd(o.hair), facial: rnd(o.facial), eyewear: rnd(o.eyewear), headwear: isDir ? 'crown' : rnd(o.headwear.filter((x) => x !== 'crown')), outfit: rnd(o.outfit), accessory: rnd(o.accessory),
            skin: rnd(pl.skin), hairColor: rnd(pl.hair), outfitColor: rnd(pl.outfit), accent: rnd(pl.accent), hatColor: rnd(pl.outfit) }; touchedLook = true; paint(); } }, 'Randomize'),
        agent && !isDir ? h('button', { class: 'btn danger', onclick: async () => { if (confirm('Remove ' + agent.name + ' and their desk?')) { try { await api('DELETE', '/agents/' + agent.id); SOV.sel = null; SOV.closeModal(); } catch (_) {} } } }, 'Remove') : null,
        h('button', { class: 'btn', onclick: SOV.closeModal }, 'Cancel')));
  }
  async function save() {
    const payload = { name: d.name || S.roles[d.role].label, role: d.role, persona: d.persona, model: d.model, avatar: d.avatar };
    try {
      if (agent) { if (d.deskId) payload.deskId = d.deskId; await api('PATCH', '/agents/' + agent.id, payload); }
      else { if (d.deskId) payload.deskId = d.deskId; else if (opts.roomId) payload.roomId = opts.roomId; const r = await api('POST', '/agents', payload); SOV.chatAgent = r.agent.id; SOV.sel = { type: 'agent', id: r.agent.id }; }
      SOV.closeModal(); SOV.render();
    } catch (_) { /* toast shown */ }
  }
  paint(); SOV.modal(h('div', {}, h('h2', {}, agent ? 'Edit ' + agent.name : 'New agent'), body), { wide: true, onClose: () => clearInterval(tick) });
};

SOV.openMission = () => {
  const m = SOV.S.mission || {}, ids = {};
  const num = (k, label, v) => SOV.field(label, ids[k] = h('input', { type: 'number', min: '0', step: '1', value: v }));
  SOV.modal(h('div', { class: 'stack' }, h('h2', {}, SOV.S.mission ? 'Edit your mission' : 'Set your mission'),
    SOV.field('Mission name', ids.name = h('input', { type: 'text', value: m.name || 'First $10k', maxlength: '80' })),
    h('div', { class: 'row' }, num('target', 'Verified profit target (USD)', m.targetCents ? m.targetCents / 100 : 10000), num('capital', 'Starting capital (USD)', m.capitalCents ? m.capitalCents / 100 : 500)),
    num('risk', 'Most you will lose before everything stops (USD)', m.riskCents ? m.riskCents / 100 : 500),
    h('p', { class: 'muted', style: 'margin:0' }, 'Only revenue confirmed by a connected payment source counts. The Director proposes; you approve.'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
      try { await api('POST', '/mission', { name: ids.name.value, targetCents: Math.round(ids.target.value * 100), capitalCents: Math.round(ids.capital.value * 100), riskCents: Math.round(ids.risk.value * 100) });
        SOV.closeModal(); SOV.chatAgent = Object.values(SOV.S.agents).find((a) => a.role === 'director').id; toast('The Director is drafting a plan. It will appear in the chat.'); } catch (_) {} } }, SOV.S.mission ? 'Update mission' : 'Wake the Director'),
      h('button', { class: 'btn', onclick: SOV.closeModal }, 'Cancel'))));
};

SOV.openRename = (type, id) => {
  const S = SOV.S, item = (type === 'room' ? S.rooms : S.connectors)[id]; if (!item) return;
  const input = h('input', { type: 'text', value: item.name, maxlength: '32', 'aria-label': 'New name' });
  const go = async () => { if (!input.value.trim()) return toast('A name cannot be empty.', 'error'); try { await api('PATCH', (type === 'room' ? '/rooms/' : '/connectors/') + id, { name: input.value }); SOV.closeModal(); } catch (_) {} };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  SOV.modal(h('div', { class: 'stack' }, h('h2', {}, 'Rename ' + type), input, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: go }, 'Rename'), h('button', { class: 'btn', onclick: SOV.closeModal }, 'Cancel'))));
  input.select();
};

SOV.openConnectorPicker = (tile) => {
  const S = SOV.S; let kind = 'stripe'; const name = h('input', { type: 'text', value: S.connectorKinds.stripe.label, maxlength: '32' });
  const sel = h('select', { onchange: (e) => { kind = e.target.value; name.value = S.connectorKinds[kind].label; info.textContent = S.connectorKinds[kind].blurb; } },
    Object.entries(S.connectorKinds).sort((a, b) => b[1].live - a[1].live).map(([k, v]) => h('option', { value: k }, v.label + (v.live ? '' : ' (placeholder)'))));
  const info = h('p', { class: 'muted', style: 'margin:0' }, S.connectorKinds.stripe.blurb);
  SOV.modal(h('div', { class: 'stack' }, h('h2', {}, 'Add a connector'), SOV.field('Service', sel), SOV.field('Name', name), info,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { try { const r = await api('POST', '/connectors', { kind, name: name.value, x: tile.x, y: tile.y }); SOV.closeModal(); SOV.select({ type: 'connector', id: r.connector.id }); } catch (_) {} } }, 'Add connector'), h('button', { class: 'btn', onclick: SOV.closeModal }, 'Cancel'))));
};
})();
