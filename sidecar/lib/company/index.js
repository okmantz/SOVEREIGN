'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { Db, uid } = require('./util');
const { makeSettings } = require('./settings');
const { makeSecrets } = require('./secrets');
const { makeLedger } = require('./ledger');
const { makeVentures } = require('./ventures');
const { makePermissions } = require('./permissions');
const { makeCrm } = require('./crm');
const { makeMemory } = require('./memory');
const { makeValidation } = require('./validation');
const { makeCfo } = require('./cfo');
const { makeOpportunities } = require('./opportunity');
const { makeAnalytics } = require('./analytics');
const { makeTools } = require('./tools');
const { makeSandbox } = require('./sandbox');
const assets = require('./assets');
const { makeBuilder } = require('./builder');
const { makeDeploy } = require('./deploy');
const { makeBrowser } = require('./browser');
const { makePayments } = require('./payments');
const { makeDirectives } = require('./directives');
const { makeCeo } = require('./ceo');
const { makeAutopilot } = require('./autopilot');
const { makeRecipes } = require('./recipes');
const { makeMail } = require('./mail');
const { makeLifecycle } = require('./lifecycle');
const { makeRetainer } = require('./retainer');
const { makePages } = require('./pages');
const { makeTunnel } = require('./tunnel');
const { makeTrail } = require('./trail');
const { makeRemote } = require('./remote');

/**
 * createCompany({ dataDir, llm, now }) → the whole company layer.
 *   llm: optional async (prompt, {json}) => string. Wire it to your existing provider (see docs/COMPANY.md).
 */
