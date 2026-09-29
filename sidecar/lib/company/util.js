'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DAY = 86400000;
const uid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const round = (n, d = 2) => Math.round((n + Number.EPSILON) * 10 ** d) / 10 ** d;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Tiny JSON-file store with atomic writes. Zero dependencies. */
class Db {
  constructor(dir) { this.dir = dir; this.cache = {}; fs.mkdirSync(dir, { recursive: true }); }
  file(n) { return path.join(this.dir, `${n}.json`); }
  get(n, def) {
    if (!(n in this.cache)) {
      try { this.cache[n] = JSON.parse(fs.readFileSync(this.file(n), 'utf8')); }
      catch { this.cache[n] = def; }
    }
    return this.cache[n];
  }
  save(n) {
    const f = this.file(n); const t = `${f}.tmp`;
    fs.writeFileSync(t, JSON.stringify(this.cache[n], null, 2));
    fs.renameSync(t, f);
  }
  set(n, v) { this.cache[n] = v; this.save(n); return v; }
}

/** Pull the first balanced JSON object/array out of model output (handles ``` fences). */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const s = text.replace(/```(?:json)?/gi, '');
  const start = s.search(/[\[{]/);
  if (start < 0) return null;
  const open = s[start]; const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** Minimal JSON-schema-ish validation: type, required, enum, maxLength, min/max. */
function validate(schema, value, at = 'input') {
  if (!schema) return null;
  const t = schema.type;
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (t && t !== actual && !(t === 'integer' && Number.isInteger(value))) return `${at} must be ${t}`;
  if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(', ')}`;
  if (typeof value === 'string' && schema.maxLength && value.length > schema.maxLength) return `${at} too long`;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${at} below minimum`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${at} above maximum`;
  }
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in value)) return `${at}.${k} is required`;
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) { const e = validate(sub, value[k], `${at}.${k}`); if (e) return e; }
    }
  }
  if (t === 'array' && schema.items) {
    for (let i = 0; i < value.length; i++) { const e = validate(schema.items, value[i], `${at}[${i}]`); if (e) return e; }
  }
  return null;
}

/** Block requests to loopback/private ranges (SSRF guard for agent-driven fetches). */
function isPrivateHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./); if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  return false;
}

module.exports = { Db, DAY, uid, round, clamp, extractJson, validate, isPrivateHost };
