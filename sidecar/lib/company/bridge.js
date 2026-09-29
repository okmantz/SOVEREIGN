'use strict';
// The bridge between the company layer (CEO, CFO, ventures, CRM, tools) and the rest of Sovereign (worlds, agents, the verified
// ledger, approvals). One company per install; every world's goal becomes a venture linked to that world by strategy.world_id.
//
//   goal ─▶ CEO (strategy, kill conditions) ─▶ Director (rooms, agents, tasks) ─▶ agents ─▶ tools ─▶ verified ledger ─▶ CEO
//
// Money truth stays where it already lives: Sovereign's own ledger. Verified entries are copied both ways (idempotent by ref), so
// the goal's profit bar and the CFO's numbers can never disagree, and nothing an agent says can become verified revenue.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HOME } = require('../store');
const { createCompany } = require('./index');
const { ROLES } = require('../roles');
const playbooks = require('./playbooks');

const REG = new WeakMap();
const rootOf = (s) => s.root || s;
const idOf = (s) => s.id || s.defaultId;
const lazy = (m) => require(m);

// company venture types by plan path / world kind
const TYPE_BY_PATH = { outreach: 'agency', ecommerce: 'ecommerce', content: 'content', product: 'saas', trading: 'other', general: 'other', grow: 'other' };
const TYPE_BY_KIND = { ecommerce: 'ecommerce', content: 'content', services: 'service', product: 'saas', trading: 'other', general: 'other' };
// company venture type → world kind (for worlds the CEO proposes)
const KIND_BY_TYPE = { saas: 'product', api: 'product', digital_product: 'product', ecommerce: 'ecommerce', agency: 'services', service: 'services', content: 'content', other: 'general' };
// role names used inside the company layer → Sovereign role ids
const ROLE_OF = { CEO: 'ceo', CFO: 'cfo', Research: 'researcher', 'Product Research': 'researcher', Analyst: 'data_analyst', 'Lead Generator': 'lead_generator', Sales: 'sales_closer',
  Marketing: 'copywriter', Copywriter: 'copywriter', Writer: 'content_manager', Distribution: 'social_manager', Monetization: 'content_manager', Video: 'designer', Designer: 'designer', Ads: 'ad_manager',
  'Store Manager': 'ecommerce_manager', Supplier: 'ecommerce_manager', Support: 'customer_support', Fulfillment: 'ops', Operations: 'ops', Finance: 'finance', Developer: 'developer', DevOps: 'devops',
  'Product Manager': 'product_manager', Product: 'product_manager', Builder: 'builder', 'Account Manager': 'account_manager', SEO: 'seo_specialist' };
const roleId = (name) => ROLE_OF[name] || String(name || '').toLowerCase().replace(/\s+/g, '_');

const companySettings = (root) => Object.assign({ enabled: true, autonomy: 'approval_only', allowPaid: false, autopilot: false }, root.data.settings.company || {});

// ---- the model, as the company layer sees it: null when offline, so every module falls back to its built-in logic
function llmFor(root) {
  const providers = lazy('../providers'), guardrails = lazy('../guardrails'), director = lazy('../director');
  const store = root.forWorld(root.defaultId), w = store.state;
  if (!w || providers.isOffline(store)) return null;
  const agent = Object.values(w.agents).find((a) => a.role === 'ceo') || director.getDirector(w);
  if (!agent) return null;
  return async (prompt, opts = {}) => {
    guardrails.assertBudget(w, agent.id);
    const res = await providers.complete(store, { agent, purpose: 'company', json: !!opts.json, maxTokens: opts.maxTokens || 900, system: 'You are part of an autonomous business. Follow the instructions exactly and reply in the format asked.', messages: [{ role: 'user', content: String(prompt).slice(0, 8000) }] });
    guardrails.recordSpend(store, { agentId: agent.id, cents: res.costCents, tokensIn: res.tokensIn, tokensOut: res.tokensOut, model: res.model });
    return res.text;
  };
}

function companyFor(any) {
  const root = rootOf(any); let h = REG.get(root);
  if (!h) {
    const dataDir = root.persist === false ? fs.mkdtempSync(path.join(os.tmpdir(), 'sov-co-')) : HOME;
    const co = createCompany({ dataDir, getLlm: () => llmFor(root) });
    h = { co, root, port: null, lastCeo: 0, lastTick: 0 }; REG.set(root, h);
    wire(h); require('./agent_tools').register(co, root); co.remote.setProvider(makeRemoteProvider(root));
  }
  applySettings(h); return h.co;
}
const holder = (any) => { companyFor(any); return REG.get(rootOf(any)); };

