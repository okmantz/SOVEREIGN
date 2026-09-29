'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * DECISION TRAIL: the receipt. An append-only file of every decision and every action that left the machine or changed money:
 * approvals and rejections (and from which device), remote stop/resume, pairing, the CEO's decisions, guardrail freezes, kills,
 * mail sent, deliveries, renewals and churn. Each line carries the hash of the line before it, so an edit or a deleted line anywhere
 * in the file is detected by verify(). It is a record for you, not a control: nothing reads it to decide anything.
 */
function makeTrail(ctx) {
  const file = path.join(ctx.dataDir, 'trail.jsonl');
  let n = 0, last = '0'.repeat(64);
  try { // resume the chain from disk
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
    if (raw.length) { const e = JSON.parse(raw[raw.length - 1]); n = e.n; last = e.hash; }
  } catch { /* a damaged tail is reported by verify(); new entries continue from a fresh chain */ }
  const clip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 400 ? x.slice(0, 400) + '…' : x)) || 'null');
  function log(type, data = {}, { actor = 'system', venture_id = null } = {}) {
    const e = { n: ++n, ts: ctx.now(), type, actor, venture_id, data: clip(data), prev: last };
    e.hash = crypto.createHash('sha256').update(JSON.stringify([e.n, e.ts, e.type, e.actor, e.venture_id, e.data, e.prev])).digest('hex'); last = e.hash;
    try { fs.appendFileSync(file, JSON.stringify(e) + '\n'); } catch { /* a full disk must not stop the business; verify() will show the gap */ }
    return e;
  }
  function read() {
    if (!fs.existsSync(file)) return [];
    const st = fs.statSync(file); const max = 2 * 1024 * 1024; const fd = fs.openSync(file, 'r'); const len = Math.min(st.size, max); const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean); if (st.size > max) lines.shift(); // the first line of a partial read may be cut
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  const tail = (count = 50, f = {}) => read().filter((e) => (!f.type || e.type.startsWith(f.type)) && (!f.since || e.ts >= f.since)).slice(-count).reverse();
  /** Re-compute the whole chain. ok=false names the first line that does not match. */
  function verify() {
    if (!fs.existsSync(file)) return { ok: true, entries: 0 };
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); let prev = '0'.repeat(64); let expect = null;
    for (let i = 0; i < lines.length; i++) {
      let e; try { e = JSON.parse(lines[i]); } catch { return { ok: false, entries: lines.length, broken_at: i + 1, reason: 'unreadable line' }; }
      if (expect !== null && e.n !== expect) return { ok: false, entries: lines.length, broken_at: e.n, reason: 'a line is missing' };
      if (i > 0 && e.prev !== prev) return { ok: false, entries: lines.length, broken_at: e.n, reason: 'chain broken' };
      const h = crypto.createHash('sha256').update(JSON.stringify([e.n, e.ts, e.type, e.actor, e.venture_id, e.data, e.prev])).digest('hex');
      if (h !== e.hash) return { ok: false, entries: lines.length, broken_at: e.n, reason: 'a line was edited' };
      prev = e.hash; expect = e.n + 1;
    }
    return { ok: true, entries: lines.length };
  }
  return { log, tail, verify, file };
}
module.exports = { makeTrail };
