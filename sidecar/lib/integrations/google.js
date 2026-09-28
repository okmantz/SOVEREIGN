'use strict';
const { request } = require('./http');
const oauth = require('./oauth');

const oauthCfg = (scope) => ({ provider: 'google', scope, clientId: (c) => c.config.clientId, clientSecret: (c, sec) => sec.clientSecret });
const oauthFields = [
  { key: 'clientId', label: 'Google OAuth client ID', placeholder: '…apps.googleusercontent.com', help: 'In Google Cloud Console create an OAuth client of type Desktop app, then paste its ID and secret. Enable the Calendar or Drive API for the project.' },
  { key: 'clientSecret', label: 'Google OAuth client secret', secret: true, placeholder: 'GOCSPX-…' }
];
const auth = async (a, c, sec) => ({ authorization: 'Bearer ' + (await oauth.accessToken(c, a, sec)) });
const isoOk = (s) => !Number.isNaN(Date.parse(s));

const calendar = {
  label: 'Google Calendar', source: 'calendar',
  blurb: 'Creates events and lists the next seven days. Events wait for your approval by default. Guests are never invited.',
  fields: [...oauthFields, { key: 'calendarId', label: 'Calendar ID', optional: true, placeholder: 'primary' }, { key: 'timeZone', label: 'Time zone', optional: true, placeholder: 'America/Chicago', help: 'Used when an event time has no offset. Defaults to UTC.' }],
  oauth: oauthCfg('https://www.googleapis.com/auth/calendar.events'),
  contract: '{"title":"Call with Acme","start":"2026-10-05T15:00:00-05:00","end":"2026-10-05T15:30:00-05:00","description":"Optional notes"}',
  validate(a) {
    if (!a.title) throw new Error('Calendar needs a "title".');
    if (!isoOk(a.start) || !isoOk(a.end) || Date.parse(a.end) <= Date.parse(a.start)) throw new Error('Calendar needs ISO "start" and a later "end".');
  },
  preview(a) { return `New event: ${a.title}\n${a.start} → ${a.end}${a.description ? '\n\n' + String(a.description).slice(0, 400) : ''}`; },
  async test(c, sec) {
    const r = await request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.config.calendarId || 'primary')}`, { headers: await auth(this, c, sec) });
    return { detail: `Connected to calendar “${(r.json && r.json.summary) || 'primary'}”.` };
  },
  async sync(c, sec, { now = Date.now() } = {}) {
    const q = new URLSearchParams({ timeMin: new Date(now).toISOString(), timeMax: new Date(now + 7 * 864e5).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '25' });
    const r = await request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.config.calendarId || 'primary')}/events?${q}`, { headers: await auth(this, c, sec) });
    const items = ((r.json && r.json.items) || []).map((e) => `${(e.start && (e.start.dateTime || e.start.date)) || '?'}  ${e.summary || '(no title)'}`);
    return { entries: [], cursor: c.cursor, notes: [items.length ? 'Next 7 days:\n' + items.join('\n') : 'Nothing on the calendar for the next 7 days.'] };
  },
  async perform(c, sec, a) {
    const tz = c.config.timeZone || 'UTC';
    const r = await request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.config.calendarId || 'primary')}/events`, { method: 'POST', headers: await auth(this, c, sec), body: {
      summary: String(a.title).slice(0, 200), description: a.description ? String(a.description).slice(0, 4000) : undefined, start: { dateTime: a.start, timeZone: tz }, end: { dateTime: a.end, timeZone: tz } } });
    return { detail: 'Created event: ' + a.title, url: r.json && r.json.htmlLink };
  }
};

const drive = {
  label: 'Google Drive', source: 'drive',
  blurb: 'Creates documents and text files. It can only see files it created (drive.file scope). Each file waits for your approval by default.',
  fields: [...oauthFields, { key: 'folderId', label: 'Folder ID', optional: true, placeholder: 'Folder to save into (optional)' }],
  oauth: oauthCfg('https://www.googleapis.com/auth/drive.file'),
  contract: '{"name":"Offer draft v1","content":"Document text","asGoogleDoc":true}',
  validate(a) { if (!a.name || a.content == null) throw new Error('Drive needs "name" and "content".'); },
  preview(a) { return `New ${a.asGoogleDoc === false ? 'text file' : 'Google Doc'}: ${a.name}\n\n${String(a.content).slice(0, 600)}`; },
  async test(c, sec) {
    const r = await request('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: await auth(this, c, sec) });
    return { detail: `Connected as ${(r.json && r.json.user && r.json.user.emailAddress) || 'your Google account'}.` };
  },
  async sync(c, sec) {
    const r = await request('https://www.googleapis.com/drive/v3/files?pageSize=20&orderBy=modifiedTime%20desc&fields=files(name,modifiedTime,webViewLink)', { headers: await auth(this, c, sec) });
    const items = ((r.json && r.json.files) || []).map((f) => `${f.modifiedTime}  ${f.name}`);
    return { entries: [], cursor: c.cursor, notes: [items.length ? 'Files Sovereign created:\n' + items.join('\n') : 'No files created yet.'] };
  },
  async perform(c, sec, a) {
    const asDoc = a.asGoogleDoc !== false, boundary = 'sov_' + Math.random().toString(36).slice(2);
    const meta = { name: String(a.name).slice(0, 200), mimeType: asDoc ? 'application/vnd.google-apps.document' : 'text/plain', ...(c.config.folderId ? { parents: [c.config.folderId] } : {}) };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${String(a.content)}\r\n--${boundary}--`;
    const r = await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', { method: 'POST',
      headers: { ...(await auth(this, c, sec)), 'content-type': `multipart/related; boundary=${boundary}` }, body });
    return { detail: 'Created in Drive: ' + a.name, url: r.json && r.json.webViewLink };
  }
};

module.exports = { calendar, drive };