function applySettings(h) {
  const cs = companySettings(h.root), cur = h.co.settings();
  const want = { autonomy: cs.autonomy === 'permissioned' ? 'permissioned' : 'approval_only', allow_paid: !!cs.allowPaid };
  if (h.port && cur.port !== h.port) want.port = h.port;
  const patch = {}; if (cur.autonomy !== want.autonomy) patch.autonomy = want.autonomy; if (cur.allow_paid !== want.allow_paid) patch.allow_paid = want.allow_paid; if (want.port) patch.port = want.port;
  if (!!cur.autopilot.enabled !== !!cs.autopilot) patch.autopilot = { enabled: !!cs.autopilot };
  if (Object.keys(patch).length) h.co.setSettings(patch);
}
const setPort = (root, port) => { const h = holder(root); h.port = port; applySettings(h); };

// ---- ventures linked to worlds
const ventureOf = (co, worldId) => co.ventures.list().find((v) => v.strategy && v.strategy.world_id === worldId) || null;
const worldOfVenture = (root, ventureId) => { const v = companyFor(root).ventures.get(ventureId); const wid = v && v.strategy && v.strategy.world_id; return wid && root.world(wid) ? root.forWorld(wid) : null; };

function rebalanceCapital(root) {
  const co = companyFor(root); let total = 0, risk = 0;
  for (const w of Object.values(root.data.worlds)) if (w.mission && ventureOf(co, w.id)) { total += (w.mission.capitalCents || 0) / 100; risk += (w.mission.riskCents > 0 ? w.mission.riskCents : w.mission.capitalCents || 0) / 100; }
  co.cfo.setCapital(total, risk);
}

/** The world's goal becomes its primary venture (once). Returns the venture, or null when there is no goal yet. */
function ensureVenture(store) {
  const root = rootOf(store), co = companyFor(root), w = store.state, wid = idOf(store);
  if (!w.mission || companySettings(root).enabled === false) return null;
  let v = ventureOf(co, wid);
  const cap = (w.mission.capitalCents || 0) / 100, risk = (w.mission.riskCents > 0 ? w.mission.riskCents : w.mission.capitalCents || 0) / 100;
  if (!v) {
    const type = TYPE_BY_PATH[(w.journey || {}).basePath || (w.journey || {}).path] || TYPE_BY_KIND[w.kind] || 'other';
    v = co.ventures.create({ name: w.mission.name.slice(0, 60), type, capital_allocated: cap, goal: w.mission.name, goal_monthly_profit: Math.max(1, (w.mission.targetCents || 0) / 100),
      kill_conditions: { max_loss: risk }, strategy: { world_id: wid, primary: true, validation_budget: Math.min(cap, co.settings().ventures.validation_budget) } });
    if (cap > 0) co.cfo.fund(v.venture_id, cap);
    co.ventures.transition(v.venture_id, 'RESEARCH', 'goal set by the owner');
    co.memory.remember(v.venture_id, 'strategy', `Goal: ${w.mission.name}. Target $${(w.mission.targetCents || 0) / 100}, capital $${cap}, loss limit $${risk}.`);
  } else if (v.active) {
    if (v.capital_allocated !== cap) co.ventures.update(v.venture_id, { capital_allocated: cap, goal: w.mission.name, kill_conditions: { ...v.kill_conditions, max_loss: risk } });
  }
  rebalanceCapital(root);
  return co.ventures.get(v.venture_id);
}

// ---- ledger: Sovereign's verified ledger and the company ledger stay in step
const IN_SOURCE = { stripe: 'stripe', shopify: 'shopify', etsy: 'etsy', woocommerce: 'woocommerce', gumroad: 'gumroad', bank: 'bank', 'ads.meta': 'meta_ads', 'harness.model': 'measured' };
const OUT_SOURCE = { stripe: 'stripe', shopify: 'shopify', etsy: 'etsy', woocommerce: 'woocommerce', gumroad: 'gumroad', bank: 'bank', meta_ads: 'ads.meta', measured: 'harness.model' };

