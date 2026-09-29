'use strict';
// The planner turns a goal into milestones, then a roadmap of concrete tasks for named roles, then the list of
// integrations that plan truly needs. Structure comes from vetted path templates so it always works offline and with
// small local models. A real model, when connected, tailors it to the goal, and every LLM answer is validated.
// Only what a task really needs becomes a requirement: a plan with no Etsy step never asks for Etsy.
const { id, assert, parseJsonLoose } = require('./util');
const { ROLES } = require('./roles');
const providers = require('./providers');
const guardrails = require('./guardrails');
const station = require('./station');

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const STORE = { etsy: 'Etsy', shopify: 'Shopify', woocommerce: 'WooCommerce', gumroad: 'Gumroad' };
const SOURCE_KINDS = ['stripe', 'shopify', 'etsy', 'woocommerce', 'gumroad']; // where verified revenue can come from

const k = (role, task, title, o = {}) => ({ role, task, title, instructions: o.instructions || '', requires: o.requires || [], optional: o.optional || [], deliver: o.deliver || [], owner: o.human ? 'human' : 'agent' });
const m = (key, title, why, days, tasks) => ({ key, title, why, days, tasks });

const PATHS = {
  outreach: { label: 'Outreach-led service', words: ['service', 'agency', 'consult', 'freelance', 'lead gen', 'clients', 'b2b', 'outreach', 'cold email', 'coaching', 'appointment'],
    build: () => [
      m('niche', 'Pick the niche and offer', 'Choose who we sell to and what we sell before spending anything.', 3, [k('researcher', 'market_scan', 'Shortlist niches with paying demand'), k('researcher', 'validate_offer', 'Validate the chosen offer'), k('critic', 'review_plan', 'Critique the plan before money is spent')]),
      m('pipeline', 'Build the lead pipeline and copy', 'Have prospects and messaging ready.', 5, [k('lead_generator', 'build_lead_list', 'Build the first lead list'), k('copywriter', 'email_copy', 'Write the outreach email copy'), k('email_marketer', 'write_sequence', 'Write the follow-up sequence')]),
      m('outreach', 'Launch outreach', 'Reach real prospects within sending limits.', 7, [k('email_marketer', 'draft_outreach_batch', 'Draft and send the first outreach email', { requires: ['email'], deliver: ['email'] }), k('sales_closer', 'reply_to_lead', 'Prepare replies for interested leads')]),
      m('close', 'Close and get paid', 'Turn replies into paid work and prove the revenue.', 14, [k('sales_closer', 'proposal', 'Write the proposal for interested clients'), k('ops', 'fulfilment_checklist', 'Prepare the delivery checklist'), k('finance', 'ledger_review', 'Review verified revenue', { optional: ['stripe'] })])] },
  ecommerce: { label: 'Online store', words: ['etsy', 'shopify', 'store', 'ecommerce', 'e-commerce', 'print on demand', 'dropship', 'products', 'sell online', 'merch', 'woocommerce', 'gumroad', 'digital download', 'planner', 'template'],
    build: (ctx) => { const P = STORE[ctx.platform]; return [
      m('products', 'Choose what to sell', 'Find products with demand and healthy margin.', 3, [k('researcher', 'market_scan', 'Find profitable product niches'), k('ecommerce_manager', 'product_ideas', 'Shortlist the first products'), k('critic', 'review_plan', 'Critique the product choice')]),
      m('assets', 'Prepare the store content', 'Get listings, copy and images ready.', 5, [k('copywriter', 'product_listing', 'Write the listing copy'), k('ecommerce_manager', 'write_listings', 'Finish the listings'), k('designer', 'listing_images_spec', 'Spec the listing images')]),
      m('launch', `Open the ${P} store`, 'Publish the listings. This step is yours.', 7, [k('ops', 'fulfilment_checklist', 'Plan order fulfilment'), k('ops', null, `Create your ${P} store and publish the drafted listings`, { human: true, instructions: 'Use the listing drafts and image specs in the Outbox.' })]),
      m('traffic', 'Get the first visitors', 'Paid and direct traffic beats waiting for organic.', 10, [k('ad_manager', 'ad_test_plan', 'Plan a small paid traffic test'), k('social_manager', 'post_batch', 'Draft launch posts')]),
      m('sales', 'Track the first sales', 'Prove revenue with verified data.', 21, [k('data_analyst', 'kpi_report', 'Report early sales and conversion', { requires: [ctx.platform] })])]; } },
  content: { label: 'Content and audience', words: ['content', 'youtube', 'blog', 'newsletter', 'audience', 'affiliate', 'podcast', 'social media', 'followers', 'seo', 'creator'],
    build: () => [
      m('audience', 'Know the audience and angle', 'Decide who we serve and what we say.', 3, [k('researcher', 'audience_profile', 'Profile the audience'), k('content_manager', 'content_calendar', 'Plan the first two weeks'), k('critic', 'review_plan', 'Critique the angle')]),
      m('produce', 'Produce the first batch', 'Make the first pieces and the offer page.', 7, [k('content_manager', 'draft_posts', 'Draft the first posts', { optional: ['notion', 'drive'], deliver: ['notion', 'drive'] }), k('copywriter', 'landing_page', 'Write the offer page'), k('designer', 'thumbnail_set', 'Spec the thumbnails')]),
      m('distribute', 'Distribute', 'Put the work in front of people, including a small paid test.', 10, [k('social_manager', 'post_batch', 'Draft the distribution posts'), k('ad_manager', 'ad_test_plan', 'Plan a small paid test')]),
      m('monetise', 'Monetise', 'Turn attention into revenue.', 14, [k('copywriter', 'email_copy', 'Write the welcome and offer emails')]),
      m('measure', 'Measure and adjust', 'Keep what earns, cut what does not.', 21, [k('data_analyst', 'kpi_report', 'Report what drove leads and sales'), k('content_manager', 'weekly_content_report', 'Write the weekly content report')])] },
  product: { label: 'Software or digital product', words: ['saas', 'app', 'software', 'tool', 'plugin', 'platform', 'api', 'extension', 'web app'],
    build: () => [
      m('validate', 'Validate demand', 'Prove people want it before building.', 4, [k('researcher', 'validate_offer', 'Validate the product idea'), k('researcher', 'audience_profile', 'Profile the first users'), k('critic', 'review_plan', 'Critique the idea')]),
      m('spec', 'Define the smallest version', 'One job, done well.', 6, [k('builder', 'mvp_spec', 'Write the MVP spec')]),
      m('build', 'Build and ship it', 'Get a working version in front of people.', 14, [k('developer', 'implement_feature', 'Build the first version'), k('ops', null, 'Deploy the first version somewhere people can reach it', { human: true, instructions: 'Use the code and run instructions in the Outbox.' })]),
      m('launch', 'Launch', 'Tell the first users.', 18, [k('copywriter', 'landing_page', 'Write the launch page'), k('lead_generator', 'build_lead_list', 'Build a list of first users'), k('email_marketer', 'draft_outreach_batch', 'Draft the launch outreach', { optional: ['email'], deliver: ['email'] })]),
      m('customers', 'Win the first customers', 'Turn interest into paid use.', 30, [k('sales_closer', 'proposal', 'Write the pricing and proposal'), k('finance', 'ledger_review', 'Review verified revenue', { optional: ['stripe'] })])] },
  trading: { label: 'Trading research', words: ['trading', 'trade', 'forex', 'futures', 'stocks', 'crypto', 'prop firm', 'backtest', 'options', 'strategy'],
    build: () => [
      m('research', 'Research approaches', 'Find strategies with evidence, not hype. No returns are promised.', 5, [k('researcher', 'market_scan', 'Compare trading approaches suited to the goal', { instructions: 'Compare 3 trading approaches. Give the evidence for and against each. Promise no returns.' }), k('critic', 'review_plan', 'Critique the chosen approach')]),
      m('rules', 'Write the risk rules', 'Decide the limits before any risk is taken.', 7, [k('critic', 'compliance_check', 'Write risk and compliance rules', { instructions: 'Define max loss per trade and per day, position sizing, and when to stop trading.' }), k('ops', 'weekly_ops_plan', 'Write the daily trading routine')]),
      m('backtest', 'Backtest', 'Test the rules on history.', 14, [k('developer', 'implement_feature', 'Write the backtest with clear metrics'), k('developer', 'write_tests', 'Write tests for the backtest')]),
      m('paper', 'Paper trade', 'Practise with no money at risk.', 28, [k('ops', null, 'Paper trade for two weeks and log every trade', { human: true }), k('data_analyst', 'kpi_report', 'Review the paper trading log')]),
      m('decide', 'Go or no-go', 'Decide honestly whether to risk real money.', 30, [k('critic', 'review_plan', 'Decide go or no-go for small live size')])] },
  general: { label: 'General business', words: [],
    build: () => [
      m('research', 'Find demand and an offer', 'Know who pays and for what.', 3, [k('researcher', 'market_scan', 'Shortlist niches with paying demand'), k('researcher', 'validate_offer', 'Validate the offer'), k('critic', 'review_plan', 'Critique the plan')]),
      m('offer', 'Make the offer real', 'Turn the idea into something people can buy.', 6, [k('copywriter', 'landing_page', 'Write the offer page'), k('builder', 'landing_page_build', 'Build the page')]),
      m('traffic', 'Reach buyers', 'Direct outreach and a small paid test.', 10, [k('lead_generator', 'build_lead_list', 'Build a list of likely buyers'), k('email_marketer', 'write_sequence', 'Write the outreach sequence'), k('ad_manager', 'ad_test_plan', 'Plan a small paid test')]),
      m('sell', 'Sell and deliver', 'Close the first customers.', 14, [k('sales_closer', 'proposal', 'Write the proposal'), k('ops', 'fulfilment_checklist', 'Prepare delivery')]),
      m('measure', 'Measure', 'Keep what earns.', 21, [k('data_analyst', 'kpi_report', 'Report results'), k('finance', 'ledger_review', 'Review verified revenue', { optional: ['stripe'] })])] }
};

