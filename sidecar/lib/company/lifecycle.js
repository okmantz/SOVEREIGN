'use strict';
const { uid, DAY, round, extractJson } = require('./util');
const { EMAIL } = require('./mail');

/**
 * LIFECYCLE: the timed e-mail sequences that turn a lead into a customer and keep a customer paying.
 *
 *   outreach     touch 2 on day 3, touch 3 on day 7, a break-up note on day 14 (stops the moment the prospect replies)
 *   onboarding   welcome on day 0, "did it land?" on day 3, a 1-5 check-in on day 14
 *   dunning      3 steps over 7 days after a failed payment (stops the moment the payment recovers)
 *   churn_save   check-in, then a pause / downgrade offer, for at-risk customers and scheduled cancellations
 *   winback      two notes after a cancellation
 *   testimonial  one ask for a quote + one referral at day 30 (only if the customer is not unhappy)
 *   upsell       a next-tier offer when the retainer's threshold is reached
 *
 * Every step becomes a DRAFT in the mail queue. A human approves drafts in the daily digest (one batch, about ten minutes);
 * only sequences the owner lists in settings.mail.auto_send skip that. Nothing here creates money or marks a sale.
 */
const SEQ = {
  outreach: { label: 'Outreach follow-ups', subject: 'prospect', ai: true, steps: [{ key: 'touch2', day: 3 }, { key: 'touch3', day: 7 }, { key: 'breakup', day: 14 }] },
  onboarding: { label: 'Onboarding', subject: 'customer', steps: [{ key: 'welcome', day: 0 }, { key: 'day3', day: 3 }, { key: 'day14', day: 14 }] },
  dunning: { label: 'Payment recovery', subject: 'customer', kind: 'billing', steps: [{ key: 'd0', day: 0 }, { key: 'd3', day: 3 }, { key: 'd7', day: 7 }] },
  churn_save: { label: 'Churn save', subject: 'customer', ai: true, steps: [{ key: 'checkin', day: 0 }, { key: 'pause_offer', day: 4 }] },
  winback: { label: 'Win-back', subject: 'customer', ai: true, steps: [{ key: 'w1', day: 3 }, { key: 'w2', day: 21 }] },
  testimonial: { label: 'Testimonial and referral ask', subject: 'customer', ai: true, steps: [{ key: 'ask', day: 0 }] },
  upsell: { label: 'Upsell', subject: 'customer', ai: true, steps: [{ key: 'offer', day: 0 }] },
};

