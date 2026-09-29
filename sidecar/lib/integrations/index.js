'use strict';
// Integration registry. Each adapter is a small object (see stripe.js for a source, email.js for a sink).
// Rules: secrets live only in the vault, reads become verified ledger entries, writes wait for approval.
const secrets = require('../secrets');
const ledger = require('../ledger');
const station = require('../station');
const { assert, today, money } = require('../util');
const oauth = require('./oauth');
const google = require('./google');
const messaging = require('./messaging');
const data = require('./data');

const adapters = {
  stripe: require('./stripe'), shopify: require('./shopify'), etsy: require('./etsy'), meta_ads: require('./meta_ads'),
  notion: require('./notion'), email: require('./email'), calendar: google.calendar, drive: google.drive, sheets: google.sheets,
  slack: messaging.slack, discord: messaging.discord, telegram: messaging.telegram, webhook: messaging.webhook,
  comfyui: require('./comfyui'), airtable: data.airtable, woocommerce: data.woocommerce, gumroad: data.gumroad,
  portal: { label: 'World portal', source: 'portal', internal: true, blurb: 'Sends work into another world\'s Inbox. Create portals with Connect worlds in the Worlds panel.', fields: [], async test() { return { detail: 'Portal is open.' }; } }
};
const vaultKey = (id, key) => `conn:${id}:${key}`;
const adapterFor = (kind) => adapters[kind] || null;
const secretFields = (a) => a.fields.filter((f) => f.secret);
const requiredFields = (a) => a.fields.filter((f) => !f.optional);

function describe() {
  const out = {};
  for (const [kind, meta] of Object.entries(station.CONNECTOR_KINDS)) {
    const a = adapters[kind];
    out[kind] = { ...meta, live: !!a, blurb: a ? a.blurb : 'Placeholder port. Real adapter not built yet.', fields: a ? a.fields : [], contract: a ? a.contract || null : null,
      oauth: !!(a && a.oauth), canSync: !!(a && a.sync), canPerform: !!(a && a.perform) };
  }
  return out;
}
function secretsOf(c) {
  const a = adapterFor(c.kind); const out = {};
  if (a) for (const f of secretFields(a)) out[f.key] = secrets.get(vaultKey(c.id, f.key)) || '';
  return out;
}
function publicConnector(c) {
  const a = adapterFor(c.kind); const set = {};
  if (a) for (const f of secretFields(a)) set[f.key] = secrets.has(vaultKey(c.id, f.key));
  const u = c.usage && c.usage.day === today() ? c.usage.n : 0;
  const { workflow, ...rest } = c; // the workflow text can be large: send a flag, not the text
  return { ...rest, hasWorkflow: !!workflow, secretsSet: set, oauthConnected: !!(a && a.oauth && oauth.connected(c.id)), sentToday: u };
}
function missing(c) {
  const a = adapterFor(c.kind); if (!a) return [];
  const sec = secretsOf(c);
  return requiredFields(a).filter((f) => f.secret ? !sec[f.key] : !String(c.config[f.key] || '').trim()).map((f) => f.label);
}

function configure(store, id, p) {
  const c = store.state.connectors[id]; assert(c, 'Connector not found', 404);
  const a = adapterFor(c.kind);
  if (p.name != null) { const n = String(p.name).trim().slice(0, 32); assert(n, 'A connector needs a name.'); c.name = n; }
  if (p.ventureId !== undefined) { assert(!p.ventureId || store.state.ventures[p.ventureId], 'Unknown venture.'); c.ventureId = p.ventureId || null; }
  if (p.autoSync !== undefined) c.autoSync = !!p.autoSync;
  if (a && p.config) for (const f of a.fields) if (!f.secret && p.config[f.key] !== undefined) c.config[f.key] = String(p.config[f.key]).trim().slice(0, 300);
  if (a && p.secrets) for (const f of secretFields(a)) { const v = p.secrets[f.key]; if (typeof v === 'string' && v.trim()) secrets.set(vaultKey(id, f.key), v.trim()); } // blank keeps the saved value
  if (a) { c.status = missing(c).length ? 'unconfigured' : 'untested'; c.lastError = null; }
  return c;
}

