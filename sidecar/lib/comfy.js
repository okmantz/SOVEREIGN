'use strict';
// ComfyUI, wired in so it feels built in. https://github.com/comfy-org/comfyui
//
// ComfyUI runs on the owner's machine (default http://127.0.0.1:8188) and exposes a small HTTP API:
//   GET  /system_stats                          is it up?
//   GET  /object_info/CheckpointLoaderSimple    which models are installed?
//   POST /prompt {prompt: <api-format graph>}   queue a render, returns prompt_id
//   GET  /history/<prompt_id>                   outputs, once finished
//   GET  /view?filename=&subfolder=&type=       fetch a finished file
// Rendering is local and free, so it never waits for an approval card and adds nothing to the ledger.
//
// How agents use it: when a ComfyUI connector exists, every agent is told it may end a reply with an ```images block
// (a JSON list of prompts). The sidecar renders them, saves them into the world's site folder under img/, and attaches them
// to the Outbox item. The Builder then uses those files in the website. No wiring, no workflow knowledge needed.
//
// Advanced: paste a workflow exported with "Save (API Format)" and use {{prompt}}, {{negative}}, {{seed}}, {{width}},
// {{height}}, {{checkpoint}} where the values go. Any workflow that ends in an image, GIF or video output works.
const { assert, HttpError } = require('./util');
const sites = require('./sites');

const DEFAULT_URL = 'http://127.0.0.1:8188';
const NEGATIVE = 'blurry, low quality, watermark, text, logo, distorted, deformed, extra fingers, cropped';
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const httpUrl = (v) => /^https?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/.test(String(v || '').trim());
const normalize = (u) => String(u || DEFAULT_URL).trim().replace(/\/+$/, '') || DEFAULT_URL;
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

async function call(base, path, { method = 'GET', body, token, timeoutMs = 15000, raw = false } = {}) {
  assert(httpUrl(base), 'The ComfyUI address must start with http:// or https://');
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs), headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json'; if (token) headers.authorization = 'Bearer ' + token;
  let res;
  try { res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal }); }
  catch (e) { throw new HttpError(502, e.name === 'AbortError' ? 'ComfyUI took too long to answer.' : `Could not reach ComfyUI at ${base}. Is it running?`); }
  finally { clearTimeout(timer); }
  if (raw) { if (!res.ok) throw new HttpError(502, `ComfyUI said ${res.status} while fetching a file.`); return Buffer.from(await res.arrayBuffer()); }
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

// ---- status and discovery
async function ping(base, token) {
  const r = await call(base, '/system_stats', { token, timeoutMs: 4000 });
  assert(r.ok && r.json, `Something answered at ${base}, but it does not look like ComfyUI.`);
  const dev = (r.json.devices || [])[0] || {};
  return { version: (r.json.system || {}).comfyui_version || '', device: dev.name || '', vramGB: dev.vram_total ? Math.round(dev.vram_total / 1e9) : 0 };
}
async function checkpoints(base, token) {
  const r = await call(base, '/object_info/CheckpointLoaderSimple', { token, timeoutMs: 8000 });
  const list = r.json && r.json.CheckpointLoaderSimple && r.json.CheckpointLoaderSimple.input && r.json.CheckpointLoaderSimple.input.required && r.json.CheckpointLoaderSimple.input.required.ckpt_name;
  return Array.isArray(list) && Array.isArray(list[0]) ? list[0].map(String) : [];
}
// Look for a running ComfyUI on the usual ports (portable/manual installs use 8188, the desktop app 8000).
async function detect(extra = []) {
  for (const base of [...new Set([...extra, 'http://127.0.0.1:8188', 'http://localhost:8188', 'http://127.0.0.1:8000'])].filter(httpUrl)) {
    try { const info = await ping(base); return { found: true, baseUrl: base, ...info }; } catch (_) { /* try the next one */ }
  }
  return { found: false };
}

