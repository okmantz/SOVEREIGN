'use strict';
/** The phone console. One self-contained page: every value is inserted with textContent (agent text is never trusted as HTML). */
module.exports = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#0e1113"><title>Sovereign</title>
<style>
:root{--bg:#0e1113;--card:#161b1f;--fg:#e8ecef;--mut:#8b979f;--ok:#4cc38a;--warn:#f2b84b;--bad:#ef6461;--acc:#6ea8fe;--line:#222a30}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:8px}
h1{font-size:16px;margin:0}main{max-width:720px;margin:0 auto;padding:12px;display:grid;gap:12px}.card{background:var(--card);border-radius:12px;padding:14px}
h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);margin:0 0 10px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}.kpi b{display:block;font-size:20px}.kpi span{color:var(--mut);font-size:12px}
button{font:inherit;border:0;border-radius:8px;padding:9px 14px;background:#232b31;color:var(--fg);cursor:pointer}button.ok{background:var(--ok);color:#06210f}button.no{background:#3a2323;color:#ffb3b1}button.stop{background:var(--bad);color:#fff;font-weight:700}button:disabled{opacity:.5}
.item{border-top:1px solid var(--line);padding:10px 0}.item:first-child{border:0}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}pre{white-space:pre-wrap;word-break:break-word;font:13px/1.45 ui-monospace,monospace;color:#c9d2d8;margin:6px 0 0;max-height:9em;overflow:auto}
.tag{font-size:11px;padding:2px 8px;border-radius:99px;background:#232b31;color:var(--mut)}.low{color:var(--ok)}.medium{color:var(--warn)}.high{color:var(--bad)}.mut{color:var(--mut)}.warn{color:var(--warn)}
.ag{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line)}.ag:first-child{border:0}.dot{width:10px;height:10px;border-radius:50%;margin-top:6px;background:#3a444b;flex:none}.dot.on{background:var(--ok);box-shadow:0 0 8px var(--ok)}
.pill{padding:4px 10px;border-radius:99px;font-size:12px;font-weight:700}.pill.run{background:#123522;color:var(--ok)}.pill.hold{background:#3a2323;color:var(--bad)}
#pin{position:fixed;inset:0;background:#000d;display:none;place-items:center;z-index:9}#pin div{background:var(--card);padding:20px;border-radius:12px;width:min(90vw,320px)}#pin input{width:100%;font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);margin:10px 0}
</style></head><body>
<header><h1>SOVEREIGN <span id="st" class="pill run">…</span></h1><div><button id="go" class="ok" style="display:none">Resume</button><button id="halt" class="stop">STOP</button></div></header>
<main>
<section class="card"><h2>Needs you <span id="ac" class="tag"></span></h2><div id="bulk"></div><div id="ap"></div></section>
<section class="card"><h2>Agents — live</h2><div id="ag"></div></section>
<section class="card"><h2>Money &amp; delivery</h2><div class="grid" id="mo"></div><p id="gd" class="mut"></p></section>
<section class="card"><h2>Decision trail <span id="tv" class="tag"></span></h2><div id="fd"></div></section>
</main>
<div id="pin"><div><b>PIN</b><input id="pi" type="password" inputmode="numeric" autocomplete="current-password"><button class="ok" id="pk">Unlock</button> <span id="pe" class="high"></span></div></div>
<script>
(function(){
var $=function(i){return document.getElementById(i)};var PIN=sessionStorage.getItem('pin')||'';
function el(t,x,c){var e=document.createElement(t);if(x!==undefined)e.textContent=x;if(c)e.className=c;return e}
function money(n){return (n<0?'-':'')+'$'+Math.abs(Math.round((n||0)*100)/100).toLocaleString()}
function ago(ms){var m=Math.max(0,Math.round(ms/60000));return m<60?m+'m':m<1440?Math.round(m/60)+'h':Math.round(m/1440)+'d'}
async function call(path,body){var r=await fetch(path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-pin':PIN},body:body?JSON.stringify(body):undefined,cache:'no-store'});
 if(r.status===401||r.status===429){$('pin').style.display='grid';$('pe').textContent=r.status===429?'Too many tries. Wait 15 minutes.':(PIN?'Wrong PIN':'');throw new Error('pin')}
 $('pin').style.display='none';return r.json()}
$('pk').onclick=function(){PIN=$('pi').value;sessionStorage.setItem('pin',PIN);load()};
async function act(b){try{var r=await call('api/act',b);if(r.needs_confirm){if(confirm('HIGH RISK\\n'+r.summary+'\\nApprove anyway?'))return act(Object.assign({},b,{confirm:true}));return}
 if(!r.ok)alert(r.reason||'Not done');load()}catch(e){}}
$('halt').onclick=function(){if(confirm('Stop autopilot, hold all e-mail and pause plans?'))act({action:'stop'})};
$('go').onclick=function(){if(confirm('Resume autopilot and release held e-mail?'))act({action:'resume'})};
async function load(){
 try{var s=await call('api/state')}catch(e){return}
 var held=!!s.stopped||!!s.autopilot.paused;$('st').textContent=s.stopped?'STOPPED':s.autopilot.paused?'PAUSED':s.autopilot.enabled?'RUNNING':'MANUAL';$('st').className='pill '+(held?'hold':'run');$('go').style.display=held?'':'none';$('halt').style.display=held?'none':'';
 var ap=$('ap');ap.replaceChildren();var bulk=$('bulk');bulk.replaceChildren();var safe=s.approvals.filter(function(a){return a.risk==='low'}).length;$('ac').textContent=s.approvals.length?s.approvals.length+' waiting':'nothing waiting';
 if(safe>1){var b=el('button','Approve all safe ('+safe+')','ok');b.onclick=function(){act({action:'approve_safe'})};bulk.append(b)}
 s.approvals.forEach(function(a){var d=el('div',undefined,'item');d.append(el('span',a.risk.toUpperCase(),'tag '+a.risk),' ',el('span',a.kind,'tag'),' ',el('span',ago(a.age_min*60000)+' ago','mut'));d.append(el('div',a.summary));if(a.preview)d.append(el('pre',a.preview));
  if(a.flags.length)d.append(el('div','⚠ '+a.flags.join(', '),'warn'));var r=el('div',undefined,'row');
  if(a.remote_ok){var y=el('button','Approve','ok');y.onclick=function(){act({action:'approve',key:a.key})};r.append(y)}else r.append(el('span','Desktop only (high risk)','mut'));
  var n=el('button','Reject','no');n.onclick=function(){act({action:'reject',key:a.key})};r.append(n);d.append(r);ap.append(d)});
 var ag=$('ag');ag.replaceChildren();if(!s.agents.length)ag.append(el('div','No agents yet.','mut'));
 s.agents.forEach(function(a){var r=el('div',undefined,'ag');r.append(el('span',undefined,'dot'+(a.working?' on':'')));var t=el('div');t.append(el('b',a.name),' ',el('span',a.role||'','tag'));
  t.append(el('div',a.working?a.title+' · '+ago(s.now-a.since):'idle','mut'));if(a.last){t.append(el('div','Last: '+a.last.title+' · '+ago(s.now-a.last.at)+' ago'+(a.last.passed===false?' · ⚠ failed checks':a.last.passed===true?' · ✓ checks passed':''),'mut'));if(a.last.preview)t.append(el('pre',a.last.preview))}r.append(t);ag.append(r)});
 var mo=$('mo');mo.replaceChildren();function k(l,v,c){var d=el('div',undefined,'kpi');d.append(el('b',v,c),el('span',l));mo.append(d)}
 k('MRR',money(s.money.mrr));k('Subscribers',String(s.money.subscribers));k('At risk',String(s.money.at_risk),s.money.at_risk?'warn':'');k('30d revenue',money(s.money.revenue_30d));k('30d costs',money(s.money.costs_30d));k('30d profit',money(s.money.profit_30d),s.money.profit_30d<0?'high':'');
 k('Mail today',s.mail.sent_today+'/'+s.mail.daily_limit);if(s.deliveries&&s.deliveries.on_time_pct_30d!==null)k('On time',s.deliveries.on_time_pct_30d+'%');
 $('gd').textContent=s.guardrail?(s.guardrail.ads_frozen?'ADS FROZEN. ':'')+(s.guardrail.reasons[0]||'Guardrail ok.'):'';
 $('tv').textContent=s.trail_ok?'✓ intact':'⚠ CHAIN BROKEN';var fd=$('fd');fd.replaceChildren();
 s.feed.forEach(function(f){var d=el('div',undefined,'item');d.append(el('span',ago(s.now-f.ts)+' ago','mut'),' ',el('span',f.actor||'','tag'),el('div',f.text));fd.append(d)})}
load();setInterval(load,5000);
})();
</script></body></html>`;
