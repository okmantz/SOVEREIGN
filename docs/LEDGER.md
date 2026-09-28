# The ledger

Profit is the only number that matters, so it is the one number agents cannot write.

- **Verified** entries come from three places: platform data the harness fetched itself through a connector (Stripe, Shopify, Etsy, Facebook Ads), signed webhooks (`stripe, paypal, shopify, etsy, ads.meta, ads.google, bank`), and `harness.model` (measured by Sovereign).
- **Claims**: anything an agent says it earned. Stored with `verified:false`, shown in the UI as "not counted", excluded from progress. The claim endpoint forces `source:"agent"`, so a prompt-injected agent cannot forge `stripe`.

## Signed ingest

1. In **Money → Connect a payment source**, create an ingest secret (shown once).
2. Have your Stripe/ads/bank bridge `POST /api/ingest/<source>` with body `{"ventureId","type":"revenue|cost","amountCents","ref","note"}` and header `x-sovereign-signature: hex(HMAC-SHA256(secret, rawBody))`.
3. `ref` makes it idempotent: replaying an event is ignored.

## Kill rule

After every ingest, ventures whose verified net has reached `-maxLossCents` are set to `killed`. Agents are not consulted.

## Connector sync

Stripe, Shopify, Etsy and Facebook Ads connectors pull data every 10 minutes and write the same entries, idempotent by reference. See INTEGRATIONS.md.

## Known limits

Model cost is rounded up to whole cents per call. USD only. Etsy fees are not recorded yet. Adapters are untested against live accounts.
