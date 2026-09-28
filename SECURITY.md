# Security

Sovereign runs a local server that can spend money and send messages on your behalf.

- It binds to `127.0.0.1` only and rejects browser requests from non-local origins.
- API keys are write-only and never sent to the UI. v0.1 stores them in a `0600` file; the desktop shell will move them to the OS keychain.
- Ledger revenue counts only when it arrives by HMAC-signed webhook. Agents can only file unverified claims.
- Report vulnerabilities privately to the maintainers, not in a public issue.