function classify(goalText, world) {
  const t = String(goalText || '').toLowerCase(); let best = null, score = 0;
  for (const [key, p] of Object.entries(PATHS)) { const s = p.words.filter((w) => t.includes(w)).length; if (s > score) { best = key; score = s; } }
  if (best) return best;
  const byKind = { ecommerce: 'ecommerce', trading: 'trading', content: 'content', services: 'outreach', product: 'product' }[world && world.kind];
  return byKind || 'general';
}
function platformOf(goalText) {
  const t = String(goalText || '').toLowerCase();
  return /etsy/.test(t) ? 'etsy' : /shopify/.test(t) ? 'shopify' : /woocommerce|wordpress/.test(t) ? 'woocommerce' : /gumroad|digital (product|download)|planner|template/.test(t) ? 'gumroad' : 'shopify';
}
function template(goalText, world) {
  const path = classify(goalText, world), p = PATHS[path];
  return { path, label: p.label, milestones: p.build({ platform: platformOf(goalText) }) };
}

const withIds = (ms) => ms.map((x) => ({ id: id('m'), key: x.key, title: x.title, why: x.why, days: x.days, status: 'todo', tasks: x.tasks.map((t) => ({ ...t, id: id('t'), status: 'todo', attempts: 0 })) }));
const genericTasks = (title) => [
  { role: 'researcher', task: 'validate_offer', title: `Research: ${title}`, instructions: `Work out what is needed to complete this milestone: "${title}".`, requires: [], optional: [], deliver: [], owner: 'agent' },
  { role: 'ops', task: 'weekly_ops_plan', title: `Plan: ${title}`, instructions: `Plan the steps, owners and deadlines to complete: "${title}".`, requires: [], optional: [], deliver: [], owner: 'agent' }];

