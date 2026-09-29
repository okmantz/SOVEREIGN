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
