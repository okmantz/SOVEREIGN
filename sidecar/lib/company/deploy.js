'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { round } = require('./util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP = new Set(['node_modules', '.git', '.DS_Store']);
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name); e.isDirectory() ? walk(p, base, out) : out.push(p);
  }
  return out;
}
function hostRun(cmd, args, { cwd, env, timeout = 300000 }) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    c.on('error', (e) => resolve({ ok: false, code: -1, out, err: e.message }));
    const t = setTimeout(() => c.kill('SIGKILL'), timeout);
    c.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, code, out, err }); });
  });
}

/** CLI deployers: run the provider's own CLI host-side with only its token in the environment. */
const CLI = {
  cloudflare: { cmd: 'npx', args: (o) => ['--yes', 'wrangler', 'pages', 'deploy', o.dir, '--project-name', o.name], env: { CLOUDFLARE_API_TOKEN: 'cloudflare_token', CLOUDFLARE_ACCOUNT_ID: 'cloudflare_account' } },
  netlify: { cmd: 'npx', args: (o) => ['--yes', 'netlify-cli', 'deploy', '--prod', '--dir', o.dir], env: { NETLIFY_AUTH_TOKEN: 'netlify_token', NETLIFY_SITE_ID: 'netlify_site' } },
  fly: { cmd: 'flyctl', args: () => ['deploy', '--remote-only'], env: { FLY_API_TOKEN: 'fly_token' } },
  railway: { cmd: 'railway', args: () => ['up', '--detach'], env: { RAILWAY_TOKEN: 'railway_token' } },
};

