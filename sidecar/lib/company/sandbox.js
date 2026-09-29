'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DIRS = ['source', 'tests', 'artifacts', 'logs', 'credentials'];
const ALLOWED_CMDS = new Set(['node', 'npm', 'npx', 'python3', 'python', 'git', 'pytest']);
const ID_RE = /^[a-z0-9_-]{3,64}$/i;
const MAX_FILE = 2 * 1024 * 1024;

/**
 * Per-venture workspaces: /workspaces/<venture>/{source,tests,artifacts,logs,credentials}
 *
 *  mode 'docker'  → real isolation: no network by default, memory/cpu/pids limits, dropped capabilities, non-root.
 *  mode 'process' → best effort ONLY (path jail, allow-listed binaries, scrubbed env, ulimit, timeout).
 *                   It is NOT a security boundary: code you run can read the rest of your disk. Use it for tests
 *                   and trusted code; use docker for anything an LLM wrote.
 */
function makeSandbox(ctx) {
  const root = path.join(ctx.dataDir, 'workspaces');

  function base(id) { if (!ID_RE.test(id || '')) throw new Error('invalid venture id'); return path.join(root, id); }
  function ensure(id) { const b = base(id); for (const d of DIRS) fs.mkdirSync(path.join(b, d), { recursive: true }); return b; }

  /** Resolve a workspace-relative path; reject escapes (.., absolute, symlinks). */
  function safe(id, rel) {
    const b = ensure(id);
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\0')) throw new Error('bad path');
    const target = path.resolve(b, rel);
    if (target !== b && !target.startsWith(b + path.sep)) throw new Error('path escapes workspace');
    let probe = target; while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe), realBase = fs.realpathSync(b);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new Error('symlink escapes workspace');
    if (!DIRS.includes(path.relative(b, target).split(path.sep)[0])) throw new Error(`path must start with one of: ${DIRS.join(', ')}`);
    return target;
  }
  function writeFile(id, rel, content) {
    if (Buffer.byteLength(content) > MAX_FILE) throw new Error('file too large');
    const t = safe(id, rel); fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, content, rel.startsWith('credentials') ? { mode: 0o600 } : undefined); return rel;
  }
  function readFile(id, rel) {
    if (rel.split(/[\\/]/)[0] === 'credentials') throw new Error('credentials are write-only'); // Law 6
    return fs.readFileSync(safe(id, rel), 'utf8');
  }
  function list(id, sub = 'source') {
    if (sub === 'credentials') return [];
    const out = []; const b = ensure(id);
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(path.relative(b, p));
      }
    })(safe(id, sub)); return out;
  }

  function checkArgs(id, cwd, args) {
    const b = base(id);
    for (const a of args) {
      if (typeof a !== 'string') throw new Error('args must be strings');
      if (a.startsWith('-') && !a.includes('/') && !a.includes('\\')) continue;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) continue;               // URLs are governed by the network setting
      if (a.includes('/') || a.includes('\\') || a.startsWith('.')) {
        const t = path.resolve(cwd, a.replace(/^--?[a-z-]+=/i, ''));
        if (t !== b && !t.startsWith(b + path.sep)) throw new Error(`argument escapes workspace: ${a}`);
      }
    }
  }

  async function run(id, cmd, args = [], opts = {}) {
    const s = ctx.settings().sandbox; const b = ensure(id);
    if (!ALLOWED_CMDS.has(cmd)) throw new Error(`command not allowed: ${cmd}`);
    const cwd = safe(id, opts.cwd || 'source');
    checkArgs(id, cwd, args);
    const network = Boolean(opts.network);
    if (network && !s.allow_network) throw new Error('network is disabled for sandboxes (settings.sandbox.allow_network)');
    const timeout = Math.min(opts.timeout_ms || s.timeout_ms, 600000);
    const warnings = []; let file, argv; const env = { PATH: process.env.PATH, HOME: b, NODE_ENV: opts.env && opts.env.NODE_ENV || 'test', ...(opts.env || {}) };
    if (s.mode === 'docker') {
      const mounts = ['source', 'tests', 'artifacts', 'logs'].flatMap((d) => ['-v', `${path.join(b, d)}:/work/${d}`]);
      const rel = path.relative(b, cwd).split(path.sep).join('/');
      const envArgs = Object.entries(opts.env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      file = 'docker';
      argv = ['run', '--rm', '-i', '--network', network ? 'bridge' : 'none', '--memory', `${s.memory_mb}m`, '--cpus', String(s.cpus),
        '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000', '-e', 'HOME=/tmp',
        ...envArgs, ...mounts, '-w', `/work/${rel}`, s.image, cmd, ...args];
    } else {
      warnings.push('process mode is not a security boundary; use docker for untrusted code');
      if (!network) warnings.push('network cannot be blocked in process mode');
      file = 'sh';
      argv = ['-c', `ulimit -t ${Math.ceil(s.cpu_seconds)} 2>/dev/null; ulimit -f 262144 2>/dev/null; ulimit -n 1024 2>/dev/null; exec "$0" "$@"`, cmd, ...args];
    }
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(file, argv, { cwd: s.mode === 'docker' ? undefined : cwd, env: s.mode === 'docker' ? { PATH: process.env.PATH } : env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '', timedOut = false, capped = false;
      const cap = s.output_cap;
      const add = (which) => (d) => { if (out.length + err.length > cap) { capped = true; return; } (which === 'o' ? (out += d) : (err += d)); };
      child.stdout.on('data', add('o')); child.stderr.on('data', add('e'));
      child.on('error', (e) => { err += `\nspawn error: ${e.message}`; });
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeout);
      if (opts.stdin) child.stdin.write(opts.stdin); child.stdin.end();
      child.on('close', (code) => {
        clearTimeout(timer);
        const r = { ok: code === 0 && !timedOut, code, stdout: out, stderr: err, timed_out: timedOut, output_capped: capped, duration_ms: Date.now() - started, mode: s.mode, warnings };
        try { fs.writeFileSync(path.join(b, 'logs', `run-${Date.now()}.log`), `$ ${cmd} ${args.join(' ')}\n${out}\n${err}\n[exit ${code}${timedOut ? ' TIMEOUT' : ''}]\n`); } catch { /* logging is best-effort */ }
        resolve(r);
      });
    });
  }
  return { ensure, writeFile, readFile, list, run, root, dir: (id, sub = 'source') => safe(id, sub), DIRS, ALLOWED_CMDS };
}
module.exports = { makeSandbox };
