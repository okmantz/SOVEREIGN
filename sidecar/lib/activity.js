'use strict';
// Who is doing what right now, per world. Ephemeral on purpose: after a restart nobody is mid-task.
// Every model call an agent makes goes through track(), so the UI can show live work, not just "busy".
const roots = new WeakMap(); // root store -> Map(worldId -> Map(agentId -> info))
const rootOf = (s) => s.root || s;
const idOf = (s) => s.id || s.defaultId;
function bucket(store, create) {
  const root = rootOf(store); let m = roots.get(root);
  if (!m) { if (!create) return null; roots.set(root, m = new Map()); }
  const wid = idOf(store); let b = m.get(wid);
  if (!b && create) m.set(wid, b = new Map());
  return b || null;
}
function begin(store, agentId, title) {
  const b = bucket(store, true), cur = b.get(agentId);
  b.set(agentId, { agentId, title: String(title || 'Working').slice(0, 90), since: cur ? cur.since : Date.now(), count: (cur ? cur.count : 0) + 1 });
  store.emit('run.start', { agentId, title: String(title || 'Working').slice(0, 90) });
}
function end(store, agentId) {
  const b = bucket(store, false), cur = b && b.get(agentId); if (!cur) return;
  if (--cur.count <= 0) { b.delete(agentId); store.emit('run.done', { agentId }); }
}
// Wrap any piece of agent work so the start, the finish and failures are always reported.
async function track(store, agentId, title, fn) {
  begin(store, agentId, title);
  try { return await fn(); } finally { end(store, agentId); }
}
function list(store) {
  const b = bucket(store, false), agents = (store.state && store.state.agents) || {};
  return b ? [...b.values()].filter((x) => agents[x.agentId]).map((x) => ({ agentId: x.agentId, title: x.title, since: x.since })) : [];
}
const busyIds = (store) => new Set(list(store).map((x) => x.agentId));
module.exports = { begin, end, track, list, busyIds };
