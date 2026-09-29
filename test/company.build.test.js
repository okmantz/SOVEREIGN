'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path');
const { mk } = require('./company.helpers');
const vid = (co) => { const id = co.ventures.create({ name: 'Build', capital_allocated: 100 }).venture_id; co.cfo.fund(id, 100); return id; };

test('sandbox: path jail, credentials write-only, command allow-list, arg escape blocked', async () => {
  const { co } = mk(); const id = vid(co);
  co.sandbox.writeFile(id, 'source/a.js', 'console.log("hi")');
  assert.throws(() => co.sandbox.writeFile(id, '../evil.txt', 'x')); assert.throws(() => co.sandbox.writeFile(id, 'source/../../evil.txt', 'x'));
  assert.throws(() => co.sandbox.writeFile(id, '/etc/passwd', 'x')); assert.throws(() => co.sandbox.writeFile(id, 'other/x', 'x'));
  co.sandbox.writeFile(id, 'credentials/token', 'secret'); assert.throws(() => co.sandbox.readFile(id, 'credentials/token')); assert.deepEqual(co.sandbox.list(id, 'credentials'), []);
  await assert.rejects(co.sandbox.run(id, 'rm', ['-rf', '/']), /not allowed/); await assert.rejects(co.sandbox.run(id, 'node', ['../../../etc/passwd']), /escapes/);
  const r = await co.sandbox.run(id, 'node', ['a.js']); assert.equal(r.ok, true); assert.match(r.stdout, /hi/); assert.ok(r.warnings.length);
  fs.symlinkSync('/tmp', path.join(co.sandbox.dir(id, 'source'), 'link')); assert.throws(() => co.sandbox.writeFile(id, 'source/link/x.txt', 'x'), /symlink/);
});
test('sandbox: timeout kills runaway process; network refused unless allowed', async () => {
  const { co } = mk(); const id = vid(co);
  co.sandbox.writeFile(id, 'source/loop.js', 'setInterval(()=>{},1000)');
  const r = await co.sandbox.run(id, 'node', ['loop.js'], { timeout_ms: 400 }); assert.equal(r.timed_out, true); assert.equal(r.ok, false);
  await assert.rejects(co.sandbox.run(id, 'npm', ['install'], { network: true }), /network is disabled/);
});
test('assets: landing page escapes HTML and scaffold tests really pass in the sandbox', async () => {
  const { co } = mk(); const id = vid(co);
  const html = co.assets.landingPage({ name: '<b>X</b>', copy: { headline: '<script>alert(1)</script>', sub: 's', bullets: ['a'], cta: 'Go' } });
  assert.ok(!html.includes('<script>alert(1)</script>')); assert.match(co.assets.svgImage({ name: 'Acme Co' }), /^<svg/);
  const r = await co.tools.invoke('app.scaffold', { kind: 'saas-starter', options: { name: 'Acme', tagline: 't', slug: 'acme' } }, { agent_id: 'dev', venture_id: id });
  assert.equal(r.status, 'done'); const t = await co.sandbox.run(id, 'node', ['--test'], { cwd: 'tests' }); assert.equal(t.ok, true, t.stdout + t.stderr);
});
test('build loop: feeds real test failures back to the model until green', async () => {
  let call = 0;
  const llm = async (p) => { call++; return call === 1
    ? JSON.stringify({ files: [{ path: 'source/add.js', content: 'module.exports=(a,b)=>a-b' }, { path: 'tests/add.test.js', content: "const t=require('node:test');const a=require('node:assert');t('add',()=>a.equal(require('../source/add')(2,3),5))" }] })
    : (assert.match(p, /FAILED/), '```json\n' + JSON.stringify({ files: [{ path: 'source/add.js', content: 'module.exports=(a,b)=>a+b' }] }) + '\n```'); };
  const { co } = mk({ llm }); const id = vid(co);
  const r = await co.builder.buildLoop({ venture_id: id, spec: 'add', maxIterations: 3 }); assert.equal(r.ok, true); assert.equal(r.iterations, 2);
});
test('build loop: rejects path-escaping files from the model', async () => {
  const llm = async () => JSON.stringify({ files: [{ path: 'source/../../pwned.js', content: 'x' }, { path: 'tests/t.test.js', content: "require('node:test')('ok',()=>{})" }] });
  const { co, dir } = mk({ llm }); const id = vid(co); const r = await co.builder.buildLoop({ venture_id: id, spec: 's', maxIterations: 1 });
  assert.ok(r.log[0].skipped); assert.equal(fs.existsSync(path.join(dir, 'pwned.js')), false);
});
test('deploy: ship (scaffold → tests → local deploy → verify → monitor) and outage alert', async () => {
  const { co } = mk(); const id = vid(co);
  const http = require('node:http'); const routes = require('../sidecar/lib/company/routes');
  const srv = http.createServer(async (req, res) => { if (!(await routes.handle(co, req, res))) { res.writeHead(404); res.end(); } }); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  co.setSettings({ port: srv.address().port });
  const r = await co.deploy.ship({ venture_id: id, scaffold: { kind: 'static-site', options: { name: 'Hello', copy: { headline: 'Hello World', sub: 's', bullets: ['x'], cta: 'Go' } } }, target: 'local', expect: 'Hello World', retries: 2 });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(co.ventures.get(id).deployed_url, r.url);
  assert.equal((await co.deploy.checkMonitors())[0].ok, true);
  fs.rmSync(path.join(co.dataDir, 'sites', id), { recursive: true }); const down = await co.deploy.checkMonitors(); assert.equal(down[0].ok, false);
  assert.ok(co.db.get('events', []).some((e) => e.type === 'deploy.down')); assert.ok(co.directives.list({ status: 'open' }).some((d) => d.role === 'DevOps'));
  srv.close();
});
test('deploy: production deploy through the registry waits for approval by default', async () => {
  const { co } = mk(); const id = vid(co);
  const r = await co.tools.invoke('deploy.ship', { target: 'local' }, { agent_id: 'dev', venture_id: id }); assert.equal(r.status, 'pending_approval');
});
