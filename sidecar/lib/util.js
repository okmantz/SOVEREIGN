'use strict';
const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const assert = (cond, msg, status = 400) => { if (!cond) throw new HttpError(status, msg); };
const id = (prefix) => prefix + '_' + crypto.randomBytes(4).toString('hex');
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const today = () => new Date().toISOString().slice(0, 10);
const money = (cents) => (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toFixed(2);
const int = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : dflt);

module.exports = { HttpError, assert, id, clamp, today, money, int };
