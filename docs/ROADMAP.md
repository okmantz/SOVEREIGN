# Roadmap

**v0.1** Station editor, Director plans + approvals, dispatch, budgets, signed ledger, kill rules.

**v0.2 (this repo)** 3D neon station with zoom and pan, 19 roles, 17 character presets, own-desk placement, chat with any agent, Ollama/OpenRouter/OpenAI-compatible providers, eight integration adapters (stubbed-HTTP tested), room rename and resize.

**v0.3 (this repo)** Guided journey (goal, milestones, roadmap, setup, autopilot), worlds and portals, coded per-role jobs with saved settings, Director assigns work, opening sequence, smoothed characters, wider panel with Integrations, nine more adapters (17 total), Ollama streaming and queueing, data stored in the project folder.

**v0.4 (this repo)** Company layer: CEO above the Director, CFO and spend gate, ventures with kill conditions, business memory, CRM, permissioned tools with earned trust, per-venture sandbox, free deploy (local preview, ZIP for any free host, or a free host token), Stripe checkout and webhook, five business recipes, Founder Control Center. Free by default.

**v0.4.x Prove it on live accounts**
- Run every adapter against real accounts, fix what breaks, add Stripe webhooks, email warmup schedules, ad spend actions with hard caps, GitHub, MCP servers.
- Night Shift: scheduled Director check-ins and recipe runs inside an explicit leash, every away-action logged.
- Recipes engine (`recipes/` format): reusable multi-step venture playbooks.
- Capital allocator: shift budget toward winning ventures by verified return, cut losers.
- Critic gate: compliance checklist that blocks launches (ad policy, CAN-SPAM/GDPR, refund terms).

**v0.5 Desktop**
- Tauri shell, OS keychain, per-launch API token, signed installers.
- SQLite ledger and run history.

**v0.6 Depth**
- Per-agent sandboxed workspaces and code execution.
- Voice, chat channels (Telegram/Discord) for approvals on your phone.
- Import/export a station as a shareable template.
