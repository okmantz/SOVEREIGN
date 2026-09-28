# Contributing

1. `node --test` must pass. The suite covers the laws in `docs/GUARDRAILS.md`; a change that weakens one needs a test explaining why.
2. Node core modules only in `sidecar/` unless there is a strong reason. Zero runtime deps is a feature.
3. Any new way for an agent to spend money, send messages or change the station goes behind a capability, a budget check and (if irreversible) an approval. Add the test first.
4. Never expose secrets to `frontend/`. Secrets are write-only through `sidecar/lib/secrets.js`.
