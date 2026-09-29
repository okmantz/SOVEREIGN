# Autonomy, speed and free-first building (v0.4)

**Speed.** Cloud providers stream and retry (`providers/sse.js`); deliverables are short by default (Settings: Fast/Balanced/Thorough); job tasks are stateless so prompts stay small; the roadmap is readable instantly and the model tailors wording in the background; independent tasks run in parallel (`orchestrator.js`).

**Parallel autopilot.** Producers (research, lead lists, copy, designs) start together once the first milestone has decided the niche; consumers (reviews, builds, reports, sends) wait for the work before them. Up to two milestones ahead may run. One specialist runs one task at a time.

**Director delegation.** Idle agents get extra drafts and analysis (`orchestrator.EXTRAS`). Extras never send, post or spend, and are not repeated across rounds.

**Working memory.** `memory.js`: the owner's constraints (capital, loss limit, rules) and a shared block of decisions, handoffs and spend plan go into every prompt. Agents start replies with `HANDOFF:` and optional `DECISION:` lines.

**Capital ladder.** `strategy.js`: stage targets and budgets are computed in code; a model may propose ideas but cannot grant itself money. Moving up needs verified profit.

**Never stops early.** When a round finishes, the Director decides iterate or advance, replans, redeploys and issues a fresh SOP. It stops only when verified net profit reaches the target. Owner-only blockers are moved to the Needs-you list after a grace period (Settings) and re-queued automatically. The offline demo model stops after one round. Temporary pauses (model down, daily budget) resume by themselves.

**Websites.** Agents return files as `FILE: name` + a fenced block. `sites.js` saves them to `data/sites/<world>/` and the sidecar serves `/sites/<world>/` under a sandbox CSP (no API access). Buy buttons read `window.STORE_LINKS` from `config.js`, which you edit in the Journey panel. Free hosts serve static files only, so checkout is a hosted payment page.

**SOP.** `sop.js` writes the plan as a document at deploy time, files it in the Outbox and emits `sop.route` so the UI flies it through the rooms.

---

# v0.5: the autonomous task loop, ComfyUI, and the first-run tutorial

## Autonomous task loop (`sidecar/lib/loop.js`)
Goal → Plan → Execute → Evaluate → Learn → Repeat.

- **Execute** goes through `runner.assign`, so roadmap tasks, extra work and the Director's assignments all take part.
- **Evaluate** runs before a result is accepted. Free checks always run: anything that costs more than the stage budget, thin or declined answers, and missing files for site and catalog tasks. In `smart` mode a model judge also reads copy, builds and money work against the task's "done when" and the owner's constraints. Settings: `smart` / `always` / `off`.
- A failed result is sent back with the exact gaps, up to **max revisions** (default 1). After that it is accepted with its open issues written in the Outbox item.
- **Learn**: every fix becomes a short lesson in the shared team memory (every agent reads the latest ones), and each round ends with the Director writing what to change next.
- **Repeat**: the next round starts until the goal is reached.

Stopping conditions: goal reached; a venture hits its loss limit; daily model budget (pauses, resumes); model unreachable (pauses, retries); you pause; two rounds finish nothing; optional round cap; max revisions per task. `journey.view().loop` reports them, the stats and the latest lessons. The offline demo model is never evaluated.

## ComfyUI (`sidecar/lib/comfy.js`, `integrations/comfyui.js`)
Start ComfyUI, then press **Find and connect ComfyUI** in Integrations. It looks on the usual ports (8188, 8000), creates the connector, picks an installed model and tests it. When connected, every agent is told it may end a reply with an `images` block; the sidecar renders the images (one at a time), saves them to `data/sites/<world>/img/`, attaches thumbnails to the Outbox item, and the Builder uses them in the website. Rendering is local and free, so it needs no approval. Advanced: paste an API-format workflow with `{{prompt}}`, `{{negative}}`, `{{seed}}`, `{{width}}`, `{{height}}`, `{{checkpoint}}` placeholders (Connector settings).

## Tutorial (`frontend/tutorial.js`)
Five steps with Next and Skip on each, shown once after the first goal is saved. Enter or → is Next, Esc skips. Replay from Settings → Help.