function syncLedger(store) {
  const root = rootOf(store), co = companyFor(root), ledger = lazy('../ledger'), w = store.state, wid = idOf(store);
  const v = ventureOf(co, wid); if (!v) return { in: 0, out: 0 };
  w.company = w.company || { imported: [], mirrored: [] };
  const seenIn = new Set(w.company.imported), seenOut = new Set(w.company.mirrored); let inN = 0, outN = 0;
  for (const e of w.ledger) { // Sovereign → company
    if (!e.verified || seenIn.has(e.id) || !IN_SOURCE[e.source] || String(e.ref || '').startsWith('co:')) continue;
    const category = e.type === 'revenue' ? 'revenue' : e.source === 'harness.model' ? 'ai_inference' : e.source === 'ads.meta' ? 'marketing' : 'other_opex';
    try { co.ledger.record({ venture_id: v.venture_id, category, amount: e.amountCents / 100, source: IN_SOURCE[e.source], ref: 'w:' + e.id, memo: e.note || '' }); inN++; } catch (_) { /* skip a line the company ledger rejects */ }
    seenIn.add(e.id);
  }
  for (const r of co.ledger.filter({ venture_id: v.venture_id })) { // company → Sovereign (Stripe checkout revenue, refunds, measured tool spend)
    if (seenOut.has(r.id) || String(r.ref || '').startsWith('w:') || !OUT_SOURCE[r.source] || !['revenue', 'refund', 'cogs', 'marketing', 'software', 'infrastructure', 'other_opex', 'ai_inference', 'payment_fees'].includes(r.category)) continue;
    const type = r.category === 'revenue' ? 'revenue' : 'cost';
    try { const added = ledger.add(store, { type, amountCents: Math.round(r.amount * 100), source: OUT_SOURCE[r.source], ref: 'co:' + (r.ref || r.id), note: (r.category === 'refund' ? 'refund: ' : '') + (r.memo || ''), ventureId: undefined }); if (added) outN++; } catch (_) { /* duplicate or invalid */ }
    seenOut.add(r.id);
  }
  w.company.imported = [...seenIn].slice(-4000); w.company.mirrored = [...seenOut].slice(-4000);
  if (inN || outN) { ledger.evaluateVentures(store); store.change('ledger'); }
  return { in: inN, out: outN };
}

// ---- one Approve/Reject place: company approvals also appear in Sovereign's own approval list
function wire(h) {
  const { co, root } = h, guardrails = lazy('../guardrails');
  const queue = co.permissions.queueApproval;
  co.permissions.queueApproval = (item) => {
    const a = queue(item); const w = worldOfVenture(root, a.venture_id) || root.forWorld(root.defaultId);
    try { guardrails.requestApproval(w, { kind: 'company.approval', summary: String(a.summary || 'Company approval').slice(0, 200), detail: [a.reason || (a.payload ? JSON.stringify(a.payload).slice(0, 160) : '')].filter(Boolean), payload: { approval_id: a.id } }); } catch (_) { /* the company queue still holds it */ }
    return a;
  };
  co.on(/^venture\.killed$/, (e) => haltWorld(root, e.venture_id, e.data && e.data.reason));
  co.on(/^venture\.created$/, (e) => { const v = co.ventures.get(e.venture_id); if (v && !(v.strategy && v.strategy.world_id) && !h.creating) proposeWorldFor(root, v); });
}
lazy('../guardrails').registerExecutor('company.approval', async (store, payload) => {
  const co = companyFor(store), a = co.permissions.getApproval(payload.approval_id); if (!a) throw new Error('That company approval no longer exists.');
  let outcome = null;
  if (a.status === 'pending') outcome = (await co.resolveApproval(a.id, true, 'approved in Sovereign')).outcome; // ceo.onApproval runs a tool approval exactly once
  if (a.type === 'tool') { const r = outcome || { status: 'skipped', result: 'this approval was already handled' }; lazy('../runner').addOutbox(store, { kind: 'connector-action', title: `Done: ${a.tool}`, content: JSON.stringify(r.result || r, null, 2).slice(0, 4000), fromRoom: 'Company' }); return { status: r.status }; }
  return { ok: true };
});
/** Company approvals the owner rejected in Sovereign are rejected in the company too. */
function reconcileApprovals(store) {
  const co = companyFor(store);
  for (const a of store.state.approvals) if (a.kind === 'company.approval' && a.status === 'pending' && a.payload) { const c = co.permissions.getApproval(a.payload.approval_id); if (c && c.status !== 'pending') { a.status = c.status; a.resolvedAt = c.resolved || Date.now(); store.change('approval', { id: a.id }); } } // resolved in the digest or from a phone: close the mirror
  for (const a of store.state.approvals) if (a.kind === 'company.approval' && a.status === 'rejected' && a.payload) { const c = co.permissions.getApproval(a.payload.approval_id); if (c && c.status === 'pending') co.permissions.resolve(c.id, false, 'rejected in Sovereign'); }
}

