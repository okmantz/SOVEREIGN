'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fresh, stub, restore } = require('./helpers');
const station = require('../sidecar/lib/station');
const integrations = require('../sidecar/lib/integrations');
const oauth = require('../sidecar/lib/integrations/oauth');
const ledger = require('../sidecar/lib/ledger');
const runner = require('../sidecar/lib/runner');
const guardrails = require('../sidecar/lib/guardrails');
const agents = require('../sidecar/lib/agents');

test.afterEach(restore);
const add = (view, kind, config, sec) => { const c = station.createConnector(view.state, { kind }); integrations.configure(view, c.id, { config, secrets: sec }); return c; };
const act = async (view, c, action) => integrations.perform(view, c.id, integrations.parseAction(c, JSON.stringify(action)));

test('Slack and Discord post through their webhooks; oversized or empty messages are rejected before any request', async () => {
  const { view } = fresh(); const sl = add(view, 'slack', {}, { webhookUrl: 'https://hooks.slack.com/services/T/B/x' }), dc = add(view, 'discord', {}, { webhookUrl: 'https://discord.com/api/webhooks/1/x' });
  const calls = stub(() => ({ body: {} }));
  await act(view, sl, { text: 'Milestone done' }); await act(view, dc, { text: 'Milestone done' });
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { text: 'Milestone done' }); assert.deepStrictEqual(JSON.parse(calls[1].opts.body), { content: 'Milestone done' });
  await assert.rejects(() => act(view, sl, { text: '' }), /needs "text"/); await assert.rejects(() => act(view, dc, { text: 'x'.repeat(2000) }), /under 1900/);
  assert.strictEqual(calls.length, 2);
});

test('Telegram sends from your bot to your chat, and errors never leak the bot token', async () => {
  const { view } = fresh(); const c = add(view, 'telegram', { chatId: '42' }, { botToken: '123:SECRETTOKEN' });
  const calls = stub(() => ({ body: { ok: true } }));
  await act(view, c, { text: 'Hello' });
  assert.match(calls[0].url, /api\.telegram\.org\/bot123:SECRETTOKEN\/sendMessage/); assert.strictEqual(JSON.parse(calls[0].opts.body).chat_id, '42');
  stub(() => ({ status: 401, body: { description: 'Unauthorized' } }));
  await assert.rejects(() => act(view, c, { text: 'Hello' }), (e) => !/SECRETTOKEN/.test(e.message));
});

test('Webhook posts your JSON payload as-is and rejects non-objects', async () => {
  const { view } = fresh(); const c = add(view, 'webhook', {}, { url: 'https://example.com/hook?token=abc' });
  const calls = stub(() => ({ body: {} }));
  await act(view, c, { payload: { lead: 'Acme', score: 4 } });
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { lead: 'Acme', score: 4 });
  await assert.rejects(() => act(view, c, { payload: 'text' }), /needs a "payload" object/);
  assert.ok(!JSON.stringify(integrations.publicConnector(c)).includes('token=abc'), 'the URL is a secret and is never shown');
});

test('Airtable adds a row to the configured table with typecast on', async () => {
  const { view } = fresh(); const c = add(view, 'airtable', { baseId: 'appX', table: 'Leads' }, { token: 'pat_x' });
  const calls = stub(() => ({ body: {} }));
  await act(view, c, { fields: { Name: 'Acme', Status: 'New' } });
  assert.match(calls[0].url, /api\.airtable\.com\/v0\/appX\/Leads$/); assert.strictEqual(calls[0].opts.headers.authorization, 'Bearer pat_x');
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body).records[0].fields, { Name: 'Acme', Status: 'New' });
  await assert.rejects(() => act(view, c, { fields: {} }), /needs a "fields" object/);
});

test('Google Sheets appends a row to the chosen sheet and range', async () => {
  const { view } = fresh(); const c = add(view, 'sheets', { clientId: 'cid.apps.googleusercontent.com', spreadsheetId: 'SHEET1', range: 'Leads!A:C' }, { clientSecret: 'GOCSPX-x' });
  const orig = oauth.accessToken; oauth.accessToken = async () => 'tok';
  try {
    const calls = stub(() => ({ body: {} }));
    await act(view, c, { row: ['Acme', 'New', 3] });
    assert.match(calls[0].url, /spreadsheets\/SHEET1\/values\/Leads!A%3AC:append\?valueInputOption=USER_ENTERED/); assert.deepStrictEqual(JSON.parse(calls[0].opts.body).values, [['Acme', 'New', 3]]);
    await assert.rejects(() => act(view, c, { row: [] }), /"row" array/);
  } finally { oauth.accessToken = orig; }
});

