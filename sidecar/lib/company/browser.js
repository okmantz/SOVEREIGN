'use strict';
const { isPrivateHost, validate } = require('./util');

const READ = new Set(['goto', 'extract', 'screenshot', 'inspect', 'search', 'wait']);
const INTERACT = new Set(['click', 'type', 'select', 'upload', 'fill']);
const COMMIT = new Set(['submit', 'publish', 'purchase']);
const MONEY_HOST = /(bank|paypal|venmo|wise\.com|coinbase|binance|stripe\.com\/(dashboard|settings)|checkout\.)/i;

/**
 * Browser agent. Driver is pluggable (Playwright when installed, fake in tests); the permission mapping is the point:
 *   read  (goto/extract/screenshot/search)  → level 0
 *   interact (click/type/fill/upload)        → level 1 draft on unknown domains, level 2 on domains the venture may write to
 *   commit (submit/publish/purchase)         → level 2 on write-granted domains, level 3 if it spends, else level 4
 *   banking/payment/credential pages         → always level 4
 */
function makeBrowser(ctx) {
  let driver = null; const sessions = new Map();
  const setDriver = (d) => { driver = d; };

  async function playwrightDriver() {
    let pw; try { pw = require('playwright'); } catch { throw new Error('playwright is not installed. Run: npm i playwright && npx playwright install chromium (optional dependency)'); }
    const browser = await pw.chromium.launch({ headless: true });
    return {
      async open(id) { const c = await browser.newContext(); const p = await c.newPage(); return { c, p }; },
      async run(h, a) {
        const p = h.p;
        switch (a.type) {
          case 'goto': await p.goto(a.url, { timeout: 30000, waitUntil: 'domcontentloaded' }); return { url: p.url(), title: await p.title() };
          case 'click': await p.click(a.selector, { timeout: 10000 }); return { url: p.url() };
          case 'type': await p.fill(a.selector, a.text, { timeout: 10000 }); return {};
          case 'fill': for (const [sel, val] of Object.entries(a.fields || {})) await p.fill(sel, val, { timeout: 10000 }); return {};
          case 'select': await p.selectOption(a.selector, a.value); return {};
          case 'upload': await p.setInputFiles(a.selector, a.path); return {};
          case 'extract': return { url: p.url(), text: (await p.innerText(a.selector || 'body')).slice(0, 20000) };
          case 'inspect': return { url: p.url(), title: await p.title(), links: await p.$$eval('a[href]', (as) => as.slice(0, 50).map((x) => x.href)), forms: await p.$$eval('form', (fs) => fs.length) };
          case 'screenshot': return { png_base64: (await p.screenshot()).toString('base64') };
          case 'wait': await p.waitForTimeout(Math.min(a.ms || 1000, 10000)); return {};
          case 'submit': case 'publish': case 'purchase': await p.click(a.selector, { timeout: 10000 }); return { url: p.url() };
          case 'search': await p.goto(`https://duckduckgo.com/html/?q=${encodeURIComponent(a.query)}`); return { text: (await p.innerText('body')).slice(0, 8000) };
          default: throw new Error('unsupported action');
        }
      },
      async close(h) { await h.c.close(); },
    };
  }

  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
  const domainMatch = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

  /** Map an action to a permission level (or a refusal). */
  function classify(a, pageUrl, venture_id) {
    const s = ctx.settings().browser; const host = hostOf(a.url || pageUrl);
    if (a.type === 'goto' || a.type === 'search') {
      if (a.type === 'goto' && (!/^https?:\/\//.test(a.url || ''))) return { refuse: 'only http(s) URLs' };
      if (a.type === 'goto' && isPrivateHost(host) && !s.allow_private) return { refuse: 'private/internal addresses are blocked' };
      if (a.type === 'goto' && domainMatch(host, s.blocked_domains)) return { refuse: 'domain is blocked' };
    }
    if (READ.has(a.type)) return { level: 0 };
    const writable = domainMatch(hostOf(pageUrl), (ctx.ventures.get(venture_id) || {}).strategy?.browser_write_domains || []) || domainMatch(hostOf(pageUrl), s.allowed_domains);
    const sensitive = MONEY_HOST.test(pageUrl || '') || (a.selector && /password|card|cvv|iban|routing/i.test(a.selector));
    if (sensitive) return { level: 4, why: 'banking/payment/credential surface' };
    if (INTERACT.has(a.type)) return { level: writable ? 2 : 1 };
    if (COMMIT.has(a.type)) return { level: a.spend > 0 ? 3 : writable ? 2 : 4, cost: a.spend || 0 };
    return { refuse: `unknown action ${a.type}` };
  }

  /** Called through the tool registry as `browser.act`; returns a result or throws. */
  async function execute(a, { venture_id }) {
    if (!driver) driver = await playwrightDriver();
    let s = sessions.get(venture_id); if (!s) { s = { handle: await driver.open(venture_id), url: '' }; sessions.set(venture_id, s); }
    const r = await driver.run(s.handle, a); if (r && r.url) s.url = r.url; return r;
  }
  const currentUrl = (venture_id) => (sessions.get(venture_id) || {}).url || '';

  const schema = { type: 'object', required: ['type'], properties: { type: { type: 'string', enum: [...READ, ...INTERACT, ...COMMIT] }, url: { type: 'string', maxLength: 2000 }, selector: { type: 'string', maxLength: 500 }, text: { type: 'string', maxLength: 5000 } } };

  /** Entry point for agents: classify → registry (permissions/CFO) → execute. */
  async function act(agent_id, venture_id, a) {
    const bad = validate(schema, a); if (bad) return { status: 'error', error: bad };
    const c = classify(a, currentUrl(venture_id), venture_id);
    if (c.refuse) return { status: 'denied', reason: c.refuse };
    const tool = `browser.${a.type}`;
    if (!ctx.tools.get(tool)) ctx.tools.register({ name: tool, owner: 'browser', description: `browser ${a.type}`, required_permission: 4, spend_category: 'marketing', input_schema: schema, irreversible: true, handler: (input, m) => execute(input, m) });
    return ctx.tools.invoke(tool, a, { agent_id, venture_id, overrides: { level: c.level, cost: c.cost || 0, irreversible: c.level >= 4 } });
  }

  /** Driverless, read-only page fetch for research (competitor sites, directories). SSRF-guarded. */
  async function fetchPage(url, { maxChars = 20000 } = {}) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s)');
    if (isPrivateHost(u.hostname) && !ctx.settings().browser.allow_private) throw new Error('private addresses are blocked');
    const res = await fetch(url, { headers: { 'user-agent': 'sovereign-research/0.4' }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
    const html = await res.text();
    const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    return { status: res.status, title: (html.match(/<title[^>]*>([^<]*)/i) || [])[1] || '', text: text.slice(0, maxChars), hash: require('node:crypto').createHash('sha256').update(text).digest('hex') };
  }
  /** Competitor watch: emits an event when a watched page's text changes. */
  async function watchCompetitors() {
    const w = ctx.db.get('competitors', {}); const changes = [];
    for (const rec of Object.values(w)) {
      try { const p = await fetchPage(rec.url); if (rec.hash && rec.hash !== p.hash) { changes.push(rec.url); ctx.emit('competitor.changed', { url: rec.url }, rec.venture_id); ctx.memory.remember(rec.venture_id, 'competitor', `${rec.url} changed`, { title: p.title }); } rec.hash = p.hash; rec.checked = ctx.now(); }
      catch (e) { rec.error = e.message; }
    }
    ctx.db.save('competitors'); return changes;
  }
  const watch = (venture_id, url) => { const w = ctx.db.get('competitors', {}); w[url] = { venture_id, url, hash: null }; ctx.db.save('competitors'); };
  return { setDriver, classify, act, fetchPage, watchCompetitors, watch, execute };
}
module.exports = { makeBrowser };
