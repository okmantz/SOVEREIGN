'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const crypto = require('node:crypto'); const http = require('node:http');
const { mk } = require('./company.helpers');
const { allowed } = require('../sidecar/lib/company/tunnel');

function setup(opts = {}) {
  const t = mk({ llm: opts.llm || null, settings: { mail: { provider: 'test', window: { start: 0, end: 24 } }, remote: { telegram: { enabled: true, poll: false }, quiet_hours: { start: 0, end: 0 }, report_hour: 0 } } });
  const sent = []; t.co.mail.registerMailer('test', async (m) => { sent.push(m); return { id: 'x' }; });
  t.co.secrets.set('mail_footer', 'Reply STOP. Acme, 1 Main St'); t.co.secrets.set('telegram_bot_token', '123:abc');
  const calls = []; t.co.remote.setFetch(async (url, opt) => { const method = String(url).split('/').pop(); const body = JSON.parse((opt && opt.body) || '{}'); calls.push({ method, body }); return { ok: true, status: 200, json: async () => ({ ok: true, result: method === 'getUpdates' ? [] : { message_id: 1 } }) }; });
  const id = t.co.ventures.create({ name: 'Acme', type: 'service', capital_allocated: 100 }).venture_id; t.co.cfo.fund(id, 100);
  const sends = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body);
  let uid = 1; const OWNER = 555;
  const say = (text, from = OWNER, chat = from, type = 'private') => t.co.remote.handleTelegram({ update_id: uid++, message: { text, chat: { id: chat, type }, from: { id: from, first_name: 'Owen' } } });
  const tap = (data, from = OWNER) => t.co.remote.handleTelegram({ update_id: uid++, callback_query: { id: 'cb' + uid, from: { id: from }, message: { chat: { id: from } }, data } });
  const pair = async () => { const { code } = t.co.remote.startPairing('telegram'); await say(`/pair ${code}`); };
  return { ...t, id, sent, calls, sends, say, tap, pair, OWNER };
}

