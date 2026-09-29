'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { uid, DAY, round } = require('./util');

const OPEN = ['scheduled', 'producing', 'awaiting_approval', 'approved'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = (t) => new Date(t).toISOString().slice(0, 10);

/** Ready-made retainer shapes. The brief is what the agent is told to produce; the owner edits it per business. */
const TEMPLATES = {
  weekly_report: { name: 'Weekly performance report', interval: 'week', period_days: 7, deliverables: [
    { key: 'report', title: 'Weekly report', brief: 'A one-page report for the customer: what happened this week, what it means, and the three most useful actions for next week. Use only the data and notes the customer gave us; mark anything missing as needing input.' }] },
  content_batch: { name: 'Monthly content batch', interval: 'month', period_days: 30, deliverables: [
    { key: 'posts', title: 'Twelve ready-to-post drafts', brief: 'Twelve short social posts in the customer\'s voice about their business, each with a hook, the point, and a call to action. No invented statistics or testimonials.' },
    { key: 'calendar', title: 'Posting calendar', brief: 'A simple four-week calendar assigning each of the twelve posts to a day and a platform.' }] },
  lead_list: { name: 'Weekly lead list', interval: 'week', period_days: 7, deliverables: [
    { key: 'leads', title: 'Qualified lead list', brief: 'Ten prospective customers for the customer\'s business with: business name, why they fit, and the public route to reach them (a published business contact, never a private address). Only include information you were given or that is public; mark anything unverified as needing verification.' }] },
};

/**
 * RETAINER DELIVERY ENGINE. Sell a recurring service; agents produce the deliverable every cycle; the owner approves each one (in the
 * daily digest); the approved deliverable is e-mailed and filed in the customer's private portal.
 *
 *   paid (checkout / renewal) → cycle scheduled → agent produces → quality gate → approval (once per cycle) → sent → delivered
 *
 * Nothing is fabricated: with no model the deliverable is a labelled placeholder that cannot be bulk-approved, and every cycle is
 * timestamped so on-time delivery on the status page is measured, not claimed.
 */
function makeRetainer(ctx) {
  const R = () => ctx.db.get('retainers', {});
  const CY = () => ctx.db.get('cycles', []);
  const cfg = () => ctx.settings().retainer;
  const saveC = () => ctx.db.save('cycles');
  const customerOf = (cy) => ctx.crm.customers(cy.venture_id).find((c) => c.id === cy.customer_id) || null;

  // ---- definition
  function define(venture_id, input = {}) {
    if (!ctx.ventures.get(venture_id)) throw new Error('unknown venture');
    const t = input.template ? TEMPLATES[input.template] : null; if (input.template && !t) throw new Error(`unknown template ${input.template}`);
    const d = { ...(t || {}), ...input }; delete d.template;
    const interval = d.interval; if (!['week', 'month'].includes(interval)) throw new Error('interval must be week or month');
    const price = Number(d.price); if (!(price > 0)) throw new Error('price must be a positive number');
    if (!d.name || !Array.isArray(d.deliverables) || !d.deliverables.length || d.deliverables.length > 6) throw new Error('a retainer needs a name and 1 to 6 deliverables');
    const deliverables = d.deliverables.map((x, i) => { if (!x.title || !x.brief) throw new Error('each deliverable needs a title and a brief'); return { key: String(x.key || `d${i + 1}`).replace(/\W+/g, '_').slice(0, 30), title: String(x.title).slice(0, 120), brief: String(x.brief).slice(0, 2000) }; });
    const up = d.upsell && d.upsell.name && Number(d.upsell.price) > 0 ? { name: String(d.upsell.name).slice(0, 80), price: Number(d.upsell.price), pitch: String(d.upsell.pitch || '').slice(0, 400), after_cycles: Math.max(1, Number(d.upsell.after_cycles) || 3) } : null;
    const def = { venture_id, name: String(d.name).slice(0, 80), price, interval, period_days: Number(d.period_days) || (interval === 'week' ? 7 : 30), deliverables, first_delivery_delay_days: Math.max(0, Number(d.first_delivery_delay_days) || 0), upsell: up, defined: ctx.now() };
    R()[venture_id] = def; ctx.db.save('retainers'); ctx.emit('retainer.defined', { name: def.name, price, interval }, venture_id); return def;
  }
  const get = (venture_id) => R()[venture_id] || null;
  const templates = () => TEMPLATES;

  // ---- cycles
  const cycle = (id) => CY().find((c) => c.id === id) || null;
  const cycles = (f = {}) => CY().filter((c) => (!f.venture_id || c.venture_id === f.venture_id) && (!f.customer_id || c.customer_id === f.customer_id) && (!f.status || c.status === f.status));
  const openCycle = (customer) => CY().find((c) => c.customer_id === customer.id && OPEN.includes(c.status)) || null;
  const lastCycle = (customer) => cycles({ customer_id: customer.id }).sort((a, b) => b.n - a.n)[0] || null;
  const nextDue = (customer) => { const o = openCycle(customer); return o ? o.due_at : null; };
  function newCycle(def, customer, due_at) {
    const last = lastCycle(customer); const start = last ? last.period_end : ctx.now();
    const cy = { id: uid('cyc'), venture_id: def.venture_id, customer_id: customer.id, n: last ? last.n + 1 : 1, period_start: start, period_end: start + def.period_days * DAY, due_at, status: 'scheduled', deliverables: [], attempts: 0, revisions: [], created: ctx.now() };
    CY().push(cy); saveC(); ctx.emit('retainer.scheduled', { cycle_id: cy.id, n: cy.n }, def.venture_id); return cy;
  }
  /** Why a customer's deliveries are on hold (null = deliver). A customer who stopped paying is not served for free. */
  function heldReason(c) {
    if (c.churned) return 'churned'; if (c.paused) return 'billing paused';
    if (c.failed_payment && (c.failed_attempts || 0) >= cfg().hold_after_failed_payments) return `payment failed ${c.failed_attempts} times`;
    return null;
  }
  function startCustomer(customer) {
    const def = get(customer.venture_id); if (!def || openCycle(customer) || lastCycle(customer)) return null;
    return newCycle(def, customer, ctx.now() + def.first_delivery_delay_days * DAY);
  }
  /** The next cycle exists as soon as the previous one is delivered and its period is nearly over. */
  function ensureNext(customer) {
    const def = get(customer.venture_id); if (!def || heldReason(customer) || openCycle(customer)) return null;
    const last = lastCycle(customer); if (!last) return newCycle(def, customer, ctx.now());
    if (!['delivered', 'skipped', 'failed'].includes(last.status)) return null;
    if (ctx.now() < last.period_end - DAY) return null;
    return newCycle(def, customer, Math.max(ctx.now(), last.period_end));
  }
  const onRenewal = (customer) => { try { return ensureNext(customer); } catch { return null; } };

  // ---- producing
  const qc = (deliverables) => {
    const issues = [];
    for (const d of deliverables) {
      if (d.placeholder) continue;
      if (d.content.length < 250) issues.push(`"${d.title}" is very short`);
      if (/\[needs input/i.test(d.content)) issues.push(`"${d.title}" has [needs input] markers to fill in`);
      if (/as an ai (language )?model|i (cannot|can't) (browse|access)|lorem ipsum|\[insert|\bTODO\b/i.test(d.content)) issues.push(`"${d.title}" contains filler or model boilerplate`);
    }
    return issues;
  };
  async function generate(cy, def, customer, notes) {
    const p = customer.profile || {}; const { notes: told, ...rest } = p;
    let brief = ''; try { brief = ctx.memory.digest(cy.venture_id) || ''; } catch { /* no memory yet */ }
    const out = [];
    for (const d of def.deliverables) {
      const prompt = `You are producing the "${d.title}" deliverable of a paid "${def.name}" for one customer.\n` +
        `Customer: ${customer.name || customer.email}\nWhat they told us (may be empty):\n${told || 'nothing yet'}\nProfile: ${JSON.stringify(rest)}\n` +
        `Period covered: ${ymd(cy.period_start)} to ${ymd(cy.period_end)} (delivery number ${cy.n}).\nBrief: ${d.brief}\n` +
        (cy.revisions.length ? `The owner rejected the previous attempt with this feedback, address it: ${cy.revisions[cy.revisions.length - 1].note || 'improve quality'}\n` : '') +
        (notes.length ? `A quality check found these problems in your last attempt, fix them: ${notes.join('; ')}\n` : '') +
        (brief ? `Business context (verified facts only):\n${String(brief).slice(0, 1200)}\n` : '') +
        'Rules: use only the facts above. Do not invent numbers, results, quotes, names or links. Where information is missing write "[needs input: what is missing]" in that spot. Be specific and useful. Plain text with short headings, no filler.';
      let content = null; if (ctx.llm) { try { content = String(await ctx.llm(prompt, { maxTokens: 1400 })).trim(); } catch (e) { cy.error = e.message; } }
      if (!content) out.push({ key: d.key, title: d.title, placeholder: true, content: `[PLACEHOLDER: no model is connected]\n${d.title} for ${customer.name || customer.email} (${ymd(cy.period_start)} to ${ymd(cy.period_end)})\n\nBrief: ${d.brief}\n\nConnect a real model in Settings and this is written for real. A placeholder can never be bulk-approved.` });
      else out.push({ key: d.key, title: d.title, placeholder: false, content });
    }
    return out;
  }
  async function produce(cy) {
    const def = get(cy.venture_id), customer = customerOf(cy);
    if (!def || !customer || heldReason(customer)) { cy.status = 'skipped'; cy.error = 'customer not deliverable'; saveC(); return cy; }
    cy.status = 'producing'; cy.attempts++; saveC();
    let d = await generate(cy, def, customer, []); let issues = qc(d);
    if (issues.length && !d.some((x) => x.placeholder)) { d = await generate(cy, def, customer, issues); issues = qc(d); } // one automatic repair before a human sees it
    cy.deliverables = d; cy.placeholder = d.some((x) => x.placeholder); cy.qc_issues = issues;
    const a = ctx.permissions.queueApproval({ type: 'delivery', venture_id: cy.venture_id, summary: `${def.name} #${cy.n} for ${customer.name || customer.email}${cy.placeholder ? ' (PLACEHOLDER)' : ''}`, payload: { cycle_id: cy.id },
      reason: issues.length ? `needs reading: ${issues.join('; ')}` : 'quality checks passed' });
    cy.approval_id = a.id; cy.status = 'awaiting_approval'; saveC(); ctx.emit('retainer.produced', { cycle_id: cy.id, placeholder: cy.placeholder }, cy.venture_id); return cy;
  }

  // ---- approval → delivery
  const portalRoot = (venture_id, token) => path.join(ctx.dataDir, 'portal', venture_id, token);
  const portalUrl = (customer, file = '') => `${ctx.publicUrl ? ctx.publicUrl() : ''}/hooks/portal/${customer.venture_id}/${customer.portal_token}/${file}`;
  function publishPortal(cy, customer, def) {
    const dir = portalRoot(cy.venture_id, customer.portal_token); fs.mkdirSync(dir, { recursive: true });
    const body = cy.deliverables.map((d) => `<h2>${esc(d.title)}</h2><pre>${esc(d.content)}</pre>`).join('');
    const page = (title, inner) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}pre{white-space:pre-wrap;font:inherit}a{color:#245}</style>${inner}`;
    fs.writeFileSync(path.join(dir, `${cy.id}.html`), page(`${def.name} #${cy.n}`, `<h1>${esc(def.name)} #${cy.n}</h1><p>${ymd(cy.period_start)} to ${ymd(cy.period_end)}</p>${body}<p><a href="./">All deliveries</a></p>`));
    const rows = cycles({ customer_id: customer.id }).filter((c) => ['approved', 'delivered'].includes(c.status)).sort((a, b) => b.n - a.n).map((c) => `<li><a href="${esc(c.id)}.html">#${c.n}: ${ymd(c.period_start)} to ${ymd(c.period_end)}</a></li>`).join('');
    fs.writeFileSync(path.join(dir, 'index.html'), page(`${def.name}: deliveries`, `<h1>${esc(def.name)}</h1><ul>${rows}</ul>`));
  }
  /** Reads a portal file for the public route: token-scoped, no directory escape. */
  function portalFile(venture_id, token, file) {
    if (!/^[\w-]+$/.test(venture_id) || !/^[a-f0-9]{16,64}$/.test(token)) return null;
    const root = portalRoot(venture_id, token); const f = path.resolve(root, file && file !== '' ? file : 'index.html');
    if (!f.startsWith(root + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return null; return fs.readFileSync(f);
  }
  async function onApproved(cycle_id) {
    const cy = cycle(cycle_id); if (!cy || cy.status !== 'awaiting_approval') return { ok: false, reason: 'cycle is not waiting for approval' };
    const def = get(cy.venture_id), customer = customerOf(cy); if (!def || !customer) { cy.status = 'failed'; saveC(); return { ok: false }; }
    if (cfg().publish_portal) { try { publishPortal(cy, customer, def); } catch { /* the e-mail still goes out */ } }
    const first = String(customer.name || '').trim().split(/\s+/)[0] || 'there'; const sender = ctx.settings().pages.company_name || 'The team';
    const text = cy.deliverables.map((d) => `== ${d.title} ==\n${d.content}`).join('\n\n');
    const link = cfg().publish_portal ? `\n\nA copy is kept here: ${portalUrl(customer, cy.id + '.html')}` : '';
    cy.status = 'approved'; cy.approved_at = ctx.now();
    const m = ctx.mail.queue({ venture_id: cy.venture_id, to: customer.email, subject: `${def.name}: ${ymd(cy.period_start)} to ${ymd(cy.period_end)}`, kind: 'delivery', ref: cy.id, dedupe: `delivery:${cy.id}`, status: 'approved', priority: 'normal',
      body: `Hi ${first},\n\nHere is your ${def.name} (#${cy.n}).\n\n${text}${link}\n\nReply to this email with feedback: it shapes the next one.\n\n${sender}` });
    cy.mail_id = m.id; saveC(); const sent = await ctx.mail.flush(); return { ok: true, mail_id: m.id, sent };
  }
  function onRejected(cycle_id, note = '') {
    const cy = cycle(cycle_id); if (!cy) return { ok: false };
    cy.revisions.push({ ts: ctx.now(), note });
    if (cy.revisions.length > cfg().max_revisions) {
      cy.status = 'failed'; saveC(); const cu = customerOf(cy);
      ctx.crm.openTicket({ venture_id: cy.venture_id, customer_id: cy.customer_id, subject: `Delivery #${cy.n} failed review ${cy.revisions.length} times`, severity: 'high' });
      ctx.directives.add({ venture_id: cy.venture_id, role: 'Support', task: `Deliver #${cy.n} by hand for ${cu ? cu.name || cu.email : cy.customer_id}`, description: 'Automatic production failed review repeatedly. Write it manually or tell the customer about the delay.', priority: 'high' });
      return { ok: true, failed: true };
    }
    cy.status = 'scheduled'; cy.attempts = 0; cy.due_at = ctx.now(); saveC(); return { ok: true, revising: cy.revisions.length };
  }
  function markDelivered(cycle_id) {
    const cy = cycle(cycle_id); if (!cy || cy.status === 'delivered') return null;
    cy.status = 'delivered'; cy.delivered_at = ctx.now(); cy.on_time = cy.delivered_at <= cy.due_at + cfg().sla_hours * 3600000; saveC();
    const c = customerOf(cy); if (c) ctx.crm.patchCustomer(c.id, { delivered_cycles: (c.delivered_cycles || 0) + 1, last_delivery: ctx.now() });
    ctx.emit('retainer.delivered', { cycle_id: cy.id, on_time: cy.on_time }, cy.venture_id); return cy;
  }
  ctx.on(/^mail\.sent$/, (e) => { if (e.data.kind === 'delivery' && e.data.ref) markDelivered(e.data.ref); });
  ctx.on(/^customer\.churned$/, (e) => { for (const cy of cycles({ customer_id: e.data.customer_id })) if (['scheduled', 'awaiting_approval'].includes(cy.status)) { cy.status = 'skipped'; cy.error = 'customer churned'; } saveC(); });

  // ---- the loop: called every minute by the scheduler
  async function tick() {
    const out = { scheduled: 0, produced: 0, held: 0 };
    for (const [vid] of Object.entries(R())) {
      if (!ctx.ventures.canWork(vid)) continue;
      for (const c of ctx.crm.customers(vid)) { if (heldReason(c)) { if (!c.churned) out.held++; continue; } if (ensureNext(c)) out.scheduled++; }
    }
    for (const cy of CY().filter((x) => x.status === 'scheduled' && x.due_at <= ctx.now()).slice(0, 3)) { try { await produce(cy); out.produced++; } catch (e) { cy.status = 'scheduled'; cy.error = e.message; cy.due_at = ctx.now() + 3600000; saveC(); } }
    return out;
  }

  function upsellCandidates(venture_id) {
    const def = get(venture_id); if (!def || !def.upsell) return [];
    return ctx.crm.customers(venture_id).filter((c) => !c.churned && !c.paused && !c.failed_payment && !c.cancel_pending && (c.delivered_cycles || 0) >= def.upsell.after_cycles
      && (!c.upsell_offered_at || ctx.now() - c.upsell_offered_at > 60 * DAY) && (c.satisfaction === null || c.satisfaction >= 4));
  }
  /** Measured, never claimed: this is what the public status page shows. */
  function stats(venture_id) {
    const all = cycles({ venture_id }); const done = all.filter((c) => c.status === 'delivered'); const since = ctx.now() - 30 * DAY; const recent = done.filter((c) => c.delivered_at >= since);
    const ontime = recent.filter((c) => c.on_time).length;
    const nextOpen = all.filter((c) => OPEN.includes(c.status)).sort((a, b) => a.due_at - b.due_at)[0];
    return { delivered_total: done.length, delivered_30d: recent.length, on_time_pct_30d: recent.length ? round((100 * ontime) / recent.length, 1) : null, awaiting_approval: all.filter((c) => c.status === 'awaiting_approval').length,
      failed: all.filter((c) => c.status === 'failed').length, last_delivery_at: done.length ? Math.max(...done.map((c) => c.delivered_at)) : null, next_due_at: nextOpen ? nextOpen.due_at : null };
  }
  return { define, get, templates, startCustomer, ensureNext, onRenewal, tick, produce, onApproved, onRejected, markDelivered, cycle, cycles, nextDue, upsellCandidates, stats, portalFile, portalUrl, heldReason, TEMPLATES };
}
module.exports = { makeRetainer, TEMPLATES };
