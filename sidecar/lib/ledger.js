'use strict';
// The money truth layer. Product law: the interface never asserts revenue the harness cannot prove.
//  - "verified" entries come only from signed connector webhooks or from the harness itself (model spend).
//  - Anything an agent merely says it earned is stored as a *claim* and never counts toward profit.
const crypto = require('crypto');
const { id, assert, int } = require('./util');
const secrets = require('./secrets');

const VERIFIED_SOURCES = new Set(['stripe', 'paypal', 'shopify', 'ads.meta', 'ads.google', 'bank', 'harness.model']);

function add(store, e) {
  const state = store.state;
  const source = String(e.source || 'agent');
  assert(e.type === 'revenue' || e.type === 'cost', 'Entry type must be revenue or cost.');
  const amountCents = Math.abs(int(e.amountCents));
  assert(amountCents > 0, 'Amount must be more than zero.');
  if (e.ventureId) assert(state.ventures[e.ventureId], 'Unknown venture.', 404);
  if (e.ref && state.ledger.some((x) => x.ref === e.ref && x.source === source)) return null; // idempotent
  const entry = {
    id: id('led'), at: Date.now(), ventureId: e.ventureId || null, type: e.type, amountCents,
    source, ref: e.ref || null, note: String(e.note || '').slice(0, 200),
    verified: VERIFIED_SOURCES.has(source) && e.verified !== false
  };
  state.ledger.push(entry);
  if (state.ledger.length > 5000) state.ledger.splice(0, state.ledger.length - 5000);
  store.change('ledger', { entryId: entry.id });
  return entry;
}

// Agents can only ever claim. Source is forced so a prompt-injected agent cannot forge "stripe".
const claim = (store, e) => add(store, { ...e, source: 'agent', verified: false });

function pnl(state, ventureId) {
  const rows = state.ledger.filter((e) => (ventureId === undefined ? true : e.ventureId === (ventureId || null)));
  const sum = (f) => rows.filter(f).reduce((s, e) => s + e.amountCents, 0);
  const revenue = sum((e) => e.verified && e.type === 'revenue');
  const cost = sum((e) => e.verified && e.type === 'cost');
  return { revenue, cost, net: revenue - cost, claimedRevenue: sum((e) => !e.verified && e.type === 'revenue') };
}

function progress(state) {
  const m = state.mission;
  const p = pnl(state);
  const target = m ? m.targetCents : 0;
  return { targetCents: target, netCents: p.net, revenueCents: p.revenue, costCents: p.cost, claimedCents: p.claimedRevenue,
    pct: target > 0 ? Math.max(0, Math.min(100, Math.round((p.net / target) * 100))) : 0 };
}

// Kill rule: a venture whose verified net loss reaches its limit is stopped. No agent gets a vote.
function evaluateVentures(store) {
  let changed = false;
  for (const v of Object.values(store.state.ventures)) {
    if (v.status === 'killed') continue;
    const net = pnl(store.state, v.id).net;
    if (net <= -Math.abs(v.maxLossCents)) {
      v.status = 'killed'; v.killedReason = 'Reached its loss limit'; v.killedAt = Date.now(); changed = true;
    }
  }
  if (changed) store.change('state');
  return changed;
}

// Signed webhook ingestion. Body is normalized: { ventureId, type, amountCents, ref, note }.
function ingest(store, connector, rawBody, signature) {
  assert(VERIFIED_SOURCES.has(connector) && connector !== 'harness.model', 'Unknown ledger source.', 404);
  const secret = secrets.get('ingest');
  assert(secret, 'No ingest secret set. Create one in Settings → Money.', 401);
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = Buffer.from(String(signature || ''), 'utf8'), want = Buffer.from(expected, 'utf8');
  assert(given.length === want.length && crypto.timingSafeEqual(given, want), 'Bad signature.', 401);
  let body; try { body = JSON.parse(rawBody); } catch (_) { assert(false, 'Body must be JSON.'); }
  const entry = add(store, { ventureId: body.ventureId, type: body.type, amountCents: body.amountCents, ref: body.ref, note: body.note, source: connector });
  evaluateVentures(store);
  return entry;
}

module.exports = { VERIFIED_SOURCES, add, claim, pnl, progress, evaluateVentures, ingest };
