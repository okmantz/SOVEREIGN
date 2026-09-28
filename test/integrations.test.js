'use strict';
process.env.SOVEREIGN_NO_PERSIST = '1';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../sidecar/lib/store');
const station = require('../sidecar/lib/station');
const director = require('../sidecar/lib/director');
const integrations = require('../sidecar/lib/integrations');
const ledger = require('../sidecar/lib/ledger');
const guardrails = require('../sidecar/lib/guardrails');
const runner = require('../sidecar/lib/runner');
const agents = require('../sidecar/lib/agents');
const secrets = require('../sidecar/lib/secrets');

const realFetch = globalThis.fetch;
const fresh = () => { const s = new Store({ persist: false }); director.ensureDirector(s); return s; };
function stub(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); const r = await handler(String(url), opts); return new Response(JSON.stringify(r.body), { status: r.status || 200 }); };
  return calls;
}
test.afterEach(() => { globalThis.fetch = realFetch; });
const add = (s, kind, config, sec) => { const c = station.createConnector(s.state, { kind }); integrations.configure(s, c.id, { config, secrets: sec }); return c; };

test('secrets are write-only: never in public connector data, blank input keeps the saved value', () => {
  const s = fresh(); const c = add(s, 'stripe', {}, { apiKey: 'rk_test_supersecret' });
  const pub = integrations.publicConnector(c);
  assert.strictEqual(pub.secretsSet.apiKey, true);
  assert.ok(!JSON.stringify(pub).includes('supersecret'));
  integrations.configure(s, c.id, { secrets: { apiKey: '' } });
  assert.strictEqual(integrations.secretsOf(c).apiKey, 'rk_test_supersecret');
  assert.strictEqual(c.status, 'untested');
});

test('an unconfigured connector says exactly what is missing', async () => {
  const s = fresh(); const c = station.createConnector(s.state, { kind: 'shopify' });
  assert.deepStrictEqual(integrations.missing(c), ['Store domain', 'Admin API access token']);
  await assert.rejects(integrations.test(s, c.id), /Still needed: Store domain/);
});

test('Stripe sync records verified revenue, fees and refunds, and is idempotent', async () => {
  const s = fresh(); const c = add(s, 'stripe', {}, { apiKey: 'rk_test_x' });
  s.state.ventures.v1 = { id: 'v1', name: 'V', status: 'testing', maxLossCents: 100000, budgetCents: 100000 }; c.ventureId = 'v1';
  const charges = { data: [
    { id: 'ch_1', created: 1000, paid: true, status: 'succeeded', currency: 'usd', amount: 5000, amount_refunded: 1000, balance_transaction: { fee: 175 } },
    { id: 'ch_2', created: 2000, paid: true, status: 'succeeded', currency: 'eur', amount: 9999 },
    { id: 'ch_3', created: 3000, paid: false, status: 'failed', currency: 'usd', amount: 700 }], has_more: false };
  const calls = stub(() => ({ body: charges }));
  const r1 = await integrations.sync(s, c.id, { now: 5000 * 1000 });
  const p = ledger.pnl(s.state, 'v1');
  assert.strictEqual(p.revenue, 5000); assert.strictEqual(p.cost, 175 + 1000);
  assert.match(r1.summary, /non-USD/);
  assert.ok(calls[0].opts.headers.authorization === 'Bearer rk_test_x');
  const r2 = await integrations.sync(s, c.id, { now: 5000 * 1000 });
  assert.strictEqual(r2.added, 0); assert.strictEqual(ledger.pnl(s.state, 'v1').revenue, 5000);
  assert.ok(s.state.ledger.every((e) => e.verified));
});

test('API errors never leak the token that was in the request', async () => {
  const s = fresh(); const c = add(s, 'meta_ads', { adAccountId: '123' }, { accessToken: 'EAABsecrettoken' });
  stub(() => ({ status: 400, body: { error: { message: 'Invalid OAuth access token' } } }));
  await assert.rejects(integrations.test(s, c.id), (e) => /graph\.facebook\.com said 400/.test(e.message) && !e.message.includes('EAABsecrettoken'));
  assert.strictEqual(c.status, 'error'); assert.ok(!(c.lastError || '').includes('EAABsecrettoken'));
});

