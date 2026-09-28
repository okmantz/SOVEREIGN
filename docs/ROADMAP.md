# Roadmap

**v0.1 (this repo)** Station editor, avatars, Director plans + approvals, dispatch, budgets, signed ledger, kill rules, three providers.

**v0.2 Real money and reach**
- Adapters: Stripe (read + webhooks), an email sender with warmup and rate limits, Meta/Google ads read + capped spend, GitHub, MCP servers.
- Night Shift: scheduled Director check-ins and recipe runs inside an explicit leash, every away-action logged.
- Recipes engine (`recipes/` format): reusable multi-step venture playbooks.
- Capital allocator: shift budget toward winning ventures by verified return, cut losers.
- Critic gate: compliance checklist that blocks launches (ad policy, CAN-SPAM/GDPR, refund terms).

**v0.3 Desktop**
- Tauri shell, OS keychain, per-launch API token, signed installers.
- SQLite ledger and run history.

**v0.4 Depth**
- Per-agent sandboxed workspaces and code execution.
- Voice, chat channels (Telegram/Discord) for approvals on your phone.
- Import/export a station as a shareable template.