async function askDirector(store, system, user, maxTokens) {
  const w = store.state, dir = Object.values(w.agents).find((a) => a.role === 'director'); assert(dir, 'No Director yet.');
  guardrails.assertBudget(w, dir.id);
  const res = await providers.complete(store, { agent: dir, purpose: 'planner', json: true, maxTokens, system, messages: [{ role: 'user', content: user }] });
  guardrails.recordSpend(store, { agentId: dir.id, cents: res.costCents, tokensIn: res.tokensIn, tokensOut: res.tokensOut, model: res.model });
  return parseJsonLoose(res.text);
}
const words = (s) => new Set(String(s).toLowerCase().split(/\W+/).filter((x) => x.length > 2));

// Step 2: milestones. Template first; a connected model may adapt them. Falls back silently to the template.
async function draftMilestones(store) {
  const w = store.state, goal = w.mission.name, tpl = template(goal, w);
  let ms = withIds(tpl.milestones), adapted = false;
  if (!providers.isOffline(store)) {
    try {
      const base = tpl.milestones.map((x) => ({ keep: x.key, title: x.title, why: x.why, days: x.days }));
      const j = await askDirector(store, 'You are the Director planning a small business roadmap. Reply with JSON only.',
        JSON.stringify({ goal, worldFocus: w.focus || undefined, baseline: base,
          rules: ['Return {"milestones":[{"keep":"<baseline keep id, optional>","title":"","why":"","days":0}]}', 'Use 3 to 6 milestones.', 'Reuse a baseline milestone by copying its keep id, adjusting title, why and days to fit the goal.', 'Add a new milestone (no keep) only if the goal truly needs one the baseline lacks, at most 2.', 'Drop steps the goal does not need. Never add steps about platforms or stores the goal does not mention.'] }), 700);
      const list = j && Array.isArray(j.milestones) ? j.milestones : null;
      if (list && list.length >= 3 && list.length <= 6) {
        const seen = new Set(); let added = 0; const out = [];
        for (const e of list) {
          const title = clip(e.title, 80); if (title.length < 3) throw new Error('bad title');
          const src = e.keep && !seen.has(e.keep) ? tpl.milestones.find((x) => x.key === e.keep) : null;
          if (e.keep && src) seen.add(e.keep);
          else if (++added > 2) throw new Error('too many new milestones');
          out.push({ key: src ? src.key : 'x' + out.length, title, why: clip(e.why, 200) || (src ? src.why : ''), days: Math.max(1, Math.min(60, Math.round(Number(e.days)) || (src ? src.days : 7))), tasks: src ? src.tasks : genericTasks(title) });
        }
        ms = withIds(out); adapted = true;
      }
    } catch (e) { w.journey.notice = 'The Director could not adapt the plan, so this is the standard plan for your goal. ' + e.message; }
  }
  w.journey.milestones = ms; w.journey.path = tpl.path; w.journey.pathLabel = tpl.label; w.journey.adapted = adapted;
}

