'use strict';
const crypto = require('node:crypto');
const { DAY, round } = require('./util');

/**
 * REMOTE CONTROL: run Sovereign on your desktop, watch and steer it from your phone.
 *
 *   Telegram   long polling from the desktop (no public URL, no tunnel needed): push alerts, approve / reject with buttons, /stop.
 *   Discord    push through a webhook; slash commands with buttons through an interactions endpoint (needs the tunnel).
 *   Console    a phone-sized web page that shows every agent, what it is doing, its last output, the decision trail, the money and
 *              the approval queue (served through the tunnel at a secret address, behind an optional PIN).
 *
 * Ideas borrowed from StarNet's channels and Night Shift guides: the first message pairs YOU as the owner and strangers get
 * nothing; stop everything from the phone; budgets still bind because a remote approval runs the same executors; a morning
 * report; a decision trail that cannot be quietly edited.
 *
 * Safety rules, all enforced in code:
 *   - only paired owners are obeyed; anything else is dropped silently and written to the trail;
 *   - a high-risk approval (spends money, irreversible, launches or scales a business, creates a world) cannot be approved from a
 *     phone unless you switch remote.allow_high_risk_remote on, and even then it takes a second confirming tap. Reject is always allowed;
 *   - stop is one tap, always; resume takes a confirming tap;
 *   - a global push circuit-breaker (30 per hour) so a bug can never spam you or run up a bill.
 */
const HIGH_RISK_RECS = new Set(['PIVOT', 'SCALE', 'INCREASE_BUDGET', 'KILL']);
const MONEY_CONNECTORS = new Set(['stripe', 'ads.meta', 'meta_ads', 'bank', 'shopify', 'etsy', 'woocommerce', 'gumroad', 'paypal']);
const ICON = { low: '🟢', medium: '🟡', high: '🔴' };
const clip = (t, n) => (String(t).length > n ? String(t).slice(0, n - 1) + '…' : String(t));

