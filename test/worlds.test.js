'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { fresh, until } = require('./helpers');
const worlds = require('../sidecar/lib/worlds');
const director = require('../sidecar/lib/director');
const guardrails = require('../sidecar/lib/guardrails');

test('saved data lives inside the project folder so a reinstall starts fresh, and the folder ignores itself in git', () => {
  const repo = path.join(__dirname, '..');
  const code = `const s=require(${JSON.stringify(path.join(repo, 'sidecar/lib/store'))}); console.log(require('path').relative(${JSON.stringify(repo)}, s.HOME))`;
  const env = { ...process.env }; delete env.SOVEREIGN_HOME;
  assert.strictEqual(execFileSync(process.execPath, ['-e', code], { env }).toString().trim(), 'data');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-'));
  execFileSync(process.execPath, ['-e', `const s=require(${JSON.stringify(path.join(repo, 'sidecar/lib/store'))}); s.ensureHome();`], { env: { ...process.env, SOVEREIGN_HOME: tmp } });
  assert.match(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8'), /^\*$/m);
});

test('a v0.2 single-station save file becomes the Main world with nothing lost', () => {
  const repo = path.join(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-'));
  fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ version: 1, mission: { name: 'Old goal', targetCents: 100 }, settings: { provider: { name: 'ollama', model: 'x' }, policy: {} }, agents: { a1: { id: 'a1', name: 'Old', role: 'researcher' } }, rooms: {}, desks: {}, hallways: {}, connectors: {}, ventures: {}, ledger: [], spend: [], approvals: [], outbox: [], transcripts: {} }));
  const out = execFileSync(process.execPath, ['-e', `const {Store}=require(${JSON.stringify(path.join(repo, 'sidecar/lib/store'))}); const s=new Store(); const w=s.state; console.log(JSON.stringify([w.name,w.mission.name,Object.keys(w.agents),s.data.settings.provider.name,w.journey.stage,s.data.settings.concurrency.ollama]))`], { env: { ...process.env, SOVEREIGN_HOME: tmp, SOVEREIGN_NO_PERSIST: '' } }).toString();
  assert.deepStrictEqual(JSON.parse(out), ['Main', 'Old goal', ['a1'], 'ollama', 'goal', 2]);
});

test('each world has its own Director, Bridge and state, and shares only settings', () => {
  const { root } = fresh();
  const id = worlds.create(root, { name: 'Trading', kind: 'trading' });
  const a = root.world(root.defaultId), b = root.world(id);
  assert.strictEqual(Object.values(b.agents).filter((x) => x.role === 'director').length, 1);
  assert.strictEqual(Object.values(b.rooms).length, 1);
  assert.notStrictEqual(Object.keys(a.agents)[0], Object.keys(b.agents)[0]);
  assert.match(b.focus, /paper trade/i);
  b.settings.budgets.globalDailyCents = 777; assert.strictEqual(a.settings.budgets.globalDailyCents, 777); // shared
  assert.ok(!JSON.stringify(b).includes('777'), 'settings are stored once at the root, not copied into each world');
});

test('connecting worlds opens a portal in each; work delivered through one lands in the other', async () => {
  const { root, view } = fresh(); const id = worlds.create(root, { name: 'Trading', kind: 'trading' });
  worlds.connect(root, root.defaultId, id);
  const [pa, pb] = [worlds.portalTo(root.world(root.defaultId), id), worlds.portalTo(root.world(id), root.defaultId)];
  assert.ok(pa && pb && pa.status === 'ready'); assert.ok(worlds.isLinked(root, root.defaultId, id));
  const r = worlds.deliver(view, id, 'Please research momentum strategies');
  assert.strictEqual(r.mode, 'director'); // the target Inbox is not wired, so its Director gets the message
  const dir = director.getDirector(root.world(id));
  await until(() => (root.world(id).transcripts[dir.id] || []).some((m) => /From world "Main": Please research momentum/.test(m.content)));
  worlds.connect(root, root.defaultId, id); // idempotent
  assert.strictEqual(Object.values(root.world(id).connectors).filter((c) => c.kind === 'portal').length, 1);
});

test('the Director can only message worlds that are linked, and can do it without approval', async () => {
  const { root, view } = fresh(); const id = worlds.create(root, { name: 'Trading', kind: 'trading' });
  assert.throws(() => director.propose(view, [{ type: 'message_world', world: 'Trading', text: 'hi' }]), /Connect this world to "Trading" first/);
  worlds.connect(root, root.defaultId, id);
  const r = director.propose(view, [{ type: 'message_world', world: 'Trading', text: 'status?' }]);
  assert.strictEqual(r.applied, true);
  const dir = director.getDirector(root.world(id));
  await until(() => (root.world(id).transcripts[dir.id] || []).some((m) => /status\?/.test(m.content)));
});

test('removing a world closes portals that pointed at it, and the last world cannot be removed', () => {
  const { root } = fresh(); const id = worlds.create(root, { name: 'Shop' });
  worlds.connect(root, root.defaultId, id);
  worlds.remove(root, id);
  assert.strictEqual(Object.values(root.world(root.defaultId).connectors).filter((c) => c.kind === 'portal').length, 0);
  assert.throws(() => worlds.remove(root, root.defaultId), /at least one world/);
});

test('the daily station budget spans every world', () => {
  const { root, view } = fresh(); const id = worlds.create(root, { name: 'Other' });
  root.data.settings.budgets.globalDailyCents = 10;
  const other = root.forWorld(id), od = director.getDirector(other.state);
  guardrails.recordSpend(other, { agentId: od.id, cents: 10 });
  assert.throws(() => guardrails.assertBudget(view.state), /Daily station budget reached/);
});
