'use strict';
const { request } = require('./http');
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

module.exports = {
  label: 'Email (Resend)', source: 'email', defaultLimit: 25,
  blurb: 'Sends email through Resend. Every send waits for your approval by default, and a daily send limit is always enforced.',
  fields: [
    { key: 'apiKey', label: 'Resend API key', secret: true, placeholder: 're_…', help: 'A sending-only key is enough and safer.' },
    { key: 'from', label: 'From address', placeholder: 'Owen <owen@yourdomain.com>', help: 'Must be on a domain you verified in Resend.' },
    { key: 'replyTo', label: 'Reply-to', optional: true, placeholder: 'you@yourdomain.com' },
    { key: 'footer', label: 'Footer (opt-out and postal address)', optional: true, placeholder: 'Reply STOP to opt out. Your Company, 123 Main St, City, ST 00000', help: 'Appended to every email. Commercial email law (CAN-SPAM, GDPR) expects an opt-out and a real address.' },
    { key: 'dailyLimit', label: 'Emails per day limit', optional: true, placeholder: '25', help: 'New sending domains should start low and warm up.' }
  ],
  contract: '{"to":"person@example.com","subject":"Short, honest subject","body":"Plain-text body"}',
  validate(a) {
    if (!EMAIL.test(String(a.to || '').trim())) throw new Error('Email needs a valid "to" address.');
    if (!a.subject || String(a.subject).length > 200) throw new Error('Email needs a "subject" under 200 characters.');
    if (!a.body || String(a.body).length > 10000) throw new Error('Email needs a "body" under 10,000 characters.');
  },
  preview(a, c) {
    return `To: ${a.to}\nSubject: ${a.subject}\n\n${String(a.body).slice(0, 700)}` + (c && c.config.footer ? '' : '\n\n⚠ No opt-out/address footer is set for this connector.');
  },
  async test(c, sec) {
    const r = await request('https://api.resend.com/domains', { headers: { authorization: 'Bearer ' + sec.apiKey }, allow: [401, 403] });
    if (r.ok) return { detail: `Connected. ${((r.json && r.json.data) || []).length} domain(s) on the account.` };
    if (/restricted|only send/i.test(r.text)) return { detail: 'Key accepted (sending-only keys cannot list domains, which is fine).' };
    throw new Error('Resend rejected that API key.');
  },
  async perform(c, sec, a) {
    const footer = c.config.footer ? `\n\n--\n${c.config.footer}` : '';
    const r = await request('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + sec.apiKey }, body: {
      from: c.config.from, to: [String(a.to).trim()], subject: String(a.subject), text: String(a.body) + footer, ...(c.config.replyTo ? { reply_to: c.config.replyTo } : {}) } });
    return { detail: `Sent to ${a.to}`, id: r.json && r.json.id };
  }
};
