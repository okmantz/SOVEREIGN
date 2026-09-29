'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const http = require('node:http');
const { mk } = require('./company.helpers');
const { classify, stripQuoted } = require('../sidecar/lib/company/lifecycle');
const { allowed } = require('../sidecar/lib/company/tunnel');

const DAY = 86400000;
/** A company with a test mail rail that records what "went out", a footer, and an open send window. */
function setup(opts = {}) {
  const t = mk({ llm: opts.llm || null, settings: { mail: { provider: 'test', window: { start: 0, end: 24 }, daily_limit: 25 } } });
  const sent = []; t.co.mail.registerMailer('test', async (m) => { sent.push(m); return { id: 'm' + sent.length }; });
  t.co.secrets.set('mail_footer', 'Reply STOP to opt out. Acme, 1 Main St, Town'); t.co.secrets.set('owner_email', 'owner@acme.test');
  const id = t.co.ventures.create({ name: 'Acme Reports', type: 'service', capital_allocated: 100 }).venture_id; t.co.cfo.fund(id, 100);
  return { ...t, sent, id };
}
const sub = (id, o = {}) => ({ id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active', metadata: { venture_id: id }, items: { data: [{ quantity: 1, price: { unit_amount: 9900, recurring: { interval: 'month', interval_count: 1 } } }] }, ...o });
const checkout = (id, o = {}, evtId = 'evt_co1') => ({ id: evtId, type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'subscription', payment_status: 'paid', amount_total: 9900, customer: 'cus_1', subscription: 'sub_1', metadata: { venture_id: id }, customer_details: { email: 'ann@client.test', name: 'Ann Lee' }, ...o } } });
const invoice = (id, evtId, o = {}) => ({ id: evtId, type: 'invoice.paid', data: { object: { id: 'in_' + evtId, object: 'invoice', customer: 'cus_1', subscription: 'sub_1', customer_email: 'ann@client.test', amount_paid: 9900, billing_reason: 'subscription_cycle', subscription_details: { metadata: { venture_id: id } }, ...o } } });

