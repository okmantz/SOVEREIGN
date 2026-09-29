'use strict';
// State store. One root holds shared settings plus any number of WORLDS. Each world is a self-contained station
// (agents, rooms, desks, hallways, connectors, ventures, ledger, goal, roadmap...) shaped exactly like the old
// single-station state, so every module keeps working on `store.state`. `store.forWorld(id)` gives the same
// interface bound to another world.
//
// Data lives NEXT TO THE CODE (./data), not in your home folder: delete the project folder and reinstall, and you
// start completely fresh. The data folder ignores itself in git so saved keys can never be committed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.SOVEREIGN_HOME || path.join(__dirname, '..', '..', 'data');
const GRID = { w: 48, h: 32 };
const rid = (p) => p + '_' + crypto.randomBytes(4).toString('hex');

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
  const ig = path.join(HOME, '.gitignore');
  if (!fs.existsSync(ig)) fs.writeFileSync(ig, '# Sovereign saved data and keys. Never commit.\n*\n');
}

function blankSettings() {
  return {
    provider: { name: 'mock', model: 'mock-1' },
    ollama: { host: 'http://127.0.0.1:11434', keepAlive: '30m', numCtx: 4096 },
    openaiCompat: { baseUrl: 'https://api.openai.com/v1' },
    // directorStructure: 'ask' = every Director plan needs your approval, 'auto' = Director applies plans itself.
    // connectorWrites:   'ask' = emails, pages, files and events wait for you, 'auto' = send directly.
    policy: { directorStructure: 'ask', connectorWrites: 'ask', spendApprovalCents: 5000 },
    budgets: { globalDailyCents: 2000, perAgentDailyCents: 500 },
    concurrency: { ollama: 2, other: 8 }, // how many agents may call the model at once
    speed: 'fast',        // fast | balanced | thorough: how long each deliverable may run
    loop: { evaluate: 'smart', maxRevisions: 1, maxRounds: 0 }, // the autonomous task loop: how hard each result is checked, how often it is redone, optional round cap
    autoDelegate: true,   // the Director hands extra work to agents that would otherwise sit idle
    intro: true,
    // company layer: free-only by default. allowPaid must be turned on by the owner before ANY action that costs money can run.
    company: { enabled: true, autonomy: 'approval_only', allowPaid: false, autopilot: false },
    ingestSecretSet: false
  };
}

function blankWorld(id, name, opts = {}) {
  return {
    id, name: name || 'Main', kind: opts.kind || 'general', color: opts.color || '#00ff88', focus: opts.focus || '', createdAt: Date.now(),
    mission: null, roadmap: null, journey: { stage: 'goal', busy: null, milestones: [], notice: null },
    memory: { brief: '', decisions: [], ownerNotes: [], handoffs: [], spendPlan: null, synced: [] }, strategy: null,
    agents: {}, rooms: {}, desks: {}, hallways: {}, connectors: {}, ventures: {},
    ledger: [], spend: [], approvals: [], outbox: [], transcripts: {}
  };
}

// Non-enumerable helpers so JSON never duplicates shared settings into each world.
function attach(root, w) {
  const def = (k, d) => Object.defineProperty(w, k, { enumerable: false, configurable: true, ...d });
  def('settings', { get: () => root.data.settings, set: (v) => { root.data.settings = v; } });
  def('all', { get: () => Object.values(root.data.worlds) });
  return w;
}

class WorldView {
  constructor(root, id) { this.root = root; this.id = id; this.persist = root.persist; }
  get state() { return this.root.data.worlds[this.id]; }
  set state(v) { attach(this.root, v); v.id = this.id; this.root.data.worlds[this.id] = v; }
  get exists() { return !!this.root.data.worlds[this.id]; }
  subscribe(fn) { return this.root.subscribe(fn); }
  emit(type, data) { this.root.emit(type, { ...data, worldId: this.id }); }
  change(type = 'state', data = {}) { this.root.change(type, { ...data, worldId: this.id }); }
  save() { this.root.save(); }
  forWorld(id) { return this.root.forWorld(id); }
}

class Store {
  constructor(opts = {}) {
    this.persist = opts.persist !== false;
    this.data = { version: 2, installId: rid('inst'), settings: blankSettings(), worlds: {} };
    this.listeners = new Set(); this._timer = null;
    if (this.persist) this.load();
    if (!Object.keys(this.data.worlds).length) this.data.worlds.w_main = blankWorld('w_main', 'Main');
    for (const w of Object.values(this.data.worlds)) attach(this, w);
    this.defaultId = Object.keys(this.data.worlds)[0];
  }
  file() { return path.join(HOME, 'state.json'); }
  load() {
    let raw; try { raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')); } catch (_) { return; } // first run
    if (raw && raw.worlds) {
      this.data = { ...this.data, ...raw, settings: { ...blankSettings(), ...(raw.settings || {}) } };
      const c = this.data.settings.concurrency; if (c && c.other === 6) c.other = 8; // the old default was too low for parallel agents
    } else if (raw && raw.agents) { // a v0.1/v0.2 single-station file becomes the "Main" world
      const { settings, ...rest } = raw;
      this.data.settings = { ...blankSettings(), ...(settings || {}) };
      this.data.worlds.w_main = { ...blankWorld('w_main', 'Main'), ...rest, id: 'w_main' };
    }
    if (!this.data.installId) this.data.installId = rid('inst');
  }
  save() {
    if (!this.persist) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      try { ensureHome(); fs.writeFileSync(this.file() + '.tmp', JSON.stringify(this.data)); fs.renameSync(this.file() + '.tmp', this.file()); }
      catch (e) { console.error('[store] save failed:', e.message); }
    }, 100);
  }
  // The default world, for single-world callers and tests.
  get state() { return this.data.worlds[this.defaultId]; }
  set state(v) { attach(this, v); v.id = this.defaultId; this.data.worlds[this.defaultId] = v; }
  world(id) { return this.data.worlds[id] || null; }
  forWorld(id) { return new WorldView(this, id); }
  addWorld(name, opts = {}) { const id = rid('w'); this.data.worlds[id] = attach(this, blankWorld(id, name, opts)); return id; }
  removeWorld(id) { delete this.data.worlds[id]; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { const ev = { type, data, at: Date.now() }; for (const l of this.listeners) l(ev); }
  // Persist + notify. Every mutation path ends here.
  change(type = 'state', data = {}) { this.save(); this.emit(type, data); }
  // Erase everything and start over (used by "Start fresh" in Settings).
  reset() {
    this.data = { version: 2, installId: rid('inst'), settings: blankSettings(), worlds: { w_main: blankWorld('w_main', 'Main') } };
    attach(this, this.data.worlds.w_main); this.defaultId = 'w_main'; this.save(); this.emit('state', { worldId: 'w_main' });
  }
}

module.exports = { Store, WorldView, GRID, HOME, ensureHome, blankWorld, blankSettings, attach };
