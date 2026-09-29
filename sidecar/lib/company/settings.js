'use strict';
/** Company-layer settings. Defaults are deliberately conservative: autonomy starts as approval_only. */
const DEFAULTS = {
  autonomy: 'approval_only',            // 'approval_only' (legacy behaviour) | 'permissioned'
  port: 8787,
  caps: { per_action: 20, per_day: 100, per_month: 500 },
  trust: { tier1_successes: 3, tier2_successes: 10, tier3_successes: 25, min_rate_tier1: 0.8, min_rate_high: 0.9 },
  cfo: { reserve_pct: 0.15, experiments_pct: 0.10, min_runway_days: 14, tax_reserve_rate: 0.2 },
  ventures: { max_active: 3, validation_budget: 100, max_validation_iterations: 2, min_opportunity_score: 60 },
  kill: { max_loss_pct: 1.0, max_days_no_revenue: 45, validation_budget_burn_kill: 0.7 },
  allow_paid: false,                     // FREE-ONLY by default: any action that costs money is refused until the owner turns this on
  sandbox: { mode: 'auto', image: 'node:20-slim', timeout_ms: 120000, memory_mb: 512,
    virtual_memory_mb: 4096, cpu_seconds: 60, cpus: 1, output_cap: 200000, allow_network: false },
  browser: { allowed_domains: [], blocked_domains: [], allow_private: false },
  autopilot: { enabled: false },
  // ---- recurring revenue (v0.6). Everything here defaults to "draft it, a human approves it in the daily digest".
  mail: { provider: 'auto', auto_send: [], auto_reply_pricing: false, daily_limit: 25, window: { start: 8, end: 18 }, footer: '', owner_email: '', hold: false },
  stripe: { poll_events: true },                                   // pull subscription events from Stripe's Events API: no public webhook needed
  tunnel: { enabled: false, mode: 'quick', public_url: '', auto_register_webhook: true },   // 'quick' = free trycloudflare URL, 'named' = permanent hostname + token
  lifecycle: { enabled: true, outreach: true, onboarding: true, dunning: true, churn_save: true, winback: true, testimonial: true, upsell: true,
    testimonial_after_days: 30, ai_personalize: true, max_per_tick: 50, churn_save_cooldown_days: 45 },
  retainer: { hold_after_failed_payments: 2, sla_hours: 48, publish_portal: true, max_revisions: 2 },
  pages: { company_name: '', support_email: '', postal_address: '', refund_days: 7, checkout_url: '', booking_url: '', billing_url: '', public_url: '' },
  // ---- remote control from a phone. Off until you pair a device; high-risk approvals stay desktop-only unless you say otherwise.
  remote: { telegram: { enabled: false, poll: true }, discord: { enabled: false }, console: { enabled: false }, notify: { approvals: true, info: true }, quiet_hours: { start: 23, end: 7 }, report_hour: 8, allow_high_risk_remote: false, max_pushes_per_hour: 30 },
  guardrail: { min_ltv_cac: 3, min_mrr_cover: 1 },                 // stop scaling ads below this LTV/CAC; do not scale while MRR covers less than this share of monthly cost
};
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a[k] === 'object' ? merge(a[k], v) : v;
  }
  return out;
}
function makeSettings(ctx) {
  const get = () => merge(DEFAULTS, ctx.db.get('settings', {}));
  const set = (patch) => { ctx.db.set('settings', merge(ctx.db.get('settings', {}), patch)); return get(); };
  return { get, set, DEFAULTS };
}
module.exports = { makeSettings, DEFAULTS };
