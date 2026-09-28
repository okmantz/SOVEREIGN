'use strict';
const { assert } = require('../util');

const cleanHost = (h) => {
  const v = String(h || '').trim().replace(/\/+$/, '');
  assert(/^https?:\/\/[^\s/]+(:\d+)?$/.test(v), 'Ollama host must look like http://127.0.0.1:11434');
  return v;
};

async function complete({ state, model, system, messages }) {
  const host = cleanHost(state.settings.ollama && state.settings.ollama.host);
  let res;
  try {
    res = await fetch(host + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: system }, ...messages] }) });
  } catch (_) { assert(false, `Could not reach Ollama at ${host}. Is it running?`, 502); }
  const j = await res.json().catch(() => ({}));
  assert(res.ok, 'Ollama: ' + (j.error || res.status), 502);
  return { text: (j.message && j.message.content) || '', tokensIn: j.prompt_eval_count || 0, tokensOut: j.eval_count || 0, costCents: 0, model };
}

// Lists the models installed on an Ollama server, for the Settings dropdown.
async function listModels(host) {
  const h = cleanHost(host);
  let res;
  try { res = await fetch(h + '/api/tags'); } catch (_) { assert(false, `Could not reach Ollama at ${h}. Is it running?`, 502); }
  const j = await res.json().catch(() => ({}));
  assert(res.ok, 'Ollama: ' + (j.error || res.status), 502);
  return (j.models || []).map((m) => m.name).sort();
}

module.exports = { complete, listModels, cleanHost };
