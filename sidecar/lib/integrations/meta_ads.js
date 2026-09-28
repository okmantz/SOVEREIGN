'use strict';
const { request, dollarsToCents, dayAgo, isoDay } = require('./http');
const acct = (v) => 'act_' + String(v || '').replace(/^act_/, '').trim();

module.exports = {
  label: 'Facebook Ads', source: 'ads.meta', ledger: true,
  blurb: 'Reads daily ad spend and records completed days as verified costs. Read-only: it cannot create or change campaigns.',
  fields: [
    { key: 'accessToken', label: 'Access token', secret: true, placeholder: 'EAAB…', help: 'A long-lived token with ads_read for your ad account (Meta for Developers → Graph API Explorer or a system user).' },
    { key: 'adAccountId', label: 'Ad account ID', placeholder: 'act_1234567890' },
    { key: 'apiVersion', label: 'Graph API version', optional: true, placeholder: 'v21.0', help: 'Meta retires old versions. Update this if requests start failing.' }
  ],
  async test(c, sec) {
    const v = c.config.apiVersion || 'v21.0';
    const r = await request(`https://graph.facebook.com/${v}/${acct(c.config.adAccountId)}?fields=name,currency&access_token=${encodeURIComponent(sec.accessToken)}`);
    const j = r.json || {};
    return { detail: `Connected to ${j.name || 'your ad account'}${j.currency ? ' (' + j.currency + ')' : ''}.`, patchConfig: { currency: j.currency || '' } };
  },
  async sync(c, sec, { now = Date.now() } = {}) {
    const notes = [];
    if (c.config.currency && c.config.currency !== 'USD') return { entries: [], cursor: c.cursor, notes: [`Account currency is ${c.config.currency}; USD only for now.`] };
    const v = c.config.apiVersion || 'v21.0', until = isoDay(dayAgo(1, now));
    const since = c.cursor ? isoDay(new Date(new Date(c.cursor).getTime() - 864e5)) : isoDay(dayAgo(14, now));
    if (since > until) return { entries: [], cursor: c.cursor, notes: ['Already up to date.'] };
    const tr = encodeURIComponent(JSON.stringify({ since, until }));
    const r = await request(`https://graph.facebook.com/${v}/${acct(c.config.adAccountId)}/insights?fields=spend,clicks,impressions&time_increment=1&limit=100&time_range=${tr}&access_token=${encodeURIComponent(sec.accessToken)}`);
    const entries = []; let clicks = 0, imps = 0;
    for (const row of (r.json && r.json.data) || []) {
      const cents = dollarsToCents(row.spend);
      clicks += Number(row.clicks) || 0; imps += Number(row.impressions) || 0;
      if (cents > 0) entries.push({ type: 'cost', amountCents: cents, ref: `metaads_${acct(c.config.adAccountId)}_${row.date_start}`, note: 'Ad spend ' + row.date_start });
    }
    notes.push(`Completed days only (through ${until}). ${clicks} clicks, ${imps} impressions.`);
    return { entries, cursor: until, notes };
  }
};