/** The CEO killed the venture: the roadmap must stop, whatever tasks remain. */
function haltWorld(root, ventureId, reason) {
  const store = worldOfVenture(root, ventureId); if (!store) return;
  const rm = store.state.roadmap, loop = lazy('../loop'), director = lazy('../director');
  if (rm && rm.status === 'running') { rm.paused = true; rm.pauseKind = 'ceo'; rm.pauseReason = `The CEO stopped this venture: ${reason || 'kill decision'}. Review it, then Resume or change the goal.`; loop.stop(store.state, 'The CEO stopped this venture', 'ceo'); }
  director.noteDirector(store, `The CEO stopped this venture${reason ? ': ' + reason : ''}. I have paused the plan; nothing more is spent on it.`);
  store.change('state');
}

// ---- CEO → Director: directives become assignments
function assignDirective(root, d) {
  const store = worldOfVenture(root, d.venture_id); if (!store) return false;
  const w = store.state, rm = w.roadmap; if (!rm || rm.status !== 'running' || rm.paused) return false;
  const role = roleId(d.role), agent = Object.values(w.agents).find((a) => a.role === role && a.deskId && w.desks[a.deskId]);
  if (!agent || lazy('../activity').list(store).some((x) => x.agentId === agent.id)) return false;
  try { lazy('../director').applyPlan(store, [{ type: 'assign_task', agent: agent.id, instructions: `From the CEO (${d.priority || 'normal'} priority): ${d.task}. ${d.description || ''}`.slice(0, 1400) }]); return true; } catch (_) { return false; }
}

// ---- a separate business earns its own world
function proposeWorldFor(root, v) {
  const store = root.forWorld(root.defaultId), director = lazy('../director');
  try { director.propose(store, [{ type: 'create_world', name: v.name.slice(0, 32), kind: KIND_BY_TYPE[v.type] || 'general', goal: v.goal || v.name, targetCents: Math.round((v.goal_monthly_profit || 100) * 100), capitalCents: Math.round((v.capital_allocated || 0) * 100), riskCents: Math.round(((v.kill_conditions || {}).max_loss || v.capital_allocated || 0) * 100), ventureId: v.venture_id }]); }
  catch (_) { /* the venture still exists; the owner can start a world for it by hand */ }
}
/** Executed by the Director when a create_world action is approved: new world, linked by portal, its goal set, its venture attached. */
function createWorld(store, p) {
  const root = rootOf(store), worlds = lazy('../worlds'), journey = lazy('../journey'), h = holder(root); h.creating = true;
  try {
    const id = worlds.create(root, { name: p.name, kind: p.kind });
    worlds.connect(root, idOf(store), id);
    const view = root.forWorld(id), co = h.co;
    journey.setGoal(view, { name: String(p.goal || p.name).slice(0, 160), targetCents: Math.max(100, Math.round(Number(p.targetCents) || 10000)), capitalCents: Math.max(0, Math.round(Number(p.capitalCents) || 0)), riskCents: Math.max(0, Math.round(Number(p.riskCents) || 0)) }).done.catch(() => {});
    if (p.ventureId && co.ventures.get(p.ventureId)) { const v = co.ventures.get(p.ventureId); co.ventures.update(p.ventureId, { strategy: { ...v.strategy, world_id: id } }); rebalanceCapital(root); }
    else ensureVenture(view);
    return id;
  } finally { h.creating = false; }
}

