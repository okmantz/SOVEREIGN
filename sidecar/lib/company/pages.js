'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DAY, round } = require('./util');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CSS = 'body{font:17px/1.65 system-ui,-apple-system,Segoe UI,sans-serif;max-width:720px;margin:0 auto;padding:2rem 1.2rem;color:#16181a;background:#fff}h1{font-size:2rem;line-height:1.2}h2{margin-top:2rem}a{color:#0b5cad}.btn{display:inline-block;background:#0b5cad;color:#fff;padding:.8rem 1.4rem;border-radius:8px;text-decoration:none;font-weight:600}.mut{color:#5b6670;font-size:.9rem}nav a{margin-right:1rem}input{font:inherit;padding:.6rem;border:1px solid #c5ccd3;border-radius:6px;width:min(100%,320px)}button{font:inherit;padding:.6rem 1rem;border:0;border-radius:6px;background:#16181a;color:#fff;cursor:pointer}.ok{color:#137a3a}.warn{color:#a05a00}.bad{color:#b3261e}footer{margin-top:3rem;border-top:1px solid #e3e7ea;padding-top:1rem}';
const shell = (title, body, nav) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><nav>${nav}</nav>${body}</body></html>`;

/**
 * HOSTED PAGES: the pages a paying customer needs to trust the business. Generated as plain static files into the venture's
 * workspace, so the existing deploy pipeline publishes them anywhere (local preview, a ZIP for any free host, or Cloudflare Pages
 * through deploy.ship for a permanent home). Numbers on the status page come only from measured data.
 *
 * The refund policy and terms are TEMPLATES built from your settings, not legal advice: have them reviewed before you rely on them.
 */
function makePages(ctx) {
  const pg = () => ctx.settings().pages;
  const nameOf = (v) => pg().company_name || (v && v.name) || 'Our service';
  const base = () => pg().public_url || (ctx.publicUrl ? ctx.publicUrl() : '');

  /** The public status document. Aggregates only: no customer names, no e-mails. */
  function publicStatus(venture_id) {
    const v = ctx.ventures.get(venture_id); if (!v) return null;
    const rt = ctx.retainer && ctx.retainer.get(venture_id); const s = rt ? ctx.retainer.stats(venture_id) : null;
    const mon = ctx.deploy.monitors().find((m) => m.venture_id === venture_id);
    const incidents = ctx.db.get('events', []).filter((e) => e.venture_id === venture_id && e.type === 'deploy.down' && e.ts > ctx.now() - 30 * DAY).length;
    const late = rt ? ctx.retainer.cycles({ venture_id }).filter((c) => ['scheduled', 'producing', 'awaiting_approval'].includes(c.status) && c.due_at + ctx.settings().retainer.sla_hours * 3600000 < ctx.now()).length : 0;
    const state = (mon && mon.up === false) ? 'outage' : late > 0 ? 'delayed' : 'operational';
    return { name: nameOf(v), updated: ctx.now(), state, site: mon ? (mon.up ? 'up' : 'down') : 'not monitored', incidents_30d: incidents,
      deliveries: s ? { delivered_30d: s.delivered_30d, on_time_pct_30d: s.on_time_pct_30d, last_delivery_at: s.last_delivery_at, next_due_at: s.next_due_at, delayed_now: late } : null };
  }

  const nav = (extra = '') => `<a href="index.html">Home</a><a href="status.html">Status</a><a href="refund.html">Refunds</a><a href="terms.html">Terms</a>${extra}`;
  const footer = () => `<footer class="mut">${esc(nameOf())}${pg().postal_address ? ` · ${esc(pg().postal_address)}` : ''}${pg().support_email ? ` · <a href="mailto:${esc(pg().support_email)}">${esc(pg().support_email)}</a>` : ''}</footer>`;

  function indexPage(v) {
    const rt = ctx.retainer && ctx.retainer.get(v.venture_id); const p = pg(); const b = base();
    const cta = p.checkout_url ? `<p><a class="btn" href="${esc(p.checkout_url)}">${rt ? `Start for $${esc(rt.price)} per ${esc(rt.interval)}` : 'Get started'}</a></p>` : p.booking_url ? `<p><a class="btn" href="${esc(p.booking_url)}">Book a call</a></p>` : `<p class="warn">No checkout link is set yet (settings.pages.checkout_url).</p>`;
    const items = rt ? `<h2>What you get every ${esc(rt.interval)}</h2><ul>${rt.deliverables.map((d) => `<li><strong>${esc(d.title)}</strong></li>`).join('')}</ul>` : '';
    const form = b ? `<h2>Questions before you buy?</h2><form id="f"><input id="e" type="email" required placeholder="you@company.com"> <button>Send me details</button></form><p id="m" class="mut"></p>
<script>document.getElementById('f').onsubmit=async function(ev){ev.preventDefault();var m=document.getElementById('m');try{var r=await fetch(${JSON.stringify(`${b}/hooks/lead/${v.venture_id}/${v.lead_token}`)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:document.getElementById('e').value,source:'hosted_page'})});m.textContent=r.ok?'Thanks. I will reply personally.':'Something went wrong. Please email us instead.'}catch(x){m.textContent='Something went wrong. Please email us instead.'}}</script>` : '';
    return shell(nameOf(v), `<h1>${esc(rt ? rt.name : nameOf(v))}</h1><p>${esc(v.goal && !/\$/.test(v.goal) ? v.goal : (v.strategy && v.strategy.offer) || '')}</p>${items}${cta}<p class="mut">${p.refund_days > 0 ? `${esc(p.refund_days)}-day refund policy. ` : ''}Cancel any time; you keep access until the end of the paid period.</p>${form}${footer()}`, nav());
  }
  function statusPage(v, snapshot) {
    const b = base(); const api = b ? `${b}/hooks/status/${v.venture_id}` : '';
    return shell(`${nameOf(v)}: status`, `<h1>Status</h1><p id="s" class="mut">Loading…</p><div id="d"></div><p class="mut">Figures are measured from delivery records, not estimated. Updated <span id="u"></span>.</p>${footer()}
