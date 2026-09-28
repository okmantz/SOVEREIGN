# Integrations

Add a port from **Settings → Integrations** (or the Connector tool), open it, paste credentials, click **Test connection**. Secrets go into the write-only vault and are never shown again. Blank fields keep the saved value.

## Honest status

Every adapter is written against the provider's documented API and covered by tests with **stubbed HTTP**: request shape, ledger mapping, idempotency, error handling, token refresh. **None has been run against a live account yet.** Provider APIs and versions change, so treat first use as a test: connect with a low-risk account or test mode, run Test connection, then Sync now and compare the numbers with the provider's dashboard. Shopify and Meta versions are configurable fields for this reason.

## Sources: read-only, feed the verified ledger

| Connector | What you need | What it records |
|---|---|---|
| **Stripe** | A *restricted* key with read access to Charges | Revenue per succeeded charge, Stripe fees, refunds |
| **Shopify** | Store domain, Admin API token (`read_orders`) | Paid orders as revenue, refunds as costs |
| **Etsy** | API keystring, shop ID, sign-in (OAuth) | Paid receipts excluding tax. Etsy fees are not recorded yet |
| **Facebook Ads** | Access token with `ads_read`, ad account ID | Completed days of spend as costs. Cannot create or edit campaigns |

USD only for now: other currencies are skipped and reported. Sync runs every 10 minutes per connector (toggle off in the connector), or click Sync now. Entries are idempotent by reference, so overlapping windows never double count. Pick a venture in the connector to attribute its revenue and costs.

## Sinks: take actions, wait for your approval

| Connector | What you need | Action shape agents produce |
|---|---|---|
| **Email (Resend)** | API key, verified from-address | `{"to","subject","body"}`. Footer appended. **Daily send limit enforced in code** (default 25) |
| **Notion** | Integration token, parent page ID | `{"title","body"}` creates a page |
| **Google Drive** | OAuth client ID/secret, sign-in | `{"name","content","asGoogleDoc"}`. `drive.file` scope: it only sees files it made |
| **Google Calendar** | OAuth client ID/secret, sign-in | `{"title","start","end","description"}`. Never invites guests |

Draw a hallway from a room into the connector. The agents in that room are told the exact JSON to end their reply with. When work arrives, the JSON is parsed and validated, and an approval card shows exactly what will happen. Set **Settings → Guardrails** to "send automatically" only when you trust the pipeline.

### Google and Etsy sign-in

In the connector panel, copy the redirect URI shown (`http://localhost:8787/oauth/callback` by default) and register it with the provider. Google: create an OAuth client of type *Desktop app* and enable the Calendar or Drive API. Etsy: create an app and add the redirect URI. Then click **Connect**. Tokens are stored in the vault and refreshed automatically.

## Email compliance

Commercial email is regulated (CAN-SPAM, GDPR and others). Set a footer with an opt-out and a real postal address, warm new domains slowly, and only email people with a plausible business reason. The approval card warns when no footer is set. Compliance is your responsibility.

## Adding an adapter

Copy `sidecar/lib/integrations/stripe.js` (source) or `email.js` (sink), register it in `integrations/index.js` and add its kind to `CONNECTOR_KINDS` in `station.js`. Sources return `{entries, cursor, notes}`. Sinks provide `contract`, `validate`, `preview`, `perform`. Add tests with stubbed `fetch` like `test/integrations.test.js`.
