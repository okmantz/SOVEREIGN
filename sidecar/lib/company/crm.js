'use strict';
const { uid, round, DAY } = require('./util');

const FUNNEL = ['new', 'qualified', 'contacted', 'replied', 'conversation', 'proposal', 'won'];
const TERMINAL = ['won', 'lost'];

/** Internal CRM + sales pipeline + customer success. Everything the CEO says about growth comes from these rows. */
function makeCrm(ctx) {
  const P = () => ctx.db.get('prospects', []);
  const C = () => ctx.db.get('customers', []);
  const T = () => ctx.db.get('tickets', []);

  function addProspect(o) {
    const p = { id: uid('pros'), venture_id: o.venture_id, name: o.name || '', company: o.company || '', contact: o.contact || '',
      source: o.source || 'unknown', segment: o.segment || '', problem: o.problem || '', offer: o.offer || '', price: o.price ?? null,
      message_variant: o.message_variant || '', status: 'new', reached: ['new'], last_contact: null,
      next_action: o.next_action || 'qualify', estimated_value: o.estimated_value || 0, probability: o.probability ?? 0.05,
      customer: false, created: ctx.now(), notes: [] };
    if (p.contact && P().some((x) => x.venture_id === p.venture_id && x.contact === p.contact)) return P().find((x) => x.venture_id === p.venture_id && x.contact === p.contact);
    P().push(p); ctx.db.save('prospects'); ctx.emit('crm.lead', { source: p.source }, p.venture_id); return p;
  }
  const PROB = { new: 0.05, qualified: 0.1, contacted: 0.12, replied: 0.25, conversation: 0.4, proposal: 0.6, won: 1, lost: 0 };
  function advance(id, status, note) {
    const p = P().find((x) => x.id === id); if (!p) throw new Error('unknown prospect');
    if (!FUNNEL.includes(status) && status !== 'lost') throw new Error(`bad status ${status}`);
    p.status = status; if (!p.reached.includes(status)) p.reached.push(status);
    p.probability = PROB[status]; p.last_contact = ctx.now(); if (note) p.notes.push({ ts: ctx.now(), note });
    if (status === 'won') { p.customer = true; }
    ctx.db.save('prospects'); ctx.emit(`crm.${status}`, { source: p.source }, p.venture_id); return p;
  }
  const prospects = (venture_id, status) => P().filter((p) => (!venture_id || p.venture_id === venture_id) && (!status || p.status === status));

  /** Reached-stage funnel: how many prospects ever got to each step. */
  function funnel(venture_id) {
    const rows = prospects(venture_id);
    const counts = Object.fromEntries(FUNNEL.map((s) => [s, rows.filter((p) => p.reached.includes(s)).length]));
    const steps = FUNNEL.slice(1).map((s, i) => ({ from: FUNNEL[i], to: s, rate: counts[FUNNEL[i]] ? round(counts[s] / counts[FUNNEL[i]], 3) : null }));
    return { counts, steps, lost: rows.filter((p) => p.status === 'lost').length, total: rows.length };
  }
  /** Which lead source / message / offer / price / segment converts? */
  function conversionBy(field, venture_id) {
    const g = {};
    for (const p of prospects(venture_id)) {
      const k = String(p[field] ?? 'unknown') || 'unknown';
      g[k] = g[k] || { key: k, leads: 0, replies: 0, won: 0 };
      g[k].leads++; if (p.reached.includes('replied')) g[k].replies++; if (p.reached.includes('won')) g[k].won++;
    }
    return Object.values(g).map((r) => ({ ...r, win_rate: round(r.won / r.leads, 3), reply_rate: round(r.replies / r.leads, 3) }))
      .sort((a, b) => b.win_rate - a.win_rate || b.leads - a.leads);
  }
  /** "Why aren't we growing?" answered from data, not vibes. */
  function whyNotGrowing(venture_id) {
    const f = funnel(venture_id); const findings = [];
    if (f.total < 30) findings.push({ issue: 'top_of_funnel', detail: `only ${f.total} leads – not enough volume to judge anything`, fix: 'increase lead discovery / outreach volume' });
    const worst = f.steps.filter((s) => s.rate !== null && f.counts[s.from] >= 10).sort((a, b) => a.rate - b.rate)[0];
    if (worst) findings.push({ issue: `${worst.from}→${worst.to}`, detail: `${Math.round(worst.rate * 100)}% conversion on ${f.counts[worst.from]} prospects is the weakest step`, fix: `improve the ${worst.to} step (message, offer or qualification)` });
    if (!f.counts.won && f.counts.proposal >= 5) findings.push({ issue: 'closing', detail: `${f.counts.proposal} proposals, 0 wins`, fix: 'test price/offer and objection handling' });
    const stale = prospects(venture_id).filter((p) => !TERMINAL.includes(p.status) && p.last_contact && ctx.now() - p.last_contact > 7 * DAY).length;
    if (stale >= 5) findings.push({ issue: 'follow_up', detail: `${stale} open prospects untouched for 7+ days`, fix: 'run follow-ups' });
    return { funnel: f, findings, blocker: findings.length ? findings[0].issue : 'none_detected' };
  }

  // ---- customers, support, retention ----
  function addCustomer(o) {
    const c = { id: uid('cust'), venture_id: o.venture_id, name: o.name || '', email: o.email || '', plan: o.plan || '', mrr: o.mrr || 0,
      since: ctx.now(), last_active: ctx.now(), failed_payment: false, refund_requested: false, satisfaction: null, churned: false, referrals: 0 };
    C().push(c); ctx.db.save('customers'); ctx.emit('customer.added', {}, c.venture_id); return c;
  }
  const customers = (venture_id) => C().filter((c) => !venture_id || c.venture_id === venture_id);
  function patchCustomer(id, patch) {
    const c = C().find((x) => x.id === id); if (!c) throw new Error('unknown customer');
    Object.assign(c, patch); ctx.db.save('customers'); return c;
  }
  const openTicket = (o) => { const t = { id: uid('tkt'), venture_id: o.venture_id, customer_id: o.customer_id, subject: o.subject, severity: o.severity || 'normal', bug: !!o.bug, status: 'open', created: ctx.now() }; T().push(t); ctx.db.save('tickets'); return t; };
  const closeTicket = (id) => { const t = T().find((x) => x.id === id); if (t) { t.status = 'closed'; ctx.db.save('tickets'); } return t; };
  const tickets = (venture_id, status) => T().filter((t) => (!venture_id || t.venture_id === venture_id) && (!status || t.status === status));

  /** Act before the customer leaves. */
  function retentionRisks(venture_id) {
    const out = [];
    for (const c of customers(venture_id).filter((x) => !x.churned)) {
      const reasons = [];
      if (c.failed_payment) reasons.push('failed payment');
      if (c.refund_requested) reasons.push('refund requested');
      if (ctx.now() - c.last_active > 14 * DAY) reasons.push('inactive 14+ days');
      if (c.satisfaction !== null && c.satisfaction <= 2) reasons.push('low satisfaction');
      const open = tickets(venture_id, 'open').filter((t) => t.customer_id === c.id);
      if (open.length >= 2) reasons.push('multiple open tickets');
      if (reasons.length) out.push({ customer_id: c.id, name: c.name, mrr: c.mrr, reasons, action: reasons.includes('failed payment') ? 'send payment-recovery message' : reasons.includes('refund requested') ? 'personal outreach before refund' : 'send check-in / re-engagement' });
    }
    return out.sort((a, b) => b.mrr - a.mrr);
  }
  const bugs = (venture_id) => tickets(venture_id, 'open').filter((t) => t.bug);
  function pipeline(venture_id) { const f = funnel(venture_id); return { leads: f.total, qualified: f.counts.qualified, customers: customers(venture_id).filter((c) => !c.churned).length }; }
  return { addProspect, advance, prospects, funnel, conversionBy, whyNotGrowing, addCustomer, customers, patchCustomer, openTicket, closeTicket, tickets, retentionRisks, bugs, pipeline, FUNNEL };
}
module.exports = { makeCrm, FUNNEL };
