'use strict';
// The team's shared working memory. Every agent reads the same block before it works and leaves a short handoff after,
// so each output builds on real decisions instead of starting from scratch. It also carries the owner's hard constraints
// (capital, loss limit, rules) into every prompt, because a budget that only lives in the goal form is a budget nobody obeys.
const { money } = require('./util');
const { ROLES } = require('./roles');
const ledger = require('./ledger');
const strategy = require('./strategy');

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

function ensure(world) {
  if (!world.memory || typeof world.memory !== 'object') world.memory = {};
  const m = world.memory;
  m.brief = m.brief || ''; m.decisions = Array.isArray(m.decisions) ? m.decisions : []; m.ownerNotes = Array.isArray(m.ownerNotes) ? m.ownerNotes : [];
  m.lessons = Array.isArray(m.lessons) ? m.lessons : []; m.handoffs = Array.isArray(m.handoffs) ? m.handoffs : []; m.spendPlan = m.spendPlan || null; m.synced = Array.isArray(m.synced) ? m.synced : [];
  return m;
}

// Money the team may still commit: starting capital plus verified net profit, never below zero.
function available(world) {
  const m = world.mission; if (!m) return 0;
  return Math.max(0, (m.capitalCents || 0) + ledger.progress(world).netCents);
}
function stageBudget(world) {
  const st = strategy.current(world);
  return st ? strategy.stageBudgetCents(world, st) : available(world);
}

// The owner's inputs as rules. Injected into every agent prompt and every planning call.
function constraints(world) {
  const m = world.mission; if (!m) return '';
  const cap = m.capitalCents || 0, risk = m.riskCents || 0, avail = available(world), budget = stageBudget(world), st = strategy.current(world);
  const notes = [...(m.notes ? [m.notes] : []), ...ensure(world).ownerNotes.map((n) => n.text)].filter(Boolean);
  const lines = ['OWNER CONSTRAINTS. These come from the owner and override every idea, tool and tactic:',
    `- Goal: ${m.name}. Target: ${money(m.targetCents)} of VERIFIED profit${m.deadline ? `, by ${m.deadline}` : ''}.`,
    cap > 0 ? `- Starting capital: ${money(cap)} in total. At most ${money(avail)} is available right now. Budget for the current stage${st ? ` (${st.title})` : ''}: ${money(budget)}.`
      : '- Starting capital: $0. Every recommendation must cost $0: free tools, free tiers, direct outreach, the owner\'s own time.',
    risk > 0 ? `- Loss limit: ${money(risk)}. Nothing may be proposed that could lose more than this.` : '',
    ...notes.slice(-6).map((n) => `- Owner rule: ${clip(n, 200)}`),
    'FREE-FIRST: build and run everything for $0 wherever possible. Websites are static files on a free host (Cloudflare Pages, GitHub Pages or Netlify). Checkout is a hosted payment link or marketplace page (Stripe Payment Link, Gumroad, Etsy), which charges only when you make a sale. Sell digital or print-on-demand products so no inventory is bought. Verify current free-tier and fee terms before relying on them, and never state a price or limit you did not verify.',
    ...(Object.values(world.connectors || {}).some((c) => c.kind === 'comfyui' && c.status !== 'unconfigured') ? ['IMAGE GENERATION: ComfyUI is connected, free and local. When an image would help (product photos, ad creatives, hero and banner images, social visuals, logos as artwork), end your reply with a fenced block labelled images containing a JSON array like [{"name":"hero","prompt":"subject, setting, style, lighting, composition"}]. At most 4 per task. The images are rendered and saved for you; never put text, real people or brand logos in a prompt.'] : []),
    'Budget rules: (1) State the exact cost of anything that costs money. (2) Everything you recommend, added to what is already committed, must fit inside the stage budget. Never propose an item priced above it. (3) If the best option is unaffordable, give the best affordable or free alternative instead and say so. (4) Try free and direct methods first; spend only to speed up something already proven.'];
  return lines.filter(Boolean).join('\n');
}

