'use strict';
const { assert } = require('../util');

async function complete({ model, system, messages }) {
  let res;
  try {
    res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: system }, ...messages] })
    });
  } catch (_) { assert(false, 'Ollama is not running on 127.0.0.1:11434.', 502); }
  const j = await res.json();
  assert(res.ok, 'Ollama: ' + (j.error || res.status), 502);
  return { text: (j.message && j.message.content) || '', tokensIn: j.prompt_eval_count || 0, tokensOut: j.eval_count || 0, costCents: 0, model };
}
module.exports = { complete };
