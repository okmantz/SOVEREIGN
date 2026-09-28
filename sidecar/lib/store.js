'use strict';
// Single JSON-file state store with change events. Local-first: everything lives in SOVEREIGN_HOME.
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.SOVEREIGN_HOME || path.join(os.homedir(), '.sovereign');
const GRID = { w: 48, h: 32 };

function blank() {
  return {
    version: 1,
    mission: null,
    settings: {
      provider: { name: 'mock', model: 'mock-1' },
      ollama: { host: 'http://127.0.0.1:11434' },
      openaiCompat: { baseUrl: 'https://api.openai.com/v1' },
      // directorStructure: 'ask' = every Director plan needs your approval, 'auto' = Director applies plans itself.
      // connectorWrites:   'ask' = emails, Notion pages, Drive files and calendar events wait for you, 'auto' = send directly.
      policy: { directorStructure: 'ask', connectorWrites: 'ask', spendApprovalCents: 5000 },
      budgets: { globalDailyCents: 2000, perAgentDailyCents: 500 },
      ingestSecretSet: false
    },
    agents: {}, rooms: {}, desks: {}, hallways: {}, connectors: {}, ventures: {},
    ledger: [], spend: [], approvals: [], outbox: [], transcripts: {}
  };
}

class Store {
  constructor(opts = {}) {
    this.persist = opts.persist !== false;
    this.state = blank();
    this.listeners = new Set();
    this._timer = null;
    if (this.persist) this.load();
  }
  file() { return path.join(HOME, 'state.json'); }
  load() {
    try { this.state = Object.assign(blank(), JSON.parse(fs.readFileSync(this.file(), 'utf8'))); }
    catch (_) { /* first run */ }
  }
  save() {
    if (!this.persist) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try {
        fs.mkdirSync(HOME, { recursive: true });
        fs.writeFileSync(this.file() + '.tmp', JSON.stringify(this.state));
        fs.renameSync(this.file() + '.tmp', this.file());
      } catch (e) { console.error('[store] save failed:', e.message); }
    }, 100);
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { const ev = { type, data, at: Date.now() }; for (const l of this.listeners) l(ev); }
  // Persist + notify. Every mutation path ends here.
  change(type = 'state', data = {}) { this.save(); this.emit(type, data); }
}

module.exports = { Store, GRID, HOME, blank };
