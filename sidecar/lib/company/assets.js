'use strict';
const crypto = require('node:crypto');
const { extractJson } = require('./util');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hue = (s) => parseInt(crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 4), 16) % 360;

/** Offline logo / hero / OG image as SVG (no API needed). */
function svgImage({ name = 'Brand', kind = 'logo', tagline = '' }) {
  const h = hue(name), c1 = `hsl(${h} 70% 45%)`, c2 = `hsl(${(h + 40) % 360} 70% 60%)`;
  const initials = esc(String(name).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
  const [w, hh] = kind === 'logo' ? [256, 256] : [1200, 630];
  const body = kind === 'logo'
    ? `<rect width="256" height="256" rx="56" fill="url(#g)"/><text x="128" y="160" font-family="system-ui,sans-serif" font-size="110" font-weight="700" text-anchor="middle" fill="#fff">${initials}</text>`
    : `<rect width="${w}" height="${hh}" fill="url(#g)"/><text x="80" y="300" font-family="system-ui,sans-serif" font-size="88" font-weight="800" fill="#fff">${esc(name)}</text>` +
      `<text x="80" y="380" font-family="system-ui,sans-serif" font-size="36" fill="#ffffffcc">${esc(String(tagline).slice(0, 70))}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${hh}" width="${w}" height="${hh}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>${body}</svg>`;
}

/** Photo-style images need a provider. OpenAI-compatible /v1/images/generations (works with OpenAI and compatible gateways). */
async function generateImage({ prompt, baseUrl = 'https://api.openai.com/v1', apiKey, model = 'gpt-image-1', size = '1024x1024' }) {
  if (!apiKey) throw new Error('no image provider key configured; use svgImage() for offline logos/banners');
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt: String(prompt).slice(0, 4000), size, n: 1 }), signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`image API HTTP ${res.status}`);
  const j = await res.json(); const d = j.data && j.data[0];
  if (d && d.b64_json) return { bytes: Buffer.from(d.b64_json, 'base64'), ext: 'png' };
  if (d && d.url) { const r = await fetch(d.url, { signal: AbortSignal.timeout(60000) }); return { bytes: Buffer.from(await r.arrayBuffer()), ext: 'png' }; }
  throw new Error('image API returned no image');
}

/** Copy: model-written when an LLM is available, otherwise built from the inputs (never invented claims). */
function fallbackCopy(o) {
  return { headline: `${o.name}: ${o.problem ? `stop ${o.problem.toLowerCase().replace(/\.$/, '')}` : o.tagline || 'get started'}`, sub: o.tagline || `Built for ${o.audience || 'busy teams'}.`, bullets: ['Set up in minutes', 'No credit card to join the waitlist', 'Made for ' + (o.audience || 'busy teams')], cta: 'Join the waitlist' };
}
async function landingCopy(llm, o) {
  const fallback = {
    headline: o.headline || `${o.name}: ${o.problem ? `stop ${o.problem.toLowerCase().replace(/\.$/, '')}` : o.tagline || 'get started'}`,
    sub: o.sub || o.tagline || `Built for ${o.audience || 'busy teams'}.`,
    bullets: o.bullets || [`Solves: ${o.problem || 'a real, recurring problem'}`, 'Set up in minutes', 'Cancel anytime'],
    cta: o.cta || (o.price ? `Get started – ${o.price}` : 'Join the waitlist'),
  };
  if (!llm) return fallback;
  const raw = await llm(`Write landing page copy. No invented statistics, testimonials or guarantees. Product: ${o.name}. Problem: ${o.problem}. ` +
    `Audience: ${o.audience}. Offer: ${o.offer || o.price || ''}. Return ONLY JSON {"headline":"","sub":"","bullets":["","",""],"cta":""}`, { json: true });
  const j = extractJson(raw); return j && j.headline ? { ...fallback, ...j, bullets: Array.isArray(j.bullets) ? j.bullets.slice(0, 5) : fallback.bullets } : fallback;
}