// ---- templates: plain, short, honest. {x} carries only facts that exist; a missing fact removes its sentence instead of inventing one.
const line = (cond, text) => (cond ? text : '');
const TPL = {
  outreach: {
    touch2: (x) => [`Following up, ${x.first}`, `Hi ${x.first},\n\nA few days ago I wrote about ${x.offer}${x.problem ? `, which is aimed at ${x.problem}` : ''}. ${line(x.proof, x.proof + ' ')}\nIf it is useful, the next step is small: ${x.next_step}.\n\nIf it is not a fit, tell me and I will stop.\n\n${x.sender}`],
    touch3: (x) => [`One question, ${x.first}`, `Hi ${x.first},\n\nOne question rather than another pitch: is ${x.problem || 'this'} something you are dealing with this quarter?\n\nIf yes, I can send a short example of what ${x.offer} looks like for a business like yours. If not, no problem at all.\n\n${x.sender}`],
    breakup: (x) => [`Closing the loop`, `Hi ${x.first},\n\nI have not heard back, so I will assume the timing is off and stop here. If ${x.offer} becomes relevant later, just reply to this email and I will pick it up.\n\nAll the best,\n${x.sender}`],
  },
  onboarding: {
    welcome: (x) => [`Welcome to ${x.company}`, `Hi ${x.first},\n\nThanks for signing up. Here is what happens next: ${x.first_delivery}\n\nTo make the first delivery good, reply to this email with three things: what you sell, who you want to reach, and any links or tone notes I should follow.\n\nBilling and card details: ${x.update_link}\n\n${x.sender}`],
    day3: (x) => [`Did it land, ${x.first}?`, x.delivered ? `Hi ${x.first},\n\nYour first delivery should have reached you. One question: what would make the next one more useful to you? A one-line answer is plenty.\n\n${x.sender}` : `Hi ${x.first},\n\nYour first delivery is not out yet: ${x.first_delivery}\nIf there is anything I still need from you, reply with it and I will use it.\n\n${x.sender}`],
    day14: (x) => [`Two weeks in: how is it going?`, `Hi ${x.first},\n\nOn a scale of 1 to 5, how is ${x.offer} working for you so far? Just reply with the number, and a sentence if you like.\n\nIf something is off, I would rather fix it now than lose you later.\n\n${x.sender}`],
  },
  dunning: {
    d0: (x) => [`Your payment did not go through`, `Hi ${x.first},\n\nWe could not process your latest payment for ${x.offer}. This happens often and is usually an expired card or a bank block. Your card will be retried automatically, and you can update it here: ${x.update_link}\n\n${x.sender}`],
    d3: (x) => [`Reminder: payment still pending`, `Hi ${x.first},\n\nJust a reminder that your payment for ${x.offer} is still unpaid. Updating your card takes a minute: ${x.update_link}\n\nIf something is wrong on our side, reply and I will sort it out.\n\n${x.sender}`],
    d7: (x) => [`Final notice before your service pauses`, `Hi ${x.first},\n\nYour payment is still outstanding, so deliveries will pause until it is resolved. You can update your card here: ${x.update_link}\n\nIf you would rather pause the subscription for a while instead of paying now, reply PAUSE and I will set it up.\n\n${x.sender}`],
  },
  churn_save: {
    checkin: (x) => [`Checking in, ${x.first}`, `Hi ${x.first},\n\nI wanted to check in personally. ${x.reason_line}Is there anything about ${x.offer} that is not working for you? An honest answer helps me fix it, even if the answer is that it is not a fit.\n\n${x.sender}`],
    pause_offer: (x) => [`A pause instead of leaving?`, `Hi ${x.first},\n\nIf ${x.offer} is not the right fit right now, you do not have to cancel. I can pause your billing for 30 days, or we can change what you receive. Reply PAUSE or tell me what would work better.\n\n${x.sender}`],
  },
  winback: {
    w1: (x) => [`Sorry to see you go`, `Hi ${x.first},\n\nI saw that your ${x.offer} subscription ended. If there was a reason, I would like to hear it, whatever it was. It helps me improve.\n\n${x.sender}`],
    w2: (x) => [`If things have changed`, `Hi ${x.first},\n\nIf ${x.offer} is worth another look, you can restart any time: ${x.checkout_url || 'just reply and I will send a link'}.\n\n${x.sender}`],
  },
  testimonial: {
    ask: (x) => [`One small favour, ${x.first}`, `Hi ${x.first},\n\nYou have been with us for about a month. Two small asks, only if ${x.offer} has been useful:\n\n1. A sentence or two on what it did for you, which I may quote (tell me if you would rather stay anonymous).\n2. If you know one person who would benefit, an introduction.\n\nNo pressure at all.\n\n${x.sender}`],
  },
  upsell: {
    offer: (x) => [`A next step for ${x.company}`, `Hi ${x.first},\n\nYou have now had ${x.delivered_cycles} deliveries of ${x.offer}. ${x.upsell_pitch}\n\n${x.upsell_name} is ${x.upsell_price}. If you would like it, reply YES and I will set it up. If not, nothing changes.\n\n${x.sender}`],
  },
};

