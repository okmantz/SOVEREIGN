# The Director

The first agent on every station. It cannot be deleted, its role cannot change, and it always wears the crown (you can restyle everything else).

**Powers:** `station.edit` (create/edit agents, rooms, desks, hallways, connectors) and `venture.create`. No other role can hold these, even from a Bridge desk.
**Limits:** it proposes; it does not change policy, budgets, keys or the mission. Those are human-only.

## Plans, not commands

The Director replies with JSON `{ "say": string, "actions": Action[] }`. Actions in one reply form one **plan**:

`create_room`, `create_desk`, `create_agent`, `create_hallway`, `create_connector` (optionally `near` a room), `create_venture`, `run_task`.
Actions can refer to earlier ones by `ref`, so one plan can build a room, its desk, and the agent sitting at it.

Lifecycle: **validate** every action → **dry-run** on a throwaway copy of state (a plan that cannot fit never reaches you) → **approve**
(default policy `ask`; `auto` lets the Director apply directly) → **apply atomically** (any failure restores the snapshot).
The approval card lists every change in plain language.

## Prompt contract

The system prompt gives the Director the mission, verified progress, rooms, crew, ventures and the action schema, and states the rules:
small experiments before scale, a loss limit on every venture, only verified ledger entries count, the owner approves plans.
With a real model, quality depends on the model you pick in Settings. The offline demo model returns a deterministic starter crew so the whole loop is testable for free.
