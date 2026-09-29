'use strict';
// Real websites, built for free. An agent (Builder, Developer, Store Manager) returns files in its reply; this module pulls them
// out, saves them to ./data/sites/<world>/, and the sidecar serves a live preview at /sites/<world>/.
//
// Why static: free hosting (GitHub Pages, Cloudflare Pages, Netlify) serves static files only, and a free plan has no server to run a
// shop on. So the store is a static site whose "Buy" buttons open a hosted checkout (a payment link, Gumroad, Etsy or Shopify page).
// Nothing here can take money itself; the money stays with the payment platform, which is also what makes it verifiable.
//
// File format the agents are told to use (either works):
//   FILE: index.html          on its own line, immediately before a fenced code block
//   ```html file:index.html   the file name in the fence header
const fs = require('fs');
const path = require('path');
const { assert } = require('./util');
const { HOME } = require('./store');

const EXT = new Set(['html', 'css', 'js', 'json', 'txt', 'md', 'svg', 'xml', 'webmanifest', 'csv']);
const BIN = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm']); // written by the sidecar itself (ComfyUI renders), never taken from an agent's text
const isBin = (n) => BIN.has(String(n).split('.').pop().toLowerCase());
const MAX_FILES = 24, MAX_BYTES = 400 * 1024;
const mem = new Map(); // worldId -> Map(name -> content), used when the store does not persist (tests)
const rootOf = (s) => s.root || s;
const idOf = (s) => s.id || s.defaultId;
const persistent = (store) => rootOf(store).persist !== false;
const dirOf = (wid) => path.join(HOME, 'sites', String(wid).replace(/[^\w-]/g, ''));

