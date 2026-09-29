'use strict';
const { uid, round, DAY } = require('./util');

/** Chart of accounts. `group` drives the contribution-profit waterfall. */
const CATEGORIES = {
  revenue: 'revenue', refund: 'refund',
  cogs: 'variable', payment_fees: 'variable',
  marketing: 'acquisition',
  software: 'operating', infrastructure: 'operating', other_opex: 'operating',
  ai_inference: 'ai',
  tax_reserve: 'reserve', capital_in: 'capital', capital_out: 'capital_out',
};
/** Law 1: only these sources can make an entry "verified". Agent claims are stored but never counted. */
const TRUSTED = new Set(['stripe', 'webhook', 'shopify', 'etsy', 'gumroad', 'woocommerce', 'meta_ads',
  'bank', 'measured', 'harness']);

function makeLedger(ctx) {
  const rows = () => ctx.db.get('ledger', []);
  const invs = () => ctx.db.get('invoices', []);

  function record(e) {
    if (!CATEGORIES[e.category]) throw new Error(`unknown ledger category: ${e.category}`);
    if (!Number.isFinite(e.amount) || e.amount <= 0) throw new Error('amount must be a positive number');
    const source = e.source || 'agent_claim';
    if (e.ref) { // idempotent: webhook retries must not double count
      const dup = rows().find((r) => r.source === source && r.ref === e.ref);
      if (dup) return dup;
    }
    const entry = {
      id: uid('led'), ts: e.ts || ctx.now(), venture_id: e.venture_id || null, category: e.category,
      group: CATEGORIES[e.category], amount: round(e.amount), source, ref: e.ref || null,
      memo: e.memo || '', verified: TRUSTED.has(source),
    };
    rows().push(entry); ctx.db.save('ledger');
    ctx.emit(`ledger.${e.category}`, { venture_id: entry.venture_id, amount: entry.amount, verified: entry.verified }, entry.venture_id);
    return entry;
  }

  function filter({ venture_id, since, until, includeUnverified } = {}) {
    return rows().filter((r) =>
      (!venture_id || r.venture_id === venture_id) && (!since || r.ts >= since) && (!until || r.ts <= until) &&
      (includeUnverified || r.verified));
  }

  /** Revenue − variable − operating − acquisition − AI = contribution profit. */
  function summary(opts = {}) {
    const g = { revenue: 0, refund: 0, variable: 0, operating: 0, acquisition: 0, ai: 0, reserve: 0, capital: 0, capital_out: 0 };
    const detail = {};
    for (const r of filter(opts)) { g[r.group] += r.amount; detail[r.category] = round((detail[r.category] || 0) + r.amount); }
    const net_revenue = g.revenue - g.refund;
    const total_costs = g.variable + g.operating + g.acquisition + g.ai;
    const contribution_profit = net_revenue - total_costs;
    const cash = g.capital - g.capital_out + net_revenue - total_costs;
    const inv = invs().filter((i) => (!opts.venture_id || i.venture_id === opts.venture_id) && !i.settled);
    const ar = inv.filter((i) => i.kind === 'receivable').reduce((s, i) => s + i.amount, 0);
    const ap = inv.filter((i) => i.kind === 'payable').reduce((s, i) => s + i.amount, 0);
    const unverified = filter({ ...opts, includeUnverified: true }).length - filter(opts).length;
    return {
      revenue: round(g.revenue), refunds: round(g.refund), net_revenue: round(net_revenue),
      variable_costs: round(g.variable), operating_costs: round(g.operating),
      acquisition_costs: round(g.acquisition), ai_costs: round(g.ai), total_costs: round(total_costs),
      contribution_profit: round(contribution_profit),
      gross_margin: net_revenue > 0 ? round((net_revenue - g.variable) / net_revenue, 3) : null,
      contribution_margin: net_revenue > 0 ? round(contribution_profit / net_revenue, 3) : null,
      reserves: round(g.reserve), capital_in: round(g.capital - g.capital_out), cash: round(cash),
      available_cash: round(cash - g.reserve - ap), receivable: round(ar), payable: round(ap),
      unverified_entries: unverified, by_category: detail,
    };
  }

  function invoice({ venture_id, kind, amount, counterparty, due, category }) {
    if (!['receivable', 'payable'].includes(kind)) throw new Error('kind must be receivable|payable');
    const inv = { id: uid('inv'), venture_id, kind, amount: round(amount), counterparty: counterparty || '',
      due: due || null, category: category || null, settled: false, created: ctx.now() };
    invs().push(inv); ctx.db.save('invoices'); return inv;
  }
  /** Cash-basis: receivables become revenue only when settled with a trusted source. */
  function settle(id, { source, ref } = {}) {
    const inv = invs().find((i) => i.id === id);
    if (!inv || inv.settled) throw new Error('invoice not found or already settled');
    inv.settled = true; ctx.db.save('invoices');
    const category = inv.kind === 'receivable' ? 'revenue' : (inv.category || 'other_opex');
    return record({ venture_id: inv.venture_id, category, amount: inv.amount, source, ref: ref || inv.id, memo: `invoice ${inv.id}` });
  }

  /** Net burn per day over the trailing window (costs − revenue), floor 0. */
  function dailyBurn(venture_id, days = 30) {
    const s = summary({ venture_id, since: ctx.now() - days * DAY });
    return Math.max(0, (s.total_costs - s.net_revenue) / days);
  }
  function monthly(venture_id) { return summary({ venture_id, since: ctx.now() - 30 * DAY }); }

  return { record, summary, filter, invoice, settle, dailyBurn, monthly, CATEGORIES, TRUSTED };
}
module.exports = { makeLedger, CATEGORIES, TRUSTED };
