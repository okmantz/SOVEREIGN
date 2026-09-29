# Agent jobs

`sidecar/lib/jobs.js` gives every role a coded job:

- **summary**: what the role is for
- **does / deliver / quality**: duties, hand-backs, and the quality bar
- **settings**: fields you can tune, saved on the agent (`agent.settings`)
- **tasks**: a library of named tasks with prompts

Every prompt an agent sees starts with its persona, then `YOUR JOB`, its duties, deliverables, quality bar, and its **saved settings**. Changing a role swaps in that role's settings. Settings are validated (text length caps, numbers clamped, selects restricted to their options).

## Example: Content Manager
Settings: platforms, posts per week, content pillars, brand voice, audience, standard call to action.
Tasks: *Plan a 2-week calendar*, *Draft posts*, *Repurpose an asset*, *Weekly content report*.

## Roles
Director, Market Researcher, Data Analyst, Lead Generator, Email Outreach, Sales Closer, Copywriter, Content Manager, Social Media Manager, Designer, Ad Manager, Store Manager, Builder, Developer, Customer Support, Operations, Finance, Critic and Compliance, Custom. Open **Agents → Edit** to see each role's job and settings.

## How work reaches an agent
| Path | Approval |
|---|---|
| The roadmap autopilot assigns a task | none (you approved the roadmap) |
| Chat: *"Tell Quill to write three headlines"* → Director `assign_task` | none |
| **Agents → Give a task**, or `POST /api/agents/:id/task` | none |
| Inbox → hallways | none to run; outbound actions still wait |

Results are filed in the Outbox. If a task is set to deliver to a connector (for example an email), the agent is told the connector's JSON contract and the action goes through the normal approval.

## Director actions
There are now 25 roles. The six added in v0.4 (CEO, CFO, Product Manager, DevOps, Account Manager, SEO Specialist) have task libraries here, and every role has a full playbook (reports to, owns, never, escalates, tools, done) in `sidecar/lib/company/playbooks.js`.

`assign_task`, `update_agent` (settings and persona), `message_world` run **immediately**. `create_*` and `remove_agent` change the station and wait for approval.