// ---- recipes: "create an autonomous SaaS company" in one call. Roles are Sovereign role ids, so every one has a real job and playbook.
const RECIPE_KIND = { saas: 'product', ecommerce: 'ecommerce', agency: 'services', content: 'content', digital_product: 'product' };
function recipes() {
  const { RECIPES } = require('./recipes');
  return Object.entries(RECIPES).map(([id, r]) => {
    const roles = [...new Set(['director', ...r.roles.map((x) => roleId(x.role))])].filter((x) => ROLES[x]);
    return { id, name: r.name, kind: RECIPE_KIND[id] || 'general', roles: roles.map((x) => ({ id: x, label: ROLES[x].label })), integrations: r.integrations, kpis: r.kpis, budgets: r.budgets, milestones: r.milestones, kill_rules: r.kill_rules, business_models: r.business_models };
  });
}
/** The owner clicked "Launch": a new world of the right kind, its goal set, its venture created, the plan drafted for approval. */
function launchRecipe(store, { recipe, name, goal, targetCents, capitalCents, riskCents }) {
  const r = recipes().find((x) => x.id === recipe); if (!r) throw Object.assign(new Error('Unknown recipe.'), { status: 400 });
  const gtxt = String(goal || '').trim(); if (gtxt.length < 4) throw Object.assign(new Error('Describe the goal in a sentence.'), { status: 400 });
  const id = createWorld(store, { name: String(name || r.name).slice(0, 32), kind: r.kind, goal: gtxt, targetCents: targetCents || 100000, capitalCents: capitalCents || 0, riskCents: riskCents || 0 });
  const co = companyFor(store), v = ventureOf(co, id);
  if (v) co.ventures.update(v.venture_id, { kill_conditions: { ...v.kill_conditions, ...r.kill_rules, max_loss: v.kill_conditions.max_loss }, strategy: { ...v.strategy, recipe, validation_budget: Math.min(v.capital_allocated || r.budgets.validation, r.budgets.validation) }, kpis: Object.fromEntries(r.kpis.map((k) => [k, null])) });
  return { worldId: id, recipe: r };
}

// ---- what every agent sees: the company briefing (real numbers, or "no data yet")
function briefing(store) {
  const root = rootOf(store), co = companyFor(root), v = ventureOf(co, idOf(store)); if (!v) return '';
  const a = co.ceo.answers(v.venture_id), snap = co.cfo.snapshot(v.venture_id), f = co.crm.funnel(v.venture_id), val = co.validation.get(v.venture_id) ? co.validation.evaluate(v.venture_id) : null, why = co.crm.whyNotGrowing(v.venture_id);
  const fv = ventureOf(co, idOf(store)); const lines = [`COMPANY BRIEFING (${fv.status}${fv.active ? '' : ', STOPPED'}): goal "${v.goal}".`,
    `Money (verified only): revenue $${v.revenue}, expenses $${v.expenses}, profit $${v.profit}, cash $${snap.cash ?? 'n/a'}, runway ${v.runway_days == null ? 'unknown' : v.runway_days + ' days'}, CAC ${v.cac == null ? 'no data' : '$' + v.cac}, LTV ${v.ltv == null ? 'no data' : '$' + v.ltv}.`,
    `Customers ${v.customers}. Funnel: ${f.total} prospects (${Object.entries(f.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none yet'}). Blocker: ${why.blocker}.`,
    val ? `Validation test: needs ${JSON.stringify(val.thresholds)}; so far ${JSON.stringify(val.metrics || {})}; verdict ${val.decision} (${val.reason}).` : 'No validation test running yet.',
    `Kill conditions: loss over $${(v.kill_conditions || {}).max_loss ?? 'n/a'}, or no revenue ${(v.kill_conditions || {}).max_days_no_revenue ?? 45} days after launch.`,
    `Should we spend more: ${a.increase_spending}. Next action: ${v.next_action ? v.next_action.task : 'not set'}.`];
  try { // recurring-revenue guardrail: agents must never propose scaling that the numbers forbid
    const g = co.ceo.cashflow(v.venture_id); lines.push(`Cash-flow guardrail: MRR $${g.mrr} vs monthly cost $${g.monthly_cost}${g.mrr_cover === null ? '' : ` (${g.mrr_cover}x)`}, LTV/CAC ${g.ltv_cac === null ? 'not measurable yet' : g.ltv_cac}. Ads ${g.ads_frozen ? 'FROZEN: do not propose paid traffic' : 'allowed'}; scaling ${g.scale_ok ? 'allowed' : 'BLOCKED'}.`);
  } catch (_) { /* briefing must never fail */ }
  const lessons = co.memory.lessons(v.venture_id).slice(0, 3); if (lessons.length) lines.push('Learned so far: ' + lessons.join(' '));
  const recent = co.memory.recall(v.venture_id, null, '').slice(0, 3).map((m) => `[${m.kind}] ${m.summary}`); if (recent.length) lines.push('Business memory: ' + recent.join(' | '));
  return lines.join('\n').slice(0, 2400);
}