function makeDeploy(ctx) {
  const monitors = () => ctx.db.get('monitors', {});

  const deployers = {
    /** Zero-credential: copies static output into data/sites/<venture>/ and serves it from the sidecar. */
    async local(o) {
      const src = ctx.sandbox.dir(o.venture_id, o.dir || 'source'); const dest = path.join(ctx.dataDir, 'sites', o.venture_id);
      fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
      let n = 0; for (const f of walk(src)) { const rel = path.relative(src, f); fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true }); fs.copyFileSync(f, path.join(dest, rel)); n++; }
      if (!fs.existsSync(path.join(dest, 'index.html'))) throw new Error('local deploy needs an index.html');
      return { url: `http://127.0.0.1:${ctx.settings().port}/venture/${o.venture_id}/`, files: n, target: 'local' };
    },
    /** Zero-credential, zero-cost: a ready-to-drop ZIP of the site. Drag it onto Netlify Drop, Cloudflare Pages (direct upload) or GitHub Pages. */
    async bundle(o) {
      const src = ctx.sandbox.dir(o.venture_id, o.dir || 'source'); const files = walk(src).map((f) => ({ name: path.relative(src, f).split(path.sep).join('/'), data: fs.readFileSync(f) }));
      if (!files.some((f) => f.name === 'index.html')) throw new Error('export needs an index.html');
      const out = path.join(ctx.sandbox.dir(o.venture_id, 'artifacts'), 'site.zip'); fs.writeFileSync(out, require('./zip').zip(files));
      return { url: null, file: 'artifacts/site.zip', files: files.length, target: 'bundle', how_to_publish: 'Drop artifacts/site.zip on app.netlify.com/drop, or use Cloudflare Pages direct upload, or unzip into a GitHub repo and enable Pages. All are free.' };
    },
    /** Vercel REST API: inline-file deployment of a static site. Needs secret `vercel_token`. */
    async vercel(o) {
      const token = ctx.secrets._get('vercel_token'); if (!token) throw new Error('missing secret vercel_token');
      const src = ctx.sandbox.dir(o.venture_id, o.dir || 'source'); const files = []; let bytes = 0;
      for (const f of walk(src)) { const buf = fs.readFileSync(f); bytes += buf.length; if (bytes > 10 * 1024 * 1024) throw new Error('site exceeds 10MB inline limit'); files.push({ file: path.relative(src, f).split(path.sep).join('/'), data: buf.toString('base64'), encoding: 'base64' }); }
      const res = await fetch('https://api.vercel.com/v13/deployments', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: o.name, files, target: 'production', projectSettings: { framework: null } }), signal: AbortSignal.timeout(60000) });
      const j = await res.json(); if (!res.ok) throw new Error(`Vercel HTTP ${res.status}: ${(j.error && j.error.message) || 'error'}`);
      for (let i = 0; i < 30 && j.readyState !== 'READY'; i++) {
        await sleep(2000); const s = await (await fetch(`https://api.vercel.com/v13/deployments/${j.id}`, { headers: { authorization: `Bearer ${token}` } })).json();
        if (s.readyState === 'READY') break; if (s.readyState === 'ERROR') throw new Error('Vercel build failed');
      }
      return { url: `https://${j.url}`, id: j.id, files: files.length, target: 'vercel' };
    },
    async cli(o) {
      const t = CLI[o.provider]; if (!t) throw new Error(`unknown cli provider ${o.provider}`);
      const env = {}; for (const [k, secret] of Object.entries(t.env)) { const v = ctx.secrets._get(secret); if (!v) throw new Error(`missing secret ${secret}`); env[k] = v; }
      const cwd = ctx.sandbox.dir(o.venture_id, o.dir || 'source');
      const r = await hostRun(t.cmd, t.args({ dir: '.', name: o.name }), { cwd, env });
      if (!r.ok) throw new Error(`${o.provider} deploy failed: ${(r.err || r.out).slice(-300)}`);
      const m = (r.out + r.err).match(/https:\/\/[^\s)]+/g); const url = o.url || (m && m[m.length - 1]);
      return { url, target: o.provider, log_tail: (r.out + r.err).slice(-300) };
    },
    /** Build + run a container on this machine (Node apps with a Dockerfile). */
    async docker(o) {
      const cwd = ctx.sandbox.dir(o.venture_id, 'source'); const tag = `sovereign-${o.venture_id}:${Date.now()}`.toLowerCase();
      const port = 4000 + (parseInt(o.venture_id.replace(/\W/g, '').slice(-4), 36) % 4000);
      const b = await hostRun('docker', ['build', '-t', tag, '.'], { cwd }); if (!b.ok) throw new Error(`docker build failed: ${b.err.slice(-300)}`);
      await hostRun('docker', ['rm', '-f', `sov-${o.venture_id}`], { cwd });
      const r = await hostRun('docker', ['run', '-d', '--name', `sov-${o.venture_id}`, '--restart', 'unless-stopped', '--memory', '256m', '--cpus', '0.5', '-p', `127.0.0.1:${port}:3000`, tag], { cwd });
      if (!r.ok) throw new Error(`docker run failed: ${r.err.slice(-300)}`);
      return { url: `http://127.0.0.1:${port}/`, id: r.out.trim().slice(0, 12), target: 'docker' };
    },
  };

  async function verify(url, { contains, status = 200, retries = 5, delay = 1500 } = {}) {
    let last;
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'follow' }); const text = await res.text();
        last = { status: res.status, ok: res.status === status && (!contains || text.includes(contains)) };
        if (last.ok) return { ok: true, ...last, attempts: i + 1 };
      } catch (e) { last = { ok: false, error: e.message }; }
      await sleep(delay);
    }
    return { ok: false, ...last, attempts: retries };
  }

  /** Deploy (target: local|bundle|vercel|docker|cloudflare|netlify|fly|railway) then verify and start monitoring. */
  async function deploy(o) {
    const target = o.target || 'local';
    const fn = CLI[target] ? (x) => deployers.cli({ ...x, provider: target }) : deployers[target];
    if (!fn) throw new Error(`unknown deploy target ${target}`);
    const name = (o.name || o.venture_id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
    const d = await fn({ ...o, name });
    if (!d.url && d.file) return { ...d, verified: null, exported: true }; // a ZIP export is not a hosted site: nothing to verify or monitor
    const v = d.url ? await verify(d.url, { contains: o.expect, retries: o.retries || 5 }) : { ok: false, error: 'no url returned' };
    ctx.ventures.update(o.venture_id, { deployed_url: d.url });
    if (v.ok) addMonitor(o.venture_id, d.url, { contains: o.expect });
    ctx.emit(v.ok ? 'deploy.ok' : 'deploy.unverified', { target, url: d.url }, o.venture_id);
    return { ...d, verified: v.ok, verification: v };
  }

  function addMonitor(venture_id, url, { contains } = {}) {
    monitors()[venture_id] = { venture_id, url, contains: contains || null, checks: 0, failures: 0, last_ok: null, last_status: null, up: true, history: [] };
    ctx.db.save('monitors');
  }
  /** Called by the 5-minute autopilot job. Emits an alert only when a site transitions up → down. */
  async function checkMonitors() {
    const results = [];
    for (const m of Object.values(monitors())) {
      const t0 = Date.now(); let ok = false, status = null;
      try { const r = await fetch(m.url, { signal: AbortSignal.timeout(10000) }); status = r.status; ok = r.ok && (!m.contains || (await r.text()).includes(m.contains)); } catch { ok = false; }
      m.checks++; if (!ok) m.failures++; m.last_status = status; if (ok) m.last_ok = ctx.now();
      m.history = [...m.history.slice(-49), { ts: ctx.now(), ok, ms: Date.now() - t0 }];
      if (m.up && !ok) ctx.emit('deploy.down', { url: m.url, status }, m.venture_id);
      if (!m.up && ok) ctx.emit('deploy.up', { url: m.url }, m.venture_id);
      m.up = ok; results.push({ venture_id: m.venture_id, ok, status, uptime: round(1 - m.failures / m.checks, 4) });
    }
    ctx.db.save('monitors'); return results;
  }

  /**
   * ship(): workspace → scaffold or model-built code → tests → deploy → verify → monitor.
   * Deploying is a level-2 (public, hard to undo) action, so callers should route it through tools.invoke('deploy.ship').
   */
  async function ship({ venture_id, scaffold, build_spec, target = 'local', expect, maxIterations = 4 }) {
    const steps = [];
    ctx.sandbox.ensure(venture_id);
    if (scaffold) { for (const [p, c] of Object.entries(ctx.assets.scaffold(scaffold.kind, scaffold.options))) ctx.sandbox.writeFile(venture_id, p, c); steps.push({ step: 'scaffold', kind: scaffold.kind }); }
    if (build_spec) { const b = await ctx.builder.buildLoop({ venture_id, spec: build_spec, maxIterations }); steps.push({ step: 'build', ok: b.ok, iterations: b.iterations }); if (!b.ok) return { ok: false, steps, error: 'tests still failing after build loop' }; }
    else if (ctx.sandbox.list(venture_id, 'tests').length) {
      const t = await ctx.sandbox.run(venture_id, 'node', ['--test'], { cwd: 'tests' }); steps.push({ step: 'test', ok: t.ok });
      if (!t.ok) return { ok: false, steps, error: 'tests failed', output: (t.stdout + t.stderr).slice(-800) };
    }
    const d = await deploy({ venture_id, target, expect, dir: 'source' }); steps.push({ step: 'deploy', target, url: d.url, verified: d.verified });
    return { ok: d.verified !== false, steps, url: d.url, ...(d.file ? { file: d.file, how_to_publish: d.how_to_publish } : {}) };
  }
  return { deploy, verify, ship, addMonitor, checkMonitors, deployers, monitors: () => Object.values(monitors()) };
}
module.exports = { makeDeploy };
