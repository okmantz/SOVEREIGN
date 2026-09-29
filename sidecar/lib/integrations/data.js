'use strict';
// Airtable (sink), WooCommerce and Gumroad (read-only ledger sources).
const { request, dollarsToCents, dayAgo, isoDay } = require('./http');

const airtable = {
  label: 'Airtable', source: 'airtable', defaultLimit: 200,
  blurb: 'Adds a row to an Airtable table. Good for lead lists and content trackers.',
  fields: [{ key: 'token', label: 'Personal access token', secret: true, placeholder: 'pat…', help: 'Needs data.records:read and data.records:write on the base.' }, { key: 'baseId', label: 'Base ID', placeholder: 'appXXXXXXXX' }, { key: 'table', label: 'Table name or ID', placeholder: 'Leads' }],
  contract: '{"fields":{"Name":"Acme","Status":"New"}}',
  validate(a) { if (!a.fields || typeof a.fields !== 'object' || Array.isArray(a.fields) || !Object.keys(a.fields).length) throw new Error('Airtable needs a "fields" object.'); },
  preview(a) { return 'Add an Airtable row:\n' + JSON.stringify(a.fields, null, 2).slice(0, 600); },
  url(c) { return `https://api.airtable.com/v0/${encodeURIComponent(c.config.baseId)}/${encodeURIComponent(c.config.table)}`; },
  async test(c, sec) { await request(this.url(c) + '?maxRecords=1', { headers: { authorization: 'Bearer ' + sec.token } }); return { detail: 'Connected to the table.' }; },
  async perform(c, sec, a) { await request(this.url(c), { method: 'POST', headers: { authorization: 'Bearer ' + sec.token }, body: { records: [{ fields: a.fields }], typecast: true } }); return { detail: 'Added an Airtable row' }; }
};

const woocommerce = {
  label: 'WooCommerce', source: 'woocommerce', ledger: true,
  blurb: 'Reads completed and processing orders and refunds as verified revenue. Read-only.',
  fields: [{ key: 'siteUrl', label: 'Store URL', placeholder: 'https://yourstore.com', help: 'Must be https.' }, { key: 'consumerKey', label: 'Consumer key', secret: true, placeholder: 'ck_…' }, { key: 'consumerSecret', label: 'Consumer secret', secret: true, placeholder: 'cs_…', help: 'WooCommerce → Settings → Advanced → REST API, with Read permission.' }],
  base(c) { const u = String(c.config.siteUrl || '').trim().replace(/\/+$/, ''); if (!/^https:\/\//.test(u) && !/^http:\/\/localhost/.test(u)) throw new Error('Store URL must start with https://'); return u + '/wp-json/wc/v3'; },
  auth(sec) { return { authorization: 'Basic ' + Buffer.from(`${sec.consumerKey}:${sec.consumerSecret}`).toString('base64') }; },
  async test(c, sec) { const r = await request(this.base(c) + '/system_status?_fields=environment', { headers: this.auth(sec) }); return { detail: 'Connected to ' + ((r.json && r.json.environment && r.json.environment.site_url) || 'your store') + '.' }; },
  async sync(c, sec, { now = Date.now() } = {}) {
    const after = new Date(c.cursor ? new Date(c.cursor).getTime() - 2 * 864e5 : dayAgo(14, now).getTime()).toISOString();
    const r = await request(`${this.base(c)}/orders?per_page=100&after=${encodeURIComponent(after)}&status=completed,processing&_fields=id,total,currency,date_created_gmt,refunds`, { headers: this.auth(sec) });
    const entries = [], notes = []; let cursor = c.cursor || null, skipped = 0;
    for (const o of Array.isArray(r.json) ? r.json : []) {
      if (!cursor || o.date_created_gmt > cursor) cursor = o.date_created_gmt;
      if (o.currency !== 'USD') { skipped++; continue; }
      entries.push({ type: 'revenue', amountCents: dollarsToCents(o.total), ref: 'woo_order_' + o.id, note: 'Order' });
      const refunded = (o.refunds || []).reduce((s, x) => s + Math.abs(dollarsToCents(x.total)), 0);
      if (refunded > 0) entries.push({ type: 'cost', amountCents: refunded, ref: `woo_refund_${o.id}_${refunded}`, note: 'Refund' });
    }
    if (skipped) notes.push(`${skipped} non-USD order${skipped > 1 ? 's' : ''} skipped (USD only for now).`);
    return { entries, cursor, notes };
  }
};

const gumroad = {
  label: 'Gumroad', source: 'gumroad', ledger: true,
  blurb: 'Reads sales and Gumroad fees as verified revenue and costs. Read-only. First page of results per sync.',
  fields: [{ key: 'accessToken', label: 'Access token', secret: true, help: 'Gumroad → Settings → Advanced → Applications → generate an access token.' }],
  async test(c, sec) { const r = await request('https://api.gumroad.com/v2/user?access_token=' + encodeURIComponent(sec.accessToken)); return { detail: 'Connected as ' + ((r.json && r.json.user && (r.json.user.name || r.json.user.email)) || 'your account') + '.' }; },
  async sync(c, sec, { now = Date.now() } = {}) {
    const after = c.cursor ? isoDay(new Date(new Date(c.cursor).getTime() - 2 * 864e5)) : isoDay(dayAgo(14, now));
    const r = await request(`https://api.gumroad.com/v2/sales?after=${after}&access_token=${encodeURIComponent(sec.accessToken)}`);
    const entries = [], notes = []; let cursor = c.cursor || null, skipped = 0;
    for (const s of (r.json && r.json.sales) || []) {
      if (!cursor || s.created_at > cursor) cursor = s.created_at;
      if (s.refunded || s.chargedback) continue;
      if (String(s.currency || 'usd').toLowerCase() !== 'usd') { skipped++; continue; }
      entries.push({ type: 'revenue', amountCents: s.price, ref: 'gumroad_' + s.id, note: 'Sale' });
      if (s.gumroad_fee > 0) entries.push({ type: 'cost', amountCents: s.gumroad_fee, ref: 'gumroadfee_' + s.id, note: 'Gumroad fee' });
    }
    if (skipped) notes.push(`${skipped} non-USD sale${skipped > 1 ? 's' : ''} skipped (USD only for now).`);
    return { entries, cursor, notes };
  }
};
module.exports = { airtable, woocommerce, gumroad };
