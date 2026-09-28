'use strict';
// Write-only secret vault. Keys never leave the sidecar and are never sent to the frontend.
// v0.1 stores a 0600 file. The Tauri shell should swap this module for the OS keychain (see docs/ROADMAP.md).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HOME } = require('./store');

const file = () => path.join(HOME, 'secrets.json');
function read() { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (_) { return {}; } }
function write(obj) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(obj), { mode: 0o600 });
}
const mem = {}; // used when SOVEREIGN_NO_PERSIST is set (tests)
const persist = () => !process.env.SOVEREIGN_NO_PERSIST;

function get(name) { return persist() ? read()[name] : mem[name]; }
function set(name, value) {
  if (persist()) { const o = read(); o[name] = value; write(o); } else mem[name] = value;
}
function has(name) { return !!get(name); }
function rotateIngestSecret() {
  const s = crypto.randomBytes(24).toString('hex');
  set('ingest', s);
  return s; // shown to the user exactly once
}

module.exports = { get, set, has, rotateIngestSecret };
