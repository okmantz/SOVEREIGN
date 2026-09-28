'use strict';
const { request } = require('./http');
const H = (t) => ({ authorization: 'Bearer ' + t, 'notion-version': '2022-06-28' });

module.exports = {
  label: 'Notion', source: 'notion',
  blurb: 'Creates pages under a parent page you choose. Each page waits for your approval by default.',
  fields: [
    { key: 'token', label: 'Integration token', secret: true, placeholder: 'ntn_… or secret_…', help: 'Create an internal integration in Notion and share your parent page with it.' },
    { key: 'parentPageId', label: 'Parent page ID', placeholder: '32-character page ID from the page URL' }
  ],
  contract: '{"title":"Page title","body":"Page text. Blank lines start new paragraphs."}',
  validate(a) { if (!a.title || !a.body) throw new Error('Notion needs "title" and "body".'); },
  preview(a) { return `New Notion page: ${a.title}\n\n${String(a.body).slice(0, 600)}`; },
  async test(c, sec) {
    const r = await request('https://api.notion.com/v1/users/me', { headers: H(sec.token) });
    return { detail: `Connected as ${(r.json && r.json.name) || 'your integration'}.` };
  },
  async perform(c, sec, a) {
    const blocks = String(a.body).split(/\n{2,}/).map((t) => t.trim()).filter(Boolean).slice(0, 90)
      .map((t) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: t.slice(0, 1900) } }] } }));
    const r = await request('https://api.notion.com/v1/pages', { method: 'POST', headers: H(sec.token), body: {
      parent: { page_id: c.config.parentPageId }, properties: { title: { title: [{ type: 'text', text: { content: String(a.title).slice(0, 200) } }] } }, children: blocks } });
    return { detail: 'Created Notion page: ' + a.title, url: r.json && r.json.url };
  }
};