// User edits from the milestones screen: keep tasks for milestones we already know, give new ones generic tasks.
function saveMilestones(store, list) {
  const w = store.state, old = new Map(w.journey.milestones.map((x) => [x.id, x]));
  assert(Array.isArray(list) && list.length >= 1 && list.length <= 8, 'Keep between 1 and 8 milestones.');
  w.journey.milestones = list.map((e) => {
    const title = clip(e.title, 80); assert(title.length >= 3, 'Each milestone needs a title.');
    const prev = e.id && old.get(e.id);
    return { id: prev ? prev.id : id('m'), key: prev ? prev.key : 'u', title, why: clip(e.why, 200), days: Math.max(1, Math.min(90, Math.round(Number(e.days)) || 7)), status: 'todo', tasks: prev ? prev.tasks : withIds([{ key: 'u', title, why: '', days: 0, tasks: genericTasks(title) }])[0].tasks };
  });
}

function deriveRequirements(rm, previous = []) {
  const map = new Map(), skipped = new Set(previous.filter((r) => r.skipped).map((r) => r.kind));
  for (const ms of rm.milestones) for (const t of ms.tasks) {
    for (const kind of t.requires) { const r = map.get(kind) || { kind, blocking: true, why: `Needed to: ${t.title}`, tasks: [] }; r.blocking = true; r.tasks.push(t.id); map.set(kind, r); }
    for (const kind of t.optional) if (!t.requires.includes(kind)) { const r = map.get(kind) || { kind, blocking: false, why: `Helps: ${t.title}`, tasks: [] }; r.tasks.push(t.id); map.set(kind, r); }
  }
  return [...map.values()].filter((r) => station.CONNECTOR_KINDS[r.kind]).map((r) => ({ ...r, skipped: skipped.has(r.kind) }));
}
function neededAgents(rm) {
  const seen = new Set(), out = [];
  for (const ms of rm.milestones) for (const t of ms.tasks) if (!seen.has(t.role) && ROLES[t.role]) { seen.add(t.role); out.push({ role: t.role, label: ROLES[t.role].label }); }
  return out;
}

