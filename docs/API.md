# API (localhost:8787)

Most endpoints act on one **world**. Send `x-world: <id>` (or `?world=<id>`); without it the first world is used. `GET /api/state` returns `world`, `worlds`, `journey`, `jobs`, `worldKinds` and `installId` along with the usual station data.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Whole station (secrets excluded) |
| GET | `/api/events` | SSE: `state, ledger, approval, outbox, handoff, run.start, run.done, token` (live text), `notice` (toasts); events carry `worldId` |
| POST | `/api/goal` (alias `/api/mission`) | `{name, targetCents, capitalCents, riskCents}`; starts the journey |
| POST | `/api/journey/...` | Milestones, roadmap, setup, pause/resume, task actions. See JOURNEY.md |
| POST/PATCH/DELETE | `/api/worlds[/:id]` | Create `{name, kind, focus}`, edit, delete |
| POST | `/api/worlds/connect` · `/disconnect` | `{a, b}` two-way portals |
| POST | `/api/agents/:id/task` | `{taskId?, instructions?}` run a job task in the background |
| POST | `/api/ollama/warm` | Load the model into memory |
| POST | `/api/reset` | `{confirm: "RESET"}` erase everything and start fresh |
| POST | `/api/director/message` | `{text}` |
| POST | `/api/approvals/:id/approve` · `/reject` | Resolve a pending plan or connector call |
| POST/PATCH/DELETE | `/api/agents[/:id]` | Create, edit (avatar, role, persona, model, deskId), remove |
| POST | `/api/agents/:id/run` | `{task}` run one agent |
| POST | `/api/agents/:id/chat` | `{text}` talk to any agent (the Director uses `/api/director/message`) |
| POST | `/api/agents` | `{name, role, avatar, deskId?, roomId?}`; omit both and the agent gets their own desk automatically |
| POST/PATCH/DELETE | `/api/rooms[/:id]` · `/api/desks[/:id]` | Room and desk editing |
| POST/DELETE | `/api/hallways[/:id]` | Hallways |
| POST/PATCH/DELETE | `/api/connectors[/:id]` | Connectors: `{kind, x?, y?}`; PATCH takes `{name, config, secrets, ventureId, autoSync}` |
| POST | `/api/connectors/:id/test` · `/sync` · `/disconnect` | Test the connection, pull data now, sign out |
| GET | `/oauth/start?connector=` · `/oauth/callback` | Google and Etsy sign-in |
| GET | `/api/ollama/models?host=` | List models on an Ollama server |
| POST | `/api/provider/test` | One-word round trip through the current provider |
| POST | `/api/run` | `{from: "inbox"|"room:<id>"|"connector:<id>", task}` dispatch along hallways |
| POST | `/api/settings` · `/api/secrets` · `/api/secrets/ingest` | Provider, Ollama (host, keepAlive, numCtx), concurrency, intro, policy, budgets; write-only keys (`openrouter`, `openai`); ingest secret |
| POST | `/api/ledger/claim` | File an *unverified* claim |
| POST | `/api/ingest/:source` | Signed ledger event (see LEDGER.md) |
