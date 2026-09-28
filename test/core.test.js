'use strict';
process.env.SOVEREIGN_NO_PERSIST = '1';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { Store } = require('../sidecar/lib/store');
const station = require('../sidecar/lib/station');
const agents = require('../sidecar/lib/agents');
const director = require('../sidecar/lib/director');
const ledger = require('../sidecar/lib/ledger');
const guardrails = require('../sidecar/lib/guardrails');
const secrets = require('../sidecar/lib/secrets');
const runner = require('../sidecar/lib/runner');

const fresh = () => { const s = new Store({ persist: false }); director.ensureDirector(s); return s; };

test('first agent is the Director, seated on the Bridge with station.edit', () => {
  const s = fresh();
  const d = director.getDirector(s.state);
  assert.ok(d.locked && d.avatar.headwear === 'crown');
  assert.ok(station.effectiveCaps(s.state, d).includes('station.edit'));
  assert.throws(() => agents.deleteAgent(s.state, d.id), /cannot be removed/);
  assert.throws(() => agents.createAgent(s.state, { name: 'Two', role: 'director' }), /only one Director/);
});

test('director-only capabilities never leak to crew, even from a Bridge desk', () => {
  const s = fresh();
  const bridge = Object.values(s.state.rooms)[0];
  const desk = station.createDesk(s.state, { roomId: bridge.id });
  const a = agents.createAgent(s.state, { name: 'Sneak', role: 'custom', deskId: desk.id });
  assert.ok(!station.effectiveCaps(s.state, a).includes('station.edit'));
});

test('room ceiling caps desk grants; shrinking a room trims desks', () => {
  const s = fresh();
  const room = station.createRoom(s.state, { name: 'Lab', kind: 'lab', x: 2, y: 10, w: 8, h: 5 });
  const desk = station.createDesk(s.state, { roomId: room.id });
  assert.ok(desk.grants.includes('web.search'));
  station.updateRoom(s.state, room.id, { capabilities: ['fs.workspace'] });
  assert.deepStrictEqual(s.state.desks[desk.id].grants, ['fs.workspace']);
});

test('rooms cannot overlap and hallways validate their ends', () => {
  const s = fresh();
  const a = station.createRoom(s.state, { kind: 'lab', x: 2, y: 10, w: 6, h: 4 });
  assert.throws(() => station.createRoom(s.state, { kind: 'lab', x: 4, y: 11, w: 6, h: 4 }), /overlaps/);
  const b = station.createRoom(s.state, { kind: 'workshop', x: 12, y: 10, w: 6, h: 4 });
  station.createHallway(s.state, { from: 'room:' + a.id, to: 'room:' + b.id });
  assert.throws(() => station.createHallway(s.state, { from: 'room:' + a.id, to: 'room:' + b.id }), /already exists/);
  assert.throws(() => station.createHallway(s.state, { from: 'outbox', to: 'room:' + a.id }), /Inbox toward the Outbox/);
});

test('only verified sources count toward profit; agent claims never do', () => {
  const s = fresh();
  const v = 'vent_x'; s.state.ventures[v] = { id: v, name: 'V', status: 'testing', maxLossCents: 1000, budgetCents: 1000 };
  ledger.claim(s, { ventureId: v, type: 'revenue', amountCents: 999999, source: 'stripe' }); // forged source is overridden
  ledger.add(s, { ventureId: v, type: 'revenue', amountCents: 5000, source: 'stripe', ref: 'ch_1' });
  const p = ledger.pnl(s.state, v);
  assert.strictEqual(p.revenue, 5000); assert.strictEqual(p.claimedRevenue, 999999);
});

test('signed ingest works, is idempotent, rejects bad signatures, and kill rule fires', () => {
  const s = fresh(); const secret = secrets.rotateIngestSecret();
  const v = 'vent_y'; s.state.ventures[v] = { id: v, name: 'V', status: 'testing', maxLossCents: 500, budgetCents: 500 };
  const body = JSON.stringify({ ventureId: v, type: 'cost', amountCents: 600, ref: 'ad_1' });
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.throws(() => ledger.ingest(s, 'stripe', body, 'nope'), /Bad signature/);
  assert.ok(ledger.ingest(s, 'ads.meta', body, sig));
  assert.strictEqual(ledger.ingest(s, 'ads.meta', body, sig), null); // replay ignored
  assert.strictEqual(s.state.ventures[v].status, 'killed');
});

