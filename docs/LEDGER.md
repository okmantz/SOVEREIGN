# The ledger

Profit is the only number that matters, so it is the one number agents cannot write.

- **Verified** entries: source in `stripe, paypal, shopify, ads.meta, ads.google, bank` (arrive through signed ingest) or `harness.model` (measured by Sovereign).
- **Claims**: anything an agent says it earned. Stored with `verified:false`, shown in the UI as "not counted", excluded from progress. The claim endpoint forces `source:"agent"`, so a prompt-injected agent cannot forge `stripe`.

## Signed ingest

1. In **Money → Connect a payment source**, create an ingest secret (shown once).
2. Have your Stripe/ads/bank bridge `POST /api/ingest/<source>` with body `{"ventureId","type":"revenue|cost","amountCents","ref","note"}` and header `x-sovereign-signature: hex(HMAC-SHA256(secret, rawBody))`.
3. `ref` makes it idempotent: replaying an event is ignored.

## Kill rule

After every ingest, ventures whose verified net has reached `-maxLossCents` are set to `killed`. Agents are not consulted.

## Known limits (v0.1)

Model cost is rounded up to whole cents per call. Stripe-native webhooks are not parsed yet (you bridge them); v0.2 adds first-party Stripe and ad-platform adapters that produce these same entries.
