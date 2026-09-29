'use strict';
// Ollama tuned for responsiveness on ordinary hardware:
//  - streams tokens (the UI shows text as it arrives)
//  - keep_alive keeps the model loaded between calls so only the first call pays the load time
//  - a capped context window and capped output length keep each call short
//  - JSON mode for planning calls, so small models return parseable plans
//  - low temperature for planning, moderate for writing
const { assert } = require('../util');

const cleanHost = (h) => {
  const v = String(h || '').trim().replace(/\/+$/, '');
  assert(/^https?:\/\/[^\s/]+(:\d+)?$/.test(v), 'Ollama host must look like http://127.0.0.1:11434');
  return v;
};
const FIRST_TOKEN_MS = 240000; // a cold model can take a while to load
const IDLE_MS = 90000;         // after that, silence for this long means it is stuck

async function complete({ state, model, system, messages, purpose, maxTokens, json, onToken }) {
  const cfg = state.settings.ollama || {};
  const host = cleanHost(cfg.host);
  const planning = json || purpose === 'director' || purpose === 'planner';
  const body = { model, stream: true, keep_alive: cfg.keepAlive || '30m', messages: [{ role: 'system', content: system }, ...messages],
    options: { num_ctx: cfg.numCtx || 4096, num_predict: maxTokens || 800, temperature: planning ? 0.2 : 0.6 } };
  if (json) body.format = 'json';
  const ctl = new AbortController(); let timer = setTimeout(() => ctl.abort(), FIRST_TOKEN_MS);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), IDLE_MS); };
  let res;
  try { res = await fetch(host + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal }); }
  catch (e) { clearTimeout(timer); assert(false, e.name === 'AbortError' ? 'Ollama took too long to start responding.' : `Could not reach Ollama at ${host}. Is it running?`, 502); }
  if (!res.ok) { clearTimeout(timer); const j = await res.json().catch(() => ({})); assert(false, 'Ollama: ' + (j.error || res.status), 502); }
  let text = '', tokensIn = 0, tokensOut = 0;
  const eat = (line) => {
    if (!line.trim()) return; let j; try { j = JSON.parse(line); } catch (_) { return; }
    if (j.error) assert(false, 'Ollama: ' + j.error, 502);
    const piece = j.message && j.message.content; if (piece) { text += piece; if (onToken) onToken(text); }
    if (j.prompt_eval_count) tokensIn = j.prompt_eval_count; if (j.eval_count) tokensOut = j.eval_count;
  };
  try {
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) { const { done, value } = await reader.read(); if (done) break; bump(); buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n')) >= 0) { eat(buf.slice(0, i)); buf = buf.slice(i + 1); } }
      eat(buf);
    } else (await res.text()).split('\n').forEach(eat);
  } catch (e) { if (e.status) throw e; assert(false, e.name === 'AbortError' ? 'Ollama stopped responding mid-answer.' : 'Lost the connection to Ollama.', 502); }
  finally { clearTimeout(timer); }
  return { text, tokensIn, tokensOut, costCents: 0, model };
}

async function listModels(host) {
  const h = cleanHost(host); let res;
  try { res = await fetch(h + '/api/tags'); } catch (_) { assert(false, `Could not reach Ollama at ${h}. Is it running?`, 502); }
  const j = await res.json().catch(() => ({}));
  assert(res.ok, 'Ollama: ' + (j.error || res.status), 502);
  return (j.models || []).map((m) => m.name).sort();
}

// Load the model into memory ahead of time so the first real request is fast. Fire and forget.
async function warm(state) {
  const cfg = state.settings.ollama || {}; const model = state.settings.provider.model;
  try { await fetch(cleanHost(cfg.host) + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: cfg.keepAlive || '30m' }) }); return true; }
  catch (_) { return false; }
}

module.exports = { complete, listModels, cleanHost, warm };
