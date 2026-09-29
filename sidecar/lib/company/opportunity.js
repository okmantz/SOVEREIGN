'use strict';
const { uid, round, clamp, extractJson, isPrivateHost } = require('./util');

const WEIGHTS = { demand: 0.25, monetization: 0.25, competition: 0.15, cost: 0.10, difficulty: 0.10, speed: 0.15 };
const PAIN = /(how do i|anyone know|is there (a|an) (tool|app|service)|wish (there was|i could)|looking for|alternative to|frustrat|hate (how|that)|too expensive|takes (me )?hours|manually|can't find|struggl)/i;

/** ---- Scanner adapters (real HTTP where an open API exists). Each returns signals: {source,title,url,engagement,text} ---- */
const UA = { 'user-agent': 'sovereign-scanner/0.4 (local research tool)' };
async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}
const scanners = {
  hackernews: async ({ query }) => {
    const j = await getJson(`https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=25&query=${encodeURIComponent(query)}`);
    return j.hits.map((h) => ({ source: 'hackernews', title: h.title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      engagement: (h.points || 0) + 2 * (h.num_comments || 0), text: h.title }));
  },
  reddit: async ({ query }) => {
    const j = await getJson(`https://www.reddit.com/search.json?limit=25&sort=top&t=month&q=${encodeURIComponent(query)}`);
    return j.data.children.map((c) => ({ source: 'reddit', title: c.data.title, url: `https://reddit.com${c.data.permalink}`,
      engagement: (c.data.score || 0) + 2 * (c.data.num_comments || 0), text: `${c.data.title} ${(c.data.selftext || '').slice(0, 500)}` }));
  },
  github: async ({ query }) => {
    const j = await getJson(`https://api.github.com/search/repositories?sort=stars&per_page=20&q=${encodeURIComponent(query)}`, { accept: 'application/vnd.github+json' });
    return j.items.map((r) => ({ source: 'github', title: r.full_name, url: r.html_url, engagement: r.stargazers_count, text: r.description || r.full_name }));
  },
};

