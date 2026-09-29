# The guided journey

`goal → milestones → roadmap → setup → run`. Each world has its own journey. State lives in `world.journey` and `world.roadmap`; the UI reads `journey.view(world)` (in `/api/state` as `journey`).

## 1. Goal
`POST /api/goal {name, targetCents, capitalCents, riskCents}`. The first save moves to *milestones* and the Director drafts them in the background (`journey.busy = 'milestones'`). Editing the goal later only updates the numbers; it never discards the plan.

## 2. Milestones
The planner (`planner.js`) classifies the goal into a path (outreach service, online store, content, product, trading, general) from keywords, using the world's type to break ties, and starts from that path's vetted milestones. With a real model connected, the Director may adapt them: reuse a baseline milestone, retitle it, drop steps the goal does not need, or add up to two new ones. **Every model answer is validated** (3 to 6 milestones, bounded text, known ids); anything else falls back silently to the standard plan. You can edit, add or remove milestones before approving.

## 3. Roadmap
Approving milestones builds the roadmap: tasks per milestone, each with a role, a job task, optional instructions, the integrations it *requires* (blocking) or would *benefit from* (optional), and an owner (an agent, or you for human steps such as "create your store"). A connected model tailors each task's instructions to the goal. You can remove tasks; requirements and the team list recompute. Approving the roadmap approves the team it names.

**Only what the plan uses is requested.** Etsy appears only for a goal that mentions Etsy; a trading plan needs no integrations at all.

## 4. Setup
Shows the model status, one card per integration the plan uses (needed or recommended), and the team. Connect it, or **Skip for now**: tasks needing a skipped integration are skipped, the rest run. If the plan has no revenue source, the panel suggests connecting one, since only verified revenue counts.

`Deploy the team and start` runs the deploy plan (`planner.deployActions`): only the agents, rooms, connectors and hallways the roadmap needs, pre-approved by your roadmap approval.

## 5. Run
The autopilot works one task at a time per world, in milestone order, and only asks you for:

| Needs you | Why |
|---|---|
| **A human step** | Something only you can do (open the store, deploy the build). It does not stop other tasks. |
| **A missing connection** | A task needs an integration that is not ready. Connect it and the task runs. |
| **A failure** | A task failed twice. Retry or skip. |
| **An approval** | Any outbound action, as always. |

It **pauses itself** (with the reason shown) if the model is unreachable or a budget is hit, and does not count that against the task. `Pause` / `Resume` are always available. When every milestone is done, **Plan the next phase** keeps your team and plans again.

## Endpoints
`POST /api/journey/milestones/{generate,save,approve}`, `/roadmap/{generate,back,approve}`, `/requirement {kind, skipped}`, `/setup/complete`, `/pause`, `/resume`, `/replan`, `/task/:id/{remove,retry,done,skip}`.
