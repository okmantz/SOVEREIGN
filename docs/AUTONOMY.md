# Autonomy, speed and free-first building (v0.4)

**Speed.** Cloud providers stream and retry (`providers/sse.js`); deliverables are short by default (Settings: Fast/Balanced/Thorough); job tasks are stateless so prompts stay small; the roadmap is readable instantly and the model tailors wording in the background; independent tasks run in parallel (`orchestrator.js`).

**Parallel autopilot.** Producers (research, lead lists, copy, designs) start together once the first milestone has decided the niche; consumers (reviews, builds, reports, sends) wait for the work before them. Up to two milestones ahead may run. One specialist runs one task at a time.

**Director delegation.** Idle agents get extra drafts and analysis (`orchestrator.EXTRAS`). Extras never send, post or spend, and are not repeated across rounds.

**Working memory.** `memory.js`: the owner's constraints (capital, loss limit, rules) and a shared block of decisions, handoffs and spend plan go into every prompt. Agents start replies with `HANDOFF:` and optional `DECISION:` lines.

**Capital ladder.** `strategy.js`: stage targets and budgets are computed in code; a model may propose ideas but cannot grant itself money. Moving up needs verified profit.

**Never stops early.** When a round finishes, the Director decides iterate or advance, replans, redeploys and issues a fresh SOP. It stops only when verified net profit reaches the target. Owner-only blockers are moved to the Needs-you list after a grace period (Settings) and re-queued automatically. The offline demo model stops after one round. Temporary pauses (model down, daily budget) resume by themselves.

**Websites.** Agents return files as `FILE: name` + a fenced block. `sites.js` saves them to `data/sites/<world>/` and the sidecar serves `/sites/<world>/` under a sandbox CSP (no API access). Buy buttons read `window.STORE_LINKS` from `config.js`, which you edit in the Journey panel. Free hosts serve static files only, so checkout is a hosted payment page.

**SOP.** `sop.js` writes the plan as a document at deploy time, files it in the Outbox and emits `sop.route` so the UI flies it through the rooms.