<script>var snap=${JSON.stringify(snapshot).replace(/</g, '\\u003c')};function show(j){var s=document.getElementById('s');s.className=j.state==='operational'?'ok':j.state==='delayed'?'warn':'bad';s.textContent=j.state==='operational'?'All systems operational':j.state==='delayed'?'Some deliveries are delayed':'Service disruption';var d=j.deliveries;document.getElementById('d').innerHTML='';function row(t){var p=document.createElement('p');p.textContent=t;document.getElementById('d').appendChild(p)}row('Website: '+j.site+'. Incidents in the last 30 days: '+j.incidents_30d+'.');if(d){row('Deliveries in the last 30 days: '+d.delivered_30d+(d.on_time_pct_30d===null?'':', '+d.on_time_pct_30d+'% on time')+'.');if(d.last_delivery_at)row('Last delivery: '+new Date(d.last_delivery_at).toDateString()+'.');if(d.delayed_now)row('Delayed right now: '+d.delayed_now+'.')}document.getElementById('u').textContent=new Date(j.updated).toLocaleString()}
${api ? `fetch(${JSON.stringify(api)}).then(function(r){return r.json()}).then(show).catch(function(){show(snap)});` : 'show(snap);'}</script>`, nav());
  }
  function refundPage(v) {
    const p = pg(); const d = Number(p.refund_days) || 0; const c = p.support_email ? `<a href="mailto:${esc(p.support_email)}">${esc(p.support_email)}</a>` : 'the contact address on this site';
    return shell(`${nameOf(v)}: refund policy`, `<h1>Refund policy</h1>${d > 0 ? `<p>If ${esc(nameOf(v))} is not useful to you, email ${c} within <strong>${esc(d)} days</strong> of your first payment and we will refund that payment in full. No forms and no argument.</p>` : '<p>Payments are not refundable once a delivery has been made. If a delivery does not arrive or is clearly wrong, contact us and we will put it right or refund that period.</p>'}<h2>Renewals</h2><p>Subscriptions renew automatically each period. You can cancel at any time; the cancellation takes effect at the end of the period you have paid for, and you will not be charged again. If you are charged after cancelling, we will refund that charge.</p><h2>Failed or missing deliveries</h2><p>If a delivery is late or does not arrive, tell us. We will deliver it, or refund that period.</p><h2>How to ask</h2><p>Email ${c}.</p><p class="mut">Template generated from your settings. It is not legal advice; have it reviewed for your jurisdiction.</p>${footer()}`, nav());
  }
  function termsPage(v) {
    const p = pg(); const rt = ctx.retainer && ctx.retainer.get(v.venture_id);
    return shell(`${nameOf(v)}: terms`, `<h1>Terms of service</h1><h2>The service</h2><p>${esc(nameOf(v))} provides ${rt ? esc(rt.name) + ` on a ${esc(rt.interval)}ly subscription, delivered by e-mail` : 'the service described on our website'}. Deliverables are prepared with the help of automated tools and reviewed by a person before they are sent.</p><h2>No guarantee of results</h2><p>We work to make each delivery useful, but we do not guarantee any particular business result.</p><h2>Payment and cancellation</h2><p>Payment is taken in advance for each period by our payment processor. Cancel any time; the cancellation applies from the end of the paid period. See the <a href="refund.html">refund policy</a>.</p><h2>Your information</h2><p>We use the information you send us only to provide the service and to contact you about it. We do not sell it. You can ask us to delete it at any time${p.support_email ? ` by writing to ${esc(p.support_email)}` : ''}. You can unsubscribe from non-essential e-mail with the link in any message.</p><h2>Liability</h2><p>To the extent the law allows, our liability is limited to the amount you paid for the period in question.</p><p class="mut">Template generated from your settings. It is not legal advice; have it reviewed for your jurisdiction.</p>${footer()}`, nav());
  }

  /** Write the whole hosted-page pack into the venture workspace (source/), ready for deploy.ship or a ZIP. */
  function build(venture_id) {
    const v = ctx.ventures.get(venture_id); if (!v) throw new Error('unknown venture');
    const snap = publicStatus(venture_id); const files = { 'index.html': indexPage(v), 'status.html': statusPage(v, snap), 'refund.html': refundPage(v), 'terms.html': termsPage(v), 'status.json': JSON.stringify(snap, null, 2) };
    for (const [name, body] of Object.entries(files)) ctx.sandbox.writeFile(venture_id, `source/${name}`, body);
    const warnings = []; const p = pg();
    if (!p.checkout_url && !p.booking_url) warnings.push('settings.pages.checkout_url is empty: the home page has no way to pay yet.');
    if (!p.support_email) warnings.push('settings.pages.support_email is empty: the refund policy has no contact address.');
    if (!p.postal_address) warnings.push('settings.pages.postal_address is empty: commercial e-mail law in many places expects one.');
    if (!base()) warnings.push('No public URL (tunnel or settings.pages.public_url): the lead form and live status are left out until there is one.');
    return { files: Object.keys(files), dir: 'source', warnings };
  }
  /** Keep the JSON snapshot current wherever it is already published locally (the live status also reads /hooks/status directly). */
  function refreshStatus(venture_id) {
    const snap = publicStatus(venture_id); if (!snap) return null; const body = JSON.stringify(snap, null, 2);
    try { ctx.sandbox.writeFile(venture_id, 'source/status.json', body); } catch { /* no workspace yet */ }
    const live = path.join(ctx.dataDir, 'sites', venture_id); if (fs.existsSync(live)) { try { fs.writeFileSync(path.join(live, 'status.json'), body); } catch { /* read-only */ } }
    return snap;
  }
  return { build, publicStatus, refreshStatus, indexPage, statusPage, refundPage, termsPage, round };
}
module.exports = { makePages };
