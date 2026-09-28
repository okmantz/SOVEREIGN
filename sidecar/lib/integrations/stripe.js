'use strict';
const { request } = require('./http');

module.exports = {
  label: 'Stripe', source: 'stripe', ledger: true,
  blurb: 'Reads charges, fees and refunds and records them as verified revenue. Read-only.',
  fields: [{ key: 'apiKey', label: 'Restricted API key', secret: true, placeholder: 'rk_live_…', help: 'Create a restricted key in Stripe with read access to Charges. Do not use a full secret key.' }],
  async test(c, sec) {
    const r = await request('https://api.stripe.com/v1/balance', { headers: { authorization: 'Bearer ' + sec.apiKey } });
    return { detail: r.json && r.json.livemode ? 'Connected to your live Stripe account.' : 'Connected (test mode).' };
  },
  async sync(c, sec, { now = Date.now() } = {}) {
    const nowSec = Math.floor(now / 1000);
    const since = (c.cursor || nowSec - 14 * 86400) - 2 * 86400; // overlap is safe: entries are idempotent by ref
    const base = `https://api.stripe.com/v1/charges?limit=100&created[gte]=${since}&expand[]=data.balance_transaction`;
    const entries = [], notes = []; let url = base, cursor = c.cursor || 0, skipped = 0;
    for (let page = 0; page < 5; page++) {
      const r = await request(url, { headers: { authorization: 'Bearer ' + sec.apiKey } });
      const data = (r.json && r.json.data) || [];
      for (const ch of data) {
        cursor = Math.max(cursor, ch.created || 0);
        if (!ch.paid || ch.status !== 'succeeded') continue;
        if (ch.currency !== 'usd') { skipped++; continue; }
        entries.push({ type: 'revenue', amountCents: ch.amount, ref: 'stripe_' + ch.id, note: 'Charge' });
        const fee = ch.balance_transaction && ch.balance_transaction.fee;
        if (fee > 0) entries.push({ type: 'cost', amountCents: fee, ref: 'stripefee_' + ch.id, note: 'Stripe fee' });
        if (ch.amount_refunded > 0) entries.push({ type: 'cost', amountCents: ch.amount_refunded, ref: `stripere_${ch.id}_${ch.amount_refunded}`, note: 'Refund' });
      }
      if (!(r.json && r.json.has_more) || !data.length) break;
      url = base + '&starting_after=' + data[data.length - 1].id;
    }
    if (skipped) notes.push(`${skipped} non-USD charge${skipped > 1 ? 's' : ''} skipped (USD only for now).`);
    return { entries, cursor, notes };
  }
};
