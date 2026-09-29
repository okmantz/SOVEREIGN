'use strict';
// Fits the company into every roadmap. Every plan starts with the goal, then the CEO's business decision and the CFO's budget, the
// path's specialist roles (the "recipe" for that kind of business: SaaS, store, agency, content, digital product), the free deploy
// step after anything the Builder makes, and ends with the CEO's scale / hold / pivot / kill review. Runs inside planner.buildRoadmapBase.
const { id } = require('../util');

const T = (role, task, title, instructions = '') => ({ id: id('t'), role, task, title, instructions, requires: [], optional: [], deliver: [], owner: 'agent', status: 'todo', attempts: 0 });
const has = (rm, role, task) => rm.milestones.some((m) => m.tasks.some((t) => t.role === role && t.task === task));
const findMs = (rm, keys) => rm.milestones.find((m) => keys.includes(m.key)) || null;
const addTo = (rm, ms, task, after) => {
  if (!ms || has(rm, task.role, task.task)) return;
  const i = after ? ms.tasks.findIndex(after) : -1;
  if (i >= 0) ms.tasks.splice(i + 1, 0, task); else ms.tasks.push(task);
};

// path → which specialist tasks belong in that kind of business, and in which milestone
const RECIPE = {
  product:  [['spec', 'product_manager', 'mvp_scope', 'Define the MVP scope with acceptance criteria'], ['launch', 'seo_specialist', 'keyword_map', 'Map the free search queries buyers use'], ['customers', 'account_manager', 'onboarding_plan', 'Plan onboarding for the first customers']],
  ecommerce: [['traffic', 'seo_specialist', 'keyword_map', 'Map the free search queries buyers use'], ['sales', 'account_manager', 'onboarding_plan', 'Plan the post-purchase experience and reviews']],
  outreach: [['close', 'account_manager', 'onboarding_plan', 'Plan client onboarding for the first deals']],
  content:  [['distribute', 'seo_specialist', 'keyword_map', 'Map the free search queries the audience uses'], ['measure', 'seo_specialist', 'publishing_plan', 'Order the next pages by expected lead value']],
  general:  [['traffic', 'seo_specialist', 'keyword_map', 'Map the free search queries buyers use'], ['sell', 'account_manager', 'onboarding_plan', 'Plan onboarding for the first customers']],
  grow:     []
};

function augment(world, rm) {
  if (!rm || !rm.milestones.length) return rm;
  const first = rm.milestones[0], last = rm.milestones[rm.milestones.length - 1], cycle = (world.journey && world.journey.cycle) || 0;
  const goal = (world.mission && world.mission.name) || rm.goal;
  // 1. the decision at the top: budget first (parallel with research), then the CEO's strategy once the research and critique are in
  if (cycle === 0) {
    addTo(rm, first, T('cfo', 'budget_plan', 'Plan the budget and cash reserve', 'Split the capital into a test budget, experiments and a reserve. Prefer free options and keep every line exact.'));
    addTo(rm, first, T('ceo', 'business_strategy', 'Set the business strategy and kill conditions', `Decide the business for the goal "${goal}": model, price, minimum viable product, how we win the first ten customers, cost to test, and the kill conditions. Use the research and the critic's verdict.`));
  }
  // 2. the recipe for this kind of business
  const path = rm.path === 'trading' ? null : (RECIPE[rm.path] ? rm.path : 'general');
  for (const [key, role, task, title] of (path ? RECIPE[path] : [])) addTo(rm, findMs(rm, [key]) || last, T(role, task, title));
  // 3. anything the Builder makes gets deployed and checked by DevOps, on a free host or as a local preview
  for (const ms of rm.milestones) if (ms.tasks.some((t) => t.role === 'builder' && ['landing_page_build', 'store_site'].includes(t.task)))
    addTo(rm, ms, T('devops', 'deploy_site', 'Deploy the site free and check it is live', 'Publish the built site with the free target the owner has a key for, otherwise the local preview and the ZIP export. Verify the page loads.'), (t) => t.role === 'builder' && ['landing_page_build', 'store_site'].includes(t.task));
  // 4. the last word is always the CEO's, from the numbers
  addTo(rm, last, T('ceo', 'weekly_review', cycle === 0 ? 'Review the numbers: scale, hold, pivot or kill' : 'Decide the next move from the numbers', 'Answer from the company briefing: is it profitable, what blocks revenue, should we spend more. End with exactly one of SCALE, HOLD, ITERATE, PIVOT, KILL.'));
  return rm;
}
module.exports = { augment, RECIPE };
