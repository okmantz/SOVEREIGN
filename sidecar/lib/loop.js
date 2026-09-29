'use strict';
// The Autonomous Task Loop.  Goal → Plan → Execute → Evaluate → Learn → Repeat.
//
// Agents do not just answer and stop. Every task an agent does goes round this loop, and the whole team goes round it at the level of a
// round of work, until the goal is reached or a defined stopping condition fires.
//
//   Plan      the Director turns the goal into milestones and tasks (planner.js) and briefs the team (journey.directorSync)
//   Execute   agents do the tasks, in parallel where they can (journey.js, runner.assign)
//   Evaluate  every result is checked before it is accepted: instant code checks (budget, required files, thin answers) and,
//             for work that matters, a model judge that reads it against the task's "done when" and the owner's constraints
//   Learn     what needed fixing becomes a lesson in the shared team memory, so the next task and the next round start smarter
//   Repeat    a result that fails is revised (a few times at most); a round that ends short of the goal starts the next round
//
// Stopping conditions (the only ways it stops):
//   goal reached · loss limit hit (the venture is killed) · daily model budget (pauses, resumes on its own) · model unreachable
//   (pauses, resumes) · you pause it · two rounds with nothing finished (needs you) · the optional round cap · max revisions per task
const memory = require('./memory');
const providers = require('./providers');
const guardrails = require('./guardrails');
const activity = require('./activity');
const ledger = require('./ledger');
const sites = require('./sites');
const { money, parseJsonLoose } = require('./util');

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const DEFAULTS = { evaluate: 'smart', maxRevisions: 1, maxRounds: 0 };
// Work where a weak result costs money or reputation gets the model judge in 'smart' mode. Research and ops drafts get the free code checks only.
const JUDGED = new Set(['copywriter', 'builder', 'developer', 'ecommerce_manager', 'email_marketer', 'ad_manager', 'finance', 'sales_closer', 'designer']);

function config(state) {
  const l = (state.settings && state.settings.loop) || {};
  return { evaluate: ['off', 'smart', 'always'].includes(l.evaluate) ? l.evaluate : DEFAULTS.evaluate, maxRevisions: Math.max(0, Math.min(3, Number.isFinite(Number(l.maxRevisions)) ? Math.round(Number(l.maxRevisions)) : DEFAULTS.maxRevisions)), maxRounds: Math.max(0, Math.min(500, Math.round(Number(l.maxRounds)) || 0)) };
}
function stats(state) { const s = state.loopStats = state.loopStats || {}; for (const k of ['evaluated', 'passedFirst', 'revised', 'accepted', 'gaveUp', 'checks']) s[k] = s[k] || 0; return s; }
const isOffline = (store) => providers.isOffline(store);

// ---- Evaluate, part 1: instant checks that cost nothing

