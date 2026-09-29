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
      body: body ? form(body).toString() : undefined, signal: AbortSignal.timeout(30000) });
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

  /** WEBHOOK → ORDER → LEDGER (verified) → CRM → FULFILLMENT. Idempotent on Stripe event/object ids. */
  function handleEvent(evt) {
    const o = evt.data && evt.data.object; if (!o) return { handled: false };
    const venture_id = (o.metadata && o.metadata.venture_id) || null;
    if (!venture_id || !ctx.ventures.get(venture_id)) return { handled: false, reason: 'no venture metadata' };
    switch (evt.type) {
      case 'checkout.session.completed': {
        if (o.payment_status && o.payment_status !== 'paid') return { handled: false, reason: 'not paid' };
        const amount = (o.amount_total || 0) / 100;
        if (ctx.ledger.filter({ venture_id }).some((r) => r.source === 'stripe' && r.ref === evt.id)) return { handled: true, duplicate: true, revenue: 0 };
        if (amount > 0) ctx.ledger.record({ venture_id, category: 'revenue', amount, source: 'stripe', ref: evt.id, memo: `checkout ${o.id}` });
        const email = (o.customer_details && o.customer_details.email) || o.customer_email || '';
        const c = ctx.crm.addCustomer({ venture_id, email, name: (o.customer_details && o.customer_details.name) || '', plan: o.mode, mrr: o.mode === 'subscription' ? amount : 0 });
        const p = email && ctx.crm.prospects(venture_id).find((x) => x.contact === email); if (p && p.status !== 'won') ctx.crm.advance(p.id, 'won', 'paid via Stripe');
        if (ctx.validation.get(venture_id)) ctx.validation.record(venture_id, { purchases: 1 });
        const ord = Object.values(orders()).find((x) => x.stripe_session === o.id); if (ord) { ord.status = 'paid'; ord.customer_id = c.id; ctx.db.save('orders'); }
        fulfill(venture_id, c); return { handled: true, revenue: amount };
      }
      case 'charge.refunded': {
        const amount = (o.amount_refunded || 0) / 100; if (amount > 0) ctx.ledger.record({ venture_id, category: 'refund', amount, source: 'stripe', ref: evt.id, memo: `refund ${o.id}` });
        return { handled: true, refund: amount };
      }
      case 'invoice.payment_failed': {
        const c = ctx.crm.customers(venture_id).find((x) => x.email && x.email === o.customer_email); if (c) ctx.crm.patchCustomer(c.id, { failed_payment: true });
        ctx.emit('payment.failed', { customer: o.customer_email }, venture_id); return { handled: true };
      }
      default: return { handled: false, reason: 'ignored event type' };
    }
  }
  /** Fulfillment hook: digital products get a task; services get onboarding. Real delivery is venture-specific. */
  function fulfill(venture_id, customer) {
    const v = ctx.ventures.get(venture_id);
    const task = v.type === 'service' || v.type === 'agency' ? 'onboard new client' : v.type === 'saas' ? 'send login + onboarding email' : 'deliver product';
    ctx.directives.add({ venture_id, role: 'Support', task, description: `${task} for ${customer.email || customer.id}`, priority: 'high' });
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
  return { createCheckout, verifySignature, handleEvent, refund, pay, registerRail, orders: () => Object.values(orders()) };
}
module.exports = { makePayments };