function cleanName(raw, { bin = false } = {}) {
  let n = String(raw || '').trim().replace(/^[`'"*]+|[`'"*:]+$/g, '').replace(/^\.?\//, '').replace(/\\/g, '/');
  if (!/^[\w.\-/]+$/.test(n) || n.includes('..') || n.split('/').length > 3) return null;
  const ext = n.split('.').pop().toLowerCase(); if (!(EXT.has(ext) || (bin && BIN.has(ext))) || n.startsWith('.')) return null;
  return n;
}

// Pull every named file out of an agent's reply.
function extract(text) {
  const src = String(text || ''), files = [], seen = new Set();
  const re = /(?:^|\n)[ \t]*(?:[*_#>\-\s]*(?:FILE|PATH)\s*[:=]\s*`?([\w.\-/]+)`?[*_\s]*\n)?[ \t]*```([^\n]*)\n([\s\S]*?)\n[ \t]*```/gi;
  let m;
  while ((m = re.exec(src)) && files.length < MAX_FILES) {
    const head = /(?:file|path)\s*[:=]\s*([\w.\-/]+)/i.exec(m[2] || '');
    const name = cleanName(m[1] || (head && head[1])); if (!name || seen.has(name)) continue;
    const body = m[3]; if (!body.trim() || Buffer.byteLength(body) > MAX_BYTES) continue;
    seen.add(name); files.push({ name, content: body });
  }
  return files;
}

function write(store, files) {
  const wid = idOf(store); let saved = [];
  if (persistent(store)) {
    const dir = dirOf(wid);
    for (const f of files) { const p = path.join(dir, f.name); if (!p.startsWith(dir + path.sep)) continue; fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.content); saved.push(f.name); }
  } else { const m = mem.get(wid) || mem.set(wid, new Map()).get(wid); for (const f of files) { m.set(f.name, f.content); saved.push(f.name); } }
  return saved;
}
function walk(dir, base = '') {
  let out = []; let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) { const rel = base ? base + '/' + e.name : e.name; if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), rel)); else out.push(rel); }
  return out;
}
const names = (store) => (persistent(store) ? walk(dirOf(idOf(store))) : [...(mem.get(idOf(store)) || new Map()).keys()]).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
function read(store, name) {
  const n = cleanName(name, { bin: true }); if (!n) return null;
  if (!persistent(store)) return (mem.get(idOf(store)) || new Map()).get(n) || null;
  const dir = dirOf(idOf(store)), p = path.join(dir, n);
  try { return p.startsWith(dir + path.sep) ? (isBin(n) ? fs.readFileSync(p) : fs.readFileSync(p, 'utf8')) : null; } catch (_) { return null; }
}
// A rendered image or clip from ComfyUI. Returns the site-relative name, e.g. img/hero-1.png.
function writeBinary(store, name, buf) {
  const n = cleanName(name, { bin: true }); assert(n && isBin(n), 'Not a media file name.'); assert(Buffer.isBuffer(buf) && buf.length && buf.length <= 25 * 1024 * 1024, 'Media is empty or over 25 MB.');
  const wid = idOf(store);
  if (persistent(store)) { const dir = dirOf(wid), p = path.join(dir, n); assert(p.startsWith(dir + path.sep), 'Bad path.'); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
  else (mem.get(wid) || mem.set(wid, new Map()).get(wid)).set(n, buf);
  store.change('state'); return n;
}

// Save any files in a reply. Returns the file names saved (empty when the reply had none).
function ingest(store, text) {
  const files = extract(text); if (!files.length) return [];
  const saved = write(store, files); store.change('state'); return saved;
}

// The "Buy" links the owner pastes in. The site reads window.STORE_LINKS from config.js; no rebuild is needed to change a link.
function setLinks(store, links) {
  const clean = {};
  for (const [k, v] of Object.entries(links || {}).slice(0, 60)) {
    const key = String(k).replace(/[^\w-]/g, '').slice(0, 40), url = String(v || '').trim();
    if (!key || !url) continue; assert(/^https:\/\/[^\s"'<>]+$/.test(url) && url.length < 500, `The link for "${key}" must be a full https:// address.`); clean[key] = url;
  }
  write(store, [{ name: 'config.js', content: '// Buy links. Edited from the Sovereign Site panel. Each product id maps to a hosted checkout page.\nwindow.STORE_LINKS = ' + JSON.stringify(clean, null, 2) + ';\n' }]);
  store.change('state'); return clean;
}
function links(store) { const t = read(store, 'config.js'); const m = t && /STORE_LINKS\s*=\s*(\{[\s\S]*?\});/.exec(t); try { return m ? JSON.parse(m[1]) : {}; } catch (_) { return {}; } }

// Product ids the site uses, read from products.json when the Store Manager wrote it.
function products(store) {
  const t = read(store, 'products.json'); if (!t) return [];
  try { const j = JSON.parse(t), list = Array.isArray(j) ? j : Array.isArray(j.products) ? j.products : []; return list.slice(0, 60).map((p, i) => ({ id: String(p.id || p.slug || 'p' + (i + 1)).replace(/[^\w-]/g, '').slice(0, 40), name: String(p.name || p.title || 'Product').slice(0, 80), price: p.price != null ? String(p.price).slice(0, 12) : '' })); } catch (_) { return []; }
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', json: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', svg: 'image/svg+xml', xml: 'application/xml', webmanifest: 'application/manifest+json', csv: 'text/csv' };
const mime = (n) => MIME[n.split('.').pop().toLowerCase()] || 'text/plain';

// What the Builder sees about the current site, so a second pass improves the site instead of starting over.
function context(store) {
  const ns = names(store); if (!ns.length) return '';
  const cat = read(store, 'products.json'), idx = read(store, 'index.html');
  const media = ns.filter(isBin);
  return [`Files already in the site: ${ns.join(', ')}.`, media.length ? `Generated images you may use with <img src="..."> (relative paths, already in the site): ${media.join(', ')}.` : '', cat ? `products.json (the catalog; use these exact ids):\n${cat.slice(0, 2500)}` : '', idx && !cat ? `index.html so far (first 1200 chars):\n${idx.slice(0, 1200)}` : ''].filter(Boolean).join('\n');
}
const view = (store) => { const ns = names(store); return ns.length ? { files: ns.filter((n) => !isBin(n)), images: ns.filter(isBin), preview: `/sites/${idOf(store)}/`, products: products(store), links: links(store), folder: persistent(store) ? dirOf(idOf(store)) : null } : null; };

module.exports = { writeBinary, isBin, extract, ingest, names, read, setLinks, links, products, context, view, mime, cleanName };