// ---- replies: a deterministic intent classifier (no model needed, no invented meaning)
function stripQuoted(t) {
  const lines = String(t || '').split(/\r?\n/); const out = [];
  for (const l of lines) { if (/^\s*>/.test(l) || /^on .{5,120} wrote:\s*$/i.test(l.trim()) || /^-{2,}\s*(original message|forwarded)/i.test(l.trim())) break; out.push(l); }
  return out.join('\n').trim();
}
function classify(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(unsubscribe|remove me|opt.?out|do not contact|don'?t contact|stop (emailing|sending|contacting))\b/.test(t) || /^\s*stop\b/.test(t)) return 'stop';
  if (/\b(out of (the )?office|auto.?reply|automatic reply|on vacation|away until)\b/.test(t)) return 'ooo';
  if (/\b(cancel|cancellation|close my account|end (my )?(subscription|service))\b/.test(t)) return 'cancel';
  if (/\bpause\b/.test(t)) return 'pause';
  if (/\b(not interested|no thanks|no thank you|not a fit|not right now|remove)\b/.test(t)) return 'not_interested';
  if (/\b(price|pricing|cost|how much|rates?|quote|fees?|per month|monthly)\b|\$\s?\d/.test(t)) return 'pricing';
  if (/\b(interested|tell me more|sounds good|let'?s (talk|chat|do)|book|call|demo|send (me )?(the )?(details|info)|yes)\b/.test(t)) return 'interested';
  return 'other';
}

function makeLifecycle(ctx) {
  const E = () => ctx.db.get('enrollments', []);
  const IN = () => ctx.db.get('inbound', []);
  const cfg = () => ctx.settings().lifecycle;
  const subjectOf = (e) => (e.subject_type === 'customer' ? ctx.crm.customers(e.venture_id).find((c) => c.id === e.subject_id) : ctx.crm.prospects(e.venture_id).find((p) => p.id === e.subject_id)) || null;

  // ---------------------------------------------------------------- enrolment
  function enroll(venture_id, sequence, subject_type, subject_id, o = {}) {
    const def = SEQ[sequence]; if (!def) throw new Error(`unknown sequence ${sequence}`);
    if (!subject_id || !cfg().enabled || cfg()[sequence] === false || !ctx.ventures.canWork(venture_id)) return null;
    const subj = subject_type === 'customer' ? ctx.crm.customers(venture_id).find((c) => c.id === subject_id) : ctx.crm.prospects(venture_id).find((p) => p.id === subject_id);
    const to = subj && (subject_type === 'customer' ? subj.email : subj.contact); if (!subj || !EMAIL.test(to || '')) return null;
    if (ctx.mail.isUnsubscribed(to) && sequence !== 'dunning') return null;
    const dup = E().find((e) => e.sequence === sequence && e.subject_id === subject_id && e.status === 'active'); if (dup) return dup;
    if (o.cooldownDays && E().some((e) => e.sequence === sequence && e.subject_id === subject_id && ctx.now() - e.created < o.cooldownDays * DAY)) return null;
    const e = { id: uid('enr'), venture_id, sequence, subject_type, subject_id, to, start: ctx.now() + (o.delayDays || 0) * DAY, cursor: 0, status: 'active', history: [], created: ctx.now(), reason: o.reason || '', vars: o.vars || {} };
    E().push(e); if (E().length > 5000) E().splice(0, E().length - 5000); ctx.db.save('enrollments'); ctx.emit('lifecycle.enrolled', { sequence, subject_id }, venture_id); return e;
  }
  function stopFor(subject_id, sequences, reason) {
    let n = 0; for (const e of E()) if (e.subject_id === subject_id && e.status === 'active' && (!sequences || sequences.includes(e.sequence))) { e.status = 'stopped'; e.stop_reason = reason; n++; }
    if (n) ctx.db.save('enrollments'); return n;
  }
  function stopForEmail(email, reason) { const to = String(email).toLowerCase(); let n = 0; for (const e of E()) if (e.status === 'active' && e.to.toLowerCase() === to) { e.status = 'stopped'; e.stop_reason = reason; n++; } if (n) ctx.db.save('enrollments'); return n; }

  /** Should this step still go out? Checked at send time, not just at enrolment, so a reply or a payment cancels what is queued. */
  function stopReason(e) {
    const s = subjectOf(e); if (!s) return 'subject removed';
    if (ctx.mail.isUnsubscribed(e.to) && e.sequence !== 'dunning') return 'unsubscribed';
    if (!ctx.ventures.canWork(e.venture_id)) return 'venture stopped';
    if (e.sequence === 'outreach' && ['replied', 'conversation', 'proposal', 'won', 'lost'].includes(s.status)) return `prospect is ${s.status}`;
    if (e.subject_type === 'customer') {
      if (e.sequence === 'winback') return s.churned ? null : 'customer is active again';
      if (s.churned) return 'customer churned';
      if (e.sequence === 'dunning' && !s.failed_payment) return 'payment recovered';
      if (e.sequence === 'churn_save' && !s.cancel_pending && !ctx.crm.retentionRisks(e.venture_id).some((r) => r.customer_id === s.id)) return 'no longer at risk';
    }
    return null;
  }

  // ---------------------------------------------------------------- composing
  async function varsFor(e, step) {
    const v = ctx.ventures.get(e.venture_id) || {}; const pg = ctx.settings().pages; const rt = ctx.retainer && ctx.retainer.get(e.venture_id); const s = subjectOf(e) || {};
    const first = String(s.name || '').trim().split(/\s+/)[0] || 'there'; const company = pg.company_name || v.name || 'our team';
    const offer = rt ? rt.name : (v.model && v.model.label) || (v.strategy && v.strategy.offer) || v.name || 'our service';
    const x = { first, company, offer, sender: pg.company_name || 'The team', problem: s.problem || (v.strategy && v.strategy.problem) || '', proof: (v.strategy && v.strategy.proof) || '',
      next_step: pg.booking_url ? `a short call (${pg.booking_url})` : 'a short reply with a time that suits you', checkout_url: pg.checkout_url || '', reason_line: '', delivered: false,
      first_delivery: rt ? `your first ${rt.name} arrives within ${Math.max(1, rt.first_delivery_delay_days || 0) * 24} hours of setup, and then every ${rt.interval}.` : 'I will follow up personally with the details.', update_link: pg.billing_url || 'reply to this email and I will send you a secure link',
      delivered_cycles: s.delivered_cycles || 0, upsell_name: '', upsell_price: '', upsell_pitch: '', context: `${s.name || ''} ${s.company || ''} ${s.problem || ''}`.trim() };
    if (e.reason) x.reason_line = /cancel/.test(e.reason) ? 'I noticed a cancellation is scheduled, and I would like to understand why. ' : /inactive/.test(e.reason) ? 'I noticed we have not heard from you in a while. ' : '';
    if (e.subject_type === 'customer') {
      x.delivered = (s.delivered_cycles || 0) > 0;
      if (rt && ctx.retainer.nextDue) { const nd = ctx.retainer.nextDue(s); if (nd) x.first_delivery = `your first ${rt.name} is scheduled for ${new Date(nd).toDateString()}, and then every ${rt.interval}.`; }
      if (e.sequence === 'dunning') { // a real card-update link when Stripe can make one; otherwise the setting; otherwise a plain instruction
        try { const fresh = s.billing_link && ctx.now() - (s.billing_link_at || 0) < DAY; const link = fresh ? s.billing_link : await ctx.payments.billingPortalLink(s, pg.public_url || undefined);
          if (link) { x.update_link = link; if (!fresh) ctx.crm.patchCustomer(s.id, { billing_link: link, billing_link_at: ctx.now() }); } } catch { /* keep the fallback */ }
      }
      if (e.sequence === 'upsell' && rt && rt.upsell) Object.assign(x, { upsell_name: rt.upsell.name, upsell_price: `$${rt.upsell.price}/${rt.interval}`, upsell_pitch: rt.upsell.pitch || '' });
    }
    return x;
  }
  /** Optional model polish: same facts, same links, same single ask. Any doubt, keep the template. */
  async function personalize(seq, base, x) {
    const llm = ctx.llm; if (!llm || !cfg().ai_personalize || !SEQ[seq].ai) return base;
    try {
      const raw = await llm(`Rewrite this e-mail so it reads like one specific person wrote it to ${x.first}. Keep every fact, every link and the single call to action. Under 110 words. Plain text. No hype, no invented claims, no new promises, no emojis. Return ONLY JSON {"subject":"","body":""}.\n\nSUBJECT: ${base.subject}\nBODY:\n${base.body}\n\nWhat we know about them: ${x.context || 'nothing more'}`, { json: true, maxTokens: 500 });
      const j = extractJson(raw); if (!j || !j.subject || !j.body) return base;
      const links = base.body.match(/https?:\/\/\S+/g) || []; if (links.some((u) => !String(j.body).includes(u.replace(/[).,]+$/, '')))) return base;
      if (String(j.body).length < 60 || String(j.body).length > 1400) return base;
      return { subject: String(j.subject).slice(0, 200), body: String(j.body), personalized: true };
    } catch { return base; }
  }
  async function compose(e, step) {
    const x = await varsFor(e, step); const [subject, body] = TPL[e.sequence][step.key](x); const base = { subject, body };
    return personalize(e.sequence, base, x);
  }

  /** Send-time pass: for every active enrolment whose next step is due, queue a draft. One step at most per enrolment per day (no bursts after downtime). */
  async function runDue() {
    const out = { queued: 0, stopped: 0, done: 0 }; const cap = cfg().max_per_tick;
    for (const e of E().filter((x) => x.status === 'active')) {
      if (out.queued >= cap) break;
      const def = SEQ[e.sequence]; const step = def.steps[e.cursor];
      if (!step) { e.status = 'done'; out.done++; continue; }
      if (ctx.now() < e.start + step.day * DAY || (e.min_next && ctx.now() < e.min_next)) continue;
      const why = stopReason(e); if (why) { e.status = 'stopped'; e.stop_reason = why; out.stopped++; continue; }
      try {
        const msg = await compose(e, step);
        const m = ctx.mail.queue({ venture_id: e.venture_id, to: e.to, subject: msg.subject, body: msg.body, kind: def.kind || 'sequence', sequence: e.sequence, step: step.key, enrollment_id: e.id,
          priority: e.sequence === 'dunning' ? 'fast' : 'normal', dedupe: `${e.id}:${step.key}` });
        e.history.push({ step: step.key, mail_id: m.id, ts: ctx.now(), personalized: !!msg.personalized }); e.cursor++; e.min_next = ctx.now() + DAY; out.queued++;
        if (e.cursor >= def.steps.length) { e.status = 'done'; out.done++; }
      } catch (err) { e.last_error = err.message; }
    }
    ctx.db.save('enrollments'); return out;
  }

  // ---------------------------------------------------------------- triggers (events → enrolments)
  ctx.on(/^crm\.contacted$/, (ev) => { const p = ev.data.prospect_id; if (p) enroll(ev.venture_id, 'outreach', 'prospect', p, { reason: 'first touch sent' }); });
  ctx.on(/^crm\.(replied|conversation|proposal|won|lost)$/, (ev) => { if (ev.data.prospect_id) stopFor(ev.data.prospect_id, ['outreach'], `prospect ${ev.type.split('.')[1]}`); });
  ctx.on(/^customer\.added$/, (ev) => { enroll(ev.venture_id, 'onboarding', 'customer', ev.data.customer_id, { reason: 'new customer' }); });
  ctx.on(/^payment\.failed$/, (ev) => { if (ev.data.customer_id) enroll(ev.venture_id, 'dunning', 'customer', ev.data.customer_id, { reason: `failed payment (attempt ${ev.data.attempt || 1})` }); });
  ctx.on(/^payment\.recovered$/, (ev) => { if (ev.data.customer_id) stopFor(ev.data.customer_id, ['dunning'], 'payment recovered'); });
  ctx.on(/^customer\.cancel_pending$/, (ev) => { enroll(ev.venture_id, 'churn_save', 'customer', ev.data.customer_id, { reason: 'cancellation scheduled', cooldownDays: 7 }); });
  ctx.on(/^customer\.cancel_reverted$/, (ev) => { stopFor(ev.data.customer_id, ['churn_save'], 'customer kept the subscription'); });
  ctx.on(/^customer\.churned$/, (ev) => { const id = ev.data.customer_id; stopFor(id, ['onboarding', 'dunning', 'churn_save', 'testimonial', 'upsell'], 'customer churned'); enroll(ev.venture_id, 'winback', 'customer', id, { reason: ev.data.reason || 'churned', cooldownDays: 60 }); });
  ctx.on(/^customer\.reactivated$/, (ev) => { stopFor(ev.data.customer_id, ['winback'], 'customer is back'); });

  // ---------------------------------------------------------------- the hourly scan: churn-save, testimonial ask, upsell
  async function scan() {
    const out = { churn_save: 0, testimonial: 0, upsell: 0 }; const c = cfg();
    for (const v of ctx.ventures.list({ activeOnly: true })) {
      const id = v.venture_id; const risks = ctx.crm.retentionRisks(id); const risky = new Set(risks.map((r) => r.customer_id));
      for (const r of risks) {
        if (r.reasons.includes('failed payment')) continue; // dunning owns failed payments
        if (enroll(id, 'churn_save', 'customer', r.customer_id, { reason: r.reasons.join(', '), cooldownDays: c.churn_save_cooldown_days })) out.churn_save++;
      }
      for (const cu of ctx.crm.customers(id)) {
        if (cu.churned || cu.paused || cu.failed_payment || risky.has(cu.id) || cu.testimonial_asked_at) continue;
        if (ctx.now() - cu.since < c.testimonial_after_days * DAY || (cu.satisfaction !== null && cu.satisfaction < 4)) continue;
        if (enroll(id, 'testimonial', 'customer', cu.id, { reason: `customer for ${c.testimonial_after_days}+ days` })) { ctx.crm.patchCustomer(cu.id, { testimonial_asked_at: ctx.now() }); out.testimonial++; }
      }
      for (const cu of (ctx.retainer ? ctx.retainer.upsellCandidates(id) : []).filter((x) => !risky.has(x.id))) {
        if (enroll(id, 'upsell', 'customer', cu.id, { reason: 'threshold reached', cooldownDays: 60 })) { ctx.crm.patchCustomer(cu.id, { upsell_offered_at: ctx.now() }); out.upsell++; }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- inbound replies (fast lane)
  const emailOf = (from) => { const m = String(from || '').match(/<([^>]+)>/); return String(m ? m[1] : from || '').trim().toLowerCase(); };
  async function checkoutLinkFor(venture_id) {
    const pg = ctx.settings().pages; if (pg.checkout_url) return pg.checkout_url;
    const rt = ctx.retainer && ctx.retainer.get(venture_id); if (!rt || !ctx.secrets._get('stripe_secret_key')) return null;
    const base = pg.public_url || (ctx.publicUrl ? ctx.publicUrl() : '') || 'https://example.com';
    try { return (await ctx.payments.createCheckout({ venture_id, name: rt.name, amount: rt.price, recurring: rt.interval, success_url: `${base}/?checkout=success`, cancel_url: `${base}/?checkout=cancelled` })).url; } catch { return null; }
  }
  function priceLine(venture_id) {
    const v = ctx.ventures.get(venture_id) || {}; const rt = ctx.retainer && ctx.retainer.get(venture_id);
    if (rt) return { offer: rt.name, price: `$${rt.price} per ${rt.interval}`, includes: rt.deliverables.map((d) => d.title).join(', ') };
    if (v.model && v.model.price) return { offer: v.model.label || v.name, price: `$${v.model.price} ${v.model.unit || ''}`.trim(), includes: '' };
    return null;
  }
  /**
   * An e-mail came in (Resend inbound, a forwarder, Zapier: POST /hooks/reply/<venture>/<token>). Classify it, stop sequences that
   * should stop, and, for a pricing question, have a reply with the price and a payment link waiting within seconds. It is still a draft
   * unless the owner turned on settings.mail.auto_reply_pricing, and the owner is told at once either way.
   */
  async function handleInbound({ venture_id, from, subject = '', text = '' }) {
    const t0 = ctx.now(); const email = emailOf(from); if (!EMAIL.test(email)) return { ok: false, error: 'no sender address' };
    const body = stripQuoted(text); const intent = classify(`${subject}\n${body}`);
    const rec = { id: uid('in'), ts: t0, venture_id, from: email, subject: String(subject).slice(0, 200), intent, body: body.slice(0, 2000) }; IN().push(rec); if (IN().length > 500) IN().splice(0, IN().length - 500); ctx.db.save('inbound');
    let cust = ctx.crm.findCustomer(venture_id, { email }); let pros = ctx.crm.prospects(venture_id).find((p) => String(p.contact).toLowerCase() === email);
    const first = String((cust && cust.name) || (pros && pros.name) || '').trim().split(/\s+/)[0] || 'there'; const pg = ctx.settings().pages; const sender = pg.company_name || 'The team';
    const draft = (subj, msg, o = {}) => ctx.mail.queue({ venture_id, to: email, subject: subj, body: msg, kind: 'reply', priority: 'fast', ref: rec.id, dedupe: `reply:${rec.id}`, ...o });
    if (intent === 'stop') { ctx.mail.unsubscribe(email, 'replied stop'); stopForEmail(email, 'unsubscribed'); if (pros && pros.status !== 'lost') ctx.crm.advance(pros.id, 'lost', 'opted out'); return { ok: true, intent }; }
    if (intent === 'ooo') { for (const e of E()) if (e.status === 'active' && e.to.toLowerCase() === email) e.min_next = ctx.now() + 7 * DAY; ctx.db.save('enrollments'); return { ok: true, intent }; }
    if (cust) { // a customer: their reply is the engagement signal, and a bare 1-5 is a satisfaction score
      const patch = { last_active: ctx.now() }; const score = body.match(/^\s*([1-5])\s*(?:\/\s*5)?\b/); if (score) patch.satisfaction = Number(score[1]);
      if (['other', 'interested'].includes(intent) && !score) patch.profile = { ...(cust.profile || {}), notes: `${(cust.profile && cust.profile.notes) || ''}\n[${new Date(ctx.now()).toISOString().slice(0, 10)}] ${body}`.trim().slice(-3000) };
      ctx.crm.patchCustomer(cust.id, patch);
      if (score && patch.satisfaction <= 2) ctx.crm.openTicket({ venture_id, customer_id: cust.id, subject: `Low satisfaction score (${patch.satisfaction}/5)`, severity: 'high' });
      if (score) return { ok: true, intent: 'score', score: patch.satisfaction };
    } else if (!pros) { pros = ctx.crm.addProspect({ venture_id, contact: email, source: 'inbound_reply', offer: '' }); }
    if (pros && !cust) { stopFor(pros.id, ['outreach'], 'prospect replied'); if (['new', 'qualified', 'contacted'].includes(pros.status)) pros = ctx.crm.advance(pros.id, 'replied', `reply: ${intent}`); }
    const alert = (msg) => { ctx.emit('alert', { msg }, venture_id); ctx.mail.notifyOwner(`Sovereign: ${msg}`, `${msg}\n\nFrom: ${email}\nSubject: ${subject}\n\n${body.slice(0, 600)}\n\nApprove or edit the draft in the daily digest.`, venture_id, `alert:${rec.id}`); };
    switch (intent) {
      case 'pricing': {
        const pl = priceLine(venture_id); const link = await checkoutLinkFor(venture_id);
        if (!pl) { ctx.crm.openTicket({ venture_id, subject: `Pricing question from ${email}, no offer price is set`, severity: 'high' }); alert(`Pricing question from ${email} but no price is configured`); return { ok: true, intent, drafted: false }; }
        const refund = pg.refund_days > 0 ? `\nIf it is not useful in the first ${pg.refund_days} days, tell me and I will refund you.` : '';
        const msg = `Hi ${first},\n\nThanks for asking. ${pl.offer} is ${pl.price}.${pl.includes ? ` Each cycle includes: ${pl.includes}.` : ''}${link ? `\n\nYou can start here: ${link}` : '\n\nReply YES and I will send you the payment link.'}${refund}\n\n${pg.booking_url ? `Prefer to talk first? ${pg.booking_url}` : 'Prefer to talk first? Reply with a time that suits you.'}\n\n${sender}`;
        const auto = ctx.settings().mail.auto_reply_pricing && !!link; // deterministic text only; the model never writes this one
        const m = draft(`Re: ${subject || pl.offer}`, msg, { flags: link ? [] : ['no_payment_link'], ...(auto ? { status: 'approved' } : {}) });
        if (pros && pros.status === 'replied') ctx.crm.advance(pros.id, 'conversation', 'asked for pricing');
        alert(`Pricing question from ${email}: reply drafted${auto ? ' and sent automatically' : ''}`); if (auto) await ctx.mail.flush(); rec.drafted_ms = ctx.now() - t0; ctx.db.save('inbound');
        return { ok: true, intent, mail_id: m.id, auto, link: !!link, ms: ctx.now() - t0 };
      }
      case 'interested': {
        if (cust) { ctx.crm.openTicket({ venture_id, customer_id: cust.id, subject: `Customer reply needs a human: ${body.slice(0, 80)}`, severity: 'normal' }); return { ok: true, intent, ticket: true }; }
        const msg = `Hi ${first},\n\nGreat to hear it. The simplest next step is ${pg.booking_url ? `a short call: ${pg.booking_url}` : 'a quick reply with two times that suit you this week'}. If you would rather see it in writing first, say so and I will send the details.\n\n${sender}`;
        const m = draft(`Re: ${subject || 'next step'}`, msg); if (pros && ['replied', 'contacted'].includes(pros.status)) ctx.crm.advance(pros.id, 'conversation', 'interested');
        alert(`Interested reply from ${email}: reply drafted`); return { ok: true, intent, mail_id: m.id };
      }
      case 'cancel': {
        if (cust) { ctx.crm.openTicket({ venture_id, customer_id: cust.id, subject: `Cancellation request: ${body.slice(0, 80)}`, severity: 'high' }); enroll(venture_id, 'churn_save', 'customer', cust.id, { reason: 'cancellation requested', cooldownDays: 7 }); }
        alert(`Cancellation request from ${email}`); return { ok: true, intent };
      }
      case 'pause': {
        if (cust && cust.stripe_subscription) {
          const a = ctx.permissions.queueApproval({ type: 'pause', venture_id, summary: `Pause billing for ${cust.name || cust.email} for 30 days (they asked)`, payload: { customer_id: cust.id, days: 30 } });
          draft('Your pause request', `Hi ${first},\n\nDone, I have asked to pause your billing for 30 days. You will not be charged during that time, and I will check in before it resumes.\n\n${sender}`, { flags: ['send_after_pause_approved'] });
          alert(`Pause request from ${email}`); return { ok: true, intent, approval_id: a.id };
        }
        ctx.crm.openTicket({ venture_id, customer_id: cust && cust.id, subject: `Pause request from ${email}`, severity: 'high' }); return { ok: true, intent, ticket: true };
      }
      case 'not_interested': { if (pros && pros.status !== 'lost') ctx.crm.advance(pros.id, 'lost', 'not interested'); if (cust) ctx.crm.openTicket({ venture_id, customer_id: cust.id, subject: `Unhappy reply: ${body.slice(0, 80)}`, severity: 'high' }); return { ok: true, intent }; }
      default: ctx.crm.openTicket({ venture_id, customer_id: cust && cust.id, subject: `Reply needs a human: ${body.slice(0, 80) || subject}`, severity: 'normal' }); return { ok: true, intent };
    }
  }

  // ---------------------------------------------------------------- the daily digest: one batch, about ten minutes
  const clip = (t, n = 500) => String(t).length > n ? String(t).slice(0, n) + '…' : String(t);
  function digest() {
    const items = [];
    for (const m of ctx.mail.list({ status: 'draft' })) items.push({ type: 'mail', id: m.id, kind: m.sequence || m.kind, to: m.to, subject: m.subject, preview: clip(m.body), priority: m.priority, flags: m.flags, bulk_ok: !m.flags.length, age_hours: round((ctx.now() - m.created) / 3600000, 1), seconds: 20 });
    for (const a of ctx.permissions.pending().filter((x) => ['delivery', 'pause'].includes(x.type))) {
      const c = a.type === 'delivery' && ctx.retainer ? ctx.retainer.cycle(a.payload.cycle_id) : null;
      items.push({ type: 'approval', id: a.id, kind: a.type, subject: a.summary, preview: c ? clip((c.deliverables || []).map((d) => `## ${d.title}\n${d.content}`).join('\n\n'), 700) : '', priority: 'normal',
        flags: c ? [...(c.placeholder ? ['placeholder_content'] : []), ...(c.qc_issues || [])] : [], bulk_ok: c ? !c.placeholder && !(c.qc_issues || []).length : true, age_hours: round((ctx.now() - a.created) / 3600000, 1), seconds: a.type === 'delivery' ? 90 : 20 });
    }
    items.sort((a, b) => (b.priority === 'fast') - (a.priority === 'fast') || b.age_hours - a.age_hours);
    const ms = ctx.mail.status(); const warnings = [];
    if (!ms.configured) warnings.push('No mail provider is configured (secrets resend_api_key + mail_from): approved messages wait in the queue as "manual" for you to send.');
    if (!ms.footer_set) warnings.push('No opt-out footer (secret mail_footer): marketing and lifecycle e-mail will be refused until you set one with a postal address.');
    if (!ctx.llm) warnings.push('The model is offline: deliveries are placeholders and cannot be bulk-approved.');
    const seconds = items.reduce((s, i) => s + i.seconds, 0);
    return { generated: ctx.now(), items, counts: { total: items.length, mail: items.filter((i) => i.type === 'mail').length, deliveries: items.filter((i) => i.kind === 'delivery').length, fast_lane: items.filter((i) => i.priority === 'fast').length, safe_to_bulk_approve: items.filter((i) => i.bulk_ok).length, needs_reading: items.filter((i) => !i.bulk_ok).length },
      est_minutes: Math.max(items.length ? 1 : 0, Math.ceil(seconds / 60)), mail: ms, warnings };
  }
  /** Approve a batch: chosen ids, or every item that is safe to approve without reading (no flags). Then send what is allowed to go. */
  async function approveBatch({ mail_ids = [], approval_ids = [], all_safe = false, by = 'owner' } = {}) {
    const d = digest(); const out = { mail: 0, approvals: 0, skipped: [], errors: [] };
    const wantMail = new Set(mail_ids), wantAppr = new Set(approval_ids);
    if (all_safe) for (const i of d.items) if (i.bulk_ok) (i.type === 'mail' ? wantMail : wantAppr).add(i.id);
    for (const id of wantMail) { if (ctx.mail.approve(id, by)) out.mail++; else out.skipped.push(id); }
    for (const id of wantAppr) { try { if (ctx.resolveApproval) { await ctx.resolveApproval(id, true, 'approved in the daily digest'); out.approvals++; } else out.skipped.push(id); } catch (e) { out.errors.push(`${id}: ${e.message}`); } }
    out.sent = await ctx.mail.flush(); return out;
  }
  async function rejectBatch({ mail_ids = [], approval_ids = [], note = '' } = {}) {
    const out = { mail: 0, approvals: 0, errors: [] };
    for (const id of mail_ids) if (ctx.mail.reject(id, note)) out.mail++;
    for (const id of approval_ids) { try { if (ctx.resolveApproval) { await ctx.resolveApproval(id, false, note || 'rejected in the daily digest'); out.approvals++; } } catch (e) { out.errors.push(`${id}: ${e.message}`); } }
    return out;
  }
  /** Nightly: tell the owner (once a day) what is waiting. */
  function notifyDigest() {
    const d = digest(); if (!d.counts.total) return { skipped: 'nothing waiting' };
    const day = new Date(ctx.now()).toISOString().slice(0, 10);
    const lines = d.items.slice(0, 12).map((i) => `- ${i.priority === 'fast' ? '[fast] ' : ''}${i.kind}: ${clip(i.subject, 80)}${i.to ? ` (${i.to})` : ''}`);
    const m = ctx.mail.notifyOwner(`Sovereign: ${d.counts.total} item(s) to approve, about ${d.est_minutes} min`, `${d.counts.safe_to_bulk_approve} can be approved in one click, ${d.counts.needs_reading} need reading.\n\n${lines.join('\n')}\n\nOpen the Founder Control Center to approve.`, null, `digest:${day}`);
    return { notified: !!m, items: d.counts.total };
  }

  async function tick() { const r = { due: await runDue(), mail: await ctx.mail.flush() }; if (ctx.retainer) r.retainer = await ctx.retainer.tick(); return r; }
  const enrollments = (f = {}) => E().filter((e) => (!f.venture_id || e.venture_id === f.venture_id) && (!f.status || e.status === f.status) && (!f.sequence || e.sequence === f.sequence));
  const catalog = () => Object.entries(SEQ).map(([id, s]) => ({ id, label: s.label, subject: s.subject, steps: s.steps, ai_polish: !!s.ai }));
  const inbound = (n = 50) => IN().slice(-n).reverse();
  return { enroll, stopFor, stopForEmail, runDue, tick, scan, handleInbound, digest, approveBatch, rejectBatch, notifyDigest, enrollments, catalog, inbound, classify, SEQ, TPL };
}
module.exports = { makeLifecycle, classify, stripQuoted, SEQ };
