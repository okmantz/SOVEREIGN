'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain' };
const hits = new Map();
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
  if (!(p.startsWith('/api/company') || p.startsWith('/hooks/') || p.startsWith('/sites/'))) return false;
  const ip = req.socket.remoteAddress || '?';
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
    m = p.match(/^\/sites\/([\w-]+)\/(.*)$/);
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
    }
    if (req.method === 'POST') {
      if ((m = p.match(/^\/api\/company\/approvals\/([\w-]+)\/(approve|reject)$/))) return json(200, await co.resolveApproval(m[1], m[2] === 'approve', (await readJson()).note));
      if (p === '/api/company/ceo/tick') return json(200, co.ceo.tick());
      if (p === '/api/company/autopilot/run') { const b = await readJson(); return json(200, b.job ? await co.autopilot.runJob(b.job) : await co.autopilot.tick()); }
      if (p === '/api/company/autopilot/resume') { co.autopilot.resume(); return json(200, co.autopilot.status()); }
      if (p === '/api/company/settings') return json(200, co.setSettings(await readJson()));
      if (p === '/api/company/capital') { const b = await readJson(); co.setCapital(Number(b.total), b.max_loss === undefined ? undefined : Number(b.max_loss)); return json(200, co.cfo.plan()); }
      if (p === '/api/company/secrets') { const b = await readJson(); co.secrets.set(String(b.name), String(b.value)); return json(200, { ok: true, names: co.secrets.names() }); }
      if (p === '/api/company/recipes/instantiate') { const b = await readJson(); return json(200, co.recipes.instantiate(b.id, b)); }
      if (p === '/api/company/opportunities/scan') { const b = await readJson(); return json(200, await co.opportunities.scan({ queries: (b.queries || []).slice(0, 5) })); }
      if ((m = p.match(/^\/api\/company\/opportunities\/([\w-]+)\/(research|models)$/))) return json(200, m[2] === 'research' ? await co.opportunities.research(m[1], await readJson()) : co.opportunities.generateModels(m[1]));
      if (p === '/api/company/agents/grant') { const b = await readJson(); co.permissions.grant(String(b.agent_id), Number(b.level)); return json(200, { tier: co.permissions.tier(b.agent_id) }); }
      if (p === '/api/company/ledger') { // human-confirmed money only; agent claims are stored as unverified
        const b = await readJson(); const e = co.ledger.record({ ...b, source: b.confirmed ? 'manual_confirmed' : 'agent_claim' }); return json(200, e);
      }
    }
    return json(404, { error: 'unknown company route' });
  } catch (e) { return json(400, { error: e.message }); }
}
module.exports = { handle };
