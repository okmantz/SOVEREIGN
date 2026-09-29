'use strict';
const secrets = require('../secrets');
const { assert } = require('../util');
const sse = require('./sse');

async function complete({ model, system, messages, maxTokens, onToken }) {
  const key = secrets.get('openrouter');
  assert(key, 'Add your OpenRouter key in Settings → Providers.', 401);
  const base = { model, messages: [{ role: 'system', content: system }, ...messages], ...(maxTokens ? { max_tokens: maxTokens } : {}) };
  const r = await sse.chat({ url: 'https://openrouter.ai/api/v1/chat/completions', label: 'OpenRouter', onToken,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key, 'x-title': 'Sovereign' },
    plans: [{ ...base, stream: true, usage: { include: true } }, { ...base, usage: { include: true } }] });
  const u = r.usage || {};
  return { text: r.text || '', tokensIn: u.prompt_tokens || 0, tokensOut: u.completion_tokens || 0, costCents: (u.cost || 0) * 100, model };
}
module.exports = { complete };
