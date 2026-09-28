'use strict';
// Authorization-code + PKCE flow for Google and Etsy. Tokens live in the write-only vault, never in state.
const crypto = require('crypto');
const secrets = require('../secrets');
const { assert } = require('../util');
const { request } = require('./http');

const PROVIDERS = {
  google: { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', extra: { access_type: 'offline', prompt: 'consent' } },
  etsy:   { authUrl: 'https://www.etsy.com/oauth/connect', tokenUrl: 'https://api.etsy.com/v3/public/oauth/token', extra: {} }
};
const pending = new Map(); // state -> { connectorId, verifier, redirectUri, at }
const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const tokenKey = (id) => 'conn:' + id + ':oauth';

function start(connector, adapter, sec, redirectUri) {
  const o = adapter.oauth; const p = PROVIDERS[o.provider];
  const clientId = o.clientId(connector, sec);
  assert(clientId, 'Save the client ID first, then click Connect.');
  const verifier = b64u(crypto.randomBytes(48)), state = b64u(crypto.randomBytes(18));
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60000) pending.delete(k);
  pending.set(state, { connectorId: connector.id, verifier, redirectUri, at: Date.now() });
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: o.scope, state,
    code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ...p.extra });
  return p.authUrl + '?' + q.toString();
}

function save(id, json, old) {
  const prev = old || {};
  secrets.set(tokenKey(id), JSON.stringify({ access: json.access_token, refresh: json.refresh_token || prev.refresh || null,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 }));
}

// Returns the connector id once the code is exchanged; the caller looks the connector up itself.
async function finish({ state, code, error }, resolve) {
  const p = pending.get(state); pending.delete(state);
  assert(p, 'That sign-in link expired. Click Connect again.');
  assert(!error && code, 'Authorization was cancelled or denied.');
  const { connector, adapter, sec } = resolve(p.connectorId);
  const o = adapter.oauth, prov = PROVIDERS[o.provider];
  const form = { grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: o.clientId(connector, sec), code_verifier: p.verifier };
  const secret = o.clientSecret && o.clientSecret(connector, sec); if (secret) form.client_secret = secret;
  const r = await request(prov.tokenUrl, { method: 'POST', form });
  assert(r.json && r.json.access_token, 'The provider did not return a token.', 502);
  save(connector.id, r.json);
  return connector.id;
}

async function accessToken(connector, adapter, sec) {
  const raw = secrets.get(tokenKey(connector.id));
  assert(raw, `Connect ${adapter.label} first: open the connector and click Connect.`);
  const t = JSON.parse(raw);
  if (t.expiresAt - 60000 > Date.now()) return t.access;
  assert(t.refresh, 'The sign-in expired. Click Connect again.');
  const o = adapter.oauth, prov = PROVIDERS[o.provider];
  const form = { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: o.clientId(connector, sec) };
  const secret = o.clientSecret && o.clientSecret(connector, sec); if (secret) form.client_secret = secret;
  const r = await request(prov.tokenUrl, { method: 'POST', form });
  assert(r.json && r.json.access_token, 'Could not refresh the sign-in. Click Connect again.', 502);
  save(connector.id, r.json, t);
  return r.json.access_token;
}

const connected = (id) => secrets.has(tokenKey(id));
const disconnect = (id) => secrets.del(tokenKey(id));

module.exports = { start, finish, accessToken, connected, disconnect, PROVIDERS };
