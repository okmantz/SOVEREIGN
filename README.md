# Sovereign

**A pixel-art command station where a Director agent and its crew build and run businesses toward a profit target you set.**

![The Sovereign station](docs/media/station.png)

You set a mission (a verified-profit target, starting capital, and the most you will lose). The **Director**, the first agent on the station, designs the crew, rooms, hallways and first venture, then asks you to approve. Agents run concurrently from desks, hand work down hallways, and deliver to the Outbox. The ledger only believes money that a payment source has confirmed.

Autonomous does not mean unsupervised. Sovereign is built around **human-gated autonomy**: agents grind between checkpoints, and you approve the few decisions that are structural, expensive or irreversible. It does not guarantee profit, and most early ventures will lose small amounts. That is what the loss limits are for.

## The station

| Piece | What it is |
|---|---|
| **Room** | A team. Its capabilities are the *ceiling* for everyone inside. |
| **Desk** | A seat with grants. What an agent can do = desk grants ∩ room ceiling ∩ agent ceiling. |
| **Hallway** | An authorized handoff lane between rooms, connectors, the Inbox and the Outbox. |
| **Connector** | A port to the outside world (Stripe, email, ads, GitHub, MCP). A hallway can only reach it from a room with the matching capability. |
| **Inbox / Outbox** | Where work enters and where finished results land as real items, not chat scrollback. |
| **Director** | The first agent. Locked in, crowned, and the only one with `station.edit` and `venture.create`. Proposes plans; you approve. |

Everything is editable by hand: draw rooms, place desks, lay hallways, drop connectors, create and restyle agents (pixel avatars, roles, personas, models). The Director can do all of it too, in one approvable plan.

## Run it

```
git clone <your repo>
cd sovereign
npm start          # Node 18+, no install step, zero dependencies
```

Open http://localhost:8787, click **Set a mission**, and approve the Director's plan. It works out of the box on an offline demo model; add an OpenRouter key or point it at Ollama in **Settings** for real work. `npm test` runs the suite.

## The laws (enforced in code, tested)

1. **The interface never asserts money the harness cannot prove.** Only HMAC-signed connector events and harness-measured model spend are *verified*. Agent claims are stored but never counted.
2. **Budgets and approvals live in code, not prompts.** Daily station and per-agent caps; Director plans, email/ad sends and structural changes need your approval by default.
3. **Kill rules have no vote.** A venture that reaches its verified loss limit is stopped automatically.
4. **Only the Director edits the station.** Director-only capabilities are stripped from everyone else, even if a desk grants them.
5. **Plans are atomic.** A Director plan is dry-run before you see it and rolls back completely if any step fails.
6. **Local first.** Binds to 127.0.0.1, rejects foreign origins, keys are write-only.

## Repo map

```
sidecar/        Local Node runtime: HTTP+SSE API, station model, agents, Director, runner, ledger, guardrails, providers
frontend/       Vanilla JS station: canvas floor plan, procedural avatars, inspector, Director chat, money, outbox
docs/           ARCHITECTURE, DIRECTOR, GUARDRAILS, LEDGER, VENTURES, API, ROADMAP
recipes/        Draft format for reusable multi-step ventures (engine lands in v0.2)
test/           Node test runner suite covering the laws above
src-tauri/      Desktop shell plan (v0.3)
```

## Status (v0.1)

Real: station editor, agents and avatars, Director plans with approvals, pipeline dispatch, budgets, signed ledger ingestion, kill rules, offline/OpenRouter/Ollama providers.
Stubbed: connectors queue to the Outbox after approval and do not call real services yet; no scheduler yet. See [docs/ROADMAP.md](docs/ROADMAP.md).