// Every dollar amount on a line that talks about spending. Revenue, price and goal lines are ignored: they are not costs.
const COST = /\b(cost|costs|spend|spending|budget|invest|investment|fee|fees|subscription|per month|a month|monthly|\/mo|ad spend|pay|paying|buy|buying|purchase|license|licence|hosting|domain|tool|plan costs)\b/i;
const NOT_COST = /\b(goal|target|revenue|profit|earn|earning|income|sales|sell|selling|sold|priced? at|charge|charging|mrr|arr|payout|commission)\b/i;
function amounts(line) {
  const out = []; const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(k\b)?/gi; let m;
  while ((m = re.exec(line))) { let cents = Math.round(parseFloat(m[1].replace(/,/g, '') + (m[2] ? '.' + m[2] : '')) * 100); if (m[3]) cents *= 1000; out.push(cents); }
  return out;
}
// Anything the plan says will cost more than the money the owner allowed.
function budgetGaps(state, text) {
  const m = state.mission; if (!m) return [];
  const limit = memory.stageBudget(state), gaps = [];
  for (const raw of String(text).split(/\n|(?<=[.!?])\s+/)) {
    const line = raw.trim(); if (!line || !COST.test(line) || (NOT_COST.test(line) && !/\b(cost|spend|budget|fee)\b/i.test(line))) continue;
    const over = amounts(line).find((c) => c > limit);
    if (over != null) { gaps.push(`This line needs ${money(over)} but the budget for this stage is ${money(limit)}: "${clip(line, 110)}". Replace it with a free or cheaper option and say what it costs.`); if (gaps.length >= 3) break; }
  }
  return gaps;
}
// Tasks that must hand back real files, not a description of them.
const NEEDS_FILES = { store_site: ['index.html'], landing_page_build: ['index.html'], import_products: ['products.json'] };
function fileGaps(taskId, text) {
  const need = NEEDS_FILES[taskId]; if (!need) return [];
  const got = sites.extract(text), names = got.map((f) => f.name), gaps = [];
  for (const n of need) if (!names.includes(n)) gaps.push(`Return ${n} as a file: a line "FILE: ${n}" followed by a fenced code block with the full contents.`);
  const pj = got.find((f) => f.name === 'products.json');
  if (pj) { try { const j = JSON.parse(pj.content), list = Array.isArray(j) ? j : j.products; if (!Array.isArray(list) || !list.length) gaps.push('products.json must contain a non-empty "products" array.'); } catch (_) { gaps.push('products.json is not valid JSON.'); } }
  return gaps;
}
function checkCode(state, { taskId, text }) {
  const body = String(text || '').replace(/^\s*(HANDOFF|DECISION)\s*:.*$/gim, '').trim(), gaps = [];
  if (/^(i (can(no|')t|could not|am unable)|sorry|as an ai)\b/i.test(body)) gaps.push('Do not decline. Give the best result you can with what you have, and say what is missing.');
  else if (body.length < 60) gaps.push('The result is too thin to use. Give the actual deliverable, with specifics.');
  gaps.push(...budgetGaps(state, body), ...fileGaps(taskId, text));
  return gaps;
}

// ---- Evaluate, part 2: a model judge for work that matters
function evaluatorFor(state, agent) {
  const seated = (r) => Object.values(state.agents).find((a) => a.role === r && a.deskId && state.desks[a.deskId] && a.id !== agent.id);
  return seated('critic') || Object.values(state.agents).find((a) => a.role === 'director') || agent;
}
async function judge(store, { agent, spec, label, text }) {
  const w = store.state, ev = evaluatorFor(w, agent); guardrails.assertBudget(w, ev.id);
  const system = 'You are the quality evaluator for an autonomous team. Reply with JSON only: {"verdict":"pass"|"revise","score":0-10,"gaps":["one specific fix",...],"lesson":"one short rule that would prevent this next time, or empty"}. ' +
    'Pass unless there is a real problem: it ignores the owner\'s constraints or budget, is vague or generic, invents facts, customers or results, lacks the concrete deliverable, or misses something the task required. Never ask for more length for its own sake. At most 3 gaps, each an instruction the author can act on.';
  const user = JSON.stringify({ task: label, doneWhen: (spec && spec.deliver) || [], qualityBar: (spec && spec.quality) || [], ownerConstraints: memory.constraints(w).slice(0, 1400), deliverable: String(text).slice(0, 3500) });
  const res = await activity.track(store, ev.id, `Checking: ${label}`, () => providers.complete(store, { agent: ev, purpose: 'planner', json: true, maxTokens: 320, system, messages: [{ role: 'user', content: user }] }));
  guardrails.recordSpend(store, { agentId: ev.id, cents: res.costCents, tokensIn: res.tokensIn, tokensOut: res.tokensOut, model: res.model });
  const j = parseJsonLoose(res.text); if (!j) return null;
  const score = Number(j.score), gaps = (Array.isArray(j.gaps) ? j.gaps : []).map((g) => clip(g, 220)).filter(Boolean).slice(0, 3);
  const revise = String(j.verdict).toLowerCase() === 'revise' && gaps.length && !(Number.isFinite(score) && score >= 8); // a high score with nitpicks is a pass
  return { pass: !revise, gaps: revise ? gaps : [], score: Number.isFinite(score) ? score : null, lesson: clip(j.lesson, 200) };
}

// Should this result be judged by the model?
function wantsJudge(store, agent, { light }) {
  const mode = config(store.state).evaluate;
  return !light && !isOffline(store) && (mode === 'always' || (mode === 'smart' && JUDGED.has(agent.role)));
}

// Evaluate one result. Returns { pass, gaps, by, lesson }. Never throws: a broken evaluator must not block real work.
async function evaluate(store, { agent, spec, taskId, label, text, light = false }) {
  const w = store.state, s = stats(w); s.evaluated++;
  if (isOffline(store)) return { pass: true, gaps: [], by: 'skip' }; // the offline demo model's canned text is not worth judging
  const code = checkCode(w, { taskId, text }); s.checks++;
  if (code.length) return { pass: false, gaps: code, by: 'checks', lesson: code[0] };
  if (wantsJudge(store, agent, { light })) {
    try { const j = await judge(store, { agent, spec, label, text }); if (j) return { ...j, by: 'judge' }; } catch (e) { if (e.status === 402) throw e; /* a failing judge means "accept", not "stop" */ }
  }
  return { pass: true, gaps: [], by: 'checks' };
}

const revisionPrompt = (original, previous, gaps) => `${original}\n\nYOUR PREVIOUS ANSWER (needs fixing):\n${String(previous).slice(0, 2500)}\n\nFIX THESE, then give the complete corrected deliverable (start with the HANDOFF line as before):\n${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}`;

// ---- Learn
function learn(state, { agent, label, rounds, accepted }) {
  const s = stats(state), fixed = rounds.filter((r) => !r.pass);
  if (!fixed.length) { s.passedFirst++; return; }
  s.revised += fixed.length; if (accepted) s.accepted++; else s.gaveUp++;
  const first = fixed[0], lesson = first.lesson || first.gaps[0];
  if (lesson) memory.addLesson(state, clip(lesson, 200), agent.name);
}
// End of a round: the Director looks back and writes down what to do differently. A connected model does it; otherwise a plain rule from the numbers.
async function reflect(store, { decision, round }) {
  const w = store.state, p = ledger.progress(w), plain = p.netCents > 0
    ? `Verified profit is ${money(p.netCents)} of ${money(p.targetCents)}. Repeat what earned it and cut what did not.`
    : 'No verified profit yet. Put the next round on getting one real paying customer with the cheapest direct method, not on more drafts.';
  let lessons = [];
  if (!isOffline(store)) {
    try {
      const dir = Object.values(w.agents).find((a) => a.role === 'director'); guardrails.assertBudget(w, dir.id);
      const m = memory.ensure(w), res = await Promise.race([activity.track(store, dir.id, 'Learning from the round', () => providers.complete(store, { agent: dir, purpose: 'planner', json: true, maxTokens: 350,
        system: ['You are the Director reviewing a finished round of work. Reply with JSON only: {"lessons":["..."]}. Up to 3 short, concrete rules for the next round: what worked, what wasted effort, what to try. Base them only on the handoffs and numbers given.', memory.constraints(w)].join('\n\n'),
        messages: [{ role: 'user', content: JSON.stringify({ round, decision: decision && decision.action, verifiedNetUSD: p.netCents / 100, targetUSD: p.targetCents / 100, handoffs: m.handoffs.slice(-10).map((h) => `${h.agent}: ${h.title}: ${h.text}`), lessonsSoFar: (m.lessons || []).map((l) => l.text) }) }] })), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 25000))]);
      guardrails.recordSpend(store, { agentId: dir.id, cents: res.costCents, tokensIn: res.tokensIn, tokensOut: res.tokensOut, model: res.model });
      const j = parseJsonLoose(res.text); lessons = (j && Array.isArray(j.lessons) ? j.lessons : []).map((l) => clip(l, 200)).filter((l) => l.length > 8).slice(0, 3);
    } catch (e) { if (e.status === 402) throw e; }
  }
  for (const l of lessons.length ? lessons : [plain]) memory.addLesson(w, l, 'Director');
  return lessons.length ? lessons : [plain];
}

// The rules of the loop, for the UI and the SOP.
function conditions(state) {
  const c = config(state);
  return [{ id: 'goal', text: 'Verified profit reaches your target' }, { id: 'loss', text: `A venture hits its loss limit (${money((state.mission || {}).riskCents || 0)}): it is killed automatically` },
    { id: 'budget', text: 'The daily model budget is used up: it pauses and resumes on its own' }, { id: 'model', text: 'The model cannot be reached: it pauses and retries' },
    { id: 'owner', text: 'You press Pause, or two rounds finish nothing (it needs something from you)' }, { id: 'revisions', text: `A task is revised at most ${c.maxRevisions} time${c.maxRevisions === 1 ? '' : 's'}, then accepted with its open issues noted` },
    ...(c.maxRounds ? [{ id: 'rounds', text: `Your cap of ${c.maxRounds} round${c.maxRounds === 1 ? '' : 's'} is reached` }] : [{ id: 'rounds', text: 'No round cap: it keeps going until the goal' }])];
}
function view(state) {
  const s = stats(state), m = memory.ensure(state);
  return { ...config(state), stats: { evaluated: s.evaluated, passedFirst: s.passedFirst, revised: s.revised, accepted: s.accepted, gaveUp: s.gaveUp }, lessons: (m.lessons || []).slice(-6).reverse(), conditions: conditions(state), lastStop: state.loopStop || null };
}
function stop(state, reason, kind) { state.loopStop = { reason, kind: kind || 'info', at: Date.now() }; }

module.exports = { config, checkCode, budgetGaps, fileGaps, evaluate, judge, revisionPrompt, learn, reflect, conditions, view, stop, stats, wantsJudge, DEFAULTS };