function makeOpportunities(ctx) {
  const db = () => ctx.db.get('opportunities', {});
  const custom = new Map(); // name → async ({query}) => signals  (Google Trends, Product Hunt, Etsy… plug in here or via browser)

  const registerScanner = (name, fn) => custom.set(name, fn);
  const scannerNames = () => [...Object.keys(scanners), ...custom.keys()];

  /** Continuous-process entry point: run every scanner on a query and ingest what looks like real pain. */
  async function scan({ queries, sources }) {
    const out = { signals: 0, added: 0, errors: [] };
    for (const q of queries) for (const name of (sources || scannerNames())) {
      const fn = custom.get(name) || scanners[name]; if (!fn) continue;
      try {
        const sigs = await fn({ query: q });
        out.signals += sigs.length; out.added += (await ingest(sigs, { query: q })).length;
      } catch (e) { out.errors.push(`${name}: ${e.message}`); }
    }
    ctx.emit('opportunity.scan', out); return out;
  }

  /** Signals → problem statements → opportunity database (deduped by normalised title). */
  async function ingest(signals, { query = '' } = {}) {
    let problems = [];
    if (ctx.llm) {
      const digest = signals.slice(0, 30).map((s, i) => `${i}. [${s.source}|${s.engagement}] ${s.title}`).join('\n');
      const raw = await ctx.llm(`From these market signals, list up to 5 concrete unmet problems people would pay to solve. ` +
        `Return ONLY JSON: {"problems":[{"title":"","problem":"","audience":"","signal_indexes":[0]}]}\n${digest}`, { json: true });
      const j = extractJson(raw);
      problems = ((j && j.problems) || []).map((p) => ({ ...p, evidence: (p.signal_indexes || []).map((i) => signals[i]).filter(Boolean) }));
    }
    if (!problems.length) { // deterministic fallback: only signals that read like pain
      problems = signals.filter((s) => PAIN.test(s.text || s.title)).map((s) => ({ title: s.title, problem: s.title, audience: '', evidence: [s] }));
    }
    const added = [];
    for (const p of problems) {
      const key = String(p.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
      if (!key || Object.values(db()).some((o) => o.key === key)) continue;
      const eng = (p.evidence || []).reduce((s, e) => s + (e.engagement || 0), 0);
      const o = { id: uid('opp'), key, title: p.title, problem: p.problem, audience: p.audience || '', query,
        evidence: (p.evidence || []).slice(0, 8), engagement: eng, status: 'new', scorecard: null, models: [], created: ctx.now() };
      db()[o.id] = o; added.push(o);
    }
    if (added.length) { ctx.db.save('opportunities'); ctx.emit('opportunity.found', { count: added.length }); }
    return added;
  }
  const add = (o) => ingest([{ source: o.source || 'manual', title: o.title, engagement: o.engagement || 0, text: o.title }], { query: o.query || '' })
    .then((r) => r[0] || null);

  /** Score 0–10 per dimension. Real signals where we have them; everything else is flagged as an estimate. */
  async function research(id, { competitors, price_hint } = {}) {
    const o = db()[id]; if (!o) throw new Error('unknown opportunity');
    const dims = { demand: clamp(Math.log10(1 + o.engagement) * 2.5, 0, 10), competition: 5, monetization: 5, cost: 5, difficulty: 5, speed: 5 };
    const basis = { demand: 'measured from signal engagement', competition: 'default', monetization: 'default', cost: 'default', difficulty: 'default', speed: 'default' };
    if (typeof competitors === 'number') { dims.competition = clamp(10 - competitors * 1.2, 0, 10); basis.competition = `measured: ${competitors} competitors found`; }
    if (ctx.llm) {
      const raw = await ctx.llm(`Score this business opportunity 0-10 (10 = best; competition 10 = little competition; cost 10 = very cheap to test; ` +
        `difficulty 10 = very easy to build). Problem: ${o.problem}. Audience: ${o.audience}. Return ONLY JSON: ` +
        `{"monetization":0,"competition":0,"cost":0,"difficulty":0,"speed":0,"notes":""}`, { json: true });
      const j = extractJson(raw);
      if (j) for (const k of ['monetization', 'competition', 'cost', 'difficulty', 'speed']) {
        if (Number.isFinite(j[k]) && !(k === 'competition' && typeof competitors === 'number')) { dims[k] = clamp(j[k], 0, 10); basis[k] = 'model estimate'; }
      }
      o.notes = (j && j.notes) || '';
    }
    const score = round(Object.entries(WEIGHTS).reduce((s, [k, w]) => s + dims[k] * w, 0) * 10, 1);
    const measured = Object.values(basis).filter((b) => b.startsWith('measured')).length;
    const estimated = Object.values(basis).filter((b) => b === 'model estimate').length;
    const confidence = measured >= 2 ? 'high' : measured + estimated >= 3 ? 'medium' : 'low';
    o.scorecard = { dims, basis, score, confidence, weights: WEIGHTS };
    o.status = 'scored'; ctx.db.save('opportunities');
    ctx.emit('opportunity.scored', { title: o.title, score, confidence });
    return o;
  }

  /** Business model generation: several ways to monetise the same problem, with unit economics. */
  function generateModels(id, { price_scale = 1 } = {}) {
    const o = db()[id]; if (!o) throw new Error('unknown opportunity');
    const t = (type, label, price, unit, conv, cogs, launch_days, extra = 0) => {
      const margin = price - cogs;
      return { type, label, price: round(price * price_scale), unit, assumed_conversion: conv, cogs_per_unit: cogs,
        unit_margin: round(margin * price_scale), launch_days, upfront_cost: extra,
        breakeven_units: margin > 0 ? Math.ceil((extra + 50) / (margin * price_scale)) : null,
        month1_revenue_at_100_leads: round(100 * conv * price * price_scale) };
    };
    o.models = [
      t('saas', 'SaaS subscription', 29, 'per month', 0.03, 4, 21, 40),
      t('service', 'Done-for-you service', 300, 'per month', 0.02, 120, 7, 0),
      t('leadgen', 'Lead-generation service', 50, 'per lead', 0.05, 15, 10, 20),
      t('digital_product', 'Digital product', 49, 'one-time', 0.04, 2, 10, 10),
      t('api', 'Usage-based API', 0.02, 'per request', 0.02, 0.008, 28, 60),
    ].sort((a, b) => (b.month1_revenue_at_100_leads / (b.launch_days + 7)) - (a.month1_revenue_at_100_leads / (a.launch_days + 7)));
    ctx.db.save('opportunities'); return o.models;
  }

  const get = (id) => db()[id] || null;
  const list = (f = {}) => Object.values(db()).filter((o) => !f.status || o.status === f.status)
    .sort((a, b) => ((b.scorecard && b.scorecard.score) || 0) - ((a.scorecard && a.scorecard.score) || 0));
  const setStatus = (id, status) => { db()[id].status = status; ctx.db.save('opportunities'); };
  return { scan, ingest, add, research, generateModels, get, list, setStatus, registerScanner, scannerNames, WEIGHTS, isPrivateHost };
}
module.exports = { makeOpportunities, WEIGHTS };
