# API (localhost:8787)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Whole station (secrets excluded) |
| GET | `/api/events` | SSE: `state, ledger, approval, outbox, handoff, run.start, run.done` |
| POST | `/api/mission` | `{name, targetCents, capitalCents, riskCents}`; wakes the Director |
| POST | `/api/director/message` | `{text}` |
| POST | `/api/approvals/:id/approve` · `/reject` | Resolve a pending plan or connector call |
| POST/PATCH/DELETE | `/api/agents[/:id]` | Create, edit (avatar, role, persona, model, deskId), remove |
| POST | `/api/agents/:id/run` | `{task}` run one agent |
| POST/PATCH/DELETE | `/api/rooms[/:id]` · `/api/desks[/:id]` | Room and desk editing |
| POST/DELETE | `/api/hallways[/:id]` · `/api/connectors[/:id]` | Hallways and connectors |
| POST | `/api/run` | `{from: "inbox"|"room:<id>"|"connector:<id>", task}` dispatch along hallways |
| POST | `/api/settings` · `/api/secrets` · `/api/secrets/ingest` | Provider, policy, budgets; write-only keys; ingest secret |
| POST | `/api/ledger/claim` | File an *unverified* claim |
| POST | `/api/ingest/:source` | Signed ledger event (see LEDGER.md) |
