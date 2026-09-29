'use strict';
// The business SOP: the plan (goal, constraints, capital ladder, team, milestones, procedures) written up as a document
// the moment the team is deployed. It is built from the roadmap in code, so it is instant, free and cannot drift from the
// plan. It lands in the Outbox at once, and a route is sent to the UI so the document visibly travels the rooms first.
const { money } = require('./util');
const { ROLES } = require('./roles');
const jobs = require('./jobs');
const strategy = require('./strategy');
const memory = require('./memory');
const station = require('./station');

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const label = (world, ref) => ref === 'inbox' ? 'Inbox' : ref === 'outbox' ? 'Outbox' : ref.startsWith('room:') ? (world.rooms[ref.slice(5)] || {}).name : (world.connectors[ref.slice(10)] || {}).name;

// Inbox to Outbox through as many rooms as the hallways allow, starting from the Director's Bridge. Connectors are ports, not stops.
function route(world) {
  const out = (ref) => Object.values(world.hallways).filter((h) => h.from === ref).map((h) => h.to);
  let best = null, steps = 0;
  const dfs = (ref, path) => {
    if (steps++ > 4000 || path.length > 18) return;
    if (ref === 'outbox') { if (!best || path.length > best.length) best = path.slice(); return; }
    for (const n of out(ref)) if (!path.includes(n)) { path.push(n); dfs(n, path); path.pop(); }
  };
  dfs('inbox', ['inbox']);
  let stops = (best || ['inbox', 'outbox']).filter((r) => !r.startsWith('connector:'));
  if (!best) { // no unbroken lane: walk what exists from the Inbox, then drop into the Outbox
    const walk = ['inbox']; let cur = 'inbox';
    for (let i = 0; i < 12; i++) { const nx = out(cur).find((n) => !walk.includes(n) && !n.startsWith('connector:')); if (!nx) break; walk.push(nx); cur = nx; }
    stops = [...walk, 'outbox'];
  }
  const bridge = Object.values(world.rooms).find((r) => r.kind === 'bridge');
  if (bridge) stops.unshift('room:' + bridge.id);
  return stops.filter((r) => r === 'inbox' || r === 'outbox' || world.rooms[r.slice(5)]).map((ref) => ({ ref, name: label(world, ref) }));
}

