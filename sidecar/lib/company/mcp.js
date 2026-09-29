'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');

/** Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0). Zero dependencies. */
class McpClient {
  constructor({ command, args = [], env = {}, cwd, timeout_ms = 30000 }) {
    Object.assign(this, { command, args, env, cwd, timeout_ms }); this.id = 0; this.pending = new Map();
  }
  async start() {
    // scrubbed environment: only what the operator explicitly passes (plus PATH)
    this.proc = spawn(this.command, this.args, { cwd: this.cwd, env: { PATH: process.env.PATH, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('error', (e) => this._failAll(e));
    this.proc.on('exit', () => this._failAll(new Error('MCP server exited')));
    this.proc.stderr.on('data', () => {});
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.t);
      m.error ? p.reject(new Error(m.error.message || 'MCP error')) : p.resolve(m.result);
    });
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sovereign', version: '0.4.0' } });
    this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return this;
  }
  _send(m) { this.proc.stdin.write(`${JSON.stringify(m)}\n`); }
  _failAll(e) { for (const [, p] of this.pending) { clearTimeout(p.t); p.reject(e); } this.pending.clear(); }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, this.timeout_ms);
      this.pending.set(id, { resolve, reject, t });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async listTools() { return (await this.request('tools/list', {})).tools || []; }
  async callTool(name, args) {
    const r = await this.request('tools/call', { name, arguments: args });
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(text || 'tool error');
    return { text, content: r.content, structured: r.structuredContent };
  }
  close() { try { this.proc.kill(); } catch { /* already gone */ } }
}
module.exports = { McpClient };
