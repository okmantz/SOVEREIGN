# Architecture

```
frontend/ (canvas + panels)  ⇄  HTTP/JSON + SSE  ⇄  sidecar/ (Node, localhost only)
                                                     ├─ store.js       JSON state, change events, atomic save
                                                     ├─ station.js     rooms, desks, hallways, connectors, capability math
                                                     ├─ agents.js      roles, avatars, seating, Director lock
                                                     ├─ director.js    plans: validate → dry-run → approve → apply (atomic)
                                                     ├─ runner.js      run an agent from a desk; dispatch work along hallways
                                                     ├─ guardrails.js  budgets, spend records, approvals + executors
                                                     ├─ ledger.js      verified vs claimed money, signed ingest, kill rules
                                                     ├─ secrets.js     write-only key vault
                                                     └─ providers/     mock, openrouter, ollama (single choke point)
```

## Data model (state.json)

`mission`, `settings`, `agents`, `rooms {x,y,w,h,kind,capabilities}`, `desks {roomId,x,y,grants}`, `hallways {from,to}`,
`connectors {kind,x,y}`, `ventures {status,budgetCents,maxLossCents}`, `ledger`, `spend`, `approvals`, `outbox`, `transcripts`.
Node refs used by hallways: `inbox`, `outbox`, `room:<id>`, `connector:<id>`.

## Capability math

`effective(agent) = desk.grants ∩ room.capabilities ∩ agent.ceiling`, minus director-only caps unless `role === 'director'`.
Shrinking a room's ceiling trims its desks' grants immediately. An unseated agent has no capabilities and cannot run.

## Dispatch

`POST /api/run {from, task}` starts at the Inbox (or a room/connector) and walks hallways: agents in a room run concurrently, outputs
join, then fan out along every outgoing hallway. Guards: max 12 hops, loop detection, a room with nobody seated posts a blocked note,
a connector hallway requires the source room to hold the connector's capability, and email/ad connectors file an approval.
Events (`handoff`, `run.start`, `run.done`) drive the walking pulses and "working" bubbles in the UI.

## Why a single JSON file

One user, one machine, low write volume. It keeps the sidecar dependency-free and the state diffable. Move to SQLite when the ledger
needs queries the file cannot answer (see roadmap).
