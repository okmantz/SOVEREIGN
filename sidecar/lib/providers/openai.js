'use strict';
// Any OpenAI-compatible endpoint: OpenAI itself, LM Studio, vLLM, Together, Groq, and so on.
const secrets = require('../secrets');
const { assert } = require('../util');

async function complete({ state, model, system, messages }) {
  const base = String((state.settings.openaiCompat || {}).baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  assert(/^https?:\/\//.test(base), 'Base URL must start with http:// or https://');
  const key = secrets.get('openai');
  const headers = { 'content-type': 'application/json' }; if (key) headers.authorization = 'Bearer ' + key;
  let res;
  try { res = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages] }) }); }
  catch (_) { assert(false, `Could not reach ${base}.`, 502); }
  const j = await res.json().catch(() => ({}));
  assert(res.ok, 'Provider: ' + ((j.error && j.error.message) || res.status), 502);
  const u = j.usage || {};
  return { text: (j.choices && j.choices[0] && j.choices[0].message.content) || '', tokensIn: u.prompt_tokens || 0, tokensOut: u.completion_tokens || 0, costCents: 0, model };
}
module.exports = { complete };