test('WooCommerce sync records completed orders and refunds as verified, skips non-USD, and is idempotent', async () => {
  const { view } = fresh(); const c = add(view, 'woocommerce', { siteUrl: 'https://shop.example.com' }, { consumerKey: 'ck_1', consumerSecret: 'cs_1' });
  view.state.ventures.v1 = { id: 'v1', name: 'V', status: 'testing', maxLossCents: 1e5, budgetCents: 1e5 }; c.ventureId = 'v1';
  const orders = [{ id: 1, total: '40.00', currency: 'USD', date_created_gmt: '2026-09-20T10:00:00', refunds: [{ total: '-10.00' }] }, { id: 2, total: '25.00', currency: 'EUR', date_created_gmt: '2026-09-21T10:00:00', refunds: [] }];
  const calls = stub(() => ({ body: orders }));
  const r = await integrations.sync(view, c.id, { now: Date.parse('2026-09-28') });
  const p = ledger.pnl(view.state, 'v1'); assert.strictEqual(p.revenue, 4000); assert.strictEqual(p.cost, 1000); assert.match(r.summary, /non-USD/);
  assert.match(calls[0].opts.headers.authorization, /^Basic /); assert.match(calls[0].url, /^https:\/\/shop\.example\.com\/wp-json\/wc\/v3\/orders/);
  const r2 = await integrations.sync(view, c.id, { now: Date.parse('2026-09-28') }); assert.strictEqual(r2.added, 0);
  await assert.rejects(() => integrations.test(view, add(view, 'woocommerce', { siteUrl: 'http://insecure.example.com' }, { consumerKey: 'a', consumerSecret: 'b' }).id), /https/);
});

test('Gumroad sync counts sales and fees, ignoring refunded and charged-back sales', async () => {
  const { view } = fresh(); const c = add(view, 'gumroad', {}, { accessToken: 'gr_x' });
  view.state.ventures.v1 = { id: 'v1', name: 'V', status: 'testing', maxLossCents: 1e5, budgetCents: 1e5 }; c.ventureId = 'v1';
  stub(() => ({ body: { success: true, sales: [
    { id: 's1', price: 2900, gumroad_fee: 435, currency: 'usd', created_at: '2026-09-25T10:00:00Z' }, { id: 's2', price: 2900, currency: 'usd', refunded: true, created_at: '2026-09-25T11:00:00Z' },
    { id: 's3', price: 900, currency: 'usd', chargedback: true, created_at: '2026-09-25T12:00:00Z' }, { id: 's4', price: 1500, currency: 'eur', created_at: '2026-09-25T13:00:00Z' }] } }));
  await integrations.sync(view, c.id, { now: Date.parse('2026-09-28') });
  const p = ledger.pnl(view.state, 'v1'); assert.strictEqual(p.revenue, 2900); assert.strictEqual(p.cost, 435);
  assert.ok(view.state.ledger.every((e) => e.verified), 'gumroad is a verified source');
});

test('every new sink waits for approval by default; nothing is sent until you approve', async () => {
  const { view } = fresh(); const c = add(view, 'slack', {}, { webhookUrl: 'https://hooks.slack.com/services/T/B/x' });
  const hub = agents.createAgent(view.state, { name: 'Ops', role: 'ops' }); const room = view.state.rooms[view.state.desks[hub.deskId].roomId];
  station.createHallway(view.state, { from: 'room:' + room.id, to: 'connector:' + c.id });
  const calls = stub(() => ({ body: {} }));
  const providers = require('../sidecar/lib/providers'), orig = providers.complete;
  providers.complete = async () => ({ text: '{"text":"Weekly plan ready"}', tokensIn: 1, tokensOut: 1, costCents: 0, model: 't' });
  try { await runner.dispatch(view, { start: 'room:' + room.id, task: 'Post the plan' }); } finally { providers.complete = orig; }
  assert.strictEqual(calls.length, 0); const ap = view.state.approvals.find((a) => a.status === 'pending'); assert.ok(ap);
  await guardrails.resolveApproval(view, ap.id, true); assert.strictEqual(calls.length, 1);
});

test('a portal is a real connector kind that is always ready and cannot be configured with secrets', () => {
  const { view } = fresh(); const c = station.createConnector(view.state, { kind: 'portal', name: 'To Trading' });
  assert.ok(integrations.describe().portal.live); assert.strictEqual(integrations.publicConnector(c).kind, 'portal');
});