test('Facebook Ads sync records completed days of spend as verified costs', async () => {
  const s = fresh(); const c = add(s, 'meta_ads', { adAccountId: 'act_9', currency: 'USD' }, { accessToken: 'tok' });
  stub(() => ({ body: { data: [{ date_start: '2026-09-25', spend: '12.34', clicks: '10', impressions: '900' }, { date_start: '2026-09-26', spend: '0', clicks: '0', impressions: '0' }] } }));
  const r = await integrations.sync(s, c.id, { now: Date.parse('2026-09-28T12:00:00Z') });
  assert.strictEqual(r.added, 1); assert.strictEqual(ledger.pnl(s.state).cost, 1234);
  assert.strictEqual(s.state.ledger.find((e) => e.type === 'cost').source, 'ads.meta');
});

test('Shopify sync counts paid orders and refunds, skipping unpaid and non-USD', async () => {
  const s = fresh(); const c = add(s, 'shopify', { shopDomain: 'https://my-shop.myshopify.com/' }, { accessToken: 'shpat_x' });
  const calls = stub(() => ({ body: { orders: [
    { id: 1, total_price: '40.00', currency: 'USD', created_at: '2026-09-20T10:00:00Z', financial_status: 'paid', refunds: [{ id: 9, transactions: [{ kind: 'refund', amount: '5.00' }] }] },
    { id: 2, total_price: '10.00', currency: 'USD', created_at: '2026-09-21T10:00:00Z', financial_status: 'pending', refunds: [] },
    { id: 3, total_price: '99.00', currency: 'CAD', created_at: '2026-09-22T10:00:00Z', financial_status: 'paid', refunds: [] }] } }));
  await integrations.sync(s, c.id, { now: Date.parse('2026-09-28T00:00:00Z') });
  const p = ledger.pnl(s.state); assert.strictEqual(p.revenue, 4000); assert.strictEqual(p.cost, 500);
  assert.ok(calls[0].url.startsWith('https://my-shop.myshopify.com/admin/api/'));
});

const EMAIL_SEC = { apiKey: 're_test_key' }, EMAIL_CFG = { from: 'Me <me@example.com>', footer: 'Reply STOP to opt out. 1 Main St', dailyLimit: '2' };
const mail = JSON.stringify({ to: 'lead@acme.com', subject: 'Quick idea', body: 'Hi there' });

test('agent output is parsed into an action; prose around the JSON is fine, bad output is rejected with the contract', () => {
  const s = fresh(); const c = add(s, 'email', EMAIL_CFG, EMAIL_SEC);
  assert.strictEqual(integrations.parseAction(c, 'Here you go:\n' + mail + '\nThanks').to, 'lead@acme.com');
  assert.throws(() => integrations.parseAction(c, 'no json here'), /expects/);
  assert.throws(() => integrations.parseAction(c, '{"to":"not-an-email","subject":"x","body":"y"}'), /valid "to"/);
});

test('email goes out through Resend with the footer, and the daily limit is enforced in code', async () => {
  const s = fresh(); const c = add(s, 'email', EMAIL_CFG, EMAIL_SEC);
  const calls = stub(() => ({ body: { id: 'em_1' } }));
  const act = JSON.parse(mail);
  await integrations.perform(s, c.id, act); await integrations.perform(s, c.id, act);
  await assert.rejects(integrations.perform(s, c.id, act), /Daily limit reached \(2\)/);
  const sent = JSON.parse(calls[0].opts.body);
  assert.deepStrictEqual(sent.to, ['lead@acme.com']); assert.match(sent.text, /Reply STOP to opt out/);
  assert.strictEqual(calls.length, 2);
});

test('pipeline to a sink: the action waits for approval, nothing is sent until you approve', async () => {
  const s = fresh(); const c = add(s, 'email', EMAIL_CFG, EMAIL_SEC);
  const hub = agents.createAgent(s.state, { name: 'Herald', role: 'email_marketer' });
  const room = s.state.rooms[s.state.desks[hub.deskId].roomId];
  station.createHallway(s.state, { from: 'inbox', to: 'room:' + room.id });
  station.createHallway(s.state, { from: 'room:' + room.id, to: 'connector:' + c.id });
  const calls = stub(() => ({ body: { id: 'em_2' } }));
  // The agent's prompt carries the output contract for the connector it feeds.
  assert.match(runner.buildSystem(s.state, hub, ['email.send'], { pipeline: true }), /"to":"person@example.com"/);
  s.state.settings.provider.name = 'mock';
  // Mock agents do not emit JSON, so simulate a good agent by driving the connector step directly through a scripted provider.
  const providers = require('../sidecar/lib/providers');
  const orig = providers.complete; providers.complete = async () => ({ text: 'Draft ready.\n' + mail, tokensIn: 1, tokensOut: 1, costCents: 0, model: 'test' });
  try { await runner.dispatch(s, { start: 'inbox', task: 'Write outreach' }); } finally { providers.complete = orig; }
  const pending = s.state.approvals.filter((a) => a.kind === 'connector.call' && a.status === 'pending');
  assert.strictEqual(pending.length, 1); assert.strictEqual(calls.length, 0);
  assert.match(pending[0].detail[0], /To: lead@acme.com/);
  await guardrails.resolveApproval(s, pending[0].id, true);
  assert.strictEqual(calls.length, 1); assert.ok(s.state.outbox.some((o) => o.kind === 'connector-action'));
});

