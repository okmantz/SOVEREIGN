'use strict';
const http = require('node:http');
const { spawn } = require('node:child_process');

/**
 * PUBLIC ACCESS FOR STRIPE, LEAD FORMS, REPLIES AND THE CUSTOMER PORTAL.
 *
 * Two ways to get subscription events without any of this:
 *   1. the Stripe event poller (payments.pollEvents, runs from the autopilot), which needs no public URL at all; and
 *   2. this module, which starts a free Cloudflare tunnel and keeps Stripe's webhook pointed at it.
 *
 * SECURITY: the tunnel never points at the main server. It points at a tiny gateway that forwards ONLY the allow-listed public
 * paths below (Stripe webhook, lead/event/reply/unsubscribe hooks, status JSON, the token-scoped portal, published sites), so the
 * private control API cannot be reached from the internet even though it lives in the same process.
 */
const ALLOW = [
  { m: ['POST'], re: /^\/hooks\/stripe$/ },
  { m: ['POST'], re: /^\/hooks\/discord$/ },
  { m: ['GET'], re: /^\/remote\/[\w-]+\/(index\.html)?$/ },
  { m: ['GET'], re: /^\/remote\/[\w-]+\/api\/state$/ },
  { m: ['POST'], re: /^\/remote\/[\w-]+\/api\/act$/ },
  { m: ['POST', 'OPTIONS'], re: /^\/hooks\/(lead|event|reply)\/[\w-]+\/[\w-]+$/ },
  { m: ['GET', 'POST'], re: /^\/hooks\/unsub\/[\w-]+\/[\w-]+\/[\w-]+$/ },
  { m: ['GET'], re: /^\/hooks\/status\/[\w-]+$/ },
  { m: ['GET'], re: /^\/hooks\/portal\/[\w-]+\/[a-f0-9]{16,64}(\/[\w.-]*)?$/ },
  { m: ['GET'], re: /^\/venture\/[\w-]+\/[\w./-]*$/ },
];
const allowed = (method, pathname) => ALLOW.some((a) => a.m.includes(method) && a.re.test(pathname));
const WEBHOOK_EVENTS = ['checkout.session.completed', 'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded'];

