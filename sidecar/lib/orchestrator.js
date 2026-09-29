'use strict';
// Pure scheduling rules for the autopilot. No I/O here, so the rules are easy to read and to test.
//
// The old autopilot ran one task at a time. Most tasks do not need each other, so now:
//  - a PRODUCER task (research, lead lists, copy, designs, plans) needs only the first milestone's decisions
//    (and earlier tasks by the same specialist), so all of them can run at the same time
//  - a CONSUMER task (a review, a build from copy, a report, a send) waits for everything before it
//  - the team may look up to LOOK milestones ahead, so nobody waits for a milestone boundary
const jobs = require('./jobs');

const DONE = new Set(['done', 'skipped']);
const LOOK = 2;
const CONSUMER_ROLES = new Set(['critic', 'finance', 'data_analyst', 'developer', 'ecommerce_manager']);
const CONSUMER_TASKS = new Set(['landing_page_build', 'draft_outreach_batch', 'followups', 'reply_to_lead', 'store_site', 'import_products', 'review_copy', 'refund_review', 'kill_or_scale', 'venture_pnl']);
const isConsumer = (t) => t.owner === 'human' || CONSUMER_ROLES.has(t.role) || CONSUMER_TASKS.has(t.task);

const flatten = (rm) => rm.milestones.flatMap((ms, mi) => ms.tasks.map((t) => ({ ms, t, mi })));

// The first milestone decides niche and offer. Producers downstream wait for its research and validation,
// but not for the critic's review, which runs alongside them.
const decisionReady = (rm) => !rm.milestones.length || rm.milestones[0].tasks.filter((t) => t.role !== 'critic').every((t) => DONE.has(t.status));

// Tasks that could start now: right status, inside the look-ahead window, every dependency done.
function eligible(rm, { look = LOOK } = {}) {
  const flat = flatten(rm), firstOpen = rm.milestones.findIndex((ms) => ms.tasks.some((t) => !DONE.has(t.status)));
  if (firstOpen < 0) return [];
  const out = [];
  flat.forEach((x, i) => {
    const { ms, t, mi } = x;
    if (!['todo', 'blocked'].includes(t.status) || mi > firstOpen + look) return;
    const before = flat.slice(0, i);
    const deps = isConsumer(t) ? before : before.filter((b) => (b.ms === ms && b.t.role === t.role) || (mi > 0 && b.mi === 0 && b.t.role !== 'critic'));
    if (deps.every((b) => DONE.has(b.t.status))) out.push({ ms, t });
  });
  return out;
}

// The finished work this task should build on, most relevant first. This is what makes a critic read the research it is critiquing.
function inputTasks(rm, ms, t, max = 3) {
  const flat = flatten(rm), i = flat.findIndex((x) => x.t.id === t.id), before = i < 0 ? flat : flat.slice(0, i);
  const pool = (isConsumer(t) ? before : before.filter((b) => b.mi === 0 || b.ms === ms)).filter((b) => b.t.status === 'done' && b.t.result);
  return pool.slice(-max).map((b) => b.t);
}
const inputsFor = (rm, ms, t, { chars = 800, max = 3 } = {}) => inputTasks(rm, ms, t, max).map((x) => `- ${x.agentName || x.role} · ${x.title}: ${String(x.result).slice(0, chars)}`).join('\n');
// Extras have no place in the plan, so they simply read the latest finished work.
const recentInputs = (rm, { chars = 500, max = 3 } = {}) => flatten(rm).filter((b) => b.t.status === 'done' && b.t.result).slice(-max).map((b) => `- ${b.t.agentName || b.t.role} · ${b.t.title}: ${String(b.t.result).slice(0, chars)}`).join('\n');

// Work an idle agent can do usefully without waiting for anything. `early` ones make sense even before the niche is decided.
// None of these send anything: extras are drafts and analysis, and only roadmap tasks can hand work to a connector.
const EXTRAS = {
  finance: [{ key: 'spend_plan', title: 'Draft the spend plan', early: true, instructions: 'Split the current stage budget across what this plan will need: tools, fees, tests. Every line gets an exact cost and the total stays under the stage budget. Prefer $0 options. End with the one thing deliberately NOT bought yet and why.' }, { task: 'venture_pnl', title: 'Check profit and loss so far' }],
  data_analyst: [{ task: 'unit_economics', title: 'Work out the unit economics', early: true, instructions: 'Use the owner\'s capital and loss limit and the offer as it stands. Show the math and say whether the numbers can support scaling.' }, { task: 'funnel_diagnosis', title: 'Map the funnel and its leaks' }],
  critic: [{ task: 'compliance_check', title: 'Check policy and legal exposure', early: true, instructions: 'Check the plan as it stands against advertising rules, email opt-out requirements, refund terms and platform policies. Name the single biggest risk.' }],
  ops: [{ task: 'weekly_ops_plan', title: 'Plan the first week', early: true }, { task: 'fulfilment_checklist', title: 'Write the delivery checklist' }],
  researcher: [{ task: 'competitor_teardown', title: 'Tear down the competition' }, { task: 'audience_profile', title: 'Profile the buyer' }],
  copywriter: [{ task: 'ad_variants', title: 'Draft hook and ad variants' }, { task: 'email_copy', title: 'Draft email copy' }],
  designer: [{ task: 'generate_visuals', title: 'Generate the brand and product images', early: true }, { task: 'design_brief', title: 'Write the design brief' }],
  lead_generator: [{ task: 'qualify_leads', title: 'Rank the leads by fit' }, { task: 'enrich_contacts', title: 'Find the best contact routes' }],
  email_marketer: [{ task: 'followups', title: 'Draft follow-up emails' }],
  sales_closer: [{ task: 'propose_times', title: 'Draft call-booking messages' }, { task: 'proposal', title: 'Draft the proposal' }],
  content_manager: [{ task: 'repurpose', title: 'Repurpose the best asset' }],
  social_manager: [{ task: 'trend_check', title: 'Find conversations to join' }],
  ad_manager: [{ task: 'creative_briefs', title: 'Write ad creative briefs' }],
  ecommerce_manager: [{ task: 'pricing_review', title: 'Review pricing and margin' }],
  builder: [{ task: 'mvp_spec', title: 'Write the smallest build spec' }],
  customer_support: [{ task: 'faq_builder', title: 'Draft the FAQ' }]
};

function pickExtra(rm, agent, { early = false, done = [] } = {}) {
  const lib = jobs.spec(agent.role).tasks, used = new Set([...rm.milestones.flatMap((m) => m.tasks), ...(rm.extras || [])].filter((t) => t.role === agent.role).map((t) => t.task || t.key));
  for (const d of done) { const [role, key] = String(d).split(':'); if (role === agent.role) used.add(key); } // extras from earlier rounds are not repeated
  for (const c of EXTRAS[agent.role] || []) {
    const key = c.task || c.key;
    if (used.has(key) || (early && !c.early) || (c.task && !lib.some((x) => x.id === c.task))) continue;
    return { key, task: c.task || null, title: c.title, instructions: c.instructions || '' };
  }
  return null;
}

module.exports = { DONE, LOOK, isConsumer, flatten, decisionReady, eligible, inputTasks, inputsFor, recentInputs, pickExtra, EXTRAS };
