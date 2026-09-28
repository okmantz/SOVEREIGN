'use strict';
const impls = { mock: require('./mock'), openrouter: require('./openrouter'), ollama: require('./ollama') };

// Every model call in the station goes through here, so budgets and spend tracking cannot be bypassed.
async function complete(store, { agent, system, messages, purpose }) {
  const prov = store.state.settings.provider;
  const impl = impls[prov.name] || impls.mock;
  return impl.complete({ state: store.state, agent, model: (agent && agent.model) || prov.model, system, messages, purpose });
}
module.exports = { complete, names: Object.keys(impls) };