// ---- the graph
function defaultGraph({ prompt, negative, seed, width, height, checkpoint, steps = 20, cfg = 7, sampler = 'euler', scheduler = 'normal' }) {
  return {
    3: { class_type: 'KSampler', inputs: { seed, steps, cfg, sampler_name: sampler, scheduler, denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    5: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'sovereign', images: ['8', 0] } }
  };
}
// A pasted API-format workflow, with {{placeholders}} filled in. A value that is exactly a placeholder keeps its type (a number stays a number).
function fromTemplate(text, vars) {
  let g; try { g = JSON.parse(text); } catch (_) { throw new HttpError(400, 'The workflow is not valid JSON. Export it from ComfyUI with "Save (API Format)".'); }
  assert(g && typeof g === 'object' && !Array.isArray(g) && Object.values(g).length && Object.values(g).every((n) => n && typeof n.class_type === 'string'), 'That is not an API-format workflow. In ComfyUI turn on Dev mode and use "Save (API Format)".');
  const fill = (v) => {
    if (typeof v === 'string') { const whole = /^\{\{(\w+)\}\}$/.exec(v); if (whole && whole[1] in vars) return vars[whole[1]]; return v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m)); }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(g);
}
const validateWorkflow = (text) => { fromTemplate(text, { prompt: 'x', negative: 'x', seed: 1, width: 512, height: 512, checkpoint: 'x' }); return true; };

// ---- rendering (one at a time: a local GPU does one job at once, so queueing here avoids timeouts while ComfyUI is busy)
const chains = new Map();
const queued = (key, fn) => { const prev = chains.get(key) || Promise.resolve(), next = prev.catch(() => {}).then(fn); chains.set(key, next.catch(() => {})); return next; };

function explain(json) {
  const e = json && (json.error || json), ne = json && json.node_errors && Object.values(json.node_errors)[0];
  const first = ne && ne.errors && ne.errors[0];
  const msg = (first && (first.details || first.message)) || (e && (e.message || e.details)) || 'ComfyUI rejected the workflow.';
  return /ckpt_name|not in list/i.test(msg) ? 'The model (checkpoint) is not installed in ComfyUI. Pick one in the ComfyUI connector settings. ' + clip(msg, 120) : clip(msg, 220);
}
const clampDim = (v, dflt) => { const n = Math.round(Number(v) / 8) * 8; return Number.isFinite(n) && n >= 256 && n <= 2048 ? n : dflt; };

async function renderOne(store, c, token, wf, { prompt, negative, width, height, seed, name }) {
  const base = normalize(c.config.baseUrl), cfg = c.config;
  const vars = { prompt, negative: negative || cfg.negative || NEGATIVE, seed, width, height, checkpoint: cfg.checkpoint || '' };
  if (!wf && !vars.checkpoint) { vars.checkpoint = (await checkpoints(base, token))[0] || ''; assert(vars.checkpoint, 'ComfyUI has no models installed yet. Add a checkpoint in ComfyUI first.'); }
  const graph = wf ? fromTemplate(wf, vars) : defaultGraph({ ...vars, steps: Number(cfg.steps) || 20, cfg: Number(cfg.cfg) || 7, sampler: cfg.sampler || 'euler', scheduler: cfg.scheduler || 'normal' });
  const q = await call(base, '/prompt', { method: 'POST', body: { prompt: graph, client_id: 'sovereign' }, token });
  if (!q.ok) throw new HttpError(502, explain(q.json)); const pid = q.json && q.json.prompt_id; assert(pid, 'ComfyUI did not accept the job.', 502);
  const deadline = Date.now() + Math.max(30, Number(cfg.timeoutSec) || 240) * 1000; let outputs = null;
  while (Date.now() < deadline) {
    await sleep(700); const h = await call(base, '/history/' + encodeURIComponent(pid), { token, timeoutMs: 10000 }), item = h.json && h.json[pid];
    if (!item) continue;
    if (item.status && item.status.status_str === 'error') { const m = (item.status.messages || []).find((x) => x[0] === 'execution_error'); throw new HttpError(502, 'ComfyUI failed while rendering: ' + clip(m && m[1] && (m[1].exception_message || m[1].node_type), 200)); }
    if (item.outputs && Object.keys(item.outputs).length) { outputs = item.outputs; break; }
  }
  assert(outputs, 'ComfyUI is still rendering after the time limit. Raise the timeout in its connector settings, or use a smaller size.', 504);
  const files = []; for (const node of Object.values(outputs)) for (const key of ['images', 'gifs', 'videos']) for (const f of node[key] || []) if (f && f.filename && f.type !== 'temp') files.push(f);
  assert(files.length, 'The workflow finished but produced no saved image. End it with a Save Image node.', 502);
  const saved = [];
  for (const [i, f] of files.slice(0, 4).entries()) {
    const ext = (String(f.filename).split('.').pop() || 'png').toLowerCase(), okExt = sites.isBin('x.' + ext) ? ext : 'png';
    const buf = await call(base, `/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || '')}&type=${encodeURIComponent(f.type || 'output')}`, { token, raw: true, timeoutMs: 30000 });
    saved.push({ name: sites.writeBinary(store, `img/${name}${files.length > 1 ? '-' + (i + 1) : ''}-${seed % 100000}.${okExt}`, buf), prompt });
  }
  return saved;
}

