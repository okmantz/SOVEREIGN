'use strict';
process.env.SOVEREIGN_NO_PERSIST = '1';
const { Store } = require('../sidecar/lib/store');
const director = require('../sidecar/lib/director');

const realFetch = globalThis.fetch;
// A store with one world and its Director, plus that world's view (the object every module works on).
function fresh() { const root = new Store({ persist: false }); const view = root.forWorld(root.defaultId); director.ensureDirector(view); return { root, view }; }
function stub(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); const r = await handler(String(url), opts); return new Response(JSON.stringify(r.body), { status: r.status || 200 }); };
  return calls;
}
const restore = () => { globalThis.fetch = realFetch; };
async function until(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 15)); } throw new Error('timed out waiting for condition'); }
// Let the mock model's replies be scripted per call.
function scriptProvider(reply) { const p = require('../sidecar/lib/providers'), orig = p.complete; p.complete = async (store, args) => { const t = await reply(args); return { text: t, tokensIn: 1, tokensOut: 1, costCents: 0, model: 'test' }; }; return () => { p.complete = orig; }; }
module.exports = { fresh, stub, restore, until, scriptProvider };
