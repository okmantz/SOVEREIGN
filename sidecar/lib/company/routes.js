'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' };
const hits = new Map();
const rhits = new Map();
const rlimited = (ip) => { const now = Date.now(); const w = (rhits.get(ip) || []).filter((t) => now - t < 60000); w.push(now); rhits.set(ip, w); if (rhits.size > 5000) rhits.clear(); return w.length > 40; }; // the phone console polls every 5 seconds
const limited = (ip) => { const now = Date.now(); const w = (hits.get(ip) || []).filter((t) => now - t < 60000); w.push(now); hits.set(ip, w); return w.length > 60; };

function body(req, limit = 100000) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', (d) => { b += d; if (b.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(b)); req.on('error', reject);
  });
}

/**
 * handle(company, req, res) → true if the request was for the company layer.
 * Mount it FIRST in your server's request handler:   if (await companyRoutes.handle(company, req, res)) return;
 * Private routes must sit behind the same 127.0.0.1 bind + Origin check as the rest of the sidecar (see standalone server.js).
 * Public routes (Stripe webhook, lead/event hooks, /sites) authenticate themselves (signature / per-venture token).
 */
async function handle(co, req, res) {
  const url = new URL(req.url, 'http://x'); const p = url.pathname;
  const json = (code, obj, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(obj)); return true; };
  if (!(p.startsWith('/api/company') || p.startsWith('/hooks/') || p.startsWith('/venture/') || p.startsWith('/remote/'))) return false;
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?'; // behind the tunnel gateway every request is local: rate-limit by the real client
  try {
    // ---- public, self-authenticating ----
    if (p === '/hooks/stripe' && req.method === 'POST') {
      const raw = await body(req, 1000000); const r = co.handleStripeWebhook(raw, req.headers['stripe-signature']);
      return json(r.status, { ok: r.ok });
    }
    let m = p.match(/^\/hooks\/(lead|event)\/([\w-]+)\/([\w-]+)$/);
    if (m) {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }
      if (limited(ip)) return json(429, { ok: false }, cors);
      let b = {}; try { b = JSON.parse(await body(req, 4096) || '{}'); } catch { return json(400, { ok: false }, cors); }
      const r = m[1] === 'lead' ? co.ingestLead(m[2], m[3], b) : co.ingestEvent(m[2], m[3], b); return json(r.status, { ok: r.ok }, cors);
    }
    if (p === '/hooks/discord' && req.method === 'POST') {
      if (limited(ip)) return json(429, { ok: false });
      const raw = await body(req, 100000); const r = await co.handleDiscordInteraction(raw, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp']);
      return r.status === 200 ? json(200, r.body) : json(r.status, { ok: false });
    }
    m = p.match(/^\/remote\/([\w-]+)\/(.*)$/);
    if (m) {
      const nostore = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }; const sub = m[2];
      if (rlimited(ip)) return json(429, { ok: false }, nostore);
      if (req.method === 'GET' && (sub === '' || sub === 'index.html')) {
        if (!co.remote.authConsole(m[1], null, ip, true).ok) { res.writeHead(404); res.end('not found'); return true; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...nostore, 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        res.end(require('./remote_page')); return true;
      }
      const auth = co.remote.authConsole(m[1], req.headers['x-pin'], ip);
      if (!auth.ok) { if (auth.status === 404) { res.writeHead(404); res.end('not found'); return true; } return json(auth.status, { ok: false, reason: auth.reason }, nostore); }
      if (req.method === 'GET' && sub === 'api/state') return json(200, await co.remote.consoleState(), nostore);
      if (req.method === 'POST' && sub === 'api/act') { let b = {}; try { b = JSON.parse(await body(req, 4096) || '{}'); } catch { return json(400, { ok: false }, nostore); } return json(200, await co.remote.consoleAct(b, 'console'), nostore); }
      res.writeHead(404); res.end('not found'); return true;
    }
    m = p.match(/^\/hooks\/reply\/([\w-]+)\/([\w-]+)$/);
    if (m && req.method === 'POST') {
      if (limited(ip)) return json(429, { ok: false });
      let b = {}; try { b = JSON.parse(await body(req, 200000) || '{}'); } catch { return json(400, { ok: false }); }
      const r = await co.handleReply(m[1], m[2], b); return json(r.status, { ok: !!r.ok, intent: r.intent });
    }
    m = p.match(/^\/hooks\/unsub\/([\w-]+)\/([\w-]+)\/([\w-]+)$/);
    if (m && (req.method === 'GET' || req.method === 'POST')) {
      const r = co.unsubscribe(m[1], m[2], m[3]);
      if (req.method === 'POST') return json(r.status, { ok: r.ok });
      res.writeHead(r.status, { 'content-type': 'text/html; charset=utf-8' }); res.end(r.ok ? '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;max-width:32rem;margin:3rem auto"><h2>You are unsubscribed</h2><p>You will not receive further e-mail from us, apart from messages about your account or payments.</p>' : 'not found'); return true;
    }
    m = p.match(/^\/hooks\/status\/([\w-]+)$/);
    if (m && req.method === 'GET') { const st = co.publicStatus(m[1]); return st ? json(200, st, { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' }) : json(404, { error: 'not found' }); }
    m = p.match(/^\/hooks\/portal\/([\w-]+)\/([a-f0-9]{16,64})(?:\/([\w.-]*))?$/);
    if (m && req.method === 'GET') {
      if (limited(ip)) return json(429, { ok: false });
      const buf = co.retainer.portalFile(m[1], m[2], m[3] || 'index.html');
      if (!buf) { res.writeHead(404); res.end('not found'); return true; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'" }); res.end(buf); return true;
    }
    m = p.match(/^\/venture\/([\w-]+)\/(.*)$/);
    if (m && req.method === 'GET') {
      const root = path.join(co.dataDir, 'sites', m[1]); const f = path.resolve(root, m[2] || 'index.html');
      const target = fs.existsSync(f) && fs.statSync(f).isDirectory() ? path.join(f, 'index.html') : f;
      if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) { res.writeHead(404); res.end('not found'); return true; }
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' }); res.end(fs.readFileSync(target)); return true;
    }
    // ---- private control API ----
    const readJson = async () => { try { return JSON.parse((await body(req)) || '{}'); } catch { throw new Error('bad json'); } };
    if (req.method === 'GET') {
      if (p === '/api/company/dashboard') return json(200, co.analytics.dashboard());
      if (p === '/api/company/briefing') return json(200, co.analytics.briefing(Number(url.searchParams.get('since')) || undefined));
      if (p === '/api/company/ventures') return json(200, co.ventures.list().map((v) => co.ceo.refresh(v.venture_id)).map(({ lead_token, ...v }) => v));
      if ((m = p.match(/^\/api\/company\/ventures\/([\w-]+)$/))) { const v = co.ventures.get(m[1]); if (!v) return json(404, { error: 'not found' }); co.ceo.refresh(m[1]); const { lead_token, ...pub } = v; return json(200, { venture: pub, answers: co.ceo.answers(m[1]), funnel: co.crm.funnel(m[1]), why: co.crm.whyNotGrowing(m[1]), ledger: co.ledger.summary({ venture_id: m[1] }), lessons: co.memory.lessons(m[1]) }); }
      if (p === '/api/company/opportunities') return json(200, co.opportunities.list());
      if (p === '/api/company/approvals') return json(200, co.permissions.pending());
      if (p === '/api/company/events') return json(200, co.db.get('events', []).slice(-100));
      if (p === '/api/company/tools') return json(200, co.tools.list());
      if (p === '/api/company/agents') return json(200, co.analytics.agentReport());
      if (p === '/api/company/settings') return json(200, co.settings());
      if (p === '/api/company/autopilot') return json(200, co.autopilot.status());
      if (p === '/api/company/recipes') return json(200, co.recipes.list());
      if (p === '/api/company/capital') return json(200, co.cfo.plan());
      if (p === '/api/company/remote') return json(200, co.remote.status());
      if (p === '/api/company/trail') return json(200, { verify: co.trail.verify(), entries: co.trail.tail(Math.min(200, Number(url.searchParams.get('n')) || 50), { type: url.searchParams.get('type') || undefined }) });
      if (p === '/api/company/report') return json(200, { text: await co.remote.report(Number(url.searchParams.get('since')) || undefined) });
      if (p === '/api/company/digest') return json(200, co.lifecycle.digest());
      if (p === '/api/company/mail') return json(200, { status: co.mail.status(), items: co.mail.list({ status: url.searchParams.get('status') || undefined, venture_id: url.searchParams.get('venture') || undefined }).slice(-200).reverse() });
      if (p === '/api/company/lifecycle') return json(200, { sequences: co.lifecycle.catalog(), enrollments: co.lifecycle.enrollments({ venture_id: url.searchParams.get('venture') || undefined, status: url.searchParams.get('status') || undefined }).slice(-200).reverse() });
      if (p === '/api/company/inbound') return json(200, co.lifecycle.inbound(100));
      if (p === '/api/company/retainers') return json(200, { templates: co.retainer.templates(), defined: co.ventures.list().map((v) => co.retainer.get(v.venture_id)).filter(Boolean) });
      if (p === '/api/company/retainer/cycles') return json(200, co.retainer.cycles({ venture_id: url.searchParams.get('venture') || undefined, status: url.searchParams.get('status') || undefined }).slice(-200).reverse());
      if (p === '/api/company/tunnel') return json(200, co.tunnel.status());
      if (p === '/api/company/customers') return json(200, co.crm.customers(url.searchParams.get('venture') || undefined).map(({ portal_token, billing_link, ...c }) => c));
      if ((m = p.match(/^\/api\/company\/cashflow\/([\w-]+)$/))) return json(200, co.ceo.cashflow(m[1]));
      if ((m = p.match(/^\/api\/company\/pages\/status\/([\w-]+)$/))) return json(200, co.pages.publicStatus(m[1]));
    }
    if (req.method === 'POST') {
      if ((m = p.match(/^\/api\/company\/approvals\/([\w-]+)\/(approve|reject)$/))) return json(200, await co.resolveApproval(m[1], m[2] === 'approve', (await readJson()).note));
      if (p === '/api/company/ceo/tick') return json(200, co.ceo.tick());
      if (p === '/api/company/autopilot/run') { const b = await readJson(); return json(200, b.job ? await co.autopilot.runJob(b.job) : await co.autopilot.tick()); }
      if (p === '/api/company/autopilot/resume') { co.autopilot.resume(); return json(200, co.autopilot.status()); }
      if (p === '/api/company/settings') return json(200, co.setSettings(await readJson()));
      if (p === '/api/company/remote/pair') { const b = await readJson(); return json(200, co.remote.startPairing(['telegram', 'discord'].includes(b.channel) ? b.channel : 'any')); }
      if (p === '/api/company/remote/test') return json(200, await co.remote.test());
      if (p === '/api/company/remote/unlink') { const b = await readJson(); return json(200, { removed: co.remote.unlink(b.channel, b.user_id) }); }
      if (p === '/api/company/remote/console') { const b = await readJson(); return json(200, b.disable ? co.remote.disableConsole() : co.remote.enableConsole({ rotate: !!b.rotate })); }
      if (p === '/api/company/remote/discord/register') return json(200, await co.remote.registerDiscordCommands());
      if (p === '/api/company/remote/stop') return json(200, await co.remote.stop('desktop', 'stopped from the desktop'));
      if (p === '/api/company/remote/resume') return json(200, await co.remote.resume('desktop'));
      if (p === '/api/company/digest/approve') return json(200, await co.lifecycle.approveBatch(await readJson()));
      if (p === '/api/company/digest/reject') return json(200, await co.lifecycle.rejectBatch(await readJson()));
      if ((m = p.match(/^\/api\/company\/mail\/([\w-]+)\/(edit|sent)$/))) { const b = await readJson(); const r = m[2] === 'edit' ? co.mail.edit(m[1], b) : co.mail.markSent(m[1]); return r ? json(200, r) : json(404, { error: 'not found or not editable' }); }
      if (p === '/api/company/lifecycle/tick') return json(200, await co.lifecycle.tick());
      if (p === '/api/company/lifecycle/scan') return json(200, await co.lifecycle.scan());
      if (p === '/api/company/inbound') { const b = await readJson(); return json(200, await co.lifecycle.handleInbound({ venture_id: String(b.venture_id), from: String(b.from || ''), subject: String(b.subject || ''), text: String(b.text || '') })); } // paste a reply you received
      if (p === '/api/company/retainer/define') { const b = await readJson(); return json(200, co.retainer.define(String(b.venture_id), b)); }
      if (p === '/api/company/retainer/tick') return json(200, await co.retainer.tick());
      if (p === '/api/company/tunnel/start') return json(200, await co.tunnel.start());
      if (p === '/api/company/tunnel/stop') return json(200, co.tunnel.stop());
      if (p === '/api/company/tunnel/register') return json(200, await co.tunnel.registerStripeWebhook());
      if (p === '/api/company/stripe/poll') return json(200, await co.payments.pollEvents());
      if (p === '/api/company/pages/build') { const b = await readJson(); return json(200, co.pages.build(String(b.venture_id))); }
      if ((m = p.match(/^\/api\/company\/customers\/([\w-]+)$/))) { // owner-set facts only: what the customer told us, a score, usage counters
        const b = await readJson(); const patch = {}; for (const k of ['name', 'satisfaction', 'profile', 'usage', 'refund_requested']) if (k in b) patch[k] = b[k];
        if ('satisfaction' in patch && patch.satisfaction !== null && !(patch.satisfaction >= 1 && patch.satisfaction <= 5)) throw new Error('satisfaction is 1 to 5');
        const { portal_token, billing_link, ...c } = co.crm.patchCustomer(m[1], patch); return json(200, c);
      }

      if (p === '/api/company/capital') { const b = await readJson(); co.setCapital(Number(b.total), b.max_loss === undefined ? undefined : Number(b.max_loss)); return json(200, co.cfo.plan()); }
      if (p === '/api/company/secrets') { const b = await readJson(); co.secrets.set(String(b.name), String(b.value)); return json(200, { ok: true, names: co.secrets.names() }); }
      if (p === '/api/company/recipes/instantiate') { const b = await readJson(); return json(200, co.recipes.instantiate(b.id, b)); }
      if (p === '/api/company/opportunities/scan') { const b = await readJson(); return json(200, await co.opportunities.scan({ queries: (b.queries || []).slice(0, 5) })); }
      if ((m = p.match(/^\/api\/company\/opportunities\/([\w-]+)\/(research|models)$/))) return json(200, m[2] === 'research' ? await co.opportunities.research(m[1], await readJson()) : co.opportunities.generateModels(m[1]));
      if (p === '/api/company/agents/grant') { const b = await readJson(); co.permissions.grant(String(b.agent_id), Number(b.level)); return json(200, { tier: co.permissions.tier(b.agent_id) }); }
      if (p === '/api/company/ledger') { // human-confirmed money only; agent claims are stored as unverified
        const b = await readJson(); const e = co.ledger.record({ ...b, source: 'agent_claim' }); return json(200, e); // never verified from here: verified money arrives by signed webhook or connector sync
      }
    }
    return json(404, { error: 'unknown company route' });
  } catch (e) { return json(400, { error: e.message }); }
}
module.exports = { handle };