test('Director plan: dry-run, approval gate, atomic apply, then pipeline runs to the Outbox', async () => {
  const s = fresh();
  s.state.mission = { name: 'Test', targetCents: 100000, capitalCents: 50000, riskCents: 10000 };
  const r = await director.handleMessage(s, 'Propose the crew.');
  assert.ok(r.approvalId && !r.applied);
  assert.strictEqual(Object.keys(s.state.agents).length, 1); // nothing applied before approval
  await guardrails.resolveApproval(s, r.approvalId, true);
  assert.strictEqual(Object.keys(s.state.agents).length, 8); // Director + 7 agents
  assert.strictEqual(Object.keys(s.state.connectors).length, 3);
  assert.strictEqual(Object.keys(s.state.ventures).length, 1);
  // Every agent has their own desk, and no two agents share one.
  const desks = Object.values(s.state.agents).map((a) => a.deskId);
  assert.ok(desks.every(Boolean)); assert.strictEqual(new Set(desks).size, desks.length);
  await runner.dispatch(s, { start: 'inbox', task: 'Find a niche' });
  assert.ok(s.state.outbox.some((o) => o.kind === 'deliverable' || o.kind === 'note'));
  // The email connector is not set up yet, so the pipeline stops with a clear note instead of sending anything.
  assert.ok(s.state.outbox.some((o) => o.status === 'blocked' && /not set up/.test(o.title)));
});

test('a plan that cannot apply rolls back fully', () => {
  const s = fresh();
  const before = JSON.stringify(s.state);
  const bad = [{ type: 'create_room', name: 'A', kind: 'lab', w: 6, h: 4 }, { type: 'create_hallway', from: 'room:ghost', to: 'outbox' }];
  assert.throws(() => director.applyPlan(s, bad), /must exist/);
  assert.strictEqual(JSON.stringify(s.state), before);
});

test('budgets stop runs in code', async () => {
  const s = fresh();
  s.state.settings.budgets.perAgentDailyCents = 5;
  const d = director.getDirector(s.state);
  guardrails.recordSpend(s, { agentId: d.id, cents: 5 });
  await assert.rejects(runner.runAgent(s, d.id, 'hi'), /daily budget/);
});

test('every new agent gets their own desk; rooms grow, then new rooms open; auto desks leave with the agent', () => {
  const s = fresh();
  const made = [];
  for (let i = 0; i < 7; i++) made.push(agents.createAgent(s.state, { name: 'W' + i, role: 'copywriter' }));
  const desks = made.map((a) => a.deskId);
  assert.ok(desks.every((d) => d && s.state.desks[d])); assert.strictEqual(new Set(desks).size, 7);
  const studios = Object.values(s.state.rooms).filter((r) => r.kind === 'studio');
  assert.ok(studios.length >= 1);
  const before = Object.keys(s.state.desks).length;
  agents.deleteAgent(s.state, made[0].id);
  assert.strictEqual(Object.keys(s.state.desks).length, before - 1);
});

test('role ceilings hold: a Lead Generator in an outreach room still cannot send email', () => {
  const s = fresh();
  const a = agents.createAgent(s.state, { name: 'Lee', role: 'lead_generator' });
  const room = s.state.rooms[s.state.desks[a.deskId].roomId];
  assert.ok(room.capabilities.includes('email.send'));
  const caps = station.effectiveCaps(s.state, a);
  assert.ok(caps.includes('email.draft') && !caps.includes('email.send'));
});

test('avatars are validated, the Director keeps the crown, and v0.1 avatars are upgraded', () => {
  const s = fresh();
  const a = agents.createAgent(s.state, { name: 'Ava', role: 'researcher', avatar: { outfit: 'nope', hair: 'wild', skin: 'red', headwear: 'crown' } });
  assert.strictEqual(a.avatar.outfit, 'labcoat'); // invalid value falls back to the role preset
  assert.strictEqual(a.avatar.hair, 'wild');
  assert.notStrictEqual(a.avatar.headwear, 'crown'); // only the Director wears it
  assert.strictEqual(director.getDirector(s.state).avatar.headwear, 'crown');
  a.avatar = { skin: '#fff', hair: '#000000', hairStyle: 2, outfit: '#123456', accessory: 'headset' }; // v0.1 shape
  assert.ok(agents.migrate(s.state));
  assert.ok(typeof a.avatar.outfitColor === 'string' && a.avatar.outfit);
});

test('rooms can be renamed and resized, and a desk cannot be cut off', () => {
  const s = fresh();
  const room = station.createRoom(s.state, { kind: 'lab', x: 2, y: 12, w: 9, h: 5 });
  station.updateRoom(s.state, room.id, { name: '  War room  ' });
  assert.strictEqual(s.state.rooms[room.id].name, 'War room');
  assert.throws(() => station.updateRoom(s.state, room.id, { name: '   ' }), /needs a name/);
  const desk = station.createDesk(s.state, { roomId: room.id, x: 8, y: 14 });
  assert.throws(() => station.updateRoom(s.state, room.id, { w: 5, h: 4 }), /cut off a desk|Shrinking/);
  station.updateRoom(s.state, room.id, { w: 12 });
  assert.strictEqual(s.state.rooms[room.id].w, 12);
  assert.ok(s.state.desks[desk.id]);
});
