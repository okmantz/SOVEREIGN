'use strict';
// All values are inserted with textContent: agent/venture text is never trusted as HTML.
const $ = (id) => document.getElementById(id);
const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round((n || 0) * 100) / 100).toLocaleString()}`;
const api = async (p, opt) => { const r = await fetch(`/api/company${p}`, opt); return r.json(); };
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
function kpi(label, value, cls) { const d = el('div', undefined, 'kpi'); d.append(el('b', value, cls), el('span', label)); return d; }
function li(text, cls) { const l = el('li'); l.append(el('span', text, cls)); return l; }

async function load() {
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
