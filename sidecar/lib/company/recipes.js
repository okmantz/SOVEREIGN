'use strict';

const common = (extra = []) => [
  { role: 'CEO', purpose: 'Manages the business: strategy, selection, kill/pivot/scale', level: 0 },
  { role: 'CFO', purpose: 'Budgets, runway, unit economics, spend authorization', level: 0 },
  ...extra,
  { role: 'Finance', purpose: 'Bookkeeping and verified ledger hygiene', level: 1 },
];
const RECIPES = {
  saas: {
    name: 'SaaS World', business_models: ['saas', 'api'], integrations: ['stripe', 'resend', 'github', 'vercel'],
    roles: common([{ role: 'Product Manager', purpose: 'MVP scope, roadmap', level: 1 }, { role: 'Developer', purpose: 'Build, test, deploy', level: 2 }, { role: 'Designer', purpose: 'UI, landing page, brand', level: 1 },
      { role: 'DevOps', purpose: 'Deploy, monitor, incident response', level: 2 }, { role: 'Marketing', purpose: 'Acquisition channels', level: 2 }, { role: 'Sales', purpose: 'Outbound and demos', level: 2 }, { role: 'Support', purpose: 'Onboarding, tickets, churn', level: 2 }]),
    kpis: ['mrr', 'trial_to_paid', 'cac', 'ltv', 'churn', 'uptime'], budgets: { validation: 100, monthly_cap: 500 },
    milestones: ['Validate demand (landing page + waitlist/preorders)', 'Ship MVP', 'First 10 paying customers', 'Reach goal MRR'],
    kill_rules: { max_days_no_revenue: 60, validation_budget_burn_kill: 0.7 },
  },
  ecommerce: {
    name: 'E-commerce World', business_models: ['ecommerce', 'digital_product'], integrations: ['stripe', 'shopify', 'etsy', 'facebook_ads', 'resend'],
    roles: common([{ role: 'Product Research', purpose: 'Demand and margin research', level: 0 }, { role: 'Supplier', purpose: 'Sourcing and quotes', level: 1 }, { role: 'Store Manager', purpose: 'Listings and inventory', level: 2 },
      { role: 'Copywriter', purpose: 'Listings and ads copy', level: 1 }, { role: 'Ads', purpose: 'Paid acquisition within caps', level: 3 }, { role: 'Support', purpose: 'Customer support and refunds', level: 2 }, { role: 'Fulfillment', purpose: 'Orders and shipping', level: 2 }]),
    kpis: ['orders', 'aov', 'gross_margin', 'roas', 'refund_rate'], budgets: { validation: 150, monthly_cap: 800 },
    milestones: ['Pick product + supplier', 'Test listing/ads', 'First 10 orders', 'Reach goal profit'], kill_rules: { max_days_no_revenue: 45, validation_budget_burn_kill: 0.7 },
  },
  agency: {
    name: 'Agency World', business_models: ['service', 'leadgen'], integrations: ['stripe', 'resend', 'google_calendar', 'notion'],
    roles: common([{ role: 'Lead Generator', purpose: 'Finds and qualifies prospects', level: 1 }, { role: 'Sales', purpose: 'Outreach, calls, proposals', level: 2 }, { role: 'Account Manager', purpose: 'Client comms and retention', level: 2 },
      { role: 'Developer', purpose: 'Delivery', level: 2 }, { role: 'Designer', purpose: 'Delivery', level: 1 }, { role: 'Copywriter', purpose: 'Delivery and outreach copy', level: 1 }, { role: 'Fulfillment', purpose: 'Deliver client work', level: 2 }]),
    kpis: ['leads', 'reply_rate', 'close_rate', 'mrr', 'gross_margin'], budgets: { validation: 50, monthly_cap: 300 },
    milestones: ['Define ICP + offer', '100 qualified outreach contacts', 'First 3 clients', 'Reach goal MRR'], kill_rules: { max_days_no_revenue: 45, validation_budget_burn_kill: 0.7 },
  },
  content: {
    name: 'Content World', business_models: ['content'], integrations: ['stripe', 'google_sheets', 'webhook'],
    roles: common([{ role: 'Research', purpose: 'Topic and keyword research', level: 0 }, { role: 'Writer', purpose: 'Articles/scripts', level: 1 }, { role: 'Video', purpose: 'Video production', level: 1 }, { role: 'Designer', purpose: 'Thumbnails/graphics', level: 1 },
      { role: 'SEO', purpose: 'On-page and distribution', level: 2 }, { role: 'Distribution', purpose: 'Publishing and promotion', level: 2 }, { role: 'Monetization', purpose: 'Affiliate, ads, sponsorship, products', level: 2 }, { role: 'Analyst', purpose: 'Analytics', level: 0 }]),
    kpis: ['traffic', 'email_subscribers', 'rpm', 'revenue_per_post'], budgets: { validation: 50, monthly_cap: 250 },
    milestones: ['Pick niche + 10 topics', 'Publish 20 pieces', 'First monetization', 'Reach goal profit'], kill_rules: { max_days_no_revenue: 90, validation_budget_burn_kill: 0.8 },
  },
  digital_product: {
    name: 'Digital Product World', business_models: ['digital_product'], integrations: ['stripe', 'gumroad', 'resend'],
    roles: common([{ role: 'Research', purpose: 'Demand research', level: 0 }, { role: 'Product', purpose: 'Define the product', level: 1 }, { role: 'Designer', purpose: 'Design', level: 1 }, { role: 'Builder', purpose: 'Create the product', level: 1 },
      { role: 'Marketing', purpose: 'Acquisition', level: 2 }, { role: 'Sales', purpose: 'Sales pages and follow-up', level: 2 }, { role: 'Support', purpose: 'Customer support', level: 2 }]),
    kpis: ['sales', 'conversion', 'refund_rate', 'cac'], budgets: { validation: 75, monthly_cap: 300 },
    milestones: ['Presell to 5 buyers', 'Build product', 'Launch', 'Reach goal profit'], kill_rules: { max_days_no_revenue: 45, validation_budget_burn_kill: 0.7 },
  },
};