// Peel HANDOFF / DECISION marker lines off an agent's reply. They sit at the top so a truncated answer still keeps them.
const MARK = /^[\s>*_#-]*\**\s*(HANDOFF|DECISION)\s*\**\s*:\s*\**\s*(.+?)\s*$/i;
function extract(text) {
  const lines = String(text || '').split('\n'), keep = []; let handoff = '', seen = 0; const decisions = [];
  for (const ln of lines) {
    const hit = seen < 8 && MARK.exec(ln);
    if (hit) { if (hit[1].toUpperCase() === 'HANDOFF') handoff = handoff || clip(hit[2], 300); else if (decisions.length < 3) decisions.push(clip(hit[2], 220)); continue; }
    if (ln.trim()) seen++;
    keep.push(ln);
  }
  let clean = keep.join('\n').replace(/^\s+/, '').trimEnd();
  if (!handoff) { // a model that put it at the end instead
    for (let i = keep.length - 1; i >= Math.max(0, keep.length - 6); i--) { const h = MARK.exec(keep[i]); if (h && h[1].toUpperCase() === 'HANDOFF') { handoff = clip(h[2], 300); keep.splice(i, 1); clean = keep.join('\n').replace(/^\s+/, '').trimEnd(); break; } }
  }
  return { clean, handoff, decisions };
}
const summarize = (text) => clip(String(text).replace(/\[[^\]]*offline demo model\]/i, '').replace(/[#*`>|_]+/g, ' '), 230);

function addDecision(world, text, by) {
  const m = ensure(world), t = clip(text, 220); if (t.length < 4) return;
  const key = t.toLowerCase().slice(0, 60);
  if (m.decisions.some((d) => d.text.toLowerCase().slice(0, 60) === key)) return;
  m.decisions.push({ text: t, by: by || 'Director', at: Date.now() });
  if (m.decisions.length > 14) m.decisions.splice(0, m.decisions.length - 14);
}
// A lesson is a short rule learned from a fix or a finished round. Every agent reads the latest ones.
function addLesson(world, text, by) {
  const m = ensure(world), t = clip(text, 200); if (t.length < 8) return;
  const key = t.toLowerCase().slice(0, 50); if (m.lessons.some((l) => l.text.toLowerCase().slice(0, 50) === key)) return;
  m.lessons.push({ text: t, by: by || 'Team', at: Date.now() }); if (m.lessons.length > 12) m.lessons.splice(0, m.lessons.length - 12);
}
function addOwnerNote(world, text) {
  const m = ensure(world), t = clip(text, 300); if (t.length < 3) return null;
  if (!m.ownerNotes.some((n) => n.text === t)) m.ownerNotes.push({ text: t, at: Date.now() });
  if (m.ownerNotes.length > 12) m.ownerNotes.splice(0, m.ownerNotes.length - 12);
  return t;
}

// File what an agent just produced. Returns the cleaned text (markers removed) and the stored entry.
function record(world, e) {
  const m = ensure(world), x = extract(e.text);
  const entry = { refId: e.refId || null, agent: clip(e.agentName, 24), role: e.role, title: clip(e.title, 90), text: x.handoff || summarize(x.clean || e.text), at: Date.now() };
  const i = entry.refId ? m.handoffs.findIndex((h) => h.refId === entry.refId) : -1;
  if (i >= 0) m.handoffs[i] = entry; else m.handoffs.push(entry);
  if (m.handoffs.length > 40) m.handoffs.splice(0, m.handoffs.length - 40);
  for (const d of x.decisions) addDecision(world, d, entry.agent);
  return { clean: x.clean, entry, decisions: x.decisions };
}

// A spend plan can never exceed the budget: items are kept in order until the money runs out.
function cleanSpendPlan(items, budgetCents) {
  if (!Array.isArray(items)) return null;
  const out = []; let total = 0;
  for (const it of items.slice(0, 12)) {
    const item = clip(it && (it.item || it.name), 70), cost = Math.round(Number(it && (it.costCents != null ? it.costCents : Number(it.cost) * 100)));
    if (item.length < 2 || !Number.isFinite(cost) || cost < 0 || total + cost > budgetCents) continue;
    out.push({ item, costCents: cost }); total += cost;
  }
  return { items: out, totalCents: total, budgetCents };
}
function setBrief(world, { brief, decisions, spend }) {
  const m = ensure(world);
  if (brief) m.brief = clip(brief, 600);
  for (const d of Array.isArray(decisions) ? decisions.slice(0, 5) : []) addDecision(world, d, 'Director');
  if (spend) { const plan = cleanSpendPlan(spend, stageBudget(world)); if (plan) m.spendPlan = plan; }
  m.updatedAt = Date.now();
}

// The block every agent sees. Sections have their own budgets so a long handoff cannot push out a decision.
function block(world, { local = false } = {}) {
  const m = ensure(world), scale = local ? 0.5 : 1, parts = [];
  if (m.brief) parts.push(`Director's brief: ${clip(m.brief, 500 * scale)}`);
  if (m.decisions.length) {
    let used = 0; const ds = [];
    for (const d of m.decisions.slice().reverse()) { if (used + d.text.length > 750 * scale) break; ds.unshift(`- ${d.text}`); used += d.text.length; }
    parts.push('Decisions already made (build on them, do not reopen them):\n' + ds.join('\n'));
  }
  if (m.lessons.length) { let used = 0; const ls = []; for (const l of m.lessons.slice().reverse()) { if (used + l.text.length > 620 * scale) break; ls.unshift(`- ${l.text}`); used += l.text.length; } parts.push('Lessons learned so far (apply them, do not repeat these mistakes):\n' + ls.join('\n')); }
  const sp = m.spendPlan;
  if (sp && sp.items.length) parts.push(`Approved spend plan (${money(sp.totalCents)} of ${money(sp.budgetCents)}): ` + sp.items.map((i) => `${i.item} ${money(i.costCents)}`).join('; ') + '. Stay inside it.');
  if (m.handoffs.length) {
    let used = 0; const hs = [];
    for (const h of m.handoffs.slice().reverse()) {
      const ln = `- ${h.agent} (${(ROLES[h.role] || {}).label || h.role}) · ${clip(h.title, 50)}: ${clip(h.text, 200)}`;
      if (used + ln.length > 1100 * scale) break; hs.unshift(ln); used += ln.length;
    }
    if (hs.length) parts.push('Latest from teammates:\n' + hs.join('\n'));
  }
  return parts.length ? 'TEAM MEMORY (shared by every agent; treat it as ground truth and stay consistent with it):\n' + parts.join('\n\n') : '';
}

const view = (world) => { const m = ensure(world); return { brief: m.brief, decisions: m.decisions.slice(-10), lessons: m.lessons.slice(-8), ownerNotes: m.ownerNotes, spendPlan: m.spendPlan, handoffs: m.handoffs.slice(-12).reverse(), budget: { availableCents: available(world), stageCents: stageBudget(world) } }; };

module.exports = { addLesson, ensure, constraints, block, extract, record, addDecision, addOwnerNote, setBrief, cleanSpendPlan, available, stageBudget, view };
