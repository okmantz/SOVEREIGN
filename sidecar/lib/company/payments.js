'use strict';
const crypto = require('node:crypto');
const { uid, round } = require('./util');

/** Stripe over plain REST (no SDK). Test with sk_test_ keys first. */
function makePayments(ctx) {
  const orders = () => ctx.db.get('orders', {});
  const key = () => { const k = ctx.secrets._get('stripe_secret_key'); if (!k) throw new Error('missing secret stripe_secret_key'); return k; };

  function form(obj, prefix = '', out = new URLSearchParams()) {
    for (const [k, v] of Object.entries(obj)) {
      const name = prefix ? `${prefix}[${k}]` : k;
      if (v && typeof v === 'object') form(v, name, out); else if (v !== undefined && v !== null) out.append(name, String(v));
    }
    return out;
  }
  async function stripe(method, path, body) {
    const res = await fetch(`https://api.stripe.com/v1${path}`, { method, headers: { authorization: `Bearer ${key()}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: body && method !== 'GET' ? form(body).toString() : undefined, signal: AbortSignal.timeout(30000) });
    const j = await res.json(); if (!res.ok) throw new Error(`Stripe: ${(j.error && j.error.message) || res.status}`); return j;
  }

  /** CUSTOMER → CHECKOUT. metadata carries venture_id so the webhook can book revenue to the right venture. */
  async function createCheckout({ venture_id, name, amount, currency = 'usd', recurring, success_url, cancel_url, customer_email }) {
    if (!ctx.ventures.canWork(venture_id)) throw new Error('venture is not active');
    const line = { quantity: 1, price_data: { currency, unit_amount: Math.round(amount * 100), product_data: { name } } };
    if (recurring) line.price_data.recurring = { interval: recurring };
    const s = await stripe('POST', '/checkout/sessions', { mode: recurring ? 'subscription' : 'payment', line_items: { 0: line }, success_url, cancel_url,
      customer_email, metadata: { venture_id }, ...(recurring ? { subscription_data: { metadata: { venture_id } } } : { payment_intent_data: { metadata: { venture_id } } }) });
    const o = { id: uid('order'), venture_id, stripe_session: s.id, amount: round(amount), status: 'created', created: ctx.now() };
    orders()[o.id] = o; ctx.db.save('orders'); return { order_id: o.id, url: s.url };
  }

  /** Verify Stripe-Signature (t=…,v1=…): HMAC-SHA256 over `${t}.${rawBody}`, 5-minute tolerance, constant-time compare. */
  function verifySignature(raw, header, secret, tolerance = 300) {
    if (!header || !secret) return false;
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
    const t = Number(parts.t); if (!t || Math.abs(ctx.now() / 1000 - t) > tolerance) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    return header.split(',').filter((p) => p.startsWith('v1=')).some((p) => { const a = Buffer.from(p.slice(3)); const b = Buffer.from(expected); return a.length === b.length && crypto.timingSafeEqual(a, b); });
  }

  // ---- subscription bookkeeping -------------------------------------------------------------------------------------
  const seen = () => ctx.db.get('stripe_seen', []);
  const subs = () => ctx.db.get('stripe_subs', {});
  const md = (x) => x && x.metadata && x.metadata.venture_id;
  /** The venture an object belongs to: our metadata is on checkout sessions, subscriptions and (copied) on invoice lines. */
  function ventureOf(o) {
    const fromLines = ((o.lines && o.lines.data) || []).map((l) => md(l) || md(l.parent && l.parent.subscription_item_details)).find(Boolean);
    const direct = md(o) || md(o.subscription_details) || md(o.parent && o.parent.subscription_details) || fromLines || null;
    if (direct) return direct;
    const c = ctx.crm.customers().find((x) => (o.customer && x.stripe_customer === o.customer) || (o.subscription && x.stripe_subscription === o.subscription) || (x.stripe_subscription && x.stripe_subscription === o.id));
    return c ? c.venture_id : null;
  }
  const customerFor = (venture_id, o) => ctx.crm.findCustomer(venture_id, { stripe_customer: typeof o.customer === 'string' ? o.customer : null,
    stripe_subscription: o.object === 'subscription' ? o.id : (typeof o.subscription === 'string' ? o.subscription : null), email: o.customer_email || (o.customer_details && o.customer_details.email) });
  /** Monthly value of a Stripe subscription object (weekly and yearly plans are normalised to a month). */
  function monthlyValue(sub) {
    let total = 0;
    for (const it of (sub.items && sub.items.data) || []) {
      const pr = it.price || it.plan || {}; const unit = (pr.unit_amount ?? pr.amount ?? 0) / 100; const rec = pr.recurring || { interval: pr.interval, interval_count: pr.interval_count };
      const n = rec.interval_count || 1; const per = { day: 30 / n, week: 52 / 12 / n, month: 1 / n, year: 1 / (12 * n) }[rec.interval] ?? 1;
      total += unit * (it.quantity || 1) * per;
    }
    return round(total);
  }

  /**
   * WEBHOOK (or the event poller) → ORDER → LEDGER (verified) → CRM → FULFILLMENT → LIFECYCLE.
   * Idempotent on the Stripe event id and, for money, on the object id, so the webhook and the poller can both run safely.
   * Handles: first checkout, renewals (invoice.paid), failed payments and their recovery, cancellations, scheduled cancellations,
   * pauses, plan changes and refunds.
   */
  function handleEvent(evt) {
    const o = evt.data && evt.data.object; if (!o) return { handled: false };
    if (evt.type !== 'checkout.session.completed' && evt.id && seen().includes(evt.id)) return { handled: true, duplicate: true };
    const venture_id = ventureOf(o);
    if (!venture_id || !ctx.ventures.get(venture_id)) return { handled: false, reason: 'no venture metadata' };
    const done = (r) => { if (evt.id) { seen().push(evt.id); if (seen().length > 5000) seen().splice(0, seen().length - 5000); ctx.db.save('stripe_seen'); } return r; };
    switch (evt.type) {
      case 'checkout.session.completed': {
        if (o.payment_status && o.payment_status !== 'paid') return { handled: false, reason: 'not paid' };
        const amount = (o.amount_total || 0) / 100;
        if (ctx.ledger.filter({ venture_id }).some((r) => r.source === 'stripe' && r.ref === evt.id)) return { handled: true, duplicate: true, revenue: 0 };
        if (amount > 0) ctx.ledger.record({ venture_id, category: 'revenue', amount, source: 'stripe', ref: evt.id, memo: `checkout ${o.id}` });
        const email = (o.customer_details && o.customer_details.email) || o.customer_email || '';
        const known = o.subscription && subs()[o.subscription];
        const c = ctx.crm.addCustomer({ venture_id, email, name: (o.customer_details && o.customer_details.name) || '', plan: o.mode, mrr: o.mode === 'subscription' ? (known ? known.mrr : amount) : 0,
          stripe_customer: typeof o.customer === 'string' ? o.customer : null, stripe_subscription: typeof o.subscription === 'string' ? o.subscription : null });
        const p = email && ctx.crm.prospects(venture_id).find((x) => x.contact === email); if (p && p.status !== 'won') ctx.crm.advance(p.id, 'won', 'paid via Stripe');
        if (ctx.validation.get(venture_id)) ctx.validation.record(venture_id, { purchases: 1 });
        const ord = Object.values(orders()).find((x) => x.stripe_session === o.id); if (ord) { ord.status = 'paid'; ord.customer_id = c.id; ctx.db.save('orders'); }
        fulfill(venture_id, c); return done({ handled: true, revenue: amount });
      }
      case 'charge.refunded': {
        const amount = (o.amount_refunded || 0) / 100; if (amount > 0) ctx.ledger.record({ venture_id, category: 'refund', amount, source: 'stripe', ref: evt.id, memo: `refund ${o.id}` });
        return done({ handled: true, refund: amount });
      }
      // ---- renewals: the payment that keeps a subscription alive
      case 'invoice.paid': case 'invoice.payment_succeeded': {
        const amount = (o.amount_paid || 0) / 100; const first = o.billing_reason === 'subscription_create'; // the first invoice is the checkout, already booked
        const c = customerFor(venture_id, o); const wasFailing = !!(c && c.failed_payment);
        if (amount > 0 && !first) ctx.ledger.record({ venture_id, category: 'revenue', amount, source: 'stripe', ref: 'inv:' + o.id, memo: `renewal ${o.number || o.id}` });
        if (c) {
          ctx.crm.patchCustomer(c.id, { failed_payment: false, failed_attempts: 0, last_paid: ctx.now(), ...(c.churned ? {} : { mrr: c.mrr || (o.subscription ? amount : 0) }) });
          if (wasFailing) ctx.emit('payment.recovered', { customer: c.email, customer_id: c.id, amount }, venture_id);
          if (!first) { ctx.emit('subscription.renewed', { customer_id: c.id, amount }, venture_id); if (ctx.retainer) ctx.retainer.onRenewal(c); }
        }
        return done({ handled: true, revenue: first ? 0 : amount, renewal: !first, recovered: wasFailing });
      }
      case 'invoice.payment_failed': {
        const c = customerFor(venture_id, o) || ctx.crm.customers(venture_id).find((x) => x.email && x.email === o.customer_email);
        if (c) ctx.crm.patchCustomer(c.id, { failed_payment: true, failed_attempts: o.attempt_count || (c.failed_attempts || 0) + 1 });
        ctx.emit('payment.failed', { customer: o.customer_email || (c && c.email), customer_id: c && c.id, attempt: o.attempt_count || 1 }, venture_id); return done({ handled: true });
      }
      // ---- subscription lifecycle: churn is marked from Stripe, not guessed
      case 'customer.subscription.deleted': {
        const c = customerFor(venture_id, o); delete subs()[o.id]; ctx.db.save('stripe_subs');
        if (!c) return done({ handled: true, churned: false, reason: 'no matching customer' });
        const was = c.churned; if (!was) ctx.crm.markChurned(c.id, o.cancellation_details && o.cancellation_details.reason ? `stripe: ${o.cancellation_details.reason}` : 'subscription canceled');
        return done({ handled: true, churned: !was });
      }
      case 'customer.subscription.created': case 'customer.subscription.updated': {
        const mrr = monthlyValue(o); subs()[o.id] = { mrr, status: o.status }; ctx.db.save('stripe_subs');
        const c = customerFor(venture_id, o); if (!c) return done({ handled: true, matched: false });
        const patch = { stripe_subscription: o.id, paused: !!o.pause_collection, subscription_status: o.status };
        if (!c.churned && mrr > 0 && ['active', 'trialing', 'past_due'].includes(o.status)) patch.mrr = mrr;
        const cancelling = !!(o.cancel_at_period_end || o.cancel_at);
        if (cancelling && !c.cancel_pending) { patch.cancel_pending = true; ctx.crm.patchCustomer(c.id, patch); ctx.emit('customer.cancel_pending', { customer_id: c.id, ends: o.cancel_at || o.current_period_end || null }, venture_id); return done({ handled: true, cancel_pending: true }); }
        if (!cancelling && c.cancel_pending) { patch.cancel_pending = false; ctx.emit('customer.cancel_reverted', { customer_id: c.id }, venture_id); }
        if (['canceled', 'incomplete_expired'].includes(o.status) && !c.churned) ctx.crm.markChurned(c.id, `subscription ${o.status}`);
        ctx.crm.patchCustomer(c.id, patch); return done({ handled: true });
      }
      default: return { handled: false, reason: 'ignored event type' };
    }
  }

  /**
   * Fulfillment hook. A venture with a retainer gets the delivery loop (first cycle scheduled, one every period after, each
   * approved once). Everything else keeps the original behaviour: a task for Support. Onboarding e-mails start from customer.added.
   */
  function fulfill(venture_id, customer) {
    const v = ctx.ventures.get(venture_id);
    if (ctx.retainer && ctx.retainer.get(venture_id)) { ctx.retainer.startCustomer(customer); return; }
    const task = v.type === 'service' || v.type === 'agency' ? 'onboard new client' : v.type === 'saas' ? 'send login + onboarding email' : 'deliver product';
    ctx.directives.add({ venture_id, role: 'Support', task, description: `${task} for ${customer.email || customer.id}`, priority: 'high' });
  }

  // ---- Stripe event poller: subscription events WITHOUT a public webhook or a tunnel ------------------------------------
  const EVENT_TYPES = ['checkout.session.completed', 'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed', 'customer.subscription.created',
    'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded'];
  /**
   * Pull recent events from Stripe's Events API (needs the same key; read access to Events) and feed them to handleEvent.
   * Safe to run every few minutes next to the webhook: ids are de-duplicated. Stripe keeps events for 30 days.
   */
  async function pollEvents({ maxPages = 5 } = {}) {
    if (!ctx.secrets._get('stripe_secret_key')) return { skipped: 'no stripe_secret_key' };
    const st = ctx.db.get('stripe_poll', { cursor: 0 }); const since = st.cursor || Math.floor(ctx.now() / 1000) - 7 * 86400;
    const rows = []; let after = null;
    for (let i = 0; i < maxPages; i++) {
      const q = new URLSearchParams({ limit: '100', 'created[gte]': String(since) }); for (const t of EVENT_TYPES) q.append('types[]', t); if (after) q.set('starting_after', after);
      const j = await stripe('GET', `/events?${q.toString()}`); rows.push(...(j.data || [])); if (!j.has_more || !j.data.length) break; after = j.data[j.data.length - 1].id;
    }
    rows.sort((a, b) => a.created - b.created); let handled = 0, ignored = 0, newest = st.cursor || 0;
    for (const evt of rows) { const r = handleEvent(evt); if (r.handled && !r.duplicate) handled++; else if (!r.handled) ignored++; newest = Math.max(newest, evt.created); }
    st.cursor = newest || since; st.last = ctx.now(); ctx.db.set('stripe_poll', st);
    return { fetched: rows.length, handled, ignored };
  }

  /** Card-update link for dunning e-mails: a Stripe Billing Portal session (the portal must be enabled once in the Stripe dashboard). */
  async function billingPortalLink(customer, return_url) {
    if (!customer || !customer.stripe_customer) return null;
    const s = await stripe('POST', '/billing_portal/sessions', { customer: customer.stripe_customer, ...(return_url ? { return_url } : {}) }); return s.url || null;
  }
  /** Pause billing (the customer keeps the subscription, no invoices are collected). Level-4-ish: only ever called from an approved action. */
  async function pauseSubscription(customer, { days = 30 } = {}) {
    if (!customer || !customer.stripe_subscription) throw new Error('customer has no Stripe subscription');
    const resumes = Math.floor(ctx.now() / 1000) + Math.round(days) * 86400;
    await stripe('POST', `/subscriptions/${customer.stripe_subscription}`, { pause_collection: { behavior: 'void', resumes_at: resumes } });
    ctx.crm.patchCustomer(customer.id, { paused: true, cancel_pending: false }); ctx.emit('customer.paused', { customer_id: customer.id, days }, customer.venture_id); return { paused: true, resumes_at: resumes };
  }
  async function resumeSubscription(customer) {
    if (!customer || !customer.stripe_subscription) throw new Error('customer has no Stripe subscription');
    await stripe('POST', `/subscriptions/${customer.stripe_subscription}`, { pause_collection: '' });
    ctx.crm.patchCustomer(customer.id, { paused: false }); return { paused: false };
  }
  async function refund({ venture_id, payment_intent, amount }) {
    return stripe('POST', '/refunds', { payment_intent, ...(amount ? { amount: Math.round(amount * 100) } : {}), metadata: { venture_id } });
  }

  /**
   * SOVEREIGN AGENT → AUTHORIZED PAYMENT → VENDOR → SETTLEMENT.
   * No live machine-payment rail is bundled. `pay()` runs the CFO + permission gates and hands an authorised payment
   * to a rail you plug in (virtual card issuing, x402, ACH…). The default rail only queues a request for a human.
   */
  const rails = { manual: async (p) => ({ settled: false, instruction: `Pay $${p.amount} to ${p.payee} for ${p.purpose}` }) };
  const registerRail = (name, fn) => { rails[name] = fn; };
  async function pay({ agent_id, venture_id, payee, amount, purpose, category = 'other_opex', rail = 'manual' }) {
    return ctx.tools.invoke('payments.pay', { payee, amount, purpose, category, rail }, { agent_id, venture_id });
  }
  ctx.tools.register({ name: 'payments.pay', owner: 'payments', description: 'Pay a vendor/service from venture budget', required_permission: 3, risk: 'high',
    cost: (i) => i.amount, irreversible: false, input_schema: { type: 'object', required: ['payee', 'amount', 'purpose'], properties: { payee: { type: 'string', maxLength: 200 }, amount: { type: 'number', minimum: 0.01 }, purpose: { type: 'string', maxLength: 300 }, rail: { type: 'string' } } },
    spend_category: 'other_opex', handler: async (i) => { const r = rails[i.rail || 'manual']; if (!r) throw new Error('unknown payment rail'); return r(i); } });
  return { createCheckout, verifySignature, handleEvent, pollEvents, billingPortalLink, pauseSubscription, resumeSubscription, monthlyValue, stripe, refund, pay, registerRail, orders: () => Object.values(orders()) };
}
module.exports = { makePayments };