function build(world, version) {
  const m = world.mission, rm = world.roadmap, S = strategy.view(world), p = m ? m.targetCents : 0;
  const crew = Object.values(world.agents).filter((a) => a.role !== 'director');
  const roomOf = (a) => { const d = a.deskId && world.desks[a.deskId]; return d && world.rooms[d.roomId] ? world.rooms[d.roomId].name : 'no desk'; };
  const L = [];
  L.push(`# Business SOP: ${m ? m.name : 'Untitled'}`, '', `Version ${version} · issued by the Director · ${new Date().toISOString().slice(0, 10)}`, '',
    'This is the operating procedure for the team. Every agent works from it; you can hold the team to it.', '');
  L.push('## 1. Mission and limits', `- Goal: ${m ? m.name : ''}`, `- Verified profit target: ${money(p)}${m && m.deadline ? ` by ${m.deadline}` : ''}`,
    `- Starting capital: ${money(m ? m.capitalCents : 0)}${m && m.capitalCents ? '' : ' (everything must cost $0)'}`, `- Loss limit: ${money(m ? m.riskCents : 0)}`);
  if (m && m.notes) L.push(`- Owner rules: ${m.notes}`);
  L.push('- Only revenue confirmed by a connected payment source counts. Anything an agent merely claims is ignored.', '- Nothing is sent, posted or spent without your approval.', '');
  if (S) {
    L.push('## 2. Strategy: the capital ladder', S.rule, '');
    S.stages.forEach((st, i) => L.push(`${i + 1}. **${st.title}** ${st.status === 'active' ? '(current)' : ''}`, `   - ${st.thesis}`, `   - Move up when verified net profit reaches ${money(st.targetCents)}.`,
      `   - Budget: ${st.budgetNowCents != null ? money(st.budgetNowCents) : 'set when the stage starts, from verified profit'}.`));
    L.push('');
  }
  L.push('## 3. Team and ownership', '| Agent | Role | Room | Owns |', '|---|---|---|---|');
  for (const a of crew) L.push(`| ${a.name} | ${(ROLES[a.role] || {}).label || a.role} | ${roomOf(a)} | ${clip(jobs.spec(a.role).summary, 90)} |`);
  L.push('', '## 4. How work moves', route(world).map((s) => s.name).join(' → '),
    'Work fans out: agents whose tasks do not depend on each other run at the same time. Reviews, builds and reports wait for the work they depend on. Shared team memory keeps every agent on the same decisions.', '');
  if (rm) {
    L.push('## 5. Milestones and procedures');
    rm.milestones.forEach((ms, i) => {
      L.push('', `### M${i + 1}. ${ms.title} (about ${ms.days} days)`, ms.why ? `Why: ${ms.why}` : '');
      ms.tasks.forEach((t, j) => {
        const who = t.owner === 'human' ? 'YOU' : `${((crew.find((a) => a.role === t.role) || {}).name) || (ROLES[t.role] || {}).label} (${(ROLES[t.role] || {}).label})`;
        const spec = jobs.spec(t.role), done = t.owner === 'human' ? (t.instructions || 'you confirm it is done') : (spec.deliver[0] || 'a clear result');
        const needs = [...t.requires.map((k) => `${(station.CONNECTOR_KINDS[k] || {}).label || k} connected`)];
        L.push(`${j + 1}. **${t.title}**`, `   - Owner: ${who}`, `   - Done when: ${clip(done, 140)}`, ...(needs.length ? [`   - Needs: ${needs.join(', ')}`] : []),
          ...(t.owner === 'human' ? [] : [`   - Standard: ${clip(spec.quality[0] || '', 120)}`]));
      });
    });
    L.push('');
    L.push('## 6. Integrations and approvals');
    if (rm.requirements.length) rm.requirements.forEach((r) => L.push(`- ${(station.CONNECTOR_KINDS[r.kind] || {}).label || r.kind}: ${r.blocking ? 'needed' : 'recommended'}. ${clip(r.why, 100)}`));
    else L.push('- None. This plan needs only the model.');
    L.push('- Emails, posts, ad spend and file writes each wait for your approval unless you turned that off in Settings.', '');
  }
  L.push('## 7. Review rhythm and KPIs', '- The Director reviews progress after every milestone and updates the team memory.', '- KPIs: verified revenue, verified costs, net profit against the stage target, cost per acquisition, conversion.', '');
  L.push('## 8. Kill and scale rules',
    '- Every venture has a loss limit. Reaching it stops the venture automatically; no agent gets a vote.',
    '- Nothing scales until verified profit shows it works. Reinvest only from verified profit, in small steps.',
    '- The Critic reviews plans before money is spent; a REJECT or REVISE verdict is recorded in the team memory.', '');
  L.push('## 9. When the team comes to you', '- A step only you can do (marked YOU above).', '- A missing connection or key.', '- An approval for anything outbound.', '- A task that failed twice.');
  return L.filter((x) => x !== undefined).join('\n');
}

// File the SOP in the Outbox now and tell the UI to fly it through the rooms.
function issue(store, { announce = true } = {}) {
  const runner = require('./runner'); // lazy: runner does not depend on this module, but keep load order simple
  const w = store.state; w.sopVersion = (w.sopVersion || 0) + 1;
  const content = build(w, w.sopVersion), r = route(w);
  const o = runner.addOutbox(store, { kind: 'sop', title: `Business SOP v${w.sopVersion}: ${clip(w.mission ? w.mission.name : 'plan', 70)}`, content, fromRoom: 'Director', meta: { sop: true, version: w.sopVersion } });
  w.lastSop = { outboxId: o.id, version: w.sopVersion };
  if (announce) store.emit('sop.route', { route: r, title: o.title, outboxId: o.id });
  store.change('state');
  return { outboxId: o.id, route: r, version: w.sopVersion };
}
const replay = (store) => { const w = store.state; store.emit('sop.route', { route: route(w), title: 'Business SOP', outboxId: w.lastSop && w.lastSop.outboxId }); };

module.exports = { build, route, issue, replay };
