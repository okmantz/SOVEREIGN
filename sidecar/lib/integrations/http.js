'use strict';
// One place for outbound HTTP. Errors carry the host and a short message, never the URL or headers,
// so tokens passed in query strings or headers cannot leak into the UI or logs.
const { HttpError } = require('../util');

function errMsg(json, text) {
  const j = json || {};
  const m = (j.error && (j.error.message || (typeof j.error === 'string' && j.error))) || j.error_description || j.message
    || (Array.isArray(j.errors) && j.errors[0] && (j.errors[0].message || j.errors[0])) || j.errors || String(text || '').slice(0, 160);
  return typeof m === 'string' ? m : JSON.stringify(m).slice(0, 160);
}

async function request(url, { method = 'GET', headers = {}, body, form, timeoutMs = 15000, allow } = {}) {
  const host = new URL(url).host;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const h = { ...headers }; let payload = body;
  if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined && typeof body !== 'string') { h['content-type'] = h['content-type'] || 'application/json'; payload = JSON.stringify(body); }
  let res;
  try { res = await globalThis.fetch(url, { method, headers: h, body: payload, signal: ctl.signal }); }
  catch (e) { throw new HttpError(502, `${host}: ${e.name === 'AbortError' ? 'timed out' : 'could not connect'}`); }
  finally { clearTimeout(timer); }
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  if (!res.ok && !(allow && allow.includes(res.status))) throw new HttpError(502, `${host} said ${res.status}: ${errMsg(json, text)}`);
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

const dollarsToCents = (v) => Math.round(parseFloat(v) * 100);
const dayAgo = (n, now = Date.now()) => new Date(now - n * 864e5);
const isoDay = (d) => d.toISOString().slice(0, 10);

module.exports = { request, dollarsToCents, dayAgo, isoDay, errMsg };
