'use strict';
// Notification and webhook sinks. Each takes a small JSON action and waits for your approval by default.
const { request } = require('./http');
const httpUrl = (v) => /^https?:\/\/[^\s]+$/.test(String(v || '').trim());

const slack = {
  label: 'Slack', source: 'slack', defaultLimit: 100,
  blurb: 'Posts a message to a Slack channel through an incoming webhook. Test connection posts one short message.',
  fields: [{ key: 'webhookUrl', label: 'Incoming webhook URL', secret: true, placeholder: 'https://hooks.slack.com/services/…', help: 'Create an incoming webhook in your Slack workspace settings.' }],
  contract: '{"text":"Message to post"}',
  validate(a) { if (!a.text || String(a.text).length > 3000) throw new Error('Slack needs "text" under 3000 characters.'); },
  preview(a) { return 'Post to Slack:\n' + String(a.text).slice(0, 600); },
  async test(c, sec) { if (!httpUrl(sec.webhookUrl)) throw new Error('That does not look like a webhook URL.'); await request(sec.webhookUrl, { method: 'POST', body: { text: 'Sovereign is connected.' } }); return { detail: 'Posted a test message to Slack.' }; },
  async perform(c, sec, a) { await request(sec.webhookUrl, { method: 'POST', body: { text: String(a.text) } }); return { detail: 'Posted to Slack' }; }
};
const discord = {
  label: 'Discord', source: 'discord', defaultLimit: 100,
  blurb: 'Posts a message to a Discord channel through a webhook. Test connection posts one short message.',
  fields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true, placeholder: 'https://discord.com/api/webhooks/…', help: 'Channel settings → Integrations → Webhooks.' }],
  contract: '{"text":"Message to post"}',
  validate(a) { if (!a.text || String(a.text).length > 1900) throw new Error('Discord needs "text" under 1900 characters.'); },
  preview(a) { return 'Post to Discord:\n' + String(a.text).slice(0, 600); },
  async test(c, sec) { if (!httpUrl(sec.webhookUrl)) throw new Error('That does not look like a webhook URL.'); await request(sec.webhookUrl, { method: 'POST', body: { content: 'Sovereign is connected.' } }); return { detail: 'Posted a test message to Discord.' }; },
  async perform(c, sec, a) { await request(sec.webhookUrl, { method: 'POST', body: { content: String(a.text) } }); return { detail: 'Posted to Discord' }; }
};
const telegram = {
  label: 'Telegram', source: 'telegram', defaultLimit: 100,
  blurb: 'Sends a message from your Telegram bot to a chat. Good for getting pinged on your phone.',
  fields: [{ key: 'botToken', label: 'Bot token', secret: true, placeholder: '123456:ABC…', help: 'Create a bot with @BotFather.' }, { key: 'chatId', label: 'Chat ID', placeholder: 'Your chat or channel ID', help: 'Message your bot once, then look up the chat ID.' }],
  contract: '{"text":"Message to send"}',
  validate(a) { if (!a.text || String(a.text).length > 3800) throw new Error('Telegram needs "text" under 3800 characters.'); },
  preview(a) { return 'Send on Telegram:\n' + String(a.text).slice(0, 600); },
  async test(c, sec) { const r = await request(`https://api.telegram.org/bot${sec.botToken}/getMe`); return { detail: `Connected to bot @${(r.json && r.json.result && r.json.result.username) || 'your bot'}.` }; },
  async perform(c, sec, a) { await request(`https://api.telegram.org/bot${sec.botToken}/sendMessage`, { method: 'POST', body: { chat_id: c.config.chatId, text: String(a.text) } }); return { detail: 'Sent on Telegram' }; }
};
const webhook = {
  label: 'Webhook', source: 'webhook', defaultLimit: 100,
  blurb: 'Sends JSON to any URL you choose (Zapier, Make, n8n, your own server). Each send waits for your approval by default.',
  fields: [{ key: 'url', label: 'Webhook URL', secret: true, placeholder: 'https://…', help: 'Treated as a secret because URLs often contain tokens. Test connection sends {"event":"sovereign.test"}.' }],
  contract: '{"payload":{"any":"json object"}}',
  validate(a) { if (!a.payload || typeof a.payload !== 'object' || Array.isArray(a.payload)) throw new Error('Webhook needs a "payload" object.'); if (JSON.stringify(a.payload).length > 20000) throw new Error('Webhook payload is over 20,000 characters.'); },
  preview(a) { return 'POST JSON to your webhook:\n' + JSON.stringify(a.payload, null, 2).slice(0, 700); },
  async test(c, sec) { if (!httpUrl(sec.url)) throw new Error('That does not look like a URL.'); const r = await request(sec.url, { method: 'POST', body: { event: 'sovereign.test' } }); return { detail: `Webhook answered ${r.status}.` }; },
  async perform(c, sec, a) { const r = await request(sec.url, { method: 'POST', body: a.payload }); return { detail: `Webhook answered ${r.status}` }; }
};
module.exports = { slack, discord, telegram, webhook };
