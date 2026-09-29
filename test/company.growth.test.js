'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const crypto = require('node:crypto'); const http = require('node:http');
const { mk } = require('./company.helpers');
const routes = require('../sidecar/lib/company/routes');

test('opportunities: ingest filters to real pain, dedupes; scorecard flags low confidence; models ranked', async () => {
  const { co } = mk();
  const added = await co.opportunities.ingest([{ source: 'reddit', title: 'How do I automate invoice follow-ups? so frustrated', engagement: 400, text: 'How do I automate invoice follow-ups' }, { source: 'hn', title: 'Show HN: my cat', engagement: 900, text: 'cat' }]);
  assert.equal(added.length, 1); assert.equal((await co.opportunities.ingest([{ source: 'x', title: 'How do I automate invoice follow-ups? so frustrated', engagement: 1, text: 'How do I automate invoice follow-ups' }])).length, 0);
  const o = await co.opportunities.research(added[0].id); assert.equal(o.scorecard.confidence, 'low');
  const o2 = await co.opportunities.research(added[0].id, { competitors: 3 }); assert.equal(o2.scorecard.basis.competition.startsWith('measured'), true);
  const m = co.opportunities.generateModels(o.id); assert.equal(m.length, 5); assert.ok(m.every((x) => x.unit_margin !== undefined));
});
test('opportunity scanners: HN/Reddit/GitHub scanners exist; custom scanner plugs in', async () => {
  const { co } = mk(); assert.deepEqual(['hackernews', 'reddit', 'github'].every((n) => co.opportunities.scannerNames().includes(n)), true);
  co.opportunities.registerScanner('trends', async () => [{ source: 'trends', title: 'is there a tool for invoice reminders', engagement: 50, text: 'is there a tool for invoice reminders' }]);
  const r = await co.opportunities.scan({ queries: ['invoices'], sources: ['trends'] }); assert.equal(r.added, 1);
});
test('CRM: funnel, conversion by source, why-not-growing from data, retention risks', () => {
  const { co, day } = mk(); const id = co.ventures.create({ name: 'C' }).venture_id;
  for (let i = 0; i < 40; i++) { const p = co.crm.addProspect({ venture_id: id, contact: `p${i}@x.co`, source: i % 2 ? 'linkedin' : 'cold_email' }); co.crm.advance(p.id, 'qualified'); if (i < 20) co.crm.advance(p.id, 'contacted'); if (i < 4) co.crm.advance(p.id, 'replied'); if (i === 1) { co.crm.advance(p.id, 'conversation'); co.crm.advance(p.id, 'proposal'); co.crm.advance(p.id, 'won'); } }
  const by = co.crm.conversionBy('source', id); assert.equal(by[0].key, 'linkedin'); const why = co.crm.whyNotGrowing(id);
  assert.match(why.findings[0].issue, /contacted→replied|qualified→contacted/);
  const c = co.crm.addCustomer({ venture_id: id, name: 'Zed', mrr: 30 }); co.crm.patchCustomer(c.id, { failed_payment: true }); day(15);
  assert.ok(co.crm.retentionRisks(id)[0].reasons.includes('failed payment'));
});
test('memory: experiments → data-driven insights (no invented claims)', () => {
  const { co } = mk(); const id = co.ventures.create({ name: 'M' }).venture_id;
  co.memory.logExperiment({ venture_id: id, action: 'outreach', channel: 'linkedin', cost: 20, visitors: 100, sales: 4, revenue: 200, outcome: 'win' });
  co.memory.logExperiment({ venture_id: id, action: 'outreach', channel: 'cold_email', cost: 40, visitors: 100, sales: 1, revenue: 20, outcome: 'loss' });
  const l = co.memory.learn(id); assert.match(l.insights[0], /linkedin converted 4×/); assert.ok(l.insights.some((x) => /cold_email is losing money/.test(x)));
  assert.match(co.memory.digest(id), /EXPERIMENT/); assert.ok(co.memory.recall(id, 'experiment', 'linkedin').length >= 1);
});
test('payments: signature verification, verified revenue, idempotent retries, refunds', () => {
  const { co, clock } = mk(); const id = co.ventures.create({ name: 'P', capital_allocated: 10 }).venture_id; co.secrets.set('stripe_webhook_secret', 'whsec_test');
  const evt = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'payment', payment_status: 'paid', amount_total: 4900, metadata: { venture_id: id }, customer_details: { email: 'a@b.co', name: 'A' } } } };
  const raw = JSON.stringify(evt); const t = Math.floor(clock.t / 1000); const sig = `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${raw}`).digest('hex')}`;
  assert.equal(co.handleStripeWebhook(raw, `t=${t},v1=deadbeef`).ok, false); assert.equal(co.handleStripeWebhook(raw, `t=${t - 1000},v1=${sig.split('v1=')[1]}`).ok, false);
  assert.equal(co.handleStripeWebhook(raw, sig).ok, true); co.handleStripeWebhook(raw, sig);
  assert.equal(co.ledger.summary({ venture_id: id }).revenue, 49); assert.equal(co.crm.customers(id).length, 1);
  co.payments.handleEvent({ id: 'evt_2', type: 'charge.refunded', data: { object: { amount_refunded: 1000, id: 'ch_1', metadata: { venture_id: id } } } }); assert.equal(co.ledger.summary({ venture_id: id }).net_revenue, 39);
});
test('browser: permission classification + SSRF guard + fake-driver action through gates', async () => {
  const { co } = mk(); const id = co.ventures.create({ name: 'B', capital_allocated: 100, strategy: { browser_write_domains: ['example.com'] } }).venture_id; co.cfo.fund(id, 100);
  const c = (a, url) => co.browser.classify(a, url, id);
  assert.equal(c({ type: 'extract' }, 'https://x.com').level, 0); assert.ok(c({ type: 'goto', url: 'http://127.0.0.1:8787' }).refuse); assert.ok(c({ type: 'goto', url: 'http://169.254.169.254/' }).refuse);
  assert.equal(c({ type: 'click', selector: 'a' }, 'https://other.com').level, 1); assert.equal(c({ type: 'click', selector: 'a' }, 'https://www.example.com/x').level, 2);
  assert.equal(c({ type: 'publish', selector: 'b' }, 'https://other.com').level, 4); assert.equal(c({ type: 'submit', selector: 'b' }, 'https://paypal.com/pay').level, 4);
  assert.equal(c({ type: 'type', selector: '#password', text: 'x' }, 'https://example.com').level, 4);
  co.browser.setDriver({ open: async () => ({}), run: async (h, a) => ({ url: 'https://example.com/p', text: 'page' }) });
  assert.equal((await co.browser.act('a', id, { type: 'extract' })).status, 'done'); assert.equal((await co.browser.act('a', id, { type: 'publish', selector: '#go' })).status, 'pending_approval');
  await assert.rejects(co.browser.fetchPage('http://localhost:1/'), /private/);
});
test('HTTP: lead/event hooks are token-protected and feed validation; Stripe route rejects bad signatures', async () => {
  const { co } = mk(); const v = co.ventures.create({ name: 'H', capital_allocated: 100 }); const id = v.venture_id; co.cfo.fund(id, 100);
  co.ventures.transition(id, 'RESEARCH'); co.ventures.transition(id, 'VALIDATION'); co.validation.start(id, { budget: 100 });
  const srv = http.createServer(async (req, res) => { if (!(await routes.handle(co, req, res))) { res.writeHead(404); res.end(); } }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', body: JSON.stringify(b) });
  assert.equal((await post(`/hooks/lead/${id}/wrong`, { email: 'a@b.co' })).status, 404);
  assert.equal((await post(`/hooks/lead/${id}/${v.lead_token}`, { email: 'a@b.co' })).status, 200); assert.equal((await post(`/hooks/event/${id}/${v.lead_token}`, { type: 'view' })).status, 200);
  assert.equal((await post(`/hooks/lead/${id}/${v.lead_token}`, { email: 'nope' })).status, 400); assert.deepEqual([co.validation.get(id).metrics.leads, co.validation.get(id).metrics.visitors], [1, 1]);
  assert.equal((await post('/hooks/stripe', { x: 1 })).status, 400);
  const ventures = await (await fetch(base + '/api/company/ventures')).json(); assert.ok(!('lead_token' in ventures[0]));
  srv.close();
});