function makeRemote(ctx) {
  const S = () => ctx.db.get('remote', { owners: [], pairing: null, offset: 0, notified: [], last_drafts_push: 0, last_drafts_count: 0, last_report_day: '', pushes: [], stopped: null, pin_fails: {}, console_seen: 0 });
  const save = () => ctx.db.save('remote');
  const cfg = () => ctx.settings().remote;
  let fetchOverride = null; const fetchFn = () => fetchOverride || ctx.fetchImpl || fetch; const setFetch = (f) => { fetchOverride = f; }; // tests only
  let provider = null, polling = false, pollAbort = null, pumping = false, lastPump = 0; const alerts = [];
  const setProvider = (p) => { provider = p; };

  // ------------------------------------------------------------------ what is waiting for you, and how risky it is
  /** Grade one approval. `meta` is supplied by whoever lists it (the bridge knows connectors and plans). */
  function riskOf(it) {
    const m = it.meta || {};
    if (it.source === 'mail') return (it.flags && it.flags.length) ? 'medium' : 'low';
    const ca = m.company || (it.source === 'company' ? m.raw : null);
    if (ca) {
      if (ca.type === 'delivery') return ca.placeholder ? 'medium' : 'low';
      if (ca.type === 'pause') return 'medium';
      if (ca.type === 'venture_create' || ca.type === 'capital_increase') return 'high';
      if (ca.type === 'recommendation') return HIGH_RISK_RECS.has(ca.payload && ca.payload.action) ? 'high' : 'medium';
      if (ca.type === 'tool') { const t = ctx.tools.get(ca.tool); return (ca.cost > 0 || (t && (t.irreversible || t.required_permission >= 3))) ? 'high' : 'medium'; }
      return 'medium';
    }
    if (it.kind === 'connector.call') return MONEY_CONNECTORS.has(m.connector_kind) ? 'high' : 'medium';
    if (it.kind === 'director.plan') return (m.actions || []).some((a) => /world|budget|capital|delete|remove|spend/i.test(a)) ? 'high' : 'low';
    return 'medium';
  }
  /** Everything you could approve or reject right now, oldest first. Keys: s: station approval, c: company approval, m: mail draft. */
  async function pending() {
    const out = [];
    if (provider && provider.approvals) for (const a of await provider.approvals()) out.push({ key: `s:${a.id}`, source: 'station', id: a.id, kind: a.kind, summary: a.summary, detail: a.detail || [], meta: a.meta || {}, at: a.at, world: a.world });
    else for (const a of ctx.permissions.pending()) out.push({ key: `c:${a.id}`, source: 'company', id: a.id, kind: a.type, summary: a.summary, detail: [a.reason || ''].filter(Boolean), meta: { raw: a, company: a }, at: a.created });
    for (const m of ctx.mail.list({ status: 'draft' })) out.push({ key: `m:${m.id}`, source: 'mail', id: m.id, kind: m.sequence || m.kind, summary: `${m.sequence || m.kind} → ${m.to}: ${m.subject}`, detail: [m.body], flags: m.flags, at: m.created });
    for (const it of out) it.risk = riskOf(it);
    return out.sort((a, b) => (a.at || 0) - (b.at || 0));
  }
  const canApproveRemotely = (it) => it.risk !== 'high' || !!cfg().allow_high_risk_remote;

  /**
   * Approve or reject one item on behalf of a paired device. Runs exactly the same code as clicking the button on the desktop
   * (executors, CFO vote, free-only gate, caps), so a remote tap can never do more than a local one.
   */
  async function act(key, approve, { actor = 'remote', confirm = false } = {}) {
    const st = S(); if (st.stopped && approve) return { ok: false, reason: 'remote hold is on (you sent stop). Resume first.' };
    const items = await pending(); const it = items.find((x) => x.key === key);
    if (!it) return { ok: false, reason: 'that request was already handled' };
    if (approve && !canApproveRemotely(it)) { ctx.trail.log('remote.blocked', { key, summary: it.summary, risk: it.risk }, { actor }); return { ok: false, reason: 'high-risk: this one can only be approved at the desktop', risk: it.risk }; }
    if (approve && it.risk === 'high' && !confirm) return { ok: false, needs_confirm: true, risk: it.risk, summary: it.summary };
    let outcome = null;
    try {
      if (it.source === 'mail') { if (approve) ctx.mail.approve(it.id, actor); else ctx.mail.reject(it.id, 'rejected from phone'); if (approve) await ctx.mail.flush(); outcome = { status: approve ? 'approved' : 'rejected' }; }
      else if (it.source === 'station') { const r = await provider.resolve(it.id, approve); outcome = { status: r && r.status }; }
      else { const r = await ctx.resolveApproval(it.id, approve, `${approve ? 'approved' : 'rejected'} from phone`); outcome = { status: r && r.approval && r.approval.status }; }
    } catch (e) { ctx.trail.log('remote.error', { key, error: e.message }, { actor }); return { ok: false, reason: e.message }; }
    ctx.trail.log(approve ? 'remote.approve' : 'remote.reject', { key, summary: it.summary, risk: it.risk, outcome }, { actor });
    return { ok: true, outcome, summary: it.summary, risk: it.risk };
  }
  async function approveAllSafe({ actor = 'remote' } = {}) {
    if (S().stopped) return { ok: false, reason: 'remote hold is on. Resume first.', approved: 0 };
    const items = (await pending()).filter((i) => i.risk === 'low' && i.source !== 'station'); let n = 0; const errors = [];
    const mailIds = items.filter((i) => i.source === 'mail').map((i) => i.id); const apprIds = items.filter((i) => i.source === 'company').map((i) => i.id);
    const r = await ctx.lifecycle.approveBatch({ mail_ids: mailIds, approval_ids: apprIds, by: actor }); n = r.mail + r.approvals; errors.push(...r.errors);
    if (provider && provider.approvals) for (const it of (await pending()).filter((i) => i.source === 'station' && i.risk === 'low')) { try { await provider.resolve(it.id, true); n++; } catch (e) { errors.push(e.message); } }
    ctx.trail.log('remote.approve_all_safe', { approved: n, errors: errors.length }, { actor }); return { ok: true, approved: n, errors };
  }

  // ------------------------------------------------------------------ stop / resume
  /** The kill switch: pause the autopilot, hold every outgoing e-mail, pause every running plan. Always allowed, from any owner device. */
  async function stop(actor = 'remote', reason = 'stopped from phone') {
    const st = S(); st.stopped = { ts: ctx.now(), reason, actor }; save(); ctx.autopilot.pause(reason); ctx.setSettings({ mail: { hold: true } });
    let plans = 0; if (provider && provider.stop) plans = await provider.stop(reason);
    ctx.trail.log('remote.stop', { reason, plans }, { actor }); return { ok: true, plans_paused: plans };
  }
  async function resume(actor = 'remote') {
    const st = S(); st.stopped = null; save(); ctx.autopilot.resume(); ctx.setSettings({ mail: { hold: false } });
    let plans = 0; if (provider && provider.resume) plans = await provider.resume();
    ctx.trail.log('remote.resume', { plans }, { actor }); return { ok: true, plans_resumed: plans };
  }

  // ------------------------------------------------------------------ reports (status, agents, morning report)
  function money() {
    const cust = ctx.crm.customers(); const live = cust.filter((c) => !c.churned); const mrr = round(live.reduce((a, c) => a + (c.mrr || 0), 0));
    const m = ctx.ledger.monthly(); return { mrr, subscribers: live.length, at_risk: live.filter((c) => c.failed_payment || c.cancel_pending).length, churned: cust.length - live.length, revenue_30d: m.net_revenue, costs_30d: m.total_costs, profit_30d: m.contribution_profit };
  }
  async function statusText() {
    const ap = ctx.autopilot.status(); const mo = money(); const ms = ctx.mail.status(); const items = await pending(); const need = items.filter((i) => !canApproveRemotely(i)).length;
    const tun = ctx.tunnel ? ctx.tunnel.status() : { running: false };
    const g = ctx.ventures.list({ activeOnly: true })[0]; const gc = g ? ctx.ceo.cashflow(g.venture_id) : null;
    return [`SOVEREIGN`, `Autopilot: ${ap.paused ? `PAUSED (${clip(ap.paused, 80)})` : ap.enabled ? 'running' : 'off'}${S().stopped ? ' · REMOTE HOLD ON' : ''}`,
      `MRR $${mo.mrr} · ${mo.subscribers} subscribers · ${mo.at_risk} at risk · ${mo.churned} churned`, `30 days: revenue $${mo.revenue_30d}, costs $${mo.costs_30d}, profit $${mo.profit_30d}`,
      gc ? `Guardrail: ${gc.ads_frozen ? 'ADS FROZEN' : gc.scale_ok ? 'ok' : 'hold'}${gc.ltv_cac !== null ? ` (LTV/CAC ${gc.ltv_cac})` : ''}` : '',
      `Mail today ${ms.sent_today}/${ms.daily_limit} · drafts ${ms.drafts}${cfgHold() ? ' · MAIL HELD' : ''}`, `Waiting for you: ${items.length}${need ? ` (${need} desktop-only)` : ''}`,
      `Public URL: ${tun.running ? tun.url : 'tunnel off'}`].filter(Boolean).join('\n');
  }
  const cfgHold = () => !!ctx.settings().mail.hold;
  async function agentsList() { return provider && provider.agents ? provider.agents() : ctx.analytics.agentReport().map((a) => ({ name: a.agent_id, role: '', working: false, title: '', since: null, last: null })); }
  const ago = (t) => { if (!t) return ''; const m = Math.max(0, Math.round((ctx.now() - t) / 60000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
  async function agentsText() {
    const list = await agentsList(); if (!list.length) return 'No agents yet.';
    return list.slice(0, 25).map((a) => `${a.working ? '🟢' : '⚪'} ${a.name}${a.role ? ` (${a.role})` : ''}: ${a.working ? `${clip(a.title, 70)} · ${ago(a.since)}` : `idle${a.last ? `, last: ${clip(a.last.title, 60)} ${ago(a.last.at)} ago${a.last.passed === false ? ' ⚠ failed checks' : ''}` : ''}`}`).join('\n');
  }
  /** The morning report: built only from recorded events, the verified ledger and the mail/retainer records. A quiet night says so. */
  async function report(since = ctx.now() - DAY) {
    const evs = ctx.db.get('events', []).filter((e) => e.ts >= since); const n = (re) => evs.filter((e) => re.test(e.type)).length;
    const led = ctx.ledger.summary({ since }); const sent = ctx.mail.list({ status: 'sent' }).filter((m) => m.sent_at >= since && m.kind !== 'owner_digest');
    const by = {}; for (const m of sent) by[m.sequence || m.kind] = (by[m.sequence || m.kind] || 0) + 1;
    const failedMail = ctx.mail.list({ status: 'failed' }).filter((m) => m.created >= since).length; const items = await pending(); const safe = items.filter((i) => i.risk === 'low').length;
    const jobs = ctx.db.get('autopilot', { log: [] }).log.filter((l) => l.ts >= since); const jobFails = jobs.filter((l) => !l.ok);
    const renewals = n(/^subscription\.renewed$/), churned = n(/^customer\.churned$/), cancels = n(/^customer\.cancel_pending$/), failedPay = n(/^payment\.failed$/), recovered = n(/^payment\.recovered$/), delivered = n(/^retainer\.delivered$/), newCust = n(/^customer\.added$/);
    const did = []; if (newCust) did.push(`${newCust} new customer(s)`); if (renewals) did.push(`${renewals} renewal(s)`); if (delivered) did.push(`${delivered} delivery(ies) sent`); if (sent.length) did.push(`${sent.length} e-mail(s) sent`); if (recovered) did.push(`${recovered} payment(s) recovered`);
    const bad = []; if (churned) bad.push(`${churned} cancelled`); if (cancels) bad.push(`${cancels} scheduled to cancel`); if (failedPay) bad.push(`${failedPay} failed payment(s)`); if (failedMail) bad.push(`${failedMail} e-mail(s) failed`); if (jobFails.length) bad.push(`${jobFails.length} job failure(s)`);
    const ap = ctx.autopilot.status(); const lines = [`☀ Sovereign report, last ${Math.max(1, Math.round((ctx.now() - since) / 3600000))}h`, did.length ? `Done: ${did.join(', ')}.` : 'Done: nothing new landed. A quiet stretch is normal; it is not padded.',
      `Money: net revenue $${led.net_revenue}, costs $${led.total_costs}, contribution $${led.contribution_profit}.`];
    if (Object.keys(by).length) lines.push(`Sent: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    if (bad.length) lines.push(`Needs attention: ${bad.join(', ')}.`); if (ap.paused) lines.push(`⏸ Autopilot is paused: ${clip(ap.paused, 100)}`);
    const skipped = ctx.trail.tail(200, { since }).filter((e) => e.type === 'remote.blocked').length; if (skipped) lines.push(`${skipped} high-risk approval(s) were kept for the desktop.`);
    lines.push(items.length ? `Waiting for you: ${items.length} (${safe} safe to approve in one tap).` : 'Waiting for you: nothing.'); return lines.join('\n');
  }

  // ------------------------------------------------------------------ one command interpreter for every channel
  const HELP = 'Commands: /status · /pending · /digest · /agents · /report · /stop · /resume\nTap Approve / Reject on any request. High-risk requests are desktop-only unless you allow them in settings.';
  /** → { text, buttons?: [[{label, data}]] , items?: [{text, buttons}] } */
  async function command(name, arg, actor) {
    switch (name) {
      case 'start': case 'help': return { text: `Connected. ${HELP}` };
      case 'status': { const t = await statusText(); return { text: t, buttons: [[{ label: 'Pending', data: 'p' }, { label: 'Agents', data: 'ag' }, { label: '⛔ Stop', data: 'stop' }]] }; }
      case 'agents': return { text: await agentsText() };
      case 'report': return { text: await report() };
      case 'digest': { const d = ctx.lifecycle.digest(); return { text: `${d.counts.total} item(s), about ${d.est_minutes} min. ${d.counts.safe_to_bulk_approve} safe to approve together, ${d.counts.needs_reading} need reading.${d.warnings.length ? '\n⚠ ' + d.warnings.join('\n⚠ ') : ''}`, buttons: d.counts.safe_to_bulk_approve ? [[{ label: `✅ Approve all safe (${d.counts.safe_to_bulk_approve})`, data: 'bulk' }]] : undefined }; }
      case 'pending': { const items = await pending(); if (!items.length) return { text: 'Nothing waiting for you.' };
        return { text: `${items.length} waiting${items.length > 8 ? ', showing the oldest 8' : ''}:`, items: items.slice(0, 8).map((i) => itemMessage(i)) }; }
      case 'stop': { const r = await stop(actor, 'stopped from phone'); return { text: `⛔ Stopped. Autopilot paused, outgoing e-mail held${r.plans_paused ? `, ${r.plans_paused} plan(s) paused` : ''}. Nothing new will run until you /resume.` }; }
      case 'resume': return { text: 'Resume autopilot and release held e-mail?', buttons: [[{ label: '▶ Confirm resume', data: 'resume!' }]] };
      default: return { text: `Unknown command. ${HELP}` };
    }
  }
  function itemMessage(it) {
    const body = it.source === 'mail' ? clip((it.detail || []).join('\n'), 600) : clip((it.detail || []).join('\n'), 700);
    const remoteOk = canApproveRemotely(it); const btn = [];
    if (remoteOk) btn.push({ label: '✅ Approve', data: `a:${it.key}:y` }); btn.push({ label: '❌ Reject', data: `a:${it.key}:n` });
    return { text: `${ICON[it.risk]} ${it.risk.toUpperCase()} · ${clip(it.summary, 200)}${body ? '\n\n' + body : ''}${it.flags && it.flags.length ? `\n⚠ ${it.flags.join(', ')}` : ''}${remoteOk ? '' : '\n🖥 Desktop-only (high risk)'}`, buttons: [btn], key: it.key };
  }
  /** A button press. Returns a plain text answer. */
  async function press(data, actor) {
    let m;
    if (data === 'p') return { followup: await command('pending', '', actor) };
    if (data === 'ag') return { text: await agentsText() };
    if (data === 'stop') return { text: (await command('stop', '', actor)).text };
    if (data === 'resume!') { const r = await resume(actor); return { text: `▶ Resumed${r.plans_resumed ? `, ${r.plans_resumed} plan(s)` : ''}. Held e-mail is released.` }; }
    if (data === 'bulk') { const r = await approveAllSafe({ actor }); return { text: r.ok ? `✅ Approved ${r.approved} safe item(s).${r.errors.length ? ` ${r.errors.length} error(s).` : ''}` : `Not done: ${r.reason}` }; }
    if ((m = data.match(/^a:([smc]:[\w-]+):([yn])$/))) {
      const r = await act(m[1], m[2] === 'y', { actor });
      if (r.needs_confirm) return { text: `🔴 High risk: ${clip(r.summary, 160)}\nApprove anyway?`, buttons: [[{ label: '✅ Yes, approve', data: `a:${m[1]}:c` }, { label: 'Cancel', data: `a:${m[1]}:x` }]] };
      return { text: r.ok ? `${m[2] === 'y' ? '✅ Approved' : '❌ Rejected'}: ${clip(r.summary, 160)}` : `Not done: ${r.reason}` };
    }
    if ((m = data.match(/^a:([smc]:[\w-]+):c$/))) { const r = await act(m[1], true, { actor, confirm: true }); return { text: r.ok ? `✅ Approved: ${clip(r.summary, 160)}` : `Not done: ${r.reason}` }; }
    if (data.endsWith(':x')) return { text: 'Cancelled.' };
    return { text: 'Unknown action.' };
  }

  // ------------------------------------------------------------------ owners and pairing (the first message proves it is you)
  const owners = (channel) => S().owners.filter((o) => !channel || o.channel === channel);
  function startPairing(channel = 'any') {
    const st = S(); if (st.owners.length >= 3) throw new Error('three devices are already paired; unlink one first');
    st.pairing = { code: String(crypto.randomInt(100000, 1000000)), expires: ctx.now() + 10 * 60000, attempts: 0, channel }; save();
    ctx.trail.log('remote.pairing_started', { channel }, { actor: 'desktop' }); return { code: st.pairing.code, expires_in_minutes: 10 };
  }
  function tryPair(channel, code, who) {
    const st = S(); const p = st.pairing; if (!p || p.expires < ctx.now()) { st.pairing = null; save(); return false; }
    if (p.channel !== 'any' && p.channel !== channel) return false;
    if (++p.attempts > 5) { st.pairing = null; save(); ctx.trail.log('remote.pairing_locked', { channel }, { actor: channel }); return false; }
    const a = Buffer.from(String(code)), b = Buffer.from(p.code); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { save(); return false; }
    st.owners = st.owners.filter((o) => !(o.channel === channel && o.user_id === who.user_id)); st.owners.push({ channel, chat_id: String(who.chat_id || ''), user_id: String(who.user_id), name: clip(who.name || '', 60), paired_at: ctx.now() }); st.pairing = null; save();
    ctx.trail.log('remote.paired', { channel, name: who.name }, { actor: channel }); return true;
  }
  const isOwner = (channel, user_id, chat_id) => S().owners.some((o) => o.channel === channel && o.user_id === String(user_id) && (channel !== 'telegram' || o.chat_id === String(chat_id)));
  function unlink(channel, user_id) { const st = S(); const before = st.owners.length; st.owners = st.owners.filter((o) => !(channel ? o.channel === channel && (!user_id || o.user_id === user_id) : true)); save(); ctx.trail.log('remote.unlinked', { removed: before - st.owners.length }, { actor: 'desktop' }); return before - st.owners.length; }

  // ------------------------------------------------------------------ Telegram
  const tgToken = () => ctx.secrets._get('telegram_bot_token');
  async function tg(method, body, signal) {
    const res = await fetchFn()(`https://api.telegram.org/bot${tgToken()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: signal || AbortSignal.timeout(35000) });
    const j = await res.json().catch(() => ({})); if (!j.ok) throw new Error(`Telegram: ${j.description || res.status}`); return j.result;
  }
  const tgKeyboard = (buttons) => (buttons && buttons.length ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.label, callback_data: b.data }))) } } : {});
  async function tgSend(chat_id, text, buttons) { return tg('sendMessage', { chat_id, text: clip(text, 3900), disable_web_page_preview: true, ...tgKeyboard(buttons) }); }
  async function tgReply(chat_id, out) { if (out.text) await tgSend(chat_id, out.text, out.buttons); for (const it of out.items || []) await tgSend(chat_id, it.text, it.buttons); }
  async function handleTelegram(u) {
    const cb = u.callback_query; const m = u.message;
    if (cb) {
      const chat_id = cb.message && cb.message.chat && cb.message.chat.id; const from = cb.from || {};
      if (!isOwner('telegram', from.id, chat_id)) { ctx.trail.log('remote.denied', { channel: 'telegram', user: String(from.id), kind: 'button' }, { actor: 'telegram' }); await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {}); return; }
      await tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
      const r = await press(String(cb.data || ''), `telegram:${from.id}`); if (r.followup) return tgReply(chat_id, r.followup); return tgReply(chat_id, r);
    }
    if (!m || typeof m.text !== 'string') return;
    const chat = m.chat || {}; const from = m.from || {}; const text = m.text.trim();
    if (!isOwner('telegram', from.id, chat.id)) {
      const mm = text.match(/^\/pair(?:@\w+)?\s+(\d{6})$/);
      if (mm && chat.type === 'private') { const ok = tryPair('telegram', mm[1], { chat_id: chat.id, user_id: from.id, name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username }); if (ok) await tgSend(chat.id, `Paired. You are now the owner of this station.\n${HELP}`); else await tgSend(chat.id, 'That code did not work.'); return; }
      ctx.trail.log('remote.denied', { channel: 'telegram', user: String(from.id), chat_type: chat.type }, { actor: 'telegram' }); return; // strangers get nothing
    }
    const mm = text.match(/^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/); const out = mm ? await command(mm[1].toLowerCase(), mm[2] || '', `telegram:${from.id}`) : { text: `I only take commands.\n${HELP}` };
    return tgReply(chat.id, out);
  }
  const nap = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
  async function pollLoop() {
    while (polling) {
      try {
        const st = S(); pollAbort = new AbortController(); const t = setTimeout(() => pollAbort.abort(), 40000); if (t.unref) t.unref(); const t0 = Date.now();
        const ups = await tg('getUpdates', { offset: st.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, pollAbort.signal); clearTimeout(t);
        for (const u of ups) { st.offset = u.update_id + 1; save(); try { await handleTelegram(u); } catch (e) { ctx.trail.log('remote.error', { error: e.message }); } }
        if (!ups.length && Date.now() - t0 < 1000) await nap(1000 - (Date.now() - t0)); // a long poll blocks for 25s; if something answers instantly (a proxy, an outage), never spin
      } catch (e) { if (!polling) break; ctx.emit('remote.telegram_error', { error: e.message }); await nap(15000); }
    }
  }
  function startTelegram() { if (polling || !cfg().telegram.enabled || cfg().telegram.poll === false || !tgToken()) return false; polling = true; pollLoop().catch(() => { polling = false; }); return true; }
  function stopTelegram() { polling = false; try { pollAbort && pollAbort.abort(); } catch { /* idle */ } }

  // ------------------------------------------------------------------ Discord
  const dcWebhook = () => ctx.secrets._get('discord_webhook_url');
  async function dcPush(text) { const url = dcWebhook(); if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url || '')) return; await fetchFn()(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: clip(text, 1900), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15000) }); }
  /** Verify an interaction: Ed25519 over timestamp+body with the application's public key. Anything else is rejected before parsing. */
  function verifyDiscord(rawBody, sig, ts) {
    const key = ctx.secrets._get('discord_public_key'); if (!key || !/^[0-9a-f]{64}$/i.test(key) || !sig || !ts) return false;
    if (Math.abs(ctx.now() / 1000 - Number(ts)) > 300) return false;
    try { const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key, 'hex')]), format: 'der', type: 'spki' }); return crypto.verify(null, Buffer.from(String(ts) + rawBody), pub, Buffer.from(sig, 'hex')); } catch { return false; }
  }
  const dcComponents = (buttons) => (buttons && buttons.length ? buttons.slice(0, 5).map((row) => ({ type: 1, components: row.slice(0, 5).map((b) => ({ type: 2, style: /Reject|Stop|Cancel/.test(b.label) ? 4 : /Approve|Yes|resume/i.test(b.label) ? 3 : 2, label: clip(b.label.replace(/^[^\w]+/, ''), 78) || 'OK', custom_id: b.data })) })) : []);
  /** One interaction in, one interaction response out (type 1 ping, 2 slash command, 3 button). */
  async function handleDiscord(i) {
    if (i.type === 1) return { type: 1 };
    const user = (i.member && i.member.user) || i.user || {}; const reply = (out) => { const lines = [out.text, ...(out.items || []).map((x) => x.text)].filter(Boolean).join('\n\n'); const comps = dcComponents(out.buttons || (out.items && out.items[0] && out.items[0].buttons)); return { type: 4, data: { content: clip(lines, 1900), flags: 64, ...(comps.length ? { components: comps } : {}) } }; };
    if (i.type === 2) {
      const sub = i.data && i.data.options && i.data.options[0]; const name = sub ? sub.name : 'help';
      if (!isOwner('discord', user.id)) {
        if (name === 'pair') { const code = String((sub.options && sub.options[0] && sub.options[0].value) || ''); const ok = /^\d{6}$/.test(code) && tryPair('discord', code, { user_id: user.id, name: user.global_name || user.username }); return { type: 4, data: { content: ok ? 'Paired. You are now the owner of this station.' : 'That code did not work.', flags: 64 } }; }
        ctx.trail.log('remote.denied', { channel: 'discord', user: String(user.id) }, { actor: 'discord' }); return { type: 4, data: { content: 'Not paired.', flags: 64 } };
      }
      if (name === 'pending') { const items = (await pending()).slice(0, 4); if (!items.length) return reply({ text: 'Nothing waiting for you.' }); const first = itemMessage(items[0]); return reply({ text: `${items.length} shown. Oldest first:\n\n${first.text}`, buttons: first.buttons }); }
      return reply(await command(name, '', `discord:${user.id}`));
    }
    if (i.type === 3) {
      if (!isOwner('discord', user.id)) { ctx.trail.log('remote.denied', { channel: 'discord', user: String(user.id), kind: 'button' }, { actor: 'discord' }); return { type: 4, data: { content: 'Not paired.', flags: 64 } }; }
      const r = await press(String(i.data && i.data.custom_id), `discord:${user.id}`); return reply(r.followup || r);
    }
    return { type: 4, data: { content: 'Unsupported.', flags: 64 } };
  }
  /** One-time helper: register the /sovereign slash command with your Discord application (needs discord_bot_token + discord_app_id). */
  async function registerDiscordCommands() {
    const tok = ctx.secrets._get('discord_bot_token'), app = ctx.secrets._get('discord_app_id'); if (!tok || !app) throw new Error('set discord_bot_token and discord_app_id first');
    const sub = (name, description, options) => ({ type: 1, name, description, ...(options ? { options } : {}) });
    const body = [{ name: 'sovereign', description: 'Control your Sovereign station', options: [sub('status', 'Status'), sub('pending', 'Requests waiting for you'), sub('digest', 'Daily digest'), sub('agents', 'What every agent is doing'), sub('report', 'Report since yesterday'), sub('stop', 'Stop everything now'), sub('resume', 'Resume after a stop'), sub('pair', 'Pair this account as the owner', [{ type: 3, name: 'code', description: '6-digit code from the desktop', required: true }])] }];
    const res = await fetchFn()(`https://discord.com/api/v10/applications/${app}/commands`, { method: 'PUT', headers: { authorization: `Bot ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Discord: ${res.status}`); return { ok: true };
  }

  // ------------------------------------------------------------------ pushing to you
  const hour = () => new Date(ctx.now()).getHours();
  const quiet = () => { const q = cfg().quiet_hours; if (!q || q.start === q.end) return false; const h = hour(); return q.start < q.end ? h >= q.start && h < q.end : h >= q.start || h < q.end; };
  const breaker = () => { const st = S(); st.pushes = st.pushes.filter((t) => ctx.now() - t < 3600000); if (st.pushes.length >= cfg().max_pushes_per_hour) return true; st.pushes.push(ctx.now()); return false; };
  /** Deliver one message to every paired channel. Individual failures never break the caller. */
  async function push(text, buttons, { urgent = false } = {}) {
    if (quiet() && !urgent) return { held: true }; if (!urgent && breaker()) { ctx.trail.log('remote.throttled', {}); return { throttled: true }; }
    let n = 0;
    if (cfg().telegram.enabled && tgToken()) for (const o of owners('telegram')) { try { await tgSend(o.chat_id, text, buttons); n++; } catch (e) { ctx.emit('remote.telegram_error', { error: e.message }); } }
    if (cfg().discord.enabled && dcWebhook()) { try { await dcPush(text + (buttons ? '\nUse /sovereign pending to act.' : '')); n++; } catch { /* webhook down */ } }
    return { sent: n };
  }
  const ALERTS = [
    [/^autopilot\.paused$/, (d) => [`⏸ Autopilot paused: ${clip(d.reason, 200)}`, true]], [/^kill\.(rule|ceo)$/, (d) => [`💀 A business was shut down: ${clip(d.name || '', 60)}. ${clip(d.reason, 160)}`, true]],
    [/^guardrail\.ads_frozen$/, (d) => [`🧊 Ads frozen: LTV/CAC ${d.ltv_cac}. ${clip((d.reasons || [])[0] || '', 160)}`, true]], [/^deploy\.down$/, (d) => [`🔻 Site is down (${clip(d.url || '', 80)})`, true]],
    [/^webhook\.failed$/, (d) => [`⚠ Stripe webhook rejected: ${d.reason}`, true]], [/^tunnel\.down$/, () => ['📡 Tunnel dropped. It restarts on its own within 5 minutes.', false]],
    [/^payment\.failed$/, (d) => [`💳 Payment failed for ${d.customer || 'a customer'} (attempt ${d.attempt || 1}). Recovery e-mails are queued.`, false]], [/^customer\.cancel_pending$/, () => ['📉 A customer scheduled a cancellation. A save e-mail is queued for your approval.', false]],
    [/^customer\.churned$/, (d) => [`❌ Customer cancelled${d.reason ? ` (${clip(d.reason, 80)})` : ''}.`, false]], [/^mail\.failed$/, (d) => [`✉ E-mail failed: ${clip(d.error, 120)}`, false]],
    [/^subscription\.renewed$/, (d) => [`💰 Renewal: $${d.amount}`, false, 'info']], [/^payment\.recovered$/, () => ['✅ A failed payment was recovered.', false, 'info']], [/^retainer\.delivered$/, (d) => [`📦 Delivery sent${d.on_time === false ? ' (late)' : ' on time'}.`, false, 'info']], [/^customer\.added$/, () => ['🎉 New customer.', false, 'info']],
  ];
  ctx.on(/^(autopilot\.paused|kill\.(rule|ceo)|guardrail\.ads_frozen|deploy\.down|webhook\.failed|tunnel\.down|payment\.failed|customer\.cancel_pending|customer\.churned|mail\.failed|subscription\.renewed|payment\.recovered|retainer\.delivered|customer\.added)$/, (e) => {
    const a = ALERTS.find(([re]) => re.test(e.type)); if (!a) return; const [text, urgent, level] = a[1](e.data || {}); alerts.push({ text, urgent, level: level || 'alert', ts: ctx.now() }); if (alerts.length > 100) alerts.shift();
  });
  // the trail records these as they happen (the receipt); desktop approvals are included because permissions.resolve emits approval.*
  ctx.on(/^(approval\.(approved|rejected)|kill\.|guardrail\.|autopilot\.paused|retainer\.(produced|delivered)|payment\.(failed|recovered)|customer\.(churned|cancel_pending|added|reactivated)|subscription\.renewed|mail\.(sent|failed)|venture\.(created|launch|killed|traction|profitable|scaling|decline|pivot))$/, (e) => { try { ctx.trail.log(e.type, e.data || {}, { venture_id: e.venture_id }); } catch { /* the receipt must never break the business */ } });

  /** Called every ~20s by the host (and by the autopilot minute job). Throttled, re-entrant safe, never throws. */
  async function pump({ force = false } = {}) {
    const c = cfg(); if (pumping || (!force && ctx.now() - lastPump < 15000)) return { skipped: true }; pumping = true; lastPump = ctx.now(); const out = { approvals: 0, alerts: 0, drafts: 0, report: false };
    try {
      if (c.telegram.enabled && tgToken() && !polling) startTelegram(); if ((!c.telegram.enabled || !tgToken()) && polling) stopTelegram();
      if (!owners().length && !(c.discord.enabled && dcWebhook())) return out;
      const st = S(); const seen = new Set(st.notified);
      // 1. alerts (urgent ones go through the night; the rest wait for morning and are then summarised, not replayed)
      const q = quiet(); const keep = []; const fresh = alerts.splice(0);
      for (const a of fresh) { if (a.level === 'info' && !c.notify.info) continue; if (q && !a.urgent) { if (ctx.now() - a.ts < 12 * 3600000 && a.level !== 'info') keep.push(a); continue; } await push(a.text, null, { urgent: a.urgent }); out.alerts++; }
      alerts.push(...keep);
      // 2. new approvals (never mail drafts one by one: they arrive as one grouped message)
      if (c.notify.approvals && !q && !S().stopped) {
        const items = (await pending()).filter((i) => i.source !== 'mail' && !seen.has(i.key)); let sent = 0;
        for (const it of items) { if (sent >= 5) break; const m = itemMessage(it); const r = await push(m.text, m.buttons); if (r.sent || r.throttled) { seen.add(it.key); sent++; out.approvals++; } }
        if (items.length > sent) { await push(`…and ${items.length - sent} more waiting. Send /pending.`); for (const it of items.slice(sent)) seen.add(it.key); }
        const drafts = ctx.mail.list({ status: 'draft' }); const safe = drafts.filter((d) => !d.flags.length).length;
        if (drafts.length && (drafts.length > st.last_drafts_count) && ctx.now() - st.last_drafts_push > 30 * 60000) { await push(`✉ ${drafts.length} e-mail draft(s) waiting (${safe} safe to approve together).`, safe ? [[{ label: `✅ Approve all safe (${safe})`, data: 'bulk' }, { label: 'Review', data: 'p' }]] : [[{ label: 'Review', data: 'p' }]]); st.last_drafts_push = ctx.now(); out.drafts = drafts.length; }
        st.last_drafts_count = drafts.length;
      }
      st.notified = [...seen].slice(-500);
      // 3. the morning report, once per day
      const day = new Date(ctx.now()).toISOString().slice(0, 10);
      if (c.report_hour >= 0 && hour() >= c.report_hour && st.last_report_day !== day && !q) { st.last_report_day = day; await push(await report()); out.report = true; }
      save();
    } catch (e) { ctx.emit('remote.error', { error: e.message }); } finally { pumping = false; }
    return out;
  }

  // ------------------------------------------------------------------ the console (the "virtual platform")
  const consoleToken = () => ctx.secrets._get('remote_console_token');
  function enableConsole({ rotate = false } = {}) {
    if (rotate || !consoleToken()) ctx.secrets.set('remote_console_token', crypto.randomBytes(24).toString('hex'));
    ctx.setSettings({ remote: { console: { enabled: true } } }); ctx.trail.log(rotate ? 'remote.console_rotated' : 'remote.console_enabled', {}, { actor: 'desktop' }); return consoleInfo();
  }
  function disableConsole() { ctx.setSettings({ remote: { console: { enabled: false } } }); ctx.trail.log('remote.console_disabled', {}, { actor: 'desktop' }); return consoleInfo(); }
  const consoleInfo = () => { const t = consoleToken(); const base = ctx.publicUrl ? ctx.publicUrl() : ''; return { enabled: !!cfg().console.enabled && !!t, path: t ? `/remote/${t}/` : null, url: t && base ? `${base}/remote/${t}/` : null, pin_set: !!ctx.secrets._get('remote_pin') }; };
  const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  /** Authenticate a console request: secret path token, then the PIN if one is set (5 wrong PINs lock that client for 15 minutes). */
  function authConsole(token, pin, client = '?', tokenOnly = false) {
    if (!cfg().console.enabled || !consoleToken() || !safeEq(token, consoleToken())) return { ok: false, status: 404 };
    const p = ctx.secrets._get('remote_pin'); if (!p || tokenOnly) return { ok: true };
    const st = S(); const f = st.pin_fails[client] || { n: 0, until: 0 }; if (f.until > ctx.now()) return { ok: false, status: 429, reason: 'locked, try again later' };
    if (safeEq(pin, p)) { if (f.n) { delete st.pin_fails[client]; save(); } return { ok: true }; }
    f.n++; if (f.n >= 5) { f.until = ctx.now() + 15 * 60000; f.n = 0; ctx.trail.log('remote.pin_lockout', { client }, { actor: 'console' }); } st.pin_fails[client] = f; save(); return { ok: false, status: 401, reason: 'PIN required' };
  }
  async function consoleState() {
    const items = await pending(); const agents = await agentsList(); const ap = ctx.autopilot.status(); const v = ctx.ventures.list({ activeOnly: true })[0]; const gc = v ? ctx.ceo.cashflow(v.venture_id) : null; const rs = v && ctx.retainer.get(v.venture_id) ? ctx.retainer.stats(v.venture_id) : null;
    const feed = [...ctx.trail.tail(40).map((e) => ({ ts: e.ts, type: e.type, actor: e.actor, text: trailLine(e) })), ...(provider && provider.feed ? provider.feed() : [])].sort((a, b) => b.ts - a.ts).slice(0, 60);
    return { now: ctx.now(), stopped: S().stopped, autopilot: { paused: ap.paused, enabled: ap.enabled }, money: money(), guardrail: gc, deliveries: rs, mail: ctx.mail.status(),
      approvals: items.slice(0, 50).map((i) => ({ key: i.key, risk: i.risk, kind: i.kind, summary: i.summary, preview: clip((i.detail || []).join('\n'), 900), flags: i.flags || [], remote_ok: canApproveRemotely(i), age_min: Math.round((ctx.now() - (i.at || ctx.now())) / 60000) })),
      agents, feed, trail_ok: ctx.trail.verify().ok, allow_high_risk_remote: !!cfg().allow_high_risk_remote };
  }
  function trailLine(e) {
    const d = e.data || {}; switch (true) {
      case e.type === 'remote.approve': case e.type === 'remote.reject': return `${e.type === 'remote.approve' ? 'Approved' : 'Rejected'} from phone (${d.risk}): ${clip(d.summary || d.key, 120)}`;
      case e.type.startsWith('approval.'): return `${e.type.split('.')[1]}: ${clip(d.summary || '', 140)}`;
      case e.type === 'mail.sent': return `E-mail sent (${d.sequence || d.kind})`; case e.type === 'remote.stop': return `STOP: ${d.reason}`; case e.type === 'remote.blocked': return `Blocked remote approval (high risk): ${clip(d.summary || '', 100)}`;
      case e.type === 'subscription.renewed': return `Renewal $${d.amount}`; case e.type === 'customer.churned': return `Customer churned ${d.reason || ''}`; case e.type === 'retainer.delivered': return `Delivery sent${d.on_time === false ? ' (late)' : ''}`;
      default: return e.type + (d.reason ? `: ${clip(d.reason, 120)}` : d.name ? `: ${clip(d.name, 80)}` : '');
    }
  }
  async function consoleAct(body, actor = 'console') {
    const a = String(body.action || '');
    if (a === 'approve' || a === 'reject') return act(String(body.key || ''), a === 'approve', { actor, confirm: !!body.confirm });
    if (a === 'approve_safe') return approveAllSafe({ actor });
    if (a === 'stop') return stop(actor, 'stopped from the console'); if (a === 'resume') return resume(actor);
    return { ok: false, reason: 'unknown action' };
  }

  const status = () => ({ telegram: { enabled: !!cfg().telegram.enabled, token_set: !!tgToken(), polling, owners: owners('telegram').map((o) => ({ name: o.name, paired_at: o.paired_at })) },
    discord: { enabled: !!cfg().discord.enabled, webhook_set: !!dcWebhook(), public_key_set: !!ctx.secrets._get('discord_public_key'), owners: owners('discord').map((o) => ({ name: o.name, paired_at: o.paired_at })) },
    pairing: S().pairing && S().pairing.expires > ctx.now() ? { active: true, channel: S().pairing.channel, expires_in_min: Math.ceil((S().pairing.expires - ctx.now()) / 60000) } : { active: false },
    console: consoleInfo(), stopped: S().stopped, quiet_now: quiet(), allow_high_risk_remote: !!cfg().allow_high_risk_remote, trail: ctx.trail.verify() });
  async function test() { return push('✅ Sovereign test message. If you can read this, push alerts work.', [[{ label: 'Status', data: 'p' }]], { urgent: true }); }
  const close = () => stopTelegram();
  return { setProvider, setFetch, pending, act, approveAllSafe, stop, resume, command, press, report, statusText, agentsText, pump, push, test, close, startPairing, tryPair, unlink, isOwner, owners, handleTelegram, startTelegram, stopTelegram,
    handleDiscord, verifyDiscord, registerDiscordCommands, enableConsole, disableConsole, consoleInfo, authConsole, consoleState, consoleAct, status, riskOf, canApproveRemotely, alerts: () => alerts };
}
module.exports = { makeRemote, HIGH_RISK_RECS, MONEY_CONNECTORS };
