# SOVEREIGN Company Layer

Additive modules under `sidecar/lib/company/`. No existing file is overwritten. Zero dependencies (Node >= 18).

## Architecture
CEO -> CFO (budget) -> Permission engine -> Tool registry -> Action. The CEO never touches money directly.

| Module | Job |
|---|---|
| ceo.js | Lifecycle engine: KPIs, kill rules, the 12 questions (`answers()`), per-stage review, discover, tick |
| ventures.js | Venture object + state machine IDEA -> RESEARCH -> VALIDATION -> BUILD -> LAUNCH -> TRACTION -> PROFITABLE -> SCALING, plus PIVOT / DECLINE / RESTRUCTURE / KILLED |
| opportunity.js | Scanners (HN, Reddit, GitHub, custom), scorecard with confidence, 5 business-model variants |
| validation.js | Thresholds -> BUILD / ITERATE / KILL / CONTINUE |
| cfo.js | Runway, reserve, spend gate, capital allocator, portfolio loss limit, tax reserve |
| ledger.js | Chart of accounts, verified-source rule, idempotent refs, contribution-profit waterfall, AR/AP |
| permissions.js / tools.js | Levels 0-4, trust tiers 0-3, $20/action, $100/day, $500/month caps, approvals |
| sandbox.js / builder.js / deploy.js | Workspace per venture, write -> test -> fix loop, ship + verify + monitor |
| browser.js | Pluggable Playwright driver, per-action permission class, SSRF guard |
| assets.js | SVG + API-generated images, landing pages, scaffolds |
| crm.js / payments.js | Prospects, funnel, tickets, retention; Stripe checkout, webhook, refunds |
| memory.js / analytics.js | 8 memory kinds, experiments, learning; dashboard, briefing, agent reports |
| autopilot.js | 5-min / hourly / nightly / weekly jobs, stops on repeated failures |
| mcp.js | stdio MCP client feeding the tool registry |
| recipes.js | saas, ecommerce, agency, content, digital_product templates |

Default autonomy is `approval_only`, which matches current behavior. `permissioned` is opt-in.

## Permission levels
0 read | 1 draft | 2 auto-execute low risk | 3 spend within caps (CFO-gated) | 4 always human approval.
Agents start at trust tier 0 and are promoted by successful tasks; not automatic on install.

## Wiring (the only edits to existing files)
```js
const { createCompany } = require('./lib/company');
const routes = require('./lib/company/routes');
const company = createCompany({ dataDir: <your data dir>, llm: <your provider's chat fn> });
// first thing in your HTTP request handler:
if (await routes.handle(company, req, res)) return;
company.directives.drain((d) => director.assign_task(d));   // CEO -> Director
company.autopilot.start();
```
package.json: `"company": "node sidecar/lib/company/server.js"` (standalone on 127.0.0.1:8788).
UI: serve `frontend/company.html` and `frontend/company.js`.
Add job entries in jobs.js for CEO, CFO, Developer, DevOps, Designer, Analyst, Support; role names were chosen without seeing your 19 existing ids, so rename to match.

## What is proven vs not
Proven by `node --test` (26 tests): ledger math, idempotency, CFO gates, permissions/trust, sandbox jail, scaffold app passes its own tests, build loop, webhook signature + dedupe, CRM funnel, validation decisions, kill rules.
NOT proven: live Stripe, Vercel, Cloudflare, Netlify, Fly, Railway, Playwright, Docker, real MCP servers, real LLM output quality.

## Known limits
- Sandbox `process` mode is NOT a security boundary and has no memory cap. Use `docker` mode for any LLM-written code.
- Not built: Google Trends, Product Hunt, Etsy, Amazon scanners (use `registerScanner` or the browser); Meta/Google ad campaign creation.
- Image generation needs an OpenAI-compatible key; SVG fallback works offline.
- Agent-to-vendor payments are a pluggable rail; the default rail only queues a human instruction.
- Stripe webhooks need a public tunnel because the sidecar binds localhost.
- Opportunity scores are low-confidence without measured data, and the CEO will not select low-confidence opportunities.
