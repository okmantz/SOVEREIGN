'use strict';
const impls = { mock: require('./mock'), openrouter: require('./openrouter'), ollama: require('./ollama'), openai: require('./openai') };

// A small queue per provider so a burst of agents cannot flood a local model (or a rate-limited API).
const gates = new Map();
function gate(name, max, fn) {
  const g = gates.get(name) || { active: 0, queue: [] }; gates.set(name, g);
  const next = () => { while (g.queue.length && g.active < Math.max(1, max)) { g.active++; const job = g.queue.shift(); job(); } };
  return new Promise((resolve, reject) => {
    g.queue.push(() => Promise.resolve().then(fn).then(resolve, reject).finally(() => { g.active--; next(); }));
    next();
  });
}

// Every model call in the station goes through here, so budgets, spend tracking and limits cannot be bypassed.
// json: ask for machine-readable output. maxTokens: cap the answer length. onToken(fullText): progress for streaming providers.
async function complete(store, { agent, system, messages, purpose, json, maxTokens, onToken }) {
  const st = store.state.settings, prov = st.provider, impl = impls[prov.name] || impls.mock;
  const c = st.concurrency || { ollama: 2, other: 8 };
  return gate(prov.name, prov.name === 'ollama' ? c.ollama : c.other, () =>
    impl.complete({ state: store.state, agent, model: (agent && agent.model) || prov.model, system, messages, purpose, json, maxTokens, onToken }));
}
const isOffline = (store) => store.state.settings.provider.name === 'mock';
module.exports = { complete, isOffline, names: Object.keys(impls), ollama: impls.ollama };