/** Single-file, responsive, dark-mode-aware landing page with lead capture + view/lead tracking hooks. */
function landingPage({ name = 'Untitled', copy, formEndpoint, trackEndpoint, checkoutUrl, brandHue, problem, tagline, audience }) {
  copy = copy || fallbackCopy({ name, problem, tagline, audience });
  const h = brandHue ?? hue(name);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title><meta name="description" content="${esc(copy.sub)}">
<style>:root{--b:hsl(${h} 70% 45%);--bg:#fff;--fg:#14171a;--mut:#5c6670}@media(prefers-color-scheme:dark){:root{--bg:#0e1113;--fg:#f2f4f5;--mut:#9aa5ad}}
*{box-sizing:border-box}body{margin:0;font:17px/1.55 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:720px;margin:0 auto;padding:64px 20px}h1{font-size:clamp(2rem,6vw,3.2rem);line-height:1.1;margin:0 0 16px}
p.sub{color:var(--mut);font-size:1.2rem}ul{padding-left:1.1em}li{margin:.4em 0}
form{display:flex;gap:8px;flex-wrap:wrap;margin:28px 0}input{flex:1 1 220px;padding:14px;border-radius:10px;border:1px solid var(--mut);background:transparent;color:inherit;font:inherit}
button,a.btn{padding:14px 22px;border:0;border-radius:10px;background:var(--b);color:#fff;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
#ok{display:none;color:var(--b);font-weight:600}</style></head><body><main>
<h1>${esc(copy.headline)}</h1><p class="sub">${esc(copy.sub)}</p>
<ul>${copy.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
${checkoutUrl ? `<p><a class="btn" id="buy" href="${esc(checkoutUrl)}">${esc(copy.cta)}</a></p>` : ''}
<form id="f"><input type="email" name="email" placeholder="you@company.com" required><button>${checkoutUrl ? 'Notify me' : esc(copy.cta)}</button></form>
<p id="ok">Thanks – you're on the list.</p></main>
<script>
var FORM=${JSON.stringify(formEndpoint || '')},TRACK=${JSON.stringify(trackEndpoint || '')};
function track(t){if(!TRACK)return;try{navigator.sendBeacon(TRACK,JSON.stringify({type:t,path:location.pathname,ref:document.referrer||''}))}catch(e){}}
track('view');var b=document.getElementById('buy');if(b)b.addEventListener('click',function(){track('checkout_click')});
document.getElementById('f').addEventListener('submit',function(e){e.preventDefault();var email=this.email.value;
 var done=function(){document.getElementById('f').style.display='none';document.getElementById('ok').style.display='block';track('lead')};
 if(!FORM)return done();fetch(FORM,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:email,source:document.referrer||'direct'})}).then(done).catch(done)});
</script></body></html>`;
}

/** Deployable starter apps (zero dependencies, include tests so the build loop has something to run). */
const SERVER_JS = `'use strict';
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
function createServer({ dataFile = path.join(__dirname, 'leads.jsonl'), checkoutUrl = process.env.CHECKOUT_URL || '', leadHook = process.env.LEAD_HOOK || '' } = {}) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (url.pathname === '/health') return send(200, { ok: true });
    if (url.pathname === '/api/checkout') return checkoutUrl ? (res.writeHead(302, { location: checkoutUrl }), res.end()) : send(503, { error: 'checkout not configured' });
    if (url.pathname === '/api/waitlist' && req.method === 'POST') {
      let b = ''; req.on('data', (d) => { b += d; if (b.length > 4096) req.destroy(); });
      return req.on('end', () => {
        let j; try { j = JSON.parse(b); } catch { return send(400, { error: 'bad json' }); }
        if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(j.email || '')) return send(400, { error: 'invalid email' });
        fs.appendFileSync(dataFile, JSON.stringify({ email: j.email, ts: Date.now() }) + '\\n');
        if (leadHook) fetch(leadHook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: j.email, source: 'app' }) }).catch(() => {});
        send(200, { ok: true });
      });
    }
    const f = path.join(PUB, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\\.\\.[\\/\\\\])+/, ''));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, { error: 'not found' });
    send(200, fs.readFileSync(f), TYPES[path.extname(f)] || 'application/octet-stream');
  });
}
if (require.main === module) createServer().listen(process.env.PORT || 3000, () => console.log('listening'));
module.exports = { createServer };
`;
const TEST_JS = `'use strict';
const test = require('node:test'); const assert = require('node:assert'); const os = require('node:os'); const path = require('node:path');
const { createServer } = require('../source/server');
test('health, waitlist validation', async () => {
  const s = createServer({ dataFile: path.join(os.tmpdir(), 'leads-' + Date.now() + '.jsonl') });
  await new Promise((r) => s.listen(0, r)); const base = 'http://127.0.0.1:' + s.address().port;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/api/waitlist', { method: 'POST', body: JSON.stringify({ email: 'nope' }) })).status, 400);
  assert.equal((await fetch(base + '/api/waitlist', { method: 'POST', body: JSON.stringify({ email: 'a@b.co' }) })).status, 200);
  s.close();
});
`;
const DOCKERFILE = `FROM node:20-slim\nWORKDIR /app\nCOPY source/ .\nENV PORT=3000\nEXPOSE 3000\nUSER node\nCMD ["node","server.js"]\n`;

/** Returns { 'source/...': content, 'tests/...': content } ready for sandbox.writeFile. */
function scaffold(kind, o = {}) {
  if (kind === 'static-site') return { 'source/index.html': o.html || landingPage(o) };
  if (kind === 'saas-starter') {
    return { 'source/server.js': SERVER_JS, 'source/public/index.html': o.html || landingPage({ ...o, formEndpoint: '/api/waitlist' }),
      'source/package.json': JSON.stringify({ name: String(o.slug || 'app'), version: '0.1.0', private: true, scripts: { start: 'node server.js', test: 'node --test ../tests' } }, null, 2),
      'source/Dockerfile': DOCKERFILE.replace('COPY source/ .', 'COPY . .'), 'tests/app.test.js': TEST_JS };
  }
  throw new Error(`unknown scaffold ${kind}`);
}
module.exports = { svgImage, generateImage, landingCopy, landingPage, scaffold, esc };