const slug = (s) => clip(s, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'image';
const findConnector = (state) => Object.values(state.connectors || {}).find((c) => c.kind === 'comfyui' && c.status !== 'unconfigured') || null;
const available = (state) => !!findConnector(state);

// Render a list of {name, prompt, negative?, width?, height?}. Failures are reported per image and never stop the caller.
async function generate(store, items, { max = 4 } = {}) {
  const c = findConnector(store.state); assert(c, 'ComfyUI is not connected.');
  const secrets = require('./secrets'), token = secrets.get(`conn:${c.id}:token`) || '', wf = c.workflow || '';
  const dW = clampDim(c.config.width, 1024), dH = clampDim(c.config.height, 1024), out = [], errors = [];
  for (const it of (items || []).slice(0, Math.max(1, max))) {
    const prompt = clip(it && it.prompt, 900); if (prompt.length < 6) continue;
    const name = slug(it.name || prompt), seed = Math.floor(Math.random() * 4294967295);
    try {
      const done = await queued(normalize(c.config.baseUrl), () => renderOne(store, c, token, wf, { prompt, negative: clip(it.negative, 300), width: clampDim(it.width, dW), height: clampDim(it.height, dH), seed, name }));
      out.push(...done);
    } catch (e) { errors.push(`${name}: ${e.message}`); if (/reach ComfyUI|not installed|no models|not valid|not an API/i.test(e.message)) break; } // no point trying the rest
  }
  if (out.length) { c.status = 'ready'; c.lastError = null; c.usage = { day: new Date().toISOString().slice(0, 10), n: ((c.usage && c.usage.n) || 0) + out.length }; }
  else if (errors.length) { c.lastError = errors[0].slice(0, 200); }
  store.change('state'); return { images: out, errors };
}

// Pull the ```images block out of an agent's reply. Returns { items, rest }.
function parseBlock(text) {
  const m = /```images?[^\n]*\n([\s\S]*?)```/i.exec(String(text || '')); if (!m) return { items: [], rest: String(text || '') };
  let j; try { j = JSON.parse(m[1]); } catch (_) { return { items: [], rest: String(text || '') }; }
  const list = Array.isArray(j) ? j : Array.isArray(j && j.images) ? j.images : [];
  return { items: list.filter((x) => x && typeof x === 'object' && typeof x.prompt === 'string'), rest: String(text).replace(m[0], '').replace(/\n{3,}/g, '\n\n').trim() };
}
// Called after an agent finishes: if the reply asks for images and ComfyUI is connected, render them.
async function fromReply(store, text, { max = 4 } = {}) {
  const { items, rest } = parseBlock(text); if (!items.length || !available(store.state)) return { text, images: [], errors: [] };
  const r = await generate(store, items, { max });
  const lines = [...r.images.map((i) => `- ${i.name}`), ...r.errors.map((e) => `- could not render ${e}`)];
  return { text: `${rest}\n\nGenerated with ComfyUI (saved in the site folder):\n${lines.join('\n')}`.trim(), images: r.images, errors: r.errors };
}

function saveWorkflow(store, text) {
  const c = findConnector(store.state); assert(c, 'Add the ComfyUI connector first.');
  if (!String(text || '').trim()) { delete c.workflow; store.change('state'); return { custom: false }; }
  assert(String(text).length <= 200000, 'That workflow is over 200 KB.'); validateWorkflow(text); c.workflow = String(text); store.change('state'); return { custom: true };
}

module.exports = { DEFAULT_URL, ping, checkpoints, detect, defaultGraph, fromTemplate, validateWorkflow, generate, parseBlock, fromReply, available, findConnector, saveWorkflow, normalize, httpUrl };