function makeTunnel(ctx, api) {
  const st = { proc: null, url: null, gateway: null, gwPort: null, started: null, error: null, webhook: null, webhook_error: null };
  const spawnFn = () => ctx.spawnImpl || spawn;
  const routes = () => require('./routes');

  function ensureGateway() {
    if (st.gateway) return Promise.resolve(st.gwPort);
    return new Promise((resolve, reject) => {
      const srv = http.createServer(async (req, res) => {
        const p = new URL(req.url, 'http://x').pathname;
        if (!allowed(req.method, p)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
        try { if (!(await routes().handle(api, req, res))) { res.writeHead(404); res.end('not found'); } } catch { if (!res.headersSent) res.writeHead(500); res.end('error'); }
      });
      srv.once('error', reject); srv.listen(0, '127.0.0.1', () => { st.gateway = srv; st.gwPort = srv.address().port; resolve(st.gwPort); });
    });
  }

  /** Keep exactly one Stripe webhook endpoint (tagged sovereign=1) pointed at the current public URL; store its signing secret. */
  async function registerStripeWebhook() {
    if (!ctx.secrets._get('stripe_secret_key')) return { skipped: 'no stripe_secret_key' };
    const base = ctx.publicUrl(); if (!/^https:\/\//.test(base)) return { skipped: 'no public https URL yet' };
    const url = `${base}/hooks/stripe`; const S = ctx.payments.stripe;
    const list = await S('GET', '/webhook_endpoints?limit=100'); const mine = (list.data || []).find((w) => w.metadata && w.metadata.sovereign === '1');
    if (mine && mine.url === url && ctx.secrets._get('stripe_webhook_secret')) { st.webhook = { id: mine.id, url }; return { ok: true, unchanged: true, url }; }
    if (mine && ctx.secrets._get('stripe_webhook_secret')) { await S('POST', `/webhook_endpoints/${mine.id}`, { url }); st.webhook = { id: mine.id, url }; return { ok: true, updated: true, url }; }
    if (mine) await S('DELETE', `/webhook_endpoints/${mine.id}`); // the signing secret is only shown at creation: without it, recreate
    const made = await S('POST', '/webhook_endpoints', { url, enabled_events: WEBHOOK_EVENTS, metadata: { sovereign: '1' }, description: 'Sovereign (managed automatically)' });
    if (made.secret) ctx.secrets.set('stripe_webhook_secret', made.secret);
    st.webhook = { id: made.id, url }; return { ok: true, created: true, url };
  }

  async function start() {
    if (st.proc) return status();
    const t = ctx.settings().tunnel; const named = t.mode === 'named'; const bin = process.env.CLOUDFLARED_BIN || 'cloudflared';
    if (named && !ctx.secrets._get('cloudflare_tunnel_token')) throw new Error('named tunnel mode needs the secret cloudflare_tunnel_token');
    if (named && !/^https:\/\//.test(t.public_url || '')) throw new Error('named tunnel mode needs settings.tunnel.public_url (your permanent https hostname)');
    const port = await ensureGateway(); st.error = null;
    const args = named ? ['tunnel', '--no-autoupdate', 'run', '--token', ctx.secrets._get('cloudflare_tunnel_token')] : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
    const proc = spawnFn()(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); st.proc = proc; st.started = ctx.now();
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => (named ? resolve(t.public_url) : reject(new Error('cloudflared did not report a URL within 30 seconds'))), named ? 8000 : 30000); timer.unref && timer.unref();
      const seen = (d) => { const s = String(d); if (!named) { const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(timer); resolve(m[0]); } } else if (/registered tunnel connection/i.test(s)) { clearTimeout(timer); resolve(t.public_url); } };
      proc.stdout && proc.stdout.on('data', seen); proc.stderr && proc.stderr.on('data', seen);
      proc.once('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'cloudflared is not installed. Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or rely on the Stripe event poller, which needs no tunnel.' : e.message)); });
      proc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`cloudflared exited (${code})`)); });
    }).catch((e) => { st.error = e.message; try { proc.kill(); } catch { /* already gone */ } st.proc = null; st.url = null; throw e; });
    st.url = url; proc.once('exit', () => { st.proc = null; st.url = null; ctx.emit('tunnel.down', {}); });
    ctx.emit('tunnel.up', { url });
    if (t.auto_register_webhook) { try { st.webhook_result = await registerStripeWebhook(); st.webhook_error = null; } catch (e) { st.webhook_error = e.message; } }
    return status();
  }
  function stop() { const p = st.proc; st.proc = null; st.url = null; if (p) { try { p.kill(); } catch { /* gone */ } } return status(); }
  /** Autopilot: bring the tunnel (and the webhook) back if it dropped. A quick tunnel gets a new URL each start; the webhook follows it. */
  async function ensure() {
    if (!ctx.settings().tunnel.enabled) return { skipped: 'tunnel disabled' };
    if (st.proc) return { running: true, url: st.url };
    try { const s = await start(); return { restarted: true, url: s.url }; } catch (e) { return { error: e.message }; }
  }
  const url = () => st.url;
  const status = () => ({ running: !!st.proc, url: st.url, mode: ctx.settings().tunnel.mode, gateway_port: st.gwPort, started: st.started, error: st.error, webhook: st.webhook, webhook_error: st.webhook_error, poller: ctx.settings().stripe.poll_events ? 'on (works without a tunnel)' : 'off' });
  async function close() { stop(); if (st.gateway) { await new Promise((r) => st.gateway.close(r)); st.gateway = null; st.gwPort = null; } }
  return { start, stop, ensure, status, url, registerStripeWebhook, ensureGateway, close, allowed, ALLOW };
}
module.exports = { makeTunnel, allowed, ALLOW };
