# Guardrails

Each rule below has a test in `test/core.test.js`. Weakening one requires changing its test and saying why.

| Law | Where | How |
|---|---|---|
| Agents run only from a seat, with a budget | `runner.js`, `guardrails.js` | No desk = no run. Daily station and per-agent caps throw before the model is called. |
| One choke point for model calls | `providers/index.js` | Spend is recorded and written to the ledger as a verified cost. |
| Director-only caps stay Director-only | `station.effectiveCaps` | Stripped for every non-Director role. |
| Structural change needs approval | `director.propose` | Default `ask`. Plans are dry-run and atomic. |
| Outbound email/ads need approval | `runner.visitConnector` | Files a `connector.call` approval; nothing is sent silently. |
| Hallways enforce capabilities | `runner.visitConnector` | A source room without the connector's cap is blocked, with a note explaining the fix. |
| Loops and runaway chains stop | `runner.dispatch` | Max 12 hops plus loop detection. |
| Local only | `sidecar/index.js` | Binds 127.0.0.1; foreign `Origin` headers get 403. |
| Keys are write-only | `secrets.js`, `publicState` | Never included in any response. |

## What the guardrails do not cover yet

Platform policies (ad accounts, email deliverability, CAN-SPAM/GDPR) and tax/legal obligations are your responsibility. Planned: sending limits and domain warmup in the email adapter, a Critic gate that blocks launches failing a compliance checklist, and per-venture spend caps enforced at the connector.
