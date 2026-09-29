'use strict';
// All values are inserted with textContent: agent/venture text is never trusted as HTML.
const $ = (id) => document.getElementById(id);
const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round((n || 0) * 100) / 100).toLocaleString()}`;
const api = async (p, opt) => { const r = await fetch(`/api/company${p}`, opt); return r.json(); };
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
function kpi(label, value, cls) { const d = el('div', undefined, 'kpi'); d.append(el('b', value, cls), el('span', label)); return d; }
function li(text, cls) { const l = el('li'); l.append(el('span', text, cls)); return l; }

async function post(p, body) { const r = await fetch(`/api/company${p}`, { method: 'POST', body: JSON.stringify(body || {}) }); return r.json(); }
async function loadDigest() {
  const [dg, tn, cust, ven] = await Promise.all([api('/digest'), api('/tunnel'), api('/customers'), api('/ventures')]);
  const c = dg.counts; $('dcount').textContent = c.total ? `${c.total} item(s) · about ${dg.est_minutes} min` : 'nothing waiting';
  $('dwarn').textContent = (dg.warnings || []).join(' ');
  const btn = $('dbtn'); btn.replaceChildren();
  if (c.safe_to_bulk_approve) { const b = el('button', `Approve all safe (${c.safe_to_bulk_approve})`, 'ok'); b.onclick = async () => { b.disabled = true; await post('/digest/approve', { all_safe: true }); load(); }; btn.append(b); }
  if (c.needs_reading) btn.append(' ', el('span', `${c.needs_reading} need reading`, 'tag'));
  const ul = $('digest'); ul.replaceChildren();
  for (const i of dg.items.slice(0, 40)) {
    const l = el('li'); const left = el('span'); left.append(el('b', `${i.priority === 'fast' ? '⚡ ' : ''}${i.kind}`), ' ', el('span', i.to ? `→ ${i.to}` : '', 'tag'), el('div', i.subject), el('div', i.preview, 'tag'));
    if (i.flags && i.flags.length) left.append(el('div', `⚠ ${i.flags.join(', ')}`, 'warn'));
    const box = el('span'); const yes = el('button', 'Approve', 'ok'), no = el('button', 'Reject', 'no');
    const ids = i.type === 'mail' ? { mail_ids: [i.id] } : { approval_ids: [i.id] };
    yes.onclick = async () => { await post('/digest/approve', ids); load(); }; no.onclick = async () => { await post('/digest/reject', ids); load(); };
    box.append(yes, ' ', no); l.append(left, box); ul.append(l);
  }
  const live = cust.filter((x) => !x.churned); const mrr = live.reduce((a, x) => a + (x.mrr || 0), 0); const risk = live.filter((x) => x.failed_payment || x.cancel_pending).length;
  const rec = $('rec'); rec.replaceChildren(); rec.append(kpi('MRR', money(mrr)), kpi('Subscribers', String(live.length)), kpi('At risk', String(risk), risk ? 'warn' : ''), kpi('Mail sent today', `${dg.mail.sent_today}/${dg.mail.daily_limit}`), kpi('Churned', String(cust.length - live.length)));
  const g = ven.length ? await api(`/cashflow/${ven[0].venture_id}`) : null; if (g && g.reasons && g.reasons.length) $('rec').append(kpi('Guardrail', g.ads_frozen ? 'ADS FROZEN' : g.scale_ok ? 'ok' : 'hold', g.ads_frozen ? 'neg' : 'warn'));
  $('tun').textContent = tn.running ? `Public URL: ${tn.url}` : `No tunnel running. Stripe events: ${tn.poller}`;
}

async function loadRemote() {
  const r = await api('/remote'); const st = $('rst'); st.replaceChildren();
  st.append(kpi('Telegram', r.telegram.owners.length ? `paired (${r.telegram.owners[0].name || 'you'})` : r.telegram.token_set ? 'not paired' : 'no bot token'), kpi('Discord', r.discord.owners.length ? 'paired' : r.discord.webhook_set ? 'webhook only' : 'off'),
    kpi('Console', r.console.enabled ? 'on' : 'off'), kpi('Trail', r.trail.ok ? `intact (${r.trail.entries})` : 'BROKEN', r.trail.ok ? '' : 'neg'), kpi('Remote hold', r.stopped ? 'ON' : 'off', r.stopped ? 'neg' : ''));
  $('rtag').textContent = r.pairing.active ? `pairing open ${r.pairing.expires_in_min} min` : '';
}
const say = (t) => { $('rmsg').textContent = t; };
$('rpair').onclick = async () => { const r = await post('/remote/pair', { channel: 'telegram' }); say(r.code ? `Send this to your bot in a private chat within ${r.expires_in_minutes} minutes: /pair ${r.code}` : (r.error || 'failed')); loadRemote(); };
$('rpairD').onclick = async () => { const r = await post('/remote/pair', { channel: 'discord' }); say(r.code ? `In Discord run: /sovereign pair code:${r.code}  (within ${r.expires_in_minutes} minutes)` : (r.error || 'failed')); loadRemote(); };
$('rcons').onclick = async () => { const r = await post('/remote/console', {}); say(r.url ? `Open on your phone: ${r.url}` : r.path ? `Console path (start the tunnel to get a public address): ${r.path}` : (r.error || 'failed')); loadRemote(); };
$('rtest').onclick = async () => { const r = await post('/remote/test', {}); say(r.sent ? 'Test sent.' : (r.error || 'Nothing sent: is a device paired and the channel enabled?')); };
$('rstop').onclick = async () => { if (confirm('Stop autopilot, hold all e-mail and pause plans?')) { await post('/remote/stop', {}); say('Stopped.'); load(); } };
$('rgo').onclick = async () => { await post('/remote/resume', {}); say('Resumed.'); load(); };

async function load() {
  loadDigest().catch(() => {}); loadRemote().catch(() => {});
  const [b, d, vs] = await Promise.all([api('/briefing'), api('/dashboard'), api('/ventures')]);
  const done = $('done'); done.replaceChildren();
  const x = b.done;
  [[`Found ${x.opportunities_found} opportunities`, x.opportunities_found], [`Started ${x.tested} validation tests`, x.tested], [`Launched ${x.launched}`, x.launched],
    [`Acquired ${x.leads} leads`, x.leads], [`${x.sales} sales`, x.sales]].forEach(([t, n]) => n && done.append(li(`✓ ${t}`)));
  done.append(li(`${money(x.revenue)} revenue · ${money(x.expenses)} expenses · ${money(x.profit)} profit`, x.profit >= 0 ? 'pos' : 'neg'));

  const appr = $('appr'); appr.replaceChildren();
  if (!b.pending_approvals.length) appr.append(li('Nothing waiting on you.'));
  for (const a of b.pending_approvals) {
    const l = el('li'); l.append(el('span', a.summary));
    const box = el('span');
    const yes = el('button', 'Approve', 'ok'); const no = el('button', 'Reject', 'no');
    yes.onclick = async () => { await api(`/approvals/${a.id}/approve`, { method: 'POST', body: '{}' }); load(); };
    no.onclick = async () => { await api(`/approvals/${a.id}/reject`, { method: 'POST', body: '{}' }); load(); };
    box.append(yes, ' ', no); l.append(box); appr.append(l);
  }
  const at = $('attn'); at.replaceChildren();
  if (!b.attention.length) at.append(li('All clear.'));
  for (const a of b.attention) at.append(li(`⚠ ${a.type}${a.detail ? ` — ${typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail)}` : ''}`, 'warn'));

  const pf = $('pf'); pf.replaceChildren(); const p = d.portfolio;
  pf.append(kpi('Capital', money(p.capital)), kpi('Revenue', money(p.revenue)), kpi('Expenses', money(p.expenses)), kpi('Profit', money(p.profit), p.profit >= 0 ? 'pos' : 'neg'), kpi('Cash', money(p.cash)));
  const body = $('vs'); body.replaceChildren();
  for (const v of vs) { const tr = el('tr'); [v.name, v.status, money(v.profit), String(v.customers), v.next_action ? `${v.next_action.role}: ${v.next_action.task}` : '—'].forEach((t, i) => { const td = el('td', t); if (i === 2) td.className = v.profit >= 0 ? 'pos' : 'neg'; tr.append(td); }); body.append(tr); }
  const sys = $('sys'); sys.replaceChildren(); const s = d.system;
  sys.append(kpi('Leads', String(d.pipeline.leads)), kpi('Qualified', String(d.pipeline.qualified)), kpi('Customers', String(d.pipeline.customers)),
    kpi('Agents', String(s.agents)), kpi('Tasks', String(s.tasks)), kpi('Failed', String(s.failed), s.failed ? 'warn' : ''), kpi('AI cost', money(s.ai_cost)));
  if (s.autopilot_paused) at.append(li(`Autopilot paused: ${s.autopilot_paused}`, 'neg'));
}
$('refresh').onclick = load; $('tick').onclick = async () => { await api('/ceo/tick', { method: 'POST', body: '{}' }); load(); };
load(); setInterval(load, 30000);
