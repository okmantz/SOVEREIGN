'use strict';
const { request } = require('./http');
const oauth = require('./oauth');
const money = (m) => (m && m.divisor ? Math.round((m.amount / m.divisor) * 100) : 0);

module.exports = {
  label: 'Etsy', source: 'etsy', ledger: true,
  blurb: 'Reads paid receipts and records them as verified revenue. Read-only, signs in with Etsy OAuth.',
  fields: [
    { key: 'apiKey', label: 'Etsy API keystring', secret: true, placeholder: 'keystring or keystring:sharedsecret', help: 'From your app at etsy.com/developers. Register the redirect URI shown below in the app.' },
    { key: 'shopId', label: 'Shop ID', placeholder: '12345678' }
  ],
  oauth: { provider: 'etsy', scope: 'transactions_r shops_r', clientId: (c, sec) => String(sec.apiKey || '').split(':')[0], clientSecret: null },
  async headers(c, sec) {
    return { 'x-api-key': sec.apiKey, authorization: 'Bearer ' + (await oauth.accessToken(c, this, sec)) };
  },
  async test(c, sec) {
    const r = await request(`https://openapi.etsy.com/v3/application/shops/${c.config.shopId}`, { headers: await this.headers(c, sec) });
    return { detail: `Connected to ${(r.json && r.json.shop_name) || 'your shop'}.` };
  },
  async sync(c, sec, { now = Date.now() } = {}) {
    const since = (c.cursor || Math.floor(now / 1000) - 14 * 86400) - 2 * 86400;
    const r = await request(`https://openapi.etsy.com/v3/application/shops/${c.config.shopId}/receipts?limit=100&min_created=${since}`, { headers: await this.headers(c, sec) });
    const entries = [], notes = []; let cursor = c.cursor || 0, skipped = 0;
    for (const rc of (r.json && r.json.results) || []) {
      cursor = Math.max(cursor, rc.created_timestamp || rc.create_timestamp || 0);
      if (rc.is_paid === false) continue;
      const cur = rc.grandtotal && rc.grandtotal.currency_code;
      if (cur && cur !== 'USD') { skipped++; continue; }
      const cents = money(rc.grandtotal) - money(rc.total_tax_cost);
      if (cents > 0) entries.push({ type: 'revenue', amountCents: cents, ref: 'etsy_receipt_' + rc.receipt_id, note: 'Receipt (excl. tax)' });
    }
    notes.push('Etsy listing and transaction fees are not recorded yet, so profit may read higher than reality.');
    if (skipped) notes.push(`${skipped} non-USD receipt${skipped > 1 ? 's' : ''} skipped (USD only for now).`);
    return { entries, cursor, notes };
  }
};
