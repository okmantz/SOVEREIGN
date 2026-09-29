'use strict';
/**
 * Standalone company-layer server (so you can try everything without touching the main sidecar):
 *     node sidecar/lib/company/server.js        → http://127.0.0.1:8788/company.html
 * Local-first: binds to 127.0.0.1 and rejects foreign Origin/Host on private routes.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createCompany } = require('./index');
const routes = require('./routes');

const PORT = Number(process.env.COMPANY_PORT || 8788);
const dataDir = process.env.SOVEREIGN_DATA || path.join(process.cwd(), 'data');
const company = createCompany({ dataDir });
company.setSettings({ port: PORT });
const FRONT = path.join(__dirname, '..', '..', '..', 'frontend');
const PUBLIC = /^\/(hooks\/|sites\/|remote\/)/;

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || '').split(':')[0]; const origin = req.headers.origin;
  const local = (h) => h === '127.0.0.1' || h === 'localhost';
  if (!PUBLIC.test(req.url) && (!local(host) || (origin && !local(new URL(origin).hostname)))) { res.writeHead(403); return res.end('forbidden'); }
  if (await routes.handle(company, req, res)) return;
  const f = path.join(FRONT, req.url === '/' ? 'company.html' : path.normalize(req.url.split('?')[0]));
  if (f.startsWith(FRONT) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(f)); }
  res.writeHead(404); res.end('not found');
});
if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => console.log(`SOVEREIGN company layer on http://127.0.0.1:${PORT}/company.html`));
  company.autopilot.start();
}
module.exports = { server, company };