test('pairing: the first message proves it is you; strangers get nothing and are logged; a wrong code never pairs', async () => {
  const { co, say, sends, OWNER } = setup();
  await say('/status', 999); assert.equal(sends().length, 0); // no pairing active: silence
  const { code } = co.remote.startPairing('telegram'); await say('/pair 000000', 777); assert.equal(co.remote.owners().length, 0); assert.match(sends().at(-1).text, /did not work/);
  await say(`/pair ${code}`, 888, 888, 'group'); assert.equal(co.remote.owners().length, 0); // groups can never pair
  await say(`/pair ${code}`, OWNER); assert.equal(co.remote.owners().length, 1); assert.match(sends().at(-1).text, /Paired/);
  const n = sends().length; await say('/status', 999); assert.equal(sends().length, n); // still nothing for a stranger
  assert.ok(co.trail.tail(50).some((e) => e.type === 'remote.denied'));
  await say('/status', OWNER); assert.match(sends().at(-1).text, /SOVEREIGN/);
  const c2 = setup(); const { code: k } = c2.co.remote.startPairing('telegram'); for (let i = 0; i < 6; i++) await c2.say('/pair 111111', 42); await c2.say(`/pair ${k}`, 42); assert.equal(c2.co.remote.owners().length, 0); // brute force locks the pairing
});
test('approve / reject from the phone: mail drafts send only after the tap; medium company approvals run the same executor; nothing runs twice', async () => {
  const { co, id, say, tap, pair, sends, sent } = setup(); await pair();
  const m = co.mail.queue({ venture_id: id, to: 'a@x.test', subject: 'Hello', body: 'a plain, kind note to a lead' });
  await say('/pending'); const msg = sends().at(-1); assert.match(msg.text, /Hello/); const btns = msg.reply_markup.inline_keyboard[0]; assert.deepEqual(btns.map((b) => b.text), ['✅ Approve', '❌ Reject']);
  assert.equal(sent.length, 0); await tap(btns[0].callback_data); assert.equal(sent.length, 1); assert.equal(co.mail.get(m.id).status, 'sent'); assert.match(sends().at(-1).text, /Approved/);
  await tap(btns[0].callback_data); assert.match(sends().at(-1).text, /already handled/); assert.equal(sent.length, 1);
  const m2 = co.mail.queue({ venture_id: id, to: 'b@x.test', subject: 'Nope', body: 'x' }); await tap(`a:m:${m2.id}:n`); assert.equal(co.mail.get(m2.id).status, 'rejected'); assert.equal(sent.length, 1);
  const a = co.permissions.queueApproval({ type: 'recommendation', venture_id: id, summary: 'Noted', payload: { action: 'NONE' } }); await tap(`a:c:${a.id}:y`); assert.equal(co.permissions.getApproval(a.id).status, 'approved');
  assert.ok(co.trail.tail(50).some((e) => e.type === 'remote.approve' && /telegram:555/.test(e.actor)));
});
test('high-risk approvals are desktop-only by default; reject always works; when allowed, a second tap is required', async () => {
  const { co, id, say, tap, pair, sends } = setup(); await pair();
  const a = co.permissions.queueApproval({ type: 'recommendation', venture_id: id, summary: 'Increase allocation $100 → $150', payload: { action: 'INCREASE_BUDGET' } });
  assert.equal((await co.remote.pending()).find((i) => i.id === a.id).risk, 'high');
  await say('/pending'); const m = sends().at(-1); assert.match(m.text, /Desktop-only/); assert.deepEqual(m.reply_markup.inline_keyboard[0].map((b) => b.text), ['❌ Reject']);
  await tap(`a:c:${a.id}:y`); assert.match(sends().at(-1).text, /desktop/); assert.equal(co.permissions.getApproval(a.id).status, 'pending'); assert.ok(co.trail.tail(20).some((e) => e.type === 'remote.blocked'));
  co.setSettings({ remote: { allow_high_risk_remote: true } }); await tap(`a:c:${a.id}:y`); const ask = sends().at(-1); assert.match(ask.text, /High risk/); assert.equal(co.permissions.getApproval(a.id).status, 'pending');
  await tap(ask.reply_markup.inline_keyboard[0][0].callback_data); assert.equal(co.permissions.getApproval(a.id).status, 'approved');
  const b = co.permissions.queueApproval({ type: 'recommendation', venture_id: id, summary: 'Scale', payload: { action: 'SCALE' } }); co.setSettings({ remote: { allow_high_risk_remote: false } }); await tap(`a:c:${b.id}:n`); assert.equal(co.permissions.getApproval(b.id).status, 'rejected');
});
test('STOP from the phone pauses the autopilot and holds all mail; approving is refused until a confirmed resume', async () => {
  const { co, id, say, tap, pair, sends, sent } = setup(); await pair(); co.setSettings({ autopilot: { enabled: true } });
  const m = co.mail.queue({ venture_id: id, to: 'a@x.test', subject: 'Hi', body: 'note', status: 'approved' });
  await say('/stop'); assert.match(sends().at(-1).text, /Stopped/); assert.ok(co.autopilot.status().paused); assert.equal(co.settings().mail.hold, true);
  assert.equal((await co.mail.flush()).on_hold, true); assert.equal(sent.length, 0); assert.equal(co.mail.get(m.id).status, 'approved');
  const d = co.mail.queue({ venture_id: id, to: 'b@x.test', subject: 'Hi', body: 'note' }); await tap(`a:m:${d.id}:y`); assert.match(sends().at(-1).text, /hold/); assert.equal(co.mail.get(d.id).status, 'draft');
  await say('/resume'); const btn = sends().at(-1).reply_markup.inline_keyboard[0][0]; assert.equal(co.autopilot.status().paused !== null, true); await tap(btn.callback_data);
  assert.equal(co.autopilot.status().paused, null); assert.equal(co.settings().mail.hold, false); await co.mail.flush(); assert.equal(sent.length, 1);
  assert.ok(co.trail.tail(20).some((e) => e.type === 'remote.stop') && co.trail.tail(20).some((e) => e.type === 'remote.resume'));
});
test('push: new approvals arrive once with buttons; drafts are grouped; quiet hours hold non-urgent, urgent still goes; circuit breaker; morning report once a day', async () => {
  const { co, id, pair, sends, calls } = setup(); await pair(); const n0 = sends().length;
  const a = co.permissions.queueApproval({ type: 'recommendation', venture_id: id, summary: 'Approve me', payload: { action: 'NONE' } }); co.mail.queue({ venture_id: id, to: 'a@x.test', subject: 's', body: 'b' }); co.mail.queue({ venture_id: id, to: 'b@x.test', subject: 's', body: 'b' });
  const r = await co.remote.pump({ force: true }); assert.equal(r.approvals, 1); assert.equal(r.drafts, 2); const s1 = sends().slice(n0); assert.ok(s1.some((x) => /Approve me/.test(x.text))); assert.ok(s1.some((x) => /2 e-mail draft/.test(x.text) && /Approve all safe/.test(JSON.stringify(x.reply_markup))));
  const n1 = sends().length; await co.remote.pump({ force: true }); assert.equal(sends().length, n1); void a; // nothing is sent twice
  co.emit('payment.failed', { customer: 'ann@x.test', attempt: 1 }, id); co.emit('subscription.renewed', { amount: 99 }, id); await co.remote.pump({ force: true }); const t = sends().slice(n1).map((x) => x.text).join('|'); assert.match(t, /Payment failed/); assert.match(t, /Renewal: \$99/);
  const h = new Date(co.now()).getHours(); co.setSettings({ remote: { quiet_hours: { start: h, end: (h + 1) % 24 } } }); const n2 = sends().length;
  co.emit('customer.churned', { reason: 'x' }, id); co.emit('subscription.renewed', { amount: 5 }, id); co.emit('autopilot.paused', { reason: 'test pause' }, id); await co.remote.pump({ force: true });
  const q = sends().slice(n2).map((x) => x.text).join('|'); assert.match(q, /Autopilot paused/); assert.doesNotMatch(q, /cancelled/); assert.doesNotMatch(q, /Renewal/); // urgent only, and info is dropped
  co.setSettings({ remote: { quiet_hours: { start: 0, end: 0 }, max_pushes_per_hour: 3 } }); const n3 = sends().length; for (let i = 0; i < 6; i++) await co.remote.push(`msg ${i}`); assert.ok(sends().length - n3 <= 3); assert.ok(co.trail.tail(30).some((e) => e.type === 'remote.throttled'));
  const c2 = setup(); await c2.pair(); const k = c2.sends().length; await c2.co.remote.pump({ force: true }); assert.equal(c2.sends().slice(k).filter((x) => /report/.test(x.text)).length, 1); await c2.co.remote.pump({ force: true }); assert.equal(c2.sends().slice(k).filter((x) => /report/.test(x.text)).length, 1);
  c2.day(1); await c2.co.remote.pump({ force: true }); assert.equal(c2.sends().slice(k).filter((x) => /report/.test(x.text)).length, 2);
});
test('morning report is built from records, says so when quiet, and counts what happened', async () => {
  const { co, id } = setup(); const quiet = await co.remote.report(); assert.match(quiet, /nothing new landed/); assert.match(quiet, /Waiting for you: nothing/);
  co.crm.addCustomer({ venture_id: id, email: 'a@x.test', mrr: 10 }); co.emit('subscription.renewed', { amount: 99 }, id); co.emit('customer.churned', { reason: 'r' }, id); co.emit('payment.failed', {}, id);
  const m = co.mail.queue({ venture_id: id, to: 'z@x.test', subject: 's', body: 'b', sequence: 'outreach', status: 'approved' }); await co.mail.flush(); void m;
  const r = await co.remote.report(); assert.match(r, /1 renewal/); assert.match(r, /1 new customer/); assert.match(r, /1 cancelled/); assert.match(r, /1 failed payment/); assert.match(r, /outreach 1/);
});
test('agents view: live task, idle, last output and whether it passed checks (provider-backed)', async () => {
  const { co, say, pair, sends } = setup(); await pair(); const now = co.now();
  co.remote.setProvider({ approvals: async () => [], agents: async () => [{ name: 'Ava', role: 'Copywriter', working: true, title: 'Writing the weekly report', since: now - 4 * 60000, last: null }, { name: 'Ben', role: 'Sales', working: false, title: '', since: null, last: { title: 'Outreach batch', at: now - 3600000, passed: false, preview: 'x' } }] });
  await say('/agents'); const t = sends().at(-1).text; assert.match(t, /🟢 Ava \(Copywriter\): Writing the weekly report · 4m/); assert.match(t, /⚪ Ben \(Sales\): idle, last: Outreach batch/); assert.match(t, /failed checks/);
  const st = await co.remote.consoleState(); assert.equal(st.agents.length, 2); assert.ok(Array.isArray(st.feed));
});
test('station provider: approvals from the main app are listed, graded and resolved through the provider; the risky ones stay desktop-only', async () => {
  const { co, say, tap, pair, sends } = setup(); await pair(); const store = [{ id: 'appr_a1', kind: 'connector.call', summary: 'Email: approve this action?', detail: ['To: x@y.z'], at: 1, meta: { connector_kind: 'email' } }, { id: 'appr_a2', kind: 'connector.call', summary: 'Meta ads: raise budget', detail: [], at: 2, meta: { connector_kind: 'ads.meta' } }, { id: 'appr_a3', kind: 'director.plan', summary: 'Plan', detail: [], at: 3, meta: { actions: ['create_world Shop'] } }, { id: 'appr_a4', kind: 'director.plan', summary: 'Plan 2', detail: [], at: 4, meta: { actions: ['assign_task Ava'] } }];
  const resolved = []; co.remote.setProvider({ approvals: async () => store.filter((x) => !resolved.includes(x.id)), resolve: async (id, ok) => { resolved.push(id); return { status: ok ? 'approved' : 'rejected' }; } });
  const items = await co.remote.pending(); assert.deepEqual(items.map((i) => i.risk), ['medium', 'high', 'high', 'low']);
  await tap('a:s:appr_a1:y'); assert.deepEqual(resolved, ['appr_a1']); await tap('a:s:appr_a2:y'); assert.deepEqual(resolved, ['appr_a1']); await tap('a:s:appr_a2:n'); assert.deepEqual(resolved, ['appr_a1', 'appr_a2']);
  await say('/digest'); assert.ok(sends().at(-1).text.length > 0); const r = await co.remote.approveAllSafe(); assert.equal(r.approved, 1); assert.ok(resolved.includes('appr_a4')); assert.ok(!resolved.includes('appr_a3'));
});
test('discord: forged signatures are rejected before parsing; ping, pairing, slash commands and buttons work for the paired owner only', async () => {
  const { co, id } = setup(); const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'); co.secrets.set('discord_public_key', raw);
  const send = async (obj, o = {}) => { const body = JSON.stringify(obj); const ts = String(Math.floor(co.now() / 1000) + (o.skew || 0)); const sig = o.badSig ? '00'.repeat(64) : crypto.sign(null, Buffer.from(ts + body), privateKey).toString('hex'); return co.handleDiscordInteraction(body, sig, ts); };
  assert.equal((await send({ type: 1 }, { badSig: true })).status, 401); assert.equal((await send({ type: 1 }, { skew: 4000 })).status, 401); assert.deepEqual((await send({ type: 1 })).body, { type: 1 });
  const slash = (name, uid2, opts) => ({ type: 2, member: { user: { id: uid2, username: 'o' } }, data: { name: 'sovereign', options: [{ type: 1, name, ...(opts ? { options: opts } : {}) }] } });
  const denied = await send(slash('status', '9')); assert.equal(denied.body.data.content, 'Not paired.');
  const { code } = co.remote.startPairing('discord'); const ok = await send(slash('pair', '9', [{ name: 'code', type: 3, value: code }])); assert.match(ok.body.data.content, /Paired/);
  const st = await send(slash('status', '9')); assert.match(st.body.data.content, /SOVEREIGN/); assert.equal(st.body.data.flags, 64);
  const m = co.mail.queue({ venture_id: id, to: 'a@x.test', subject: 'Hello', body: 'note' }); const pend = await send(slash('pending', '9')); const approve = pend.body.data.components[0].components[0]; assert.equal(approve.label, 'Approve');
  const click = await send({ type: 3, member: { user: { id: '9' } }, data: { custom_id: approve.custom_id } }); assert.match(click.body.data.content, /Approved/); assert.equal(co.mail.get(m.id).status, 'sent');
  const stranger = await send({ type: 3, member: { user: { id: '1' } }, data: { custom_id: approve.custom_id } }); assert.equal(stranger.body.data.content, 'Not paired.');
});
test('console: secret path + PIN, lockout after 5 wrong PINs, state shows agents/approvals/money, actions run through the same gates', async () => {
  const { co, id } = setup(); assert.equal(co.remote.authConsole('x', '', 'c').ok, false); const info = co.remote.enableConsole(); assert.match(info.path, /^\/remote\/[0-9a-f]{48}\/$/); const token = info.path.split('/')[2];
  assert.equal(co.remote.authConsole('wrong', '', 'c').status, 404); assert.equal(co.remote.authConsole(token, undefined, 'c').ok, true);
  co.secrets.set('remote_pin', '2468'); assert.equal(co.remote.authConsole(token, '', 'c', true).ok, true); assert.equal(co.remote.authConsole(token, 'bad', 'c').status, 401);
  for (let i = 0; i < 4; i++) co.remote.authConsole(token, 'bad', 'c'); assert.equal(co.remote.authConsole(token, '2468', 'c').status, 429); assert.equal(co.remote.authConsole(token, '2468', 'other').ok, true);
  const m = co.mail.queue({ venture_id: id, to: 'a@x.test', subject: 'Hello', body: 'note' }); const st = await co.remote.consoleState(); assert.equal(st.approvals.length, 1); assert.equal(st.trail_ok, true); assert.equal(st.approvals[0].remote_ok, true);
  const r = await co.remote.consoleAct({ action: 'approve', key: `m:${m.id}` }); assert.equal(r.ok, true); assert.equal(co.mail.get(m.id).status, 'sent');
  const h = co.permissions.queueApproval({ type: 'recommendation', venture_id: id, summary: 'Scale', payload: { action: 'SCALE' } }); assert.equal((await co.remote.consoleAct({ action: 'approve', key: `c:${h.id}` })).ok, false);
  assert.equal((await co.remote.consoleAct({ action: 'stop' })).ok, true); assert.ok((await co.remote.consoleState()).stopped);
  co.remote.disableConsole(); assert.equal(co.remote.authConsole(token, '2468', 'other').status, 404);
});
test('console over HTTP: page needs only the token, data needs the PIN, other paths 404; the gateway allow-list includes exactly these', async () => {
  const { co } = setup(); const routes = require('../sidecar/lib/company/routes'); const info = co.remote.enableConsole(); const token = info.path.split('/')[2]; co.secrets.set('remote_pin', '1357');
  const srv = http.createServer(async (req, res) => { if (!(await routes.handle(co, req, res))) { res.writeHead(404); res.end(); } }); await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const req = (method, path, headers = {}, body) => new Promise((resolve) => { const r = http.request({ port, path, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers })); }); if (body) r.write(JSON.stringify(body)); r.end(); });
  try {
    assert.equal((await req('GET', '/remote/' + 'a'.repeat(48) + '/')).status, 404); const page = await req('GET', info.path); assert.equal(page.status, 200); assert.match(page.body, /SOVEREIGN/); assert.match(page.headers['content-security-policy'], /default-src 'none'/); assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal((await req('GET', info.path + 'api/state')).status, 401); const s = await req('GET', info.path + 'api/state', { 'x-pin': '1357' }); assert.equal(s.status, 200); assert.ok(JSON.parse(s.body).money);
    assert.equal((await req('POST', info.path + 'api/act', { 'x-pin': '1357' }, { action: 'nope' })).status, 200); assert.equal((await req('GET', info.path + 'api/other', { 'x-pin': '1357' })).status, 404);
  } finally { srv.close(); }
  for (const [m, p] of [['GET', `/remote/${token}/`], ['GET', `/remote/${token}/api/state`], ['POST', `/remote/${token}/api/act`], ['POST', '/hooks/discord']]) assert.equal(allowed(m, p), true, p);
  for (const [m, p] of [['POST', '/api/company/remote/pair'], ['GET', '/api/company/remote'], ['POST', '/api/company/remote/stop'], ['GET', `/remote/${token}/api/secrets`]]) assert.equal(allowed(m, p), false, p);
});
test('decision trail: hash-chained, records approvals from every device, and detects an edited or deleted line', async () => {
  const fs = require('node:fs'); const { co, id } = setup(); const a = co.permissions.queueApproval({ type: 'recommendation', venture_id: id, summary: 'Noted', payload: { action: 'NONE' } }); co.permissions.resolve(a.id, true, 'desktop');
  co.trail.log('ceo.decision', { action: 'ADVANCE', reason: 'test' }, { actor: 'ceo' }); co.trail.log('x', { n: 1 }); assert.ok(co.trail.tail(20).some((e) => e.type === 'approval.approved')); const v = co.trail.verify(); assert.equal(v.ok, true); assert.ok(v.entries >= 3);
  const lines = fs.readFileSync(co.trail.file, 'utf8').split('\n').filter(Boolean); const edited = lines.map((l, i) => (i === 1 ? l.replace(/"actor":"[^"]*"/, '"actor":"nobody"') : l)); fs.writeFileSync(co.trail.file, edited.join('\n') + '\n'); assert.equal(co.trail.verify().ok, false); assert.match(co.trail.verify().reason, /edited/);
  fs.writeFileSync(co.trail.file, lines.filter((_, i) => i !== 1).join('\n') + '\n'); assert.equal(co.trail.verify().ok, false); assert.match(co.trail.verify().reason, /missing|broken/);
});
test('telegram long polling: updates are fetched, handled and acknowledged (offset advances); it never spins when the server answers instantly', async () => {
  const { co, sends, calls, pair, OWNER } = setup(); await pair(); co.setSettings({ remote: { telegram: { poll: true } } });
  let served = false; co.remote.setFetch(async (url, opt) => { const method = String(url).split('/').pop(); const body = JSON.parse((opt && opt.body) || '{}'); calls.push({ method, body });
    const result = method === 'getUpdates' ? (served ? [] : ((served = true), [{ update_id: 7, message: { text: '/status', chat: { id: OWNER, type: 'private' }, from: { id: OWNER } } }])) : { message_id: 1 }; return { ok: true, json: async () => ({ ok: true, result }) }; });
  assert.equal(co.remote.startTelegram(), true); await new Promise((r) => setTimeout(r, 1500)); co.remote.stopTelegram();
  assert.ok(sends().some((x) => /SOVEREIGN/.test(x.text))); const polls = calls.filter((c) => c.method === 'getUpdates'); assert.ok(polls.length >= 2 && polls.length <= 4, `polls: ${polls.length}`); assert.equal(polls[1].body.offset, 8);
});
