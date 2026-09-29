# Remote control: run it on your desktop, steer it from your phone

Ideas borrowed from StarNet's [Messaging channels](https://starnetos.com/docs/guides/channels.html) and [Night Shift](https://starnetos.com/docs/guides/night-shift.html) guides: **owner pairing** (the first message proves it is you; strangers get nothing), **stop from the phone**, **budgets still bind**, a **morning report**, and a **decision trail** you cannot quietly edit.

## The three ways in

| | Setup | Needs the tunnel? | Can do |
|---|---|---|---|
| **Telegram** (recommended) | bot token + pair | **No** (long polling from your desktop) | push alerts, approve/reject with buttons, `/status /pending /digest /agents /report /stop /resume` |
| **Discord** | webhook (push) + application (buttons) | Buttons: yes. Push only: no | same commands as `/sovereign <command>` |
| **Console** (the "virtual platform") | one click | Yes, to open it away from home | live agent cards (working or idle, current task, last output, checks passed), approvals, money, decision trail, STOP |

## Telegram in 3 minutes

1. In Telegram, message **@BotFather**, `/newbot`, copy the token.
2. Set the secret `telegram_bot_token` and `remote.telegram.enabled = true` (Settings API), or use the **Phone remote** card in the Founder Control Center.
3. Click **Pair Telegram**. You get a 6-digit code (valid 10 minutes). Send `/pair 123456` to your bot **in a private chat**. That account is now the owner. Wrong codes lock the pairing after 5 tries; groups can never pair; up to 3 devices.
4. **Send test**. Done.

## Discord

Push: create a channel webhook and set the secret `discord_webhook_url`, `remote.discord.enabled = true`.
Buttons and slash commands: create an application, set secrets `discord_public_key`, `discord_bot_token`, `discord_app_id`, start the tunnel, set the application's **Interactions Endpoint URL** to `<tunnel url>/hooks/discord`, then `POST /api/company/remote/discord/register` once, and pair with `/sovereign pair code:123456`. Signatures (Ed25519) are verified on the raw body before anything is parsed; replies are visible only to you.

## The console

`POST /api/company/remote/console` (or **Create console link**) returns a secret address: `<public url>/remote/<48 hex chars>/`. Set a PIN with the secret `remote_pin` (5 wrong PINs lock that client for 15 minutes). Start the tunnel (`POST /api/company/tunnel/start`, needs `cloudflared`) so the address works away from home; `rotate: true` invalidates the old link, `disable: true` closes it.
The tunnel forwards **only** an allow-list of paths (Stripe webhook, lead/reply/unsubscribe hooks, status JSON, token-scoped portal, this console). The private control API is not reachable from the internet.

## Safety rules (all enforced in code, all tested)

- Only paired owners are obeyed. Everyone else is dropped silently and written to the trail.
- **High-risk approvals are desktop-only by default**: spends money, irreversible, launches a business, raises budget, scales, pivots, creates a world, money-moving connectors (ads, payments, shops). Reject always works. If you set `remote.allow_high_risk_remote = true`, they still need a **second confirming tap**.
- A remote approval runs the **same executors** as the desktop button, so the CFO vote, the free-only gate and spend caps still apply. A phone can never do more than the keyboard.
- **STOP** (one tap, always available): pauses the autopilot, holds every outgoing e-mail, pauses running plans. While it is on, approving is refused. **Resume** needs a confirming tap and never undoes a CEO kill.
- Push circuit breaker: at most `remote.max_pushes_per_hour` (30) messages an hour. Quiet hours (default 23:00 to 07:00) hold everything except urgent alerts (autopilot paused, a business shut down, ads frozen, site down, webhook rejected).
- Approvals are pushed once each, oldest first, five at a time; e-mail drafts arrive as one grouped message with **Approve all safe**.

## Morning report and decision trail

- The report (default 08:00, once a day, or `/report`) is built only from records: renewals, cancellations, failed and recovered payments, e-mails by sequence, deliveries, money, job failures, what is waiting. A quiet night says so.
- `GET /api/company/trail` is an append-only, hash-chained log of approvals (desktop and phone, with which device), stop/resume, CEO decisions, guardrail freezes, kills, mail sent, deliveries, renewals, churn. Edit or delete any line and `verify` reports the first broken entry (shown on the console and in the control center). It is a receipt for you, not a control.

## StarNet's Night Shift dials, mapped to Sovereign

| StarNet | Sovereign |
|---|---|
| INITIATIVE (wait / suggest / build / free) | `autonomy` (`approval_only` or `permissioned`) + `autopilot.enabled` |
| REACH (observe / sandbox / send & publish) | `mail.auto_send` (empty = nothing unattended leaves), `allow_paid` (off), tool permission levels |
| PACE (jobs per day) | `mail.daily_limit`, `caps.per_day`, the CFO budget engine |
| Six gates, decision receipts | Trail entries with the deciding reason; `remote.throttled`, `remote.blocked` |
| Morning report | `/report`, sent daily |

## First-run checklist (do this in Stripe test mode before any real customer)

1. Pair Telegram; **Send test**; `/status`.
2. Create a test-mode checkout for the retainer; pay with `4242 4242 4242 4242`.
3. Within 5 minutes: a customer appears, an onboarding draft and a delivery cycle exist, Telegram pings you.
4. `/pending`, approve the delivery; confirm the e-mail and portal page.
5. In Stripe: cancel the subscription at period end, then trigger a failed payment (card `4000 0000 0000 0341`); confirm churn-save and dunning drafts.
6. `/stop`; confirm nothing sends; `/resume`.
