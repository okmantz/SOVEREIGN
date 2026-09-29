'use strict';
// Company tools that agents (not just code) can request. Each one goes through the same gates as every tool:
// role allow-list (playbooks) → schema → CFO if it costs money → free-only gate → permission level / trust tier.
// Nothing here can create verified money: agents may record leads, notes and experiments, never revenue or wins.
const fs = require('node:fs');
const path = require('node:path');
const CRM_STATUS = ['new', 'qualified', 'contacted', 'replied', 'conversation', 'proposal', 'lost']; // 'won' only ever comes from a verified payment
const MEM_KINDS = ['market', 'customer', 'product', 'sales', 'financial', 'experiment', 'competitor', 'strategy'];

function register(co, root) {
  const T = co.tools, S = (o) => ({ type: 'object', required: o.required || [], properties: o.props });
  const str = (n = 400) => ({ type: 'string', maxLength: n });
  const tool = (t) => T.register({ owner: 'builtin', required_permission: 0, ...t });

  tool({ name: 'crm.prospect.add', description: 'Add a qualified lead (public information only) to the CRM',
    input_schema: S({ required: ['contact'], props: { name: str(120), company: str(120), contact: str(200), source: str(80), problem: str(300), estimated_value: { type: 'number', minimum: 0 }, next_action: str(120) } }),
    handler: (i, { venture_id }) => { const p = co.crm.addProspect({ venture_id, name: i.name, company: i.company, contact: i.contact, source: i.source || 'agent', problem: i.problem, estimated_value: i.estimated_value, next_action: i.next_action }); return { prospect_id: p.id, status: p.status }; } });
  tool({ name: 'crm.prospect.update', description: 'Move a prospect along the funnel and log a note (cannot mark a sale: only a verified payment does that)',
    input_schema: S({ required: ['prospect_id', 'status'], props: { prospect_id: str(60), status: { type: 'string', enum: CRM_STATUS }, note: str(300) } }),
    handler: (i, { venture_id }) => { const p = co.crm.prospects(venture_id).find((x) => x.id === i.prospect_id); if (!p) throw new Error('unknown prospect for this venture'); const r = co.crm.advance(p.id, i.status, i.note); return { prospect_id: r.id, status: r.status }; } });
  tool({ name: 'crm.ticket.open', description: 'Open a support ticket, bug report or churn-risk note',
    input_schema: S({ required: ['subject'], props: { subject: str(300), severity: { type: 'string', enum: ['normal', 'high'] }, bug: { type: 'boolean' }, customer_id: str(60) } }),
    handler: (i, { venture_id }) => { const t = co.crm.openTicket({ venture_id, subject: i.subject, severity: i.severity || 'normal', bug: !!i.bug, customer_id: i.customer_id }); return { ticket_id: t.id }; } });
  tool({ name: 'memory.note', description: 'Write a lasting note to the business memory (market, customer, product, sales, financial, experiment, competitor, strategy)',
    input_schema: S({ required: ['kind', 'text'], props: { kind: { type: 'string', enum: MEM_KINDS }, text: str(800) } }),
    handler: (i, { venture_id }) => ({ memory_id: co.memory.remember(venture_id, i.kind, i.text, { by: 'agent' }).id }) });
  tool({ name: 'experiment.log', description: 'Log a qualitative experiment: action, channel, hypothesis and outcome (numbers come from measured data, not from agents)',
    input_schema: S({ required: ['action'], props: { action: str(200), channel: str(80), hypothesis: str(300), outcome: { type: 'string', enum: ['won', 'lost', 'inconclusive'] } } }),
    handler: (i, { venture_id }) => ({ experiment_id: co.memory.logExperiment({ venture_id, action: i.action, channel: i.channel, hypothesis: i.hypothesis, outcome: i.outcome || 'inconclusive' }).id }) });
  tool({ name: 'spend.request', description: 'Ask the CFO whether a spend is authorised. This moves no money: it returns AUTHORIZED, DENIED or NEEDS_APPROVAL with the numbers',
    input_schema: S({ required: ['amount', 'purpose'], props: { amount: { type: 'number', minimum: 0.01 }, category: { type: 'string', enum: ['marketing', 'software', 'infrastructure', 'cogs', 'ai_inference', 'other_opex'] }, purpose: str(200) } }),
    handler: (i, { venture_id }) => { if (!co.settings().allow_paid) return { decision: 'DENIED', reason: 'free-only mode is on: nothing that costs money is authorised. Find a free way, or the owner can turn on paid actions.' }; return co.cfo.decide({ venture_id, amount: i.amount, category: i.category || 'other_opex', purpose: i.purpose }); } });

  // Publish the world's built site (the files the Builder saved) through the deploy pipeline. Free targets only unless paid is allowed.
  tool({ name: 'site.publish', description: 'Publish the site the Builder made: local preview (no key), a ZIP for any free host (no key), or a free host you have a token for',
    required_permission: 2, risk: 'medium', input_schema: S({ props: { target: { type: 'string', enum: ['local', 'bundle', 'vercel', 'cloudflare', 'netlify'] }, expect: str(120) } }),
    handler: async (i, { venture_id }) => {
      const sites = require('../sites'), v = co.ventures.get(venture_id), wid = v && v.strategy && v.strategy.world_id; const store = wid && root.world(wid) ? root.forWorld(wid) : null;
      if (!store) throw new Error('this venture has no world to publish from');
      const names = sites.names(store); if (!names.includes('index.html')) throw new Error('there is no site yet: the Builder has to build one first');
      for (const n of names) { const body = sites.read(store, n); if (body == null) continue; co.sandbox.writeFile(venture_id, 'source/' + n, body); }
      return co.deploy.ship({ venture_id, target: i.target || 'local', expect: i.expect });
    } });
}
module.exports = { register, CRM_STATUS, MEM_KINDS };
