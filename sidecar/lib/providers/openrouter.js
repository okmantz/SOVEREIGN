'use strict';
const secrets = require('../secrets');
const { assert } = require('../util');

async function complete({ model, system, messages, maxTokens }) {
  const key = secrets.get('openrouter');
  assert(key, 'Add your OpenRouter key in Settings → Providers.', 401);
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key, 'x-title': 'Sovereign' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, ...messages], usage: { include: true }, ...(maxTokens ? { max_tokens: maxTokens } : {}) })
  });
  const j = await res.json();
  assert(res.ok, 'OpenRouter: ' + ((j.error && j.error.message) || res.status), 502);
  const u = j.usage || {};
  return { text: j.choices[0].message.content || '', tokensIn: u.prompt_tokens || 0, tokensOut: u.completion_tokens || 0,
    costCents: (u.cost || 0) * 100, model };
}
module.exports = { complete };
