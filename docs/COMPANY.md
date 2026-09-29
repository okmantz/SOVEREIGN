# The company layer

Sovereign now runs a business the way a company is run: **goal → CEO → Director → agents → verified money → CEO.**

```
Owner's goal
   ↓
CEO ── strategy, kill conditions, scale / hold / pivot / kill, from verified numbers only
   ↓ direction                          CFO ── every spend is judged here; nobody moves money around it
Director ── rooms, agents, tasks, and (with your approval) a whole new world
   ↓
Agents ── each with a job, a playbook and a role-limited tool list
   ↓
Tools ── permission level → CFO → free-only gate → action
   ↓
Verified ledger (Stripe, shops, ads, measured model cost) ── back to the CEO
```

## Free by default

Nothing here needs a paid service. The model can be Ollama or the offline demo; sites publish as a **local preview** or a **ZIP** you drop on any free host (Netlify Drop, Cloudflare Pages direct upload, GitHub Pages); images are SVG offline; market scanning uses free public sources (Hacker News, Reddit, GitHub, Stack Overflow, npm, App Store).

Paid actions (paid image APIs, paid hosting, ads) are **refused in code** until you untick *Free only* in Settings → Company. Even then the CFO must authorise each one against cash, runway, reserve and your caps ($20 per action, $100 per day, $500 per month by default), and level-4 actions (contracts, large payments, anything irreversible) always wait for you.

## How a goal becomes a company

1. You set a goal (or launch a **recipe**: SaaS, e-commerce, agency, content, digital product).
2. The goal becomes a **venture**: type, capital, loss limit as a kill condition, KPIs. The CFO holds the capital.
3. The roadmap opens with the CFO's budget and, once research and the critic are in, the CEO's strategy. The path's specialists follow (a SaaS plan adds a Product Manager, DevOps and an Account Manager; an agency adds an Account Manager; a store or content plan adds an SEO Specialist). Anything the Builder makes is deployed and checked by DevOps. The round ends with the CEO's scale / hold / iterate / pivot / kill call.
4. The Director staffs only the roles the plan needs, each in its own room; the CEO and CFO sit in the Boardroom.
5. If the CEO finds a business that deserves its own team, the Director proposes a **new world** (linked by a portal, with its own goal and roadmap). You approve it like any structural change.
6. Every agent sees the **company briefing** (verified money, funnel, validation status, kill conditions, lessons) or "no data yet". They never see invented numbers.
7. If the CEO kills a venture, the roadmap **pauses and stays paused**, however many tasks remain.

## Every agent knows its job

`sidecar/lib/company/playbooks.js` holds the exact job description of all 25 roles: identity, who it reports to, what it owns, the numbers it is judged by, what to read first, who receives its work, how it works, what it must never do, when it must stop and escalate, which tools it may call, and what "done" means. It is added to every agent's system prompt (a shorter form for local models). `jobs.js` holds each role's task library and saved settings.

The six new roles: **CEO, CFO, Product Manager, DevOps, Account Manager, SEO Specialist**.

## Agent tools

An agent asks for a tool by ending its reply with a fenced block:

    ```tool
    {"tool":"crm.prospect.add","input":{"contact":"lee@example.com","problem":"late invoices"}}
    ```

The tool must be on that role's list (a Researcher cannot publish a site), then it passes the permission engine. Tools that need approval appear in your normal Approvals list. Results are added to the deliverable in the Outbox.

| Tool | Cost | Level |
|---|---|---|
| crm.prospect.add / update, crm.ticket.open, memory.note, experiment.log | free | 0 |
| spend.request (asks the CFO, moves no money) | free | 0 |
| landing.create, image.svg, app.scaffold, code.build, code.run | free | 0 (sandbox only) |
| web.fetch, opportunity.scan | free | 0 |
| site.publish (local, ZIP, or a free host you have a token for), deploy.ship | free | 2 |
| stripe.checkout | free to create; Stripe takes its fee per sale | 2 |
| image.generate | paid API | 3 (needs *allow paid*) |

Agents can **never** create verified money. The CRM refuses `won` from an agent; only a verified payment wins a customer. Anything typed in as revenue is stored as a claim.

## Money: one truth

Sovereign's ledger and the company ledger stay in step, idempotently: verified Stripe / shop / ad / measured-model entries flow into the CFO's numbers, and Stripe checkout revenue and refunds received by the company layer flow back onto the goal's profit bar. Agent claims stay claims in both. Contribution profit = revenue − refunds − variable costs − operating − acquisition − AI costs.

## Autonomy

*Ask me before anything is published or sent* (default) keeps the human-gated behaviour of v0.3. *Earn trust* lets a new agent start read-only and earn low-risk, then spending authority, from its record; level 4 can never be granted. The optional **autopilot** checks monitors and payments every 5 minutes, leads hourly, and reviews strategy and capital nightly and weekly, and pauses itself on repeated failure or a breached portfolio loss limit.

## Sandbox

Each venture has `workspaces/<venture>/{source,tests,artifacts,logs,credentials}` with a path jail, an allow-listed command list, timeouts and output caps. **Docker mode** (used automatically when Docker is installed and running) adds real isolation: no network, memory, CPU and process limits, dropped capabilities. **Process mode** (the fallback) is best effort and is **not a security boundary**: it has no memory cap and cannot block the network. Use Docker for any code a model writes and you do not trust.

## Founder Control Center

`/company.html` (also *Settings → Company → Open the Founder Control Center*): what happened while you were away, what needs your decision, ventures, funnel, agent performance, capital plan. It renders with `textContent` only.

## Run and configure

- Everything runs inside `npm start`. `npm run company` starts the company layer alone on its own port.
- Settings → Company: run the layer, free only, autonomy, autopilot.
- Public routes authenticate themselves: `/hooks/stripe` (signature), `/hooks/lead|event/<venture>/<token>` (per-venture token). The sidecar binds to localhost, so a Stripe webhook needs a tunnel you set up yourself (Cloudflare Tunnel is free).

## What is proven and what is not

Proven by `npm test` (138 tests): ledger math and idempotency, CFO gates, permissions and trust, sandbox jail, the scaffolded app passes its own tests, build loop, Stripe signature verification and dedupe, CRM funnel, validation decisions, kill rules, the goal→venture→plan→team flow, role-limited tools, the free-only gate, approvals in one list, the CEO stopping a roadmap, world creation, recipe launch.

**Not proven**: live Stripe, Vercel, Cloudflare, Netlify, Fly, Railway, Playwright, Docker isolation, real MCP servers, and real model output quality (tests use the offline model and scripted replies).

## Known limits

- Not built: Google Trends, Product Hunt, Etsy and Amazon scanners (register your own with `opportunities.registerScanner`), and Meta/Google ad campaign creation.
- Opportunity scores are low-confidence without measured data, and the CEO will not auto-select a low-confidence opportunity.
- Agent-to-vendor payments are a pluggable rail; the default only queues an instruction for you.
- The CEO reviews every 30 minutes, not continuously.
