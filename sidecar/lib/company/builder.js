'use strict';
const { extractJson } = require('./util');

/**
 * Write code → run tests → fix bugs, in a loop, inside the sandbox.
 * The model proposes files + a test command; the harness writes them (path-jailed), runs them (resource-limited)
 * and feeds real failures back. The loop stops on green tests or after maxIterations.
 */
function makeBuilder(ctx) {
  async function buildLoop({ venture_id, spec, maxIterations = 4, testCommand = ['node', '--test'] }) {
    if (!ctx.llm) throw new Error('build loop needs a model; configure a provider or use assets.scaffold()');
    ctx.sandbox.ensure(venture_id);
    const log = []; let feedback = '';
    for (let i = 1; i <= maxIterations; i++) {
      const files = ctx.sandbox.list(venture_id, 'source').concat(ctx.sandbox.list(venture_id, 'tests'));
      const prompt = `You are a senior engineer. Build this in a Node 20 project with ZERO npm dependencies.\nSPEC:\n${spec}\n\n` +
        `Existing files: ${files.join(', ') || '(none)'}\n${feedback ? `The last test run FAILED:\n${feedback.slice(-3500)}\nFix the code.\n` : ''}` +
        `Return ONLY JSON: {"files":[{"path":"source/x.js","content":"..."},{"path":"tests/x.test.js","content":"..."}],"notes":""}. ` +
        `Paths must start with source/ or tests/. Include tests runnable with "node --test".`;
      const j = extractJson(await ctx.llm(prompt, { json: true }));
      if (!j || !Array.isArray(j.files) || !j.files.length) { log.push({ iteration: i, error: 'model returned no files' }); feedback = 'You returned no valid JSON files array.'; continue; }
      const written = [];
      for (const f of j.files.slice(0, 30)) {
        try { if (!/^(source|tests)\//.test(f.path)) throw new Error('path must start with source/ or tests/'); ctx.sandbox.writeFile(venture_id, f.path, String(f.content)); written.push(f.path); }
        catch (e) { log.push({ iteration: i, skipped: f.path, reason: e.message }); }
      }
      const r = await ctx.sandbox.run(venture_id, testCommand[0], testCommand.slice(1), { cwd: 'tests' });
      log.push({ iteration: i, written, ok: r.ok, code: r.code, tail: (r.stdout + r.stderr).slice(-600) });
      ctx.emit('build.iteration', { ok: r.ok, iteration: i }, venture_id);
      if (r.ok) return { ok: true, iterations: i, log };
      feedback = `${r.stdout}\n${r.stderr}`;
    }
    return { ok: false, iterations: maxIterations, log };
  }
  return { buildLoop };
}
module.exports = { makeBuilder };