// Step 3: the full roadmap. A connected model personalises each task's instructions to the goal.
async function buildRoadmap(store) {
  const w = store.state, goal = w.mission.name, prev = w.roadmap ? w.roadmap.requirements : [];
  const rm = { id: id('road'), path: w.journey.path, label: w.journey.pathLabel, goal, status: 'draft', paused: false, createdAt: Date.now(),
    summary: `${w.journey.pathLabel || 'Plan'}: ${w.journey.milestones.length} milestones toward "${goal}". Only the integrations the tasks truly need are requested.`,
    milestones: JSON.parse(JSON.stringify(w.journey.milestones)) };
  if (rm.path === 'trading') rm.summary += ' Trading carries risk of loss and this plan promises no returns; it paper-trades before any real money.';
  rm.requirements = deriveRequirements(rm, prev); rm.agents = neededAgents(rm);
  if (!providers.isOffline(store)) {
    try {
      const tasks = rm.milestones.flatMap((x) => x.tasks.filter((t) => t.owner === 'agent').map((t) => ({ id: t.id, role: t.role, title: t.title })));
      const j = await askDirector(store, 'You are the Director. Tailor task instructions to the goal. Reply with JSON only.',
        JSON.stringify({ goal, worldFocus: w.focus || undefined, tasks, rules: ['Return {"summary":"","tasks":[{"id":"","instructions":""}]}', 'summary: two sentences on how this plan reaches the goal.', 'instructions: one to three sentences specific to the goal, under 300 characters. Reference the niche, offer or audience implied by the goal.', 'Only use ids from the list. Do not invent new tasks.'] }), 1400);
      if (j) {
        if (j.summary) rm.summary = clip(j.summary, 500);
        const byId = new Map(rm.milestones.flatMap((x) => x.tasks).map((t) => [t.id, t]));
        for (const e of Array.isArray(j.tasks) ? j.tasks : []) { const t = byId.get(e.id); if (t && e.instructions) t.instructions = clip(e.instructions, 300); }
      }
    } catch (e) { w.journey.notice = 'The Director could not tailor the task wording, so tasks use the standard instructions. ' + e.message; }
  }
  w.roadmap = rm;
}

const DEFAULT_NAMES = { researcher: 'Scout', data_analyst: 'Delta', lead_generator: 'Prospect', email_marketer: 'Herald', sales_closer: 'Closer', copywriter: 'Quill', content_manager: 'Editor', social_manager: 'Echo', designer: 'Pixel', ad_manager: 'Pilot', ecommerce_manager: 'Merchant', builder: 'Forge', developer: 'Dev', customer_support: 'Helper', ops: 'Ops', finance: 'Tally', critic: 'Cato', custom: 'Agent' };

