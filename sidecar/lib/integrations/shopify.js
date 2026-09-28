'use strict';
const { request, dollarsToCents, dayAgo } = require('./http');
const domain = (v) => String(v || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const PAID = new Set(['paid', 'partially_refunded', 'refunded', 'partially_paid']);

module.exports = {
  label: 'Shopify', source: 'shopify', ledger: true,
  blurb: 'Reads paid orders and refunds and records them as verified revenue. Read-only.',
  fields: [
    { key: 'shopDomain', label: 'Store domain', placeholder: 'your-store.myshopify.com' },
    { key: 'accessToken', label: 'Admin API access token', secret: true, placeholder: 'shpat_…', help: 'Create a custom app in Shopify admin with read_orders access and paste its Admin API token.' },
    { key: 'apiVersion', label: 'API version', optional: true, placeholder: '2025-07', help: 'Shopify retires old versions after about a year. Change this if you see version errors.' }
  ],
  async test(c, sec) {
    const r = await request(`https://${domain(c.config.shopDomain)}/admin/api/${c.config.apiVersion || '2025-07'}/shop.json`, { headers: { 'x-shopify-access-token': sec.accessToken } });
    const s = (r.json && r.json.shop) || {};
    return { detail: `Connected to ${s.name || 'your store'}${s.currency ? ' (' + s.currency + ')' : ''}.` };
  },
  async sync(c, sec, { now = Date.now() } = {}) {
    const since = new Date(c.cursor ? new Date(c.cursor).getTime() - 2 * 864e5 : dayAgo(14, now).getTime()).toISOString();
    const url = `https://${domain(c.config.shopDomain)}/admin/api/${c.config.apiVersion || '2025-07'}/orders.json?status=any&financial_status=any&limit=250&created_at_min=${encodeURIComponent(since)}&fields=id,total_price,currency,created_at,financial_status,refunds`;
    const r = await request(url, { headers: { 'x-shopify-access-token': sec.accessToken } });
    const entries = [], notes = []; let cursor = c.cursor || null, skipped = 0;
    for (const o of (r.json && r.json.orders) || []) {
      if (!cursor || o.created_at > cursor) cursor = o.created_at;
      if (!PAID.has(o.financial_status)) continue;
      if (o.currency !== 'USD') { skipped++; continue; }
      entries.push({ type: 'revenue', amountCents: dollarsToCents(o.total_price), ref: 'shopify_order_' + o.id, note: 'Order' });
      for (const rf of o.refunds || []) {
        const amt = (rf.transactions || []).filter((t) => t.kind === 'refund').reduce((s, t) => s + dollarsToCents(t.amount), 0);
        if (amt > 0) entries.push({ type: 'cost', amountCents: amt, ref: 'shopify_refund_' + rf.id, note: 'Refund' });
      }
    }
    if (skipped) notes.push(`${skipped} non-USD order${skipped > 1 ? 's' : ''} skipped (USD only for now).`);
    if (((r.json && r.json.orders) || []).length >= 250) notes.push('Hit the 250-order page limit; the next sync will continue.');
    return { entries, cursor, notes };
  }
};
