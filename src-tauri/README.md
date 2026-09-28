# Desktop shell (planned, v0.3)

Tauri wraps `sidecar/` + `frontend/` into a signed Windows/macOS app.
Requirements before this ships: swap `sidecar/lib/secrets.js` for the OS keychain, start the sidecar on a random
localhost port with a per-launch token, and add the updater. Until then use `npm start` and open http://localhost:8787.