// The Director's deployment plan: only the agents, rooms, connectors and hallways this roadmap needs.
function deployActions(world) {
  const rm = world.roadmap, actions = [], taken = new Set(Object.values(world.agents).map((a) => a.name.toLowerCase()));
  const roomRef = {}, ensureRoom = (role) => {
    const kind = ROLES[role].room; if (roomRef[kind]) return roomRef[kind];
    const existing = Object.values(world.rooms).find((r) => r.kind === kind);
    if (existing) return (roomRef[kind] = 'room:' + existing.id);
    if (kind === 'bridge') return (roomRef[kind] = 'room:' + Object.values(world.rooms).find((r) => r.kind === 'bridge').id);
    actions.push({ type: 'create_room', ref: 'r_' + kind, name: station.ROOM_KINDS[kind] ? station.ROOM_KINDS[kind].label : 'Room', kind, w: 8, h: 5 });
    return (roomRef[kind] = 'room:r_' + kind);
  };
  const order = []; for (const a of rm.agents) { ensureRoom(a.role); order.push(a.role); }
  for (const a of rm.agents) {
    if (Object.values(world.agents).some((x) => x.role === a.role)) continue;
    let name = DEFAULT_NAMES[a.role] || ROLES[a.role].label, n = 2; while (taken.has(name.toLowerCase())) name = (DEFAULT_NAMES[a.role] || 'Agent') + n++;
    taken.add(name.toLowerCase()); actions.push({ type: 'create_agent', name, role: a.role });
  }
  const connRef = {}, connKinds = new Set(rm.requirements.filter((r) => !r.skipped).map((r) => r.kind));
  for (const ms of rm.milestones) for (const t of ms.tasks) for (const d of t.deliver || []) if (Object.values(world.connectors).some((c) => c.kind === d)) connKinds.add(d);
  for (const kind of connKinds) {
    if (kind === 'portal' || Object.values(world.connectors).some((c) => c.kind === kind)) continue;
    const roleUsing = (rm.milestones.flatMap((x) => x.tasks).find((t) => t.requires.includes(kind) || t.optional.includes(kind) || (t.deliver || []).includes(kind)) || {}).role;
    actions.push({ type: 'create_connector', ref: 'c_' + kind, kind, ...(roleUsing && roomRef[ROLES[roleUsing].room] && roomRef[ROLES[roleUsing].room].startsWith('room:r_') ? { near: 'r_' + ROLES[roleUsing].room } : {}) });
    connRef[kind] = 'connector:c_' + kind;
  }
  // Hallways: Inbox → each distinct room in task order → Outbox; connectors wired to the rooms that use them.
  const seq = []; for (const role of order) { const r = roomRef[ROLES[role].room]; if (r && !seq.includes(r)) seq.push(r); }
  const have = new Set(Object.values(world.hallways).map((h) => h.from + '>' + h.to)), add = (from, to) => { if (from !== to && !have.has(from + '>' + to)) { have.add(from + '>' + to); actions.push({ type: 'create_hallway', from, to }); } };
  const conRef = (kind) => connRef[kind] || (Object.values(world.connectors).find((c) => c.kind === kind) ? 'connector:' + Object.values(world.connectors).find((c) => c.kind === kind).id : null);
  if (seq.length) { add('inbox', seq[0]); for (let i = 1; i < seq.length; i++) add(seq[i - 1], seq[i]); add(seq[seq.length - 1], 'outbox'); }
  for (const ms of rm.milestones) for (const t of ms.tasks) {
    const room = roomRef[ROLES[t.role].room]; if (!room) continue;
    for (const kind of [...(t.deliver || [])]) { const c = conRef(kind); if (c) add(room, c); }
    for (const kind of [...t.requires, ...t.optional]) { const c = conRef(kind), src = station.CONNECTOR_KINDS[kind]; if (c && src && (src.mode === 'source')) add(c, room); }
  }
  return actions;
}

// 'ready' | 'skipped' | 'needs_setup' for one requirement.
function requirementStatus(world, req) {
  if (req.skipped) return 'skipped';
  return Object.values(world.connectors).some((c) => c.kind === req.kind && c.status === 'ready') ? 'ready' : 'needs_setup';
}
const hasRevenueSource = (world) => Object.values(world.connectors).some((c) => SOURCE_KINDS.includes(c.kind) && c.status === 'ready');
const roadmapNeedsSource = (rm) => !rm.requirements.some((r) => SOURCE_KINDS.includes(r.kind));

module.exports = { PATHS, SOURCE_KINDS, classify, platformOf, template, draftMilestones, saveMilestones, buildRoadmap, deriveRequirements, neededAgents, deployActions, requirementStatus, hasRevenueSource, roadmapNeedsSource, genericTasks };