function createCompany({ dataDir, llm = null, getLlm = null, now = () => Date.now() } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const dir = path.join(dataDir, 'company');
  const ctx = { dataDir: dir, db: new Db(dir), now, assets };
  Object.defineProperty(ctx, 'llm', { enumerable: true, get: () => (getLlm ? getLlm() : llm) }); // resolved on every use: an offline model means null, and every module then falls back to its built-in logic
  const listeners = [];
  ctx.on = (re, fn) => listeners.push({ re, fn });
  ctx.emit = (type, data = {}, venture_id = null) => {
    const ev = ctx.db.get('events', []); ev.push({ id: uid('ev'), ts: ctx.now(), type, venture_id, data });
    if (ev.length > 5000) ev.splice(0, ev.length - 5000); ctx.db.save('events');
    for (const l of listeners) if (l.re.test(type)) { try { l.fn({ type, data, venture_id }); } catch { /* listeners must not break emitters */ } }
  };
  Object.assign(ctx, makeSettingsBundle(ctx));
  ctx.secrets = makeSecrets(ctx);
  ctx.ledger = makeLedger(ctx); ctx.ventures = makeVentures(ctx); ctx.permissions = makePermissions(ctx);
  ctx.crm = makeCrm(ctx); ctx.memory = makeMemory(ctx); ctx.validation = makeValidation(ctx); ctx.cfo = makeCfo(ctx);
  ctx.opportunities = makeOpportunities(ctx); ctx.analytics = makeAnalytics(ctx); ctx.tools = makeTools(ctx);
  ctx.sandbox = makeSandbox(ctx); ctx.builder = makeBuilder(ctx); ctx.deploy = makeDeploy(ctx); ctx.browser = makeBrowser(ctx);
  ctx.trail = makeTrail(ctx);  // the append-only, hash-chained receipt (see trail.js)
  ctx.approvalHandlers = {};   // approval type → async (approval) => outcome; called for approved AND rejected (see ceo.onApproval)
  ctx.publicUrl = () => (ctx.tunnel && ctx.tunnel.url && ctx.tunnel.url()) || ctx.settings().tunnel.public_url || ctx.settings().pages.public_url || '';
  ctx.directives = makeDirectives(ctx); ctx.payments = makePayments(ctx); ctx.ceo = makeCeo(ctx); ctx.autopilot = makeAutopilot(ctx); ctx.recipes = makeRecipes(ctx);
  // recurring revenue: mail queue → retainer delivery → timed sequences → hosted pages
  ctx.mail = makeMail(ctx); ctx.retainer = makeRetainer(ctx); ctx.lifecycle = makeLifecycle(ctx); ctx.pages = makePages(ctx); ctx.remote = makeRemote(ctx);
  ctx.approvalHandlers.delivery = async (a) => (a.status === 'approved' ? ctx.retainer.onApproved(a.payload.cycle_id) : ctx.retainer.onRejected(a.payload.cycle_id, a.note));
  ctx.approvalHandlers.pause = async (a) => {
    if (a.status !== 'approved') return { rejected: true };
    const c = ctx.crm.customers(a.venture_id).find((x) => x.id === a.payload.customer_id); const r = await ctx.payments.pauseSubscription(c, { days: a.payload.days || 30 });
    for (const m of ctx.mail.list({ status: 'draft', venture_id: a.venture_id })) if (c && m.to === c.email && (m.flags || []).includes('send_after_pause_approved')) { m.flags = m.flags.filter((f) => f !== 'send_after_pause_approved'); ctx.db.save('mail'); }
    return r;
  };

  registerBuiltinTools(ctx);
  // event-triggered autonomy
  ctx.on(/^ledger\.(revenue|refund)$/, (e) => e.venture_id && ctx.ceo.refresh(e.venture_id));
  ctx.on(/^deploy\.down$/, (e) => e.venture_id && ctx.directives.add({ venture_id: e.venture_id, role: 'DevOps', task: 'Investigate outage', description: `Site ${e.data.url} is down (status ${e.data.status})`, priority: 'high' }));
  ctx.on(/^payment\.failed$/, (e) => e.venture_id && ctx.directives.add({ venture_id: e.venture_id, role: 'Support', task: 'Recover failed payment', description: `Customer ${e.data.customer}`, priority: 'high' }));

  const api = {
    ...ctx, llm: undefined,
    /** Set total capital and the hard portfolio loss limit ("the most you will lose"). */
    setCapital: (total, maxLoss) => ctx.cfo.setCapital(total, maxLoss),
    async resolveApproval(id, approve, note) { const a = ctx.permissions.resolve(id, approve, note); return { approval: a, outcome: await ctx.ceo.onApproval(a) }; },
    /** Stripe webhook entry: raw body string + Stripe-Signature header. */
    handleStripeWebhook(raw, sigHeader) {
      const secret = ctx.secrets._get('stripe_webhook_secret');
      if (!ctx.payments.verifySignature(raw, sigHeader, secret)) { ctx.emit('webhook.failed', { reason: 'bad signature' }); return { ok: false, status: 400 }; }
      const r = ctx.payments.handleEvent(JSON.parse(raw)); return { ok: true, status: 200, ...r };
    },
    /** Public lead/event hooks used by deployed landing pages. Token-protected per venture. */
    ingestLead(venture_id, token, body) {
      const v = ctx.ventures.get(venture_id); if (!v || !v.active || !safeEq(v.lead_token, token)) return { ok: false, status: 404 };
      const email = String(body.email || '').slice(0, 200); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, status: 400 };
      ctx.crm.addProspect({ venture_id, contact: email, source: String(body.source || 'landing_page').slice(0, 80), segment: String(body.segment || '').slice(0, 80), offer: v.model ? v.model.type : '' });
      if (ctx.validation.get(venture_id)) ctx.validation.record(venture_id, { leads: 1 });
      return { ok: true, status: 200 };
    },
    ingestEvent(venture_id, token, body) {
      const v = ctx.ventures.get(venture_id); if (!v || !v.active || !safeEq(v.lead_token, token)) return { ok: false, status: 404 };
      if (body.type === 'view' && ctx.validation.get(venture_id)) ctx.validation.record(venture_id, { visitors: 1 });
      ctx.emit(`site.${String(body.type || 'event').replace(/\W/g, '').slice(0, 30)}`, {}, venture_id); return { ok: true, status: 200 };
    },
    /** Inbound e-mail entry (POST /hooks/reply/<venture>/<token>): classify, stop sequences, draft the fast reply. */
    async handleReply(venture_id, token, body) {
      const v = ctx.ventures.get(venture_id); if (!v || !v.active || !safeEq(v.lead_token, token)) return { ok: false, status: 404 };
      const d = (body && body.data && typeof body.data === 'object') ? body.data : body || {}; // accepts a flat {from,subject,text} or a Resend-style {data:{...}}
      const from = Array.isArray(d.from) ? d.from[0] : (d.from && d.from.email) || d.from; const r = await ctx.lifecycle.handleInbound({ venture_id, from: String(from || ''), subject: String(d.subject || '').slice(0, 300), text: String(d.text || d.body || '').slice(0, 20000) });
      return { status: r.ok ? 200 : 400, ...r };
    },
    /** One-click unsubscribe (GET or POST /hooks/unsub/<venture>/<hmac>/<b64 email>). */
    unsubscribe(venture_id, token, encoded) { const e = ctx.mail.verifyUnsub(venture_id, token, encoded); if (!e) return { ok: false, status: 404 }; ctx.mail.unsubscribe(e, 'link'); ctx.lifecycle.stopForEmail(e, 'unsubscribed'); return { ok: true, status: 200 }; },
    publicStatus: (venture_id) => ctx.pages.publicStatus(venture_id),
    /** POST /hooks/discord: the signature is checked on the RAW body before anything is parsed. */
    async handleDiscordInteraction(raw, sig, ts) {
      if (!ctx.remote.verifyDiscord(raw, sig, ts)) return { status: 401 };
      let i; try { i = JSON.parse(raw); } catch { return { status: 400 }; } return { status: 200, body: await ctx.remote.handleDiscord(i) };
    },
    async close() { ctx.autopilot.stop(); ctx.remote.close(); ctx.tools.closeAll(); if (ctx.tunnel) await ctx.tunnel.close(); },
  };
  ctx.resolveApproval = (id, approve, note) => api.resolveApproval(id, approve, note);   // lets the daily digest approve company approvals in one batch
  api.tunnel = ctx.tunnel = makeTunnel(ctx, api);
  return api;
}
function makeSettingsBundle(ctx) { const s = makeSettings(ctx); return { settings: s.get, setSettings: s.set }; }
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function registerBuiltinTools(ctx) {
  const T = ctx.tools; const S = (o) => ({ type: 'object', required: o.required || [], properties: o.props });
  // workspace-local (level 0: touches only the venture's own sandbox)
  T.register({ name: 'landing.create', owner: 'builtin', description: 'Generate a landing page into the venture workspace', required_permission: 0,
    input_schema: S({ required: ['name'], props: { name: { type: 'string' }, problem: { type: 'string' }, audience: { type: 'string' }, price: { type: 'string' }, formEndpoint: { type: 'string' }, trackEndpoint: { type: 'string' }, checkoutUrl: { type: 'string' } } }),
    handler: async (i, { venture_id }) => { const copy = await ctx.assets.landingCopy(ctx.llm, i); ctx.sandbox.writeFile(venture_id, 'source/index.html', ctx.assets.landingPage({ ...i, copy })); return { path: 'source/index.html', copy }; } });
  T.register({ name: 'image.svg', owner: 'builtin', description: 'Generate a logo/hero/OG image as SVG (offline)', required_permission: 0,
    input_schema: S({ required: ['name'], props: { name: { type: 'string' }, kind: { type: 'string', enum: ['logo', 'hero', 'og'] }, tagline: { type: 'string' } } }),
    handler: async (i, { venture_id }) => { const p = `artifacts/${i.kind || 'logo'}.svg`; ctx.sandbox.writeFile(venture_id, p, ctx.assets.svgImage(i)); return { path: p }; } });
  T.register({ name: 'app.scaffold', owner: 'builtin', description: 'Write a starter app (static-site | saas-starter) into the workspace', required_permission: 0,
    input_schema: S({ required: ['kind'], props: { kind: { type: 'string', enum: ['static-site', 'saas-starter'] }, options: { type: 'object' } } }),
    handler: async (i, { venture_id }) => { const f = ctx.assets.scaffold(i.kind, i.options || {}); for (const [p, c] of Object.entries(f)) ctx.sandbox.writeFile(venture_id, p, c); return { files: Object.keys(f) }; } });
  T.register({ name: 'code.build', owner: 'builtin', description: 'Model-driven write → test → fix loop in the sandbox', required_permission: 0,
    input_schema: S({ required: ['spec'], props: { spec: { type: 'string', maxLength: 8000 }, max_iterations: { type: 'integer', minimum: 1, maximum: 8 } } }),
    handler: (i, { venture_id }) => ctx.builder.buildLoop({ venture_id, spec: i.spec, maxIterations: i.max_iterations || 4 }) });
  T.register({ name: 'code.run', owner: 'builtin', description: 'Run an allow-listed command in the sandbox', required_permission: 0,
    input_schema: S({ required: ['cmd'], props: { cmd: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, network: { type: 'boolean' } } }),
    handler: (i, { venture_id }) => ctx.sandbox.run(venture_id, i.cmd, i.args || [], { cwd: i.cwd, network: i.network }) });
  // external read (level 0)
  T.register({ name: 'web.fetch', owner: 'builtin', description: 'Fetch a public web page as text (SSRF-guarded)', required_permission: 0,
    input_schema: S({ required: ['url'], props: { url: { type: 'string', maxLength: 2000 } } }), handler: (i) => ctx.browser.fetchPage(i.url) });
  T.register({ name: 'opportunity.scan', owner: 'builtin', description: 'Scan HN/Reddit/GitHub (and registered scanners) for unmet problems', required_permission: 0,
    input_schema: S({ required: ['queries'], props: { queries: { type: 'array', items: { type: 'string' } } } }), handler: (i) => ctx.opportunities.scan({ queries: i.queries.slice(0, 5) }) });
  // publishing / money
  T.register({ name: 'deploy.ship', owner: 'builtin', description: 'Test, deploy and verify the venture workspace (public)', required_permission: 2, risk: 'medium',
    input_schema: S({ props: { target: { type: 'string', enum: ['local', 'bundle', 'vercel', 'docker', 'cloudflare', 'netlify', 'fly', 'railway'] }, scaffold: { type: 'object' }, build_spec: { type: 'string' }, expect: { type: 'string' } } }),
    handler: (i, { venture_id }) => ctx.deploy.ship({ venture_id, ...i }) });
  T.register({ name: 'image.generate', owner: 'builtin', description: 'Generate a raster image via an OpenAI-compatible API (costs money)', required_permission: 3, risk: 'medium', cost: 0.05, spend_category: 'ai_inference',
    input_schema: S({ required: ['prompt'], props: { prompt: { type: 'string', maxLength: 2000 }, name: { type: 'string' } } }),
    handler: async (i, { venture_id }) => { const k = ctx.secrets._get('image_api_key'); const r = await ctx.assets.generateImage({ prompt: i.prompt, apiKey: k, baseUrl: ctx.secrets._get('image_api_base') || undefined });
      const p = `artifacts/${(i.name || 'image').replace(/\W+/g, '-')}.${r.ext}`; require('node:fs').writeFileSync(ctx.sandbox.dir(venture_id, 'artifacts') + '/' + p.split('/')[1], r.bytes); return { path: p }; } });
  T.register({ name: 'stripe.checkout', owner: 'builtin', description: 'Create a Stripe Checkout link for the venture offer', required_permission: 2, risk: 'medium',
    input_schema: S({ required: ['name', 'amount', 'success_url', 'cancel_url'], props: { name: { type: 'string' }, amount: { type: 'number', minimum: 0.5 }, recurring: { type: 'string', enum: ['month', 'year'] }, success_url: { type: 'string' }, cancel_url: { type: 'string' } } }),
    handler: (i, { venture_id }) => ctx.payments.createCheckout({ venture_id, ...i }) });
}
module.exports = { createCompany };
