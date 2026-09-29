# Recurring revenue engine

Everything here is **draft-first**: a step becomes a draft in the mail queue, a human approves it in the daily digest (one batch, about ten minutes), and only then does it go out. Nothing in this layer creates verified money or marks a sale; only Stripe events do.

## What was added

| Piece | File | What it does |
|---|---|---|
| Subscription bookkeeping | `payments.js` | `invoice.paid` (renewals, once per invoice), `invoice.payment_failed`, `customer.subscription.updated/deleted` (churn marked from Stripe, scheduled cancellations, pauses, plan changes), refunds. First invoice is never double counted. |
| Stripe event poller | `payments.js` `pollEvents` | Pulls the same events from Stripe's Events API every 5 minutes, de-duplicated with the webhook. **No public URL or tunnel needed.** Stripe keeps events 30 days. |
| Mail queue | `mail.js` | One queue, laws enforced in code: approval, opt-out footer + one-click unsubscribe, hard daily limit, send window, unsubscribe list, kill-switch hold. Rails: `resend` built in, `registerMailer()` for others, `manual` when nothing is configured. |
| Timed sequences | `lifecycle.js` | outreach (day 3, 7, 14), onboarding (0, 3, 14), dunning (0, 3, 7), churn-save, win-back, testimonial + referral ask (day 30), upsell. Stop rules are checked at send time (a reply, a payment, an opt-out cancels what is queued). |
| Retainer engine | `retainer.js` | Define a monthly or weekly service; each cycle: schedule → agent produces → quality gate (one automatic repair) → **one approval** → e-mailed + private portal page → delivered, on-time measured. Non-paying customers are not served. |
| Inbound replies | `lifecycle.js` `handleInbound` | Classifies replies; a pricing question gets a price + payment-link draft in seconds (sent automatically only if `mail.auto_reply_pricing` is on); STOP unsubscribes; a bare 1 to 5 is a satisfaction score. |
| Daily digest | `lifecycle.js` `digest` | Everything waiting, graded; "approve all safe" approves the unflagged items in one call. |
| Cash-flow guardrail | `ceo.js` `cashflow` | Ads freeze when LTV/CAC < 3 (CFO refuses marketing spend); scaling blocked while MRR does not cover monthly cost. Numbers that do not exist yet never trigger a freeze. |
| Tunnel | `tunnel.js` | Optional Cloudflare tunnel to an **allow-listed gateway** (never the control API), auto-registers/updates the Stripe webhook. `named` mode for a permanent hostname. |
| Hosted pages | `pages.js` | Offer page, status page (measured aggregates only), refund policy, terms. Templates, **not legal advice**. |

## Setup (about 15 minutes)

1. Secrets (write-only): `stripe_secret_key` (a restricted key with read on Events, Customers, Subscriptions and Billing Portal write), `resend_api_key`, `mail_from`, `mail_footer` (opt-out line **plus a postal address**), `owner_email`.
2. Enable the Stripe Billing Portal once in the Stripe dashboard (dunning e-mails link to it).
3. Define the retainer: `POST /api/company/retainer/define {"venture_id":"...","template":"weekly_report","price":99,"upsell":{"name":"Pro","price":199,"pitch":"...","after_cycles":3}}` (templates: `weekly_report`, `content_batch`, `lead_list`, or your own deliverables).
4. Sell it with a Stripe Checkout link (`recurring: "week"|"month"`, metadata carries `venture_id`).
5. Settings you will touch: `mail.daily_limit`, `mail.window`, `mail.auto_send` (sequence names that skip approval; leave empty until you trust them), `pages.*`, `guardrail.*`.
6. Turn the autopilot on. The `minute` job runs the sequences and delivery loop; `five_min` polls Stripe.

## Honest limits

- A customer's **first** delivery needs what they tell you (reply to the welcome e-mail; `POST /api/company/customers/:id {"profile":{"notes":"..."}}`). Missing facts are written as `[needs input: ...]`, never invented, and flagged items cannot be bulk-approved.
- With the model offline, deliveries are labelled placeholders and can never be bulk-approved.
- Inbound e-mail needs a forwarder that POSTs to `/hooks/reply/<venture>/<token>` (Resend inbound, Zapier, Cloudflare Email Routing). You can also paste a reply into `POST /api/company/inbound`.
- The Stripe poller sees events within 5 minutes; the webhook (with the tunnel) within seconds.
- Nothing here has run against a live Stripe or Resend account. Run the **test-mode** checklist in `docs/REMOTE.md` first.