test('with writes set to auto the action is performed immediately', async () => {
  const s = fresh(); const c = add(s, 'notion', { parentPageId: 'abc123' }, { token: 'ntn_x' });
  s.state.settings.policy.connectorWrites = 'auto';
  const hub = agents.createAgent(s.state, { name: 'Quill', role: 'copywriter' });
  const room = s.state.rooms[s.state.desks[hub.deskId].roomId];
  station.createHallway(s.state, { from: 'room:' + room.id, to: 'connector:' + c.id });
  const calls = stub(() => ({ body: { url: 'https://notion.so/p' } }));
  const providers = require('../sidecar/lib/providers'); const orig = providers.complete;
  providers.complete = async () => ({ text: '{"title":"Offer v1","body":"Line one\\n\\nLine two"}', tokensIn: 1, tokensOut: 1, costCents: 0, model: 't' });
  try { await runner.dispatch(s, { start: 'room:' + room.id, task: 'Write the offer' }); } finally { providers.complete = orig; }
  assert.strictEqual(calls.length, 1);
  const body = JSON.parse(calls[0].opts.body); assert.strictEqual(body.parent.page_id, 'abc123'); assert.strictEqual(body.children.length, 2);
});

test('a hallway into a connector is blocked when the room lacks the capability', async () => {
  const s = fresh(); const c = add(s, 'notion', { parentPageId: 'x' }, { token: 't' });
  const room = station.createRoom(s.state, { kind: 'workshop', x: 2, y: 10, w: 8, h: 5 });
  const a = agents.createAgent(s.state, { name: 'B', role: 'builder', deskId: station.createDesk(s.state, { roomId: room.id }).id });
  station.createHallway(s.state, { from: 'room:' + room.id, to: 'connector:' + c.id });
  await runner.dispatch(s, { start: 'room:' + room.id, task: 'go' });
  assert.ok(s.state.outbox.some((o) => o.status === 'blocked' && /Blocked:/.test(o.title)));
});

test('OAuth: token refresh works and a missing sign-in gives a clear instruction', async () => {
  const s = fresh(); const c = add(s, 'calendar', { clientId: 'cid.apps.googleusercontent.com' }, { clientSecret: 'GOCSPX-x' });
  await assert.rejects(integrations.test(s, c.id), /Connect Google Calendar first/);
  secrets.set(`conn:${c.id}:oauth`, JSON.stringify({ access: 'old', refresh: 'r1', expiresAt: Date.now() - 1000 }));
  const calls = stub((url) => url.includes('oauth2.googleapis.com/token') ? { body: { access_token: 'fresh', expires_in: 3600 } } : { body: { summary: 'Work' } });
  const r = await integrations.test(s, c.id);
  assert.match(r.detail, /Work/);
  assert.ok(calls[0].opts.body.includes('grant_type=refresh_token')); assert.strictEqual(calls[1].opts.headers.authorization, 'Bearer fresh');
});

test('connectors from v0.1 state are upgraded and the old ads kind becomes Facebook Ads', () => {
  const s = fresh();
  s.state.connectors.old = { id: 'old', kind: 'ads', name: 'Ads', x: 3, y: 3 };
  s.state.settings.policy = { directorStructure: 'ask', firstOutreachApproval: false };
  assert.ok(agents.migrate(s.state));
  assert.strictEqual(s.state.connectors.old.kind, 'meta_ads'); assert.strictEqual(s.state.connectors.old.status, 'unconfigured');
  assert.strictEqual(s.state.settings.policy.connectorWrites, 'auto');
});
