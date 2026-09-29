'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { mk } = require('./company.helpers');

function venture(co, capital = 1000) { const id = co.ventures.create({ name: 'P', capital_allocated: capital }).venture_id; co.cfo.fund(id, capital); return id; }

test('default autonomy is approval_only: level 2 always needs a human', () => {
  const { co } = mk(); const id = venture(co); co.permissions.grant('a1', 3);
  assert.equal(co.permissions.authorize({ agent_id: 'a1', venture_id: id, level: 2 }).decision, 'approve');
});
test('permissioned mode: trust tiers gate level 2/3, caps enforced, level 4 never automatic', () => {
  const { co } = mk({ settings: { autonomy: 'permissioned' } }); const id = venture(co);
  const A = (agent, level, cost = 0, extra = {}) => co.permissions.authorize({ agent_id: agent, venture_id: id, level, cost, ...extra });
  assert.equal(A('new', 0).decision, 'allow'); assert.equal(A('new', 1).decision, 'draft'); assert.equal(A('new', 2).decision, 'approve');
  for (let i = 0; i < 10; i++) co.permissions.recordOutcome('vet', true);
  assert.equal(co.permissions.tier('vet'), 2); assert.equal(A('vet', 2).decision, 'allow'); assert.equal(A('vet', 3, 10).decision, 'approve');
  for (let i = 0; i < 15; i++) co.permissions.recordOutcome('vet', true);
  assert.equal(co.permissions.tier('vet'), 3); assert.equal(A('vet', 3, 10).decision, 'allow'); assert.equal(A('vet', 3, 50).decision, 'approve');   // > $20/action
  for (let i = 0; i < 4; i++) { co.permissions.commitSpend('vet', id, 20); } assert.equal(A('vet', 3, 20).decision, 'allow');
  co.permissions.commitSpend('vet', id, 20); assert.equal(A('vet', 3, 20).decision, 'deny');                                                        // $100/day hit
  assert.equal(A('vet', 4).decision, 'approve'); assert.equal(A('vet', 2, 0, { irreversible: true }).decision, 'approve');
  co.permissions.demote('vet'); assert.ok(co.permissions.tier('vet') < 3);
});
test('dead ventures cannot be worked, even by trusted agents', () => {
  const { co } = mk({ settings: { autonomy: 'permissioned' } }); const id = venture(co); co.permissions.grant('a', 3); co.ceo.killVenture(id, 'x');
  assert.equal(co.permissions.authorize({ agent_id: 'a', venture_id: id, level: 2 }).decision, 'deny');
});
test('tool registry: schema, CFO gate, approval queue, approved execution', async () => {
  const { co } = mk({ settings: { allow_paid: true } }); const id = venture(co, 100); let ran = 0;
  co.tools.register({ name: 't.spend', description: 'x', required_permission: 3, cost: 10, spend_category: 'marketing', input_schema: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } }, handler: async () => { ran++; return 'ok'; } });
  assert.equal((await co.tools.invoke('t.spend', {}, { agent_id: 'a', venture_id: id })).status, 'error');
  const r = await co.tools.invoke('t.spend', { q: 'x' }, { agent_id: 'a', venture_id: id }); assert.equal(r.status, 'pending_approval'); assert.equal(ran, 0);
  const done = await co.resolveApproval(r.approval_id, true); assert.equal(done.outcome.status, 'done'); assert.equal(ran, 1);
  assert.equal(co.ledger.summary({ venture_id: id }).acquisition_costs, 10);
  const big = await co.tools.invoke('t.spend', { q: 'x' }, { agent_id: 'a', venture_id: id, approved: true, overrides: { cost: 500 } }); assert.equal(big.status, 'denied');   // CFO vetoes even approved spend
});
test('MCP: stdio server tools appear in registry and pass through the gates', async () => {
  const { co, dir } = mk(); const id = venture(co);
  const srv = path.join(dir, 'fake-mcp.js');
  fs.writeFileSync(srv, `const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',l=>{const m=JSON.parse(l);const send=r=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,...r}));
if(m.method==='initialize')send({result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}});
else if(m.method==='tools/list')send({result:{tools:[{name:'lookup',description:'read',inputSchema:{type:'object',required:['q'],properties:{q:{type:'string'}}},annotations:{readOnlyHint:true}},{name:'wipe',description:'danger',inputSchema:{type:'object'},annotations:{destructiveHint:true}}]}});
else if(m.method==='tools/call')send({result:{content:[{type:'text',text:'result:'+(m.params.arguments.q||'')}]}});});`);
  const names = await co.tools.connectMcp({ name: 'fake', command: process.execPath, args: [srv] });
  assert.deepEqual(names.sort(), ['mcp.fake.lookup', 'mcp.fake.wipe']);
  const r = await co.tools.invoke('mcp.fake.lookup', { q: 'hi' }, { agent_id: 'a', venture_id: id }); assert.equal(r.result, 'result:hi');
  assert.equal((await co.tools.invoke('mcp.fake.wipe', {}, { agent_id: 'a', venture_id: id })).status, 'pending_approval');
  co.tools.closeAll();
});