// ---- agents call company tools (role allow-list enforced here, then permission engine + CFO + free-only gate)
const TOOL_RE = /```tool[ \t]*\n([\s\S]*?)\n[ \t]*```/g;
async function runAgentTools(store, agent, text) {
  if (!/```tool/.test(String(text))) return { text, calls: [] };
  const root = rootOf(store), co = companyFor(root), v = ventureOf(co, idOf(store));
  const calls = []; let m; TOOL_RE.lastIndex = 0;
  while ((m = TOOL_RE.exec(text)) && calls.length < 5) { try { const j = JSON.parse(m[1]); if (j && typeof j.tool === 'string') calls.push({ tool: j.tool, input: j.input && typeof j.input === 'object' ? j.input : {} }); } catch (_) { calls.push({ tool: '(unreadable)', input: {}, bad: true }); } }
  if (!calls.length) return { text, calls: [] };
  const stripped = text.replace(TOOL_RE, '').trim(), out = [];
  for (const c of calls) {
    if (c.bad) { out.push('- (a tool block was not valid JSON and was ignored)'); continue; }
    if (!playbooks.canUse(agent.role, c.tool)) { out.push(`- ${c.tool}: refused. The ${agent.role} role may not use this tool.`); continue; }
    if (!v || !co.ventures.canWork(v.venture_id)) { out.push(`- ${c.tool}: refused. There is no active venture for this world yet.`); continue; }
    const r = await co.tools.invoke(c.tool, c.input, { agent_id: agent.id, venture_id: v.venture_id });
    out.push(`- ${c.tool}: ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}${r.error ? ' (' + r.error + ')' : ''}${r.status === 'pending_approval' ? ' - waiting for your approval' : ''}${r.result ? ' ' + JSON.stringify(r.result).slice(0, 500) : ''}`);
  }
  return { text: `${stripped}\n\nTool results:\n${out.join('\n')}`, calls };
}


// ---- REMOTE CONTROL PROVIDER: what the phone sees and does. Read-mostly; every write goes through the same code as the desktop UI.
const world_stores = (root) => Object.values(root.data.worlds).map((w) => root.forWorld(w.id));
function makeRemoteProvider(root) {
  const co = () => companyFor(root);
  const clip = (t, n) => (String(t).length > n ? String(t).slice(0, n - 1) + '…' : String(t));
  return {
    /** Every pending station approval in every world. Company approvals are mirrored here, so this is the one list. */
    approvals() {
      const out = [];
      for (const st of world_stores(root)) {
        const w = st.state;
        for (const a of w.approvals) {
          if (a.status !== 'pending') continue;
          const meta = {};
          if (a.kind === 'connector.call' && a.payload) { const c = w.connectors[a.payload.connectorId]; meta.connector_kind = c ? (c.kind || c.source || c.type) : null; }
          if (a.kind === 'director.plan' && a.payload) meta.actions = (a.payload.actions || []).map((x) => `${x.type}${x.name ? ' ' + x.name : ''}`);
          if (a.kind === 'company.approval' && a.payload) { const ca = co().permissions.getApproval(a.payload.approval_id); if (!ca || ca.status !== 'pending') continue; meta.company = { ...ca, placeholder: ca.type === 'delivery' && /PLACEHOLDER/.test(ca.summary || '') }; }
          out.push({ id: a.id, kind: a.kind, summary: a.summary, detail: a.detail || [], at: a.at, world: st.id || st.defaultId, meta });
        }
      }
      return out;
    },
    async resolve(id, approve) {
      const guardrails = lazy('../guardrails');
      for (const st of world_stores(root)) if (st.state.approvals.some((a) => a.id === id)) return guardrails.resolveApproval(st, id, approve);
      throw new Error('That request no longer exists.');
    },
    /** Who is doing what, per agent: live task, and the last thing each one produced (with whether it passed the quality checks). */
    agents() {
      const out = []; const activity = lazy('../activity');
      for (const st of world_stores(root)) {
        const w = st.state; const busy = new Map(activity.list(st).map((x) => [x.agentId, x]));
        for (const a of Object.values(w.agents)) {
          const b = busy.get(a.id); const last = w.outbox.find((o) => o.meta && o.meta.agentId === a.id && o.kind !== 'sop');
          out.push({ world: w.name, name: a.name, role: (ROLES[a.role] && ROLES[a.role].label) || a.role || '', working: !!b, title: b ? b.title : '', since: b ? b.since : null,
            last: last ? { title: clip(last.title, 80), at: last.at, passed: last.meta && last.meta.loop ? !!last.meta.loop.passed : null, preview: clip(String(last.content || ''), 420) } : null });
        }
      }
      return out.sort((x, y) => (y.working - x.working) || String(x.name).localeCompare(String(y.name)));
    },
    /** Recent deliverables across worlds, for the console feed. */
    feed() {
      const out = [];
      for (const st of world_stores(root)) for (const o of st.state.outbox.slice(0, 15)) if (o.kind !== 'sop') out.push({ ts: o.at, type: 'output', actor: o.fromRoom || 'agent', text: `${o.title}${o.meta && o.meta.loop && o.meta.loop.passed === false ? ' (failed checks)' : ''}` });
      return out;
    },
    /** The kill switch for plans: pause every running roadmap. Returns how many were paused. */
    stop(reason) {
      let n = 0; const loop = lazy('../loop');
      for (const st of world_stores(root)) { const rm = st.state.roadmap; if (rm && rm.status === 'running' && !rm.paused) { rm.paused = true; rm.pauseKind = 'remote'; rm.pauseReason = `Stopped from your phone: ${reason}. Resume when you are ready.`; loop.stop(st.state, 'Stopped from your phone', 'remote'); st.change('state'); n++; } }
      return n;
    },
    resume() {
      let n = 0;
      for (const st of world_stores(root)) { const rm = st.state.roadmap; if (rm && rm.paused && rm.pauseKind === 'remote') { rm.paused = false; rm.pauseKind = null; rm.pauseReason = null; st.state.loopStop = null; st.change('state'); n++; } }
      return n;
    },
  };
}

// ---- one management pass; the server calls this every 20 seconds
async function tick(root) {
  if (companySettings(root).enabled === false) return;
  const h = holder(root), co = h.co, now = Date.now();
  for (const w of Object.values(root.data.worlds)) {
    const store = root.forWorld(w.id);
    if (w.mission && w.roadmap && w.roadmap.status !== 'draft') { try { ensureVenture(store); syncLedger(store); reconcileApprovals(store); } catch (e) { console.error('[company]', e.message); } }
  }
  if (now - h.lastCeo > 30 * 60000) { h.lastCeo = now; try { co.ceo.tick(); } catch (e) { console.error('[company] ceo', e.message); } } // the CEO reviews every 30 minutes, never on every beat
  try { await co.directives.drain((d) => assignDirective(root, d), { max: 2 }); } catch (_) { /* drain again next beat */ }
  try { await co.remote.pump(); } catch (_) { /* push never blocks the beat */ }
  if (companySettings(root).autopilot) { try { await co.autopilot.tick(); } catch (_) { /* autopilot pauses itself on repeated failure */ } }
}

// ---- everything the UI and Director prompts need
function view(store) {
  const root = rootOf(store), co = companyFor(root), v = ventureOf(co, idOf(store)), cs = companySettings(root);
  return { enabled: cs.enabled !== false, autonomy: cs.autonomy, allowPaid: !!cs.allowPaid, autopilot: !!cs.autopilot, freeOnly: !cs.allowPaid,
    venture: v ? (({ lead_token, ...pub }) => pub)(co.ventures.get(v.venture_id)) : null, pendingApprovals: co.permissions.pending().length, ventures: co.ventures.list().length, tools: co.tools.list().length, dashboard: co.analytics.dashboard() };
}

module.exports = { recipes, launchRecipe, companyFor, ventureOf, ensureVenture, syncLedger, briefing, runAgentTools, tick, view, setPort, createWorld, proposeWorldFor, assignDirective, haltWorld, reconcileApprovals, companySettings, roleId, TYPE_BY_PATH, KIND_BY_TYPE };
