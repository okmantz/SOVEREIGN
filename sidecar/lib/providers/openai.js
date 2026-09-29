'use strict';
// Any OpenAI-compatible endpoint: OpenAI itself, LM Studio, vLLM, Together, Groq, and so on. Streams when the server allows it.
const secrets = require('../secrets');
const { assert } = require('../util');
const sse = require('./sse');

async function complete({ state, model, system, messages, maxTokens, onToken }) {
  const base = String((state.settings.openaiCompat || {}).baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  assert(/^https?:\/\//.test(base), 'Base URL must start with http:// or https://');
  const key = secrets.get('openai');
  const headers = { 'content-type': 'application/json' }; if (key) headers.authorization = 'Bearer ' + key;
  const body = { model, messages: [{ role: 'system', content: system }, ...messages], ...(maxTokens ? { max_tokens: maxTokens } : {}) };
  const r = await sse.chat({ url: base + '/chat/completions', headers, label: base, onToken,
    plans: [{ ...body, stream: true, stream_options: { include_usage: true } }, { ...body, stream: true }, body] });
  const u = r.usage || {};
  return { text: r.text || '', tokensIn: u.prompt_tokens || 0, tokensOut: u.completion_tokens || 0, costCents: 0, model };
}
module.exports = { complete };