/** "Create an autonomous SaaS company." → venture + world plan + budgets + permissions + milestones + kill rules. */
function makeRecipes(ctx) {
  const list = () => Object.entries(RECIPES).map(([id, r]) => ({ id, name: r.name, roles: r.roles.length }));
  function instantiate(id, { name, goal, goal_monthly_profit = 1000, capital, opportunity_id } = {}) {
    const r = RECIPES[id]; if (!r) throw new Error(`unknown recipe ${id}`);
    const budget = capital || r.budgets.validation;
    const v = ctx.ventures.create({ name: name || `${r.name} venture`, type: r.business_models[0] === 'api' ? 'saas' : r.business_models[0], capital_allocated: budget, goal, goal_monthly_profit, opportunity_id,
      kill_conditions: r.kill_rules, strategy: { validation_budget: Math.min(budget, r.budgets.validation), recipe: id }, kpis: Object.fromEntries(r.kpis.map((k) => [k, null])) });
    ctx.cfo.fund(v.venture_id, budget);
    const world_plan = { name: r.name, venture_id: v.venture_id, director: 'Director', ceo: true,
      agents: r.roles.map((x) => ({ role: x.role, purpose: x.purpose, max_permission_level: x.level, starts_at_trust_tier: 0 })),
      integrations: r.integrations, kpis: r.kpis, budgets: r.budgets, milestones: r.milestones, business_models: r.business_models, kill_rules: r.kill_rules };
    return { venture: v, world_plan };
  }
  return { list, instantiate, RECIPES, get: (id) => RECIPES[id] || null };
}
module.exports = { makeRecipes, RECIPES };