test('renewals: invoice.paid books verified revenue once, the first invoice is not double counted', () => {
  const { co, id } = setup();
  co.payments.handleEvent(checkout(id)); const c = co.crm.customers(id)[0]; assert.equal(c.stripe_subscription, 'sub_1');
  co.payments.handleEvent(invoice(id, 'evt_first', { billing_reason: 'subscription_create' })); assert.equal(co.ledger.summary({ venture_id: id }).revenue, 99);
  const r = co.payments.handleEvent(invoice(id, 'evt_r1')); assert.equal(r.renewal, true); assert.equal(co.ledger.summary({ venture_id: id }).revenue, 198);
  assert.equal(co.payments.handleEvent(invoice(id, 'evt_r1')).duplicate, true); assert.equal(co.ledger.summary({ venture_id: id }).revenue, 198); // webhook + poller may both deliver
  assert.equal(co.crm.customers(id)[0].mrr, 99);
});
test('churn is marked from Stripe: deleted subscription zeroes MRR; scheduled cancellation is flagged and can be reverted; re-checkout reactivates', () => {
  const { co, id } = setup(); co.payments.handleEvent(checkout(id)); const c = co.crm.customers(id)[0];
  co.payments.handleEvent({ id: 'evt_u1', type: 'customer.subscription.updated', data: { object: sub(id, { cancel_at_period_end: true }) } });
  assert.equal(co.crm.customers(id)[0].cancel_pending, true); assert.ok(co.crm.retentionRisks(id)[0].reasons.includes('cancellation scheduled'));
  assert.ok(co.lifecycle.enrollments({ sequence: 'churn_save' }).length === 1);
  co.payments.handleEvent({ id: 'evt_u2', type: 'customer.subscription.updated', data: { object: sub(id, { cancel_at_period_end: false }) } });
  assert.equal(co.crm.customers(id)[0].cancel_pending, false); assert.equal(co.lifecycle.enrollments({ sequence: 'churn_save', status: 'active' }).length, 0);
  const r = co.payments.handleEvent({ id: 'evt_d1', type: 'customer.subscription.deleted', data: { object: sub(id, { status: 'canceled' }) } });
  assert.equal(r.churned, true); const after = co.crm.customers(id)[0]; assert.equal(after.churned, true); assert.equal(after.mrr, 0);
  assert.equal(co.lifecycle.enrollments({ sequence: 'winback', status: 'active' }).length, 1);
  co.payments.handleEvent(checkout(id, { id: 'cs_2' }, 'evt_co2')); assert.equal(co.crm.customers(id).length, 1); assert.equal(co.crm.customers(id)[0].churned, false);
  assert.equal(co.lifecycle.enrollments({ sequence: 'winback', status: 'active' }).length, 0);
  void c;
});
test('dunning: 3 steps over 7 days after a failed payment, stops the moment the payment recovers', async () => {
  const { co, id, day, sent } = setup(); co.payments.handleEvent(checkout(id)); co.mail.list({ status: 'draft' }).forEach((m) => co.mail.reject(m.id));
  co.payments.handleEvent({ id: 'evt_f1', type: 'invoice.payment_failed', data: { object: { id: 'in_f', object: 'invoice', customer: 'cus_1', subscription: 'sub_1', customer_email: 'ann@client.test', attempt_count: 1, subscription_details: { metadata: { venture_id: id } } } } });
  assert.equal(co.crm.customers(id)[0].failed_payment, true);
  await co.lifecycle.runDue(); let d = co.mail.list({ status: 'draft' }).filter((m) => m.sequence === 'dunning'); assert.equal(d.length, 1); assert.equal(d[0].step, 'd0'); assert.equal(d[0].priority, 'fast');
  day(3); await co.lifecycle.runDue(); day(4); await co.lifecycle.runDue(); d = co.mail.list({ status: 'draft' }).filter((m) => m.sequence === 'dunning'); assert.deepEqual(d.map((m) => m.step), ['d0', 'd3', 'd7']);
  assert.equal(sent.length, 0); // nothing goes out unapproved
  const { co: c2, id: id2, day: day2 } = setup(); c2.payments.handleEvent(checkout(id2));
  c2.payments.handleEvent({ id: 'evt_f2', type: 'invoice.payment_failed', data: { object: { id: 'in_f2', object: 'invoice', customer: 'cus_1', subscription: 'sub_1', customer_email: 'ann@client.test', attempt_count: 1, subscription_details: { metadata: { venture_id: id2 } } } } });
  await c2.lifecycle.runDue(); c2.payments.handleEvent(invoice(id2, 'evt_ok')); assert.equal(c2.crm.customers(id2)[0].failed_payment, false); day2(3); await c2.lifecycle.runDue();
  assert.equal(c2.mail.list({ status: 'draft' }).filter((m) => m.sequence === 'dunning').length, 1); // only d0 was ever drafted
});
test('outreach follow-ups: touch 2 on day 3, touch 3 on day 7, stops when the prospect replies; opt-out is honoured', async () => {
  const { co, id, day } = setup();
  const p = co.crm.addProspect({ venture_id: id, name: 'Bo Kim', contact: 'bo@lead.test', problem: 'late invoices' }); co.crm.advance(p.id, 'qualified'); co.crm.advance(p.id, 'contacted', 'touch 1 sent');
  await co.lifecycle.runDue(); assert.equal(co.mail.list().length, 0); day(3); await co.lifecycle.runDue(); assert.equal(co.mail.list()[0].step, 'touch2'); assert.match(co.mail.list()[0].body, /Bo/);
  day(4); await co.lifecycle.runDue(); assert.deepEqual(co.mail.list().map((m) => m.step), ['touch2', 'touch3']);
  const q = co.crm.addProspect({ venture_id: id, name: 'Cy', contact: 'cy@lead.test' }); co.crm.advance(q.id, 'contacted'); co.crm.advance(q.id, 'replied'); day(5); await co.lifecycle.runDue();
  assert.equal(co.mail.list().filter((m) => m.to === 'cy@lead.test').length, 0);
  const z = co.crm.addProspect({ venture_id: id, name: 'Zed', contact: 'zed@lead.test' }); co.crm.advance(z.id, 'contacted'); co.mail.unsubscribe('zed@lead.test'); day(3); await co.lifecycle.runDue();
  assert.equal(co.mail.list().filter((m) => m.to === 'zed@lead.test').length, 0);
});
test('mail law: approval required, footer required, unsubscribe link, hard daily limit, opted-out skipped', async () => {
  const { co, id, sent } = setup(); co.setSettings({ mail: { daily_limit: 2 } });
  const q = (to, kind = 'sequence') => co.mail.queue({ venture_id: id, to, subject: 's', body: 'hello there', kind });
  const a = q('a@x.test'); assert.equal(a.status, 'draft'); await co.mail.flush(); assert.equal(sent.length, 0);
  co.mail.approve(a.id); co.mail.approve(q('b@x.test').id); co.mail.approve(q('c@x.test').id); const r = await co.mail.flush(); assert.equal(r.sent, 2); assert.equal(r.held, 1);
  assert.match(sent[0].text, /Unsubscribe: http/); assert.match(sent[0].text, /Acme, 1 Main St/); assert.ok(sent[0].unsub);
  const { co: c2, id: id2 } = setup(); c2.secrets.set('mail_footer', ''); c2.setSettings({ mail: { footer: '' } });
  const m = c2.mail.queue({ venture_id: id2, to: 'n@x.test', subject: 's', body: 'b', status: 'approved' }); await c2.mail.flush(); assert.equal(c2.mail.get(m.id).status, 'failed'); assert.match(c2.mail.get(m.id).error, /footer/);
  const tok = co.mail.unsubLink(id, 'd@x.test').split('/hooks/unsub/')[1].split('/'); assert.equal(co.mail.verifyUnsub(tok[0], tok[1], tok[2]), 'd@x.test'); assert.equal(co.mail.verifyUnsub(tok[0], 'bad', tok[2]), null);
  const d = q('d@x.test'); co.mail.approve(d.id); co.mail.unsubscribe('d@x.test'); assert.equal(co.mail.get(d.id).status, 'skipped');
});
test('retainer engine: paid → cycle → agent produces → quality gate → ONE approval → e-mailed + portal → delivered; unpaid customers are not served', async () => {
  const llm = async () => 'Weekly summary for the customer.\n\nWhat happened: traffic grew and two leads replied. What it means: the outreach message is working; keep it. Next actions: 1) double the sends on the winning message, 2) follow up with both leads within a day, 3) test one new subject line. All figures come from the customer notes provided.';
  const { co, id, sent, day } = setup({ llm });
  co.retainer.define(id, { template: 'weekly_report', price: 99, upsell: { name: 'Pro tier', price: 199, pitch: 'It adds a monthly strategy call.', after_cycles: 1 } });
  co.payments.handleEvent(checkout(id)); const cust = co.crm.customers(id)[0]; co.crm.patchCustomer(cust.id, { profile: { notes: 'We sell yoga classes' } });
  assert.equal(co.retainer.cycles({ venture_id: id }).length, 1); assert.equal(co.directives.list({ venture_id: id }).length, 0); // no generic task: the delivery loop owns it
  await co.retainer.tick(); const cy = co.retainer.cycles({ venture_id: id })[0]; assert.equal(cy.status, 'awaiting_approval'); assert.equal(cy.placeholder, false); assert.deepEqual(cy.qc_issues, []);
  const dg = co.lifecycle.digest(); assert.ok(dg.items.some((i) => i.kind === 'delivery' && i.bulk_ok));
  const before = sent.length; const r = await co.lifecycle.approveBatch({ all_safe: true }); assert.equal(r.approvals, 1);
  const d = co.mail.list({ kind: 'delivery' }); assert.equal(d.length, 1); assert.equal(sent.filter((m) => /Weekly performance report/.test(m.subject)).length, 1); assert.ok(sent.length > before);
  assert.equal(co.retainer.cycle(cy.id).status, 'delivered'); assert.equal(co.crm.customers(id)[0].delivered_cycles, 1);
  const html = co.retainer.portalFile(id, cust.portal_token, cy.id + '.html'); assert.match(String(html), /Weekly report/); assert.equal(co.retainer.portalFile(id, 'a'.repeat(32), cy.id + '.html'), null); assert.equal(co.retainer.portalFile(id, cust.portal_token, '../../x'), null);
  assert.equal(co.retainer.upsellCandidates(id).length, 1);
  day(7); await co.retainer.tick(); assert.equal(co.retainer.cycles({ venture_id: id }).length, 2); // next cycle, next period
  co.crm.patchCustomer(cust.id, { failed_payment: true, failed_attempts: 3 }); await co.retainer.tick(); const held = co.retainer.cycles({ venture_id: id }).filter((c) => c.status === 'awaiting_approval').length; day(8); await co.retainer.tick();
  assert.equal(co.retainer.cycles({ venture_id: id }).filter((c) => c.status === 'awaiting_approval').length, held); // nothing new is produced for a customer whose payment keeps failing
});
test('retainer without a model: placeholder, flagged, never bulk-approvable; a rejected cycle is revised, then handed to a human after the limit', async () => {
  const { co, id } = setup(); co.retainer.define(id, { template: 'lead_list', price: 49 }); co.payments.handleEvent(checkout(id)); await co.retainer.tick();
  const cy = co.retainer.cycles({ venture_id: id })[0]; assert.equal(cy.placeholder, true); const it = co.lifecycle.digest().items.find((i) => i.kind === 'delivery'); assert.equal(it.bulk_ok, false);
  assert.equal((await co.lifecycle.approveBatch({ all_safe: true })).approvals, 0);
  for (let i = 0; i < 3; i++) { const a = co.permissions.pending().find((x) => x.type === 'delivery'); assert.ok(a); await co.resolveApproval(a.id, false, 'too thin'); await co.retainer.tick(); }
  assert.equal(co.retainer.cycle(cy.id).status, 'failed'); assert.ok(co.crm.tickets(id, 'open').length >= 1);
});
test('inbound: pricing question gets a reply with price + payment link in seconds; STOP unsubscribes; a bare score is recorded; OOO pauses sequences', async () => {
  const { co, id } = setup(); co.retainer.define(id, { template: 'weekly_report', price: 99 }); co.setSettings({ pages: { checkout_url: 'https://pay.test/abc', company_name: 'Acme', refund_days: 7 } });
  const p = co.crm.addProspect({ venture_id: id, name: 'Dee Ray', contact: 'dee@lead.test' }); co.crm.advance(p.id, 'contacted');
  const r = await co.lifecycle.handleInbound({ venture_id: id, from: 'Dee Ray <dee@lead.test>', subject: 'Re: hello', text: 'Hi, how much does this cost per month?\n\nOn Tue, Jan 1 Acme wrote:\n> old text' });
  assert.equal(r.intent, 'pricing'); assert.ok(r.ms < 2000); const m = co.mail.get(r.mail_id); assert.equal(m.status, 'draft'); assert.equal(m.priority, 'fast'); assert.match(m.body, /\$99 per week/); assert.match(m.body, /https:\/\/pay\.test\/abc/); assert.match(m.body, /refund/);
  assert.equal(co.crm.prospects(id)[0].status, 'conversation'); assert.equal(co.lifecycle.enrollments({ sequence: 'outreach', status: 'active' }).length, 0);
  co.setSettings({ mail: { auto_reply_pricing: true } }); const sent0 = m.id;
  const r2 = await co.lifecycle.handleInbound({ venture_id: id, from: 'new@lead.test', subject: 'price?', text: 'What is your pricing' }); assert.equal(co.mail.get(r2.mail_id).status, 'sent'); assert.notEqual(r2.mail_id, sent0);
  const s = await co.lifecycle.handleInbound({ venture_id: id, from: 'dee@lead.test', subject: 'x', text: 'Please unsubscribe me' }); assert.equal(s.intent, 'stop'); assert.equal(co.mail.isUnsubscribed('dee@lead.test'), true);
  co.payments.handleEvent(checkout(id)); await co.lifecycle.handleInbound({ venture_id: id, from: 'ann@client.test', subject: 'Re: check-in', text: '4' }); assert.equal(co.crm.customers(id)[0].satisfaction, 4);
  assert.equal(classify('Out of office until Monday'), 'ooo'); assert.equal(classify('Sounds good, let\'s talk'), 'interested'); assert.equal(stripQuoted('yes\n> old\nmore'), 'yes');
});
test('digest: one batch; safe items approve together; flagged items wait for a person; owner is told once a day', async () => {
  const { co, id, sent } = setup(); for (const to of ['a@x.test', 'b@x.test']) co.mail.queue({ venture_id: id, to, subject: 'hi', body: 'a plain note' });
  co.mail.queue({ venture_id: id, to: 'c@x.test', subject: 'needs eyes', body: 'check this', flags: ['no_payment_link'] });
  const d = co.lifecycle.digest(); assert.equal(d.counts.total, 3); assert.equal(d.counts.safe_to_bulk_approve, 2); assert.equal(d.counts.needs_reading, 1); assert.ok(d.est_minutes >= 1);
  const r = await co.lifecycle.approveBatch({ all_safe: true }); assert.equal(r.mail, 2); assert.equal(sent.length, 2); assert.equal(co.mail.list({ status: 'draft' }).length, 1);
  assert.ok(co.lifecycle.notifyDigest().notified); const n = co.mail.list({ kind: 'owner_digest' }).length; co.lifecycle.notifyDigest(); assert.equal(co.mail.list({ kind: 'owner_digest' }).length, n);
});
test('guardrail: ads freeze below LTV/CAC 3 and the CFO refuses marketing spend; scaling is blocked while MRR does not cover cost', () => {
  const { co, id } = setup(); co.ventures.transition(id, 'RESEARCH'); co.ventures.transition(id, 'VALIDATION'); co.ventures.transition(id, 'BUILD'); co.ventures.transition(id, 'LAUNCH'); co.ventures.transition(id, 'TRACTION');
  co.crm.addCustomer({ venture_id: id, email: 'k@x.test', mrr: 20 }); co.ledger.record({ venture_id: id, category: 'marketing', amount: 600, source: 'meta_ads', ref: 'a1' }); co.ledger.record({ venture_id: id, category: 'revenue', amount: 20, source: 'stripe', ref: 's1' });
  co.ceo.refresh(id); const g = co.ceo.applyGuardrail(id); assert.equal(g.ads_frozen, true); assert.equal(g.scale_ok, false); assert.match(g.reasons[0], /LTV\/CAC/);
  assert.equal(co.ventures.get(id).strategy.ads_frozen, true); const dec = co.cfo.evaluate({ venture_id: id, amount: 5, category: 'marketing', purpose: 'ads' }); assert.equal(dec.decision, 'DENIED'); assert.match(dec.reason, /frozen/);
  assert.doesNotMatch(co.cfo.evaluate({ venture_id: id, amount: 5, category: 'software', purpose: 'tool' }).reason, /frozen/); // only marketing is frozen
});
test('event poller: subscription events arrive without a webhook or tunnel, idempotently', async () => {
  const { co, id } = setup(); co.secrets.set('stripe_secret_key', 'sk_test_x'); const evs = [checkout(id), invoice(id, 'evt_p1'), { id: 'evt_p2', type: 'customer.subscription.deleted', data: { object: sub(id, { status: 'canceled' }) } }].map((e, i) => ({ ...e, created: 1_800_000_000 + i }));
  const real = global.fetch; let calls = 0; global.fetch = async (url) => { calls++; assert.match(String(url), /\/v1\/events/); return { ok: true, json: async () => ({ data: [...evs].reverse(), has_more: false }) }; };
  try { const r = await co.payments.pollEvents(); assert.equal(r.fetched, 3); assert.equal(r.handled, 3); assert.equal(co.crm.customers(id)[0].churned, true); assert.equal(co.ledger.summary({ venture_id: id }).revenue, 198);
    const r2 = await co.payments.pollEvents(); assert.equal(r2.handled, 0); assert.equal(co.ledger.summary({ venture_id: id }).revenue, 198); assert.ok(calls >= 2);
  } finally { global.fetch = real; }
});
test('tunnel gateway exposes ONLY the public paths, never the control API', () => {
  for (const [m, p] of [['POST', '/hooks/stripe'], ['POST', '/hooks/reply/v_1/tok_1'], ['GET', '/hooks/status/v_1'], ['GET', '/venture/v_1/index.html'], ['GET', '/hooks/portal/v_1/' + 'a'.repeat(24) + '/x.html']]) assert.equal(allowed(m, p), true, p);
  for (const [m, p] of [['GET', '/api/company/dashboard'], ['POST', '/api/company/settings'], ['POST', '/api/company/secrets'], ['GET', '/api/company/digest'], ['GET', '/'], ['GET', '/hooks/stripe']]) assert.equal(allowed(m, p), false, p);
});
test('tunnel: quick tunnel URL is captured, the Stripe webhook is registered once and kept in sync; a missing cloudflared fails with a clear message', async () => {
  const { EventEmitter } = require('node:events'); const { co } = setup(); co.secrets.set('stripe_secret_key', 'sk_test_x');
  const fake = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => p.emit('exit', 0); setImmediate(() => p.stderr.emit('data', 'INF |  https://blue-fox-1234.trycloudflare.com  |')); return p; };
  const api = require('../sidecar/lib/company/tunnel').makeTunnel;
  const calls = []; const ctxObj = { now: co.now, spawnImpl: fake, settings: co.settings, secrets: co.secrets, emit: co.emit, publicUrl: () => t2.url(), payments: { stripe: async (m, p, b) => { calls.push([m, p]); if (m === 'GET') return { data: [] }; return { id: 'we_1', secret: 'whsec_new' }; } } };
  const t2 = api(ctxObj, co); co.setSettings({ tunnel: { enabled: true, mode: 'quick', auto_register_webhook: true } });
  const s = await t2.start(); assert.equal(s.url, 'https://blue-fox-1234.trycloudflare.com'); assert.equal(co.secrets._get('stripe_webhook_secret'), 'whsec_new'); assert.ok(calls.some(([m, p]) => m === 'POST' && p === '/webhook_endpoints'));
  t2.stop(); await t2.close();
  const t3 = api({ ...ctxObj, spawnImpl: () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); setImmediate(() => p.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))); return p; } }, co);
  await assert.rejects(() => t3.start(), /cloudflared is not installed/); await t3.close();
});
test('hosted pages: offer, status, refund policy and terms are generated from settings; status has aggregates only (no customer data)', async () => {
  const { co, id } = setup(); co.retainer.define(id, { template: 'content_batch', price: 149 });
  co.setSettings({ pages: { company_name: 'Acme', support_email: 'help@acme.test', postal_address: '1 Main St', refund_days: 14, checkout_url: 'https://pay.test/x', public_url: 'https://acme.test' } });
  const r = co.pages.build(id); assert.deepEqual(r.files.sort(), ['index.html', 'refund.html', 'status.html', 'status.json', 'terms.html']); assert.deepEqual(r.warnings, []);
  const fs = require('node:fs'); const dir = co.sandbox.dir(id, 'source'); const refund = fs.readFileSync(dir + '/refund.html', 'utf8'); assert.match(refund, /14 days/); assert.match(refund, /help@acme\.test/);
  assert.match(fs.readFileSync(dir + '/index.html', 'utf8'), /\$149 per month/); co.payments.handleEvent(checkout(id)); const st = co.pages.publicStatus(id); assert.ok(!JSON.stringify(st).includes('ann@client.test')); assert.ok(['operational', 'delayed', 'outage'].includes(st.state));
  const deploy = await co.deploy.ship({ venture_id: id, target: 'bundle' }); assert.ok(deploy.file || deploy.exported);
});
test('routes: reply hook, unsubscribe link and public status are self-authenticating; portal needs its token', async () => {
  const { co, id } = setup(); const routes = require('../sidecar/lib/company/routes'); co.retainer.define(id, { template: 'weekly_report', price: 99 }); co.payments.handleEvent(checkout(id));
  const srv = http.createServer(async (req, res) => { if (!(await routes.handle(co, req, res))) { res.writeHead(404); res.end(); } }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port; const v = co.ventures.get(id);
  const req = (method, path, body) => new Promise((resolve) => { const r = http.request({ port, path, method, headers: { 'content-type': 'application/json' } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); }); if (body) r.write(JSON.stringify(body)); r.end(); });
  try {
    assert.equal((await req('POST', `/hooks/reply/${id}/wrong`, { from: 'a@b.co', text: 'hi' })).status, 404);
    const ok = await req('POST', `/hooks/reply/${id}/${v.lead_token}`, { from: 'new@lead.test', subject: 'price', text: 'how much is it' }); assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).intent, 'pricing');
    const link = co.mail.unsubLink(id, 'u@x.test').replace(/^.*(\/hooks\/unsub\/)/, '$1'); assert.equal((await req('GET', link)).status, 200); assert.equal(co.mail.isUnsubscribed('u@x.test'), true); assert.equal((await req('GET', link.replace(/\/[^/]+$/, '/AAAA'))).status, 404);
    const st = await req('GET', `/hooks/status/${id}`); assert.equal(st.status, 200); assert.ok(JSON.parse(st.body).state);
    const tokn = co.crm.customers(id)[0].portal_token; assert.equal((await req('GET', `/hooks/portal/${id}/${'b'.repeat(24)}/`)).status, 404); assert.equal((await req('GET', `/hooks/portal/${id}/${tokn}/`)).status, 404); // no delivery yet: nothing to show
  } finally { srv.close(); }
});
test('autopilot: the minute job runs the lifecycle; nightly sends the digest; five-minute job polls Stripe when a key exists', async () => {
  const { co, id } = setup(); co.mail.queue({ venture_id: id, to: 'n@x.test', subject: 's', body: 'b' });
  assert.ok(co.autopilot.EVERY.minute); const r = await co.autopilot.runJob('minute'); assert.equal(r.ok, true); const n = await co.autopilot.runJob('nightly'); assert.equal(n.ok, true); assert.ok(n.result.digest);
  const f = await co.autopilot.runJob('five_min'); assert.equal(f.ok, true); assert.equal(f.result.stripe.skipped, 'no stripe_secret_key');
});