const guard = (c) => {
  const a = adapterFor(c.kind); assert(a, `${station.CONNECTOR_KINDS[c.kind].label} is a placeholder port. No adapter is built for it yet.`);
  const m = missing(c); assert(!m.length, 'Still needed: ' + m.join(', ') + '.');
  return a;
};
async function run(store, c, fn) {
  try { return await fn(); }
  catch (e) { c.status = 'error'; c.lastError = e.message; store.change('state'); throw e; }
}

async function test(store, id) {
  const c = store.state.connectors[id]; assert(c, 'Connector not found', 404);
  const a = guard(c);
  const r = await run(store, c, () => a.test(c, secretsOf(c)));
  if (r.patchConfig) Object.assign(c.config, r.patchConfig);
  c.status = 'ready'; c.lastError = null; store.change('state');
  return r;
}

async function sync(store, id, opts) {
  const c = store.state.connectors[id]; assert(c, 'Connector not found', 404);
  const a = guard(c); assert(a.sync, `${a.label} has nothing to sync. It only performs approved actions.`);
  const r = await run(store, c, () => a.sync(c, secretsOf(c), opts));
  let added = 0, rev = 0, cost = 0;
  for (const e of r.entries || []) {
    const row = ledger.add(store, { ...e, ventureId: c.ventureId, source: a.source });
    if (row) { added++; if (row.type === 'revenue') rev += row.amountCents; else cost += row.amountCents; }
  }
  if (r.cursor !== undefined) c.cursor = r.cursor;
  c.lastSyncAt = Date.now(); c.status = 'ready'; c.lastError = null;
  ledger.evaluateVentures(store);
  store.change('state');
  const head = a.ledger ? `${a.label}: ${added} new ledger ${added === 1 ? 'entry' : 'entries'} (+${money(rev)} revenue, −${money(cost)} costs).` : `${a.label} synced.`;
  return { added, summary: [head, ...(r.notes || [])].join('\n') };
}

// Pull a JSON action out of free-form agent text. Tries each '{' as a start so prose around the JSON is fine.
function extractJson(text) {
  const s = String(text || ''), end = s.lastIndexOf('}');
  for (let i = s.indexOf('{'); i !== -1 && i < end; i = s.indexOf('{', i + 1)) {
    try { const o = JSON.parse(s.slice(i, end + 1)); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch (_) { /* try the next brace */ }
  }
  return null;
}
function parseAction(c, text) {
  const a = adapterFor(c.kind); assert(a && a.perform, `${c.name} does not accept actions.`);
  const obj = extractJson(text); assert(obj, `The message had no JSON action. ${c.name} expects: ${a.contract}`);
  try { a.validate(obj); } catch (e) { assert(false, e.message + ` Expected: ${a.contract}`); }
  return obj;
}
const previewAction = (c, action) => adapterFor(c.kind).preview(action, c);

async function perform(store, id, action) {
  const c = store.state.connectors[id]; assert(c, 'Connector not found', 404);
  const a = guard(c); assert(a.perform, `${a.label} does not accept actions.`);
  a.validate(action);
  const limit = a.defaultLimit ? Math.max(1, parseInt(c.config.dailyLimit, 10) || a.defaultLimit) : null;
  if (limit) { const u = c.usage && c.usage.day === today() ? c.usage : { day: today(), n: 0 }; assert(u.n < limit, `Daily limit reached (${limit}). Raise it in the connector settings or wait until tomorrow.`, 429); }
  const r = await run(store, c, () => a.perform(c, secretsOf(c), action));
  if (limit) { const u = c.usage && c.usage.day === today() ? c.usage : { day: today(), n: 0 }; c.usage = { day: u.day, n: u.n + 1 }; }
  store.change('state');
  return r;
}

// Background pull for connectors that feed the ledger. Read-only, so it needs no approval.
async function syncDue(store) {
  for (const c of Object.values(store.state.connectors)) {
    const a = adapterFor(c.kind);
    if (!a || !a.ledger || !c.autoSync || c.status !== 'ready') continue;
    try { await sync(store, c.id); } catch (e) { console.error(`[sync] ${c.name}: ${e.message}`); }
  }
}

// Remove every stored secret for a connector that is being deleted.
function forget(c) {
  const a = adapterFor(c.kind);
  if (a) for (const f of secretFields(a)) secrets.del(vaultKey(c.id, f.key));
  oauth.disconnect(c.id);
}

module.exports = { forget, describe, adapterFor, publicConnector, configure, test, sync, perform, parseAction, previewAction, extractJson, syncDue, secretsOf, missing, oauth };
