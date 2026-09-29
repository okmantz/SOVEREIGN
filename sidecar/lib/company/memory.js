'use strict';
const { uid, round } = require('./util');

const KINDS = ['market', 'customer', 'product', 'sales', 'financial', 'experiment', 'competitor', 'strategy'];

/** Business memory: structured, per-venture, queryable months later. Not chat history. */
function makeMemory(ctx) {
  const M = () => ctx.db.get('bizmemory', []);
  const X = () => ctx.db.get('experiments', []);

  function remember(venture_id, kind, summary, data = {}) {
    if (!KINDS.includes(kind)) throw new Error(`memory kind must be one of ${KINDS.join(', ')}`);
    const e = { id: uid('mem'), venture_id, kind, summary: String(summary).slice(0, 1000), data, ts: ctx.now() };
    M().push(e); ctx.db.save('bizmemory'); return e;
  }
  function recall(venture_id, kind, q) {
    const words = q ? q.toLowerCase().split(/\W+/).filter(Boolean) : [];
    return M().filter((e) => (!venture_id || e.venture_id === venture_id) && (!kind || e.kind === kind))
      .map((e) => ({ e, s: words.reduce((n, w) => n + (e.summary.toLowerCase().includes(w) ? 1 : 0), 0) }))
      .filter((x) => !words.length || x.s > 0).sort((a, b) => b.s - a.s || b.e.ts - a.e.ts).map((x) => x.e);
  }

  /** Action → Result → Cost → Outcome. The raw material for learning. */
  function logExperiment(x) {
    const e = { id: uid('exp'), venture_id: x.venture_id, action: x.action, channel: x.channel || '', hypothesis: x.hypothesis || '',
      cost: x.cost || 0, visitors: x.visitors || 0, leads: x.leads || 0, sales: x.sales || 0, revenue: x.revenue || 0,
      outcome: x.outcome || 'inconclusive', ts: ctx.now() };
    X().push(e); ctx.db.save('experiments');
    remember(x.venture_id, 'experiment', `${e.action}${e.channel ? ` via ${e.channel}` : ''}: ${e.visitors} visitors → ${e.sales} sales, cost $${e.cost}, revenue $${e.revenue} (${e.outcome})`, e);
    return e;
  }

  /** Aggregate by channel / action and generate insights strictly from the numbers. */
  function learn(venture_id) {
    const rows = X().filter((e) => !venture_id || e.venture_id === venture_id);
    const agg = (key) => {
      const g = {};
      for (const e of rows) {
        const k = e[key] || 'unspecified'; g[k] = g[k] || { key: k, n: 0, cost: 0, visitors: 0, leads: 0, sales: 0, revenue: 0 };
        for (const f of ['cost', 'visitors', 'leads', 'sales', 'revenue']) g[k][f] += e[f]; g[k].n++;
      }
      return Object.values(g).map((r) => ({ ...r, conversion: r.visitors ? round(r.sales / r.visitors, 4) : null,
        cac: r.sales ? round(r.cost / r.sales, 2) : null, roi: r.cost ? round((r.revenue - r.cost) / r.cost, 2) : null }));
    };
    const byChannel = agg('channel'); const byAction = agg('action');
    const insights = [];
    const conv = byChannel.filter((c) => c.conversion !== null && c.visitors >= 30 && c.key !== 'unspecified').sort((a, b) => b.conversion - a.conversion);
    if (conv.length >= 2 && conv[conv.length - 1].conversion > 0) {
      insights.push(`${conv[0].key} converted ${round(conv[0].conversion / conv[conv.length - 1].conversion, 1)}× better than ${conv[conv.length - 1].key} (${conv[0].conversion * 100}% vs ${conv[conv.length - 1].conversion * 100}%).`);
    }
    for (const c of byChannel) if (c.cost >= 20 && c.roi !== null && c.roi < 0) insights.push(`${c.key} is losing money: $${round(c.cost)} spent, $${round(c.revenue)} returned (ROI ${c.roi}).`);
    for (const c of byChannel) if (c.cost >= 20 && c.roi !== null && c.roi > 1) insights.push(`${c.key} is profitable: ROI ${c.roi}.`);
    ctx.db.set('insights', { ...ctx.db.get('insights', {}), [venture_id || '_all']: { ts: ctx.now(), insights } });
    return { by_channel: byChannel, by_action: byAction, insights };
  }
  const lessons = (venture_id) => (ctx.db.get('insights', {})[venture_id || '_all'] || { insights: [] }).insights;

  /** Compact context block for CEO prompts: "We tried this offer in May…". */
  function digest(venture_id, n = 6) {
    const parts = [];
    for (const k of KINDS) {
      const items = recall(venture_id, k).slice(0, 2).map((e) => `- ${e.summary}`);
      if (items.length) parts.push(`${k.toUpperCase()}:\n${items.join('\n')}`);
    }
    const l = lessons(venture_id).slice(0, n); if (l.length) parts.push(`LESSONS:\n${l.map((x) => `- ${x}`).join('\n')}`);
    return parts.join('\n');
  }
  return { remember, recall, logExperiment, learn, lessons, digest, KINDS, experiments: (v) => X().filter((e) => !v || e.venture_id === v) };
}
module.exports = { makeMemory, KINDS };
