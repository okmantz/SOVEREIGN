'use strict';
const { uid, validate, round } = require('./util');
const { McpClient } = require('./mcp');

/**
 * Permissioned Tool Registry. Every capability — built-in, MCP, browser, deploy — is invoked through here,
 * so every call passes the same gates: schema → rate limit → CFO (if it costs money) → permission engine.
 */
function makeTools(ctx) {
  const tools = new Map(); const calls = new Map(); const mcpClients = new Map();

  function register(t) {
    for (const k of ['name', 'description', 'handler']) if (!t[k]) throw new Error(`tool needs ${k}`);
    tools.set(t.name, { owner: 'builtin', risk: 'low', cost: 0, required_permission: 0, input_schema: null, output_schema: null,
      rate_limit: { max: 60, per_ms: 60000 }, irreversible: false, ...t });
    return t.name;
  }
  const meta = (t) => ({ name: t.name, owner: t.owner, description: t.description, risk: t.risk, cost: typeof t.cost === 'function' ? 'variable' : t.cost,
    required_permission: t.required_permission, input_schema: t.input_schema, output_schema: t.output_schema, rate_limit: t.rate_limit, irreversible: t.irreversible });
  const list = (f = {}) => [...tools.values()].filter((t) => (!f.owner || t.owner === f.owner) && (f.max_level === undefined || t.required_permission <= f.max_level)).map(meta);
  const get = (n) => tools.get(n) || null;

  function rateLimited(t) {
    const now = ctx.now(); const w = (calls.get(t.name) || []).filter((x) => now - x < t.rate_limit.per_ms);
    if (w.length >= t.rate_limit.max) { calls.set(t.name, w); return true; }
    w.push(now); calls.set(t.name, w); return false;
  }

  async function invoke(name, input = {}, { agent_id = 'unknown', venture_id = null, approved = false, overrides = {} } = {}) {
    // `overrides` (level/cost/irreversible) is for trusted internal callers such as the browser classifier – never expose it over HTTP.
    const t = tools.get(name); if (!t) return { status: 'error', error: `unknown tool ${name}` };
    const bad = validate(t.input_schema, input); if (bad) return { status: 'error', error: bad };
    if (rateLimited(t)) return { status: 'denied', reason: 'rate limit' };
    const cost = round(overrides.cost ?? (typeof t.cost === 'function' ? t.cost(input) : t.cost || 0));
    const level = overrides.level ?? t.required_permission;
    const irreversible = overrides.irreversible ?? t.irreversible;
    if (cost > 0 && !ctx.settings().allow_paid) return { status: 'denied', reason: 'free-only mode: this action costs money. Turn on "allow paid" in the company settings if you want it.' };
    if (cost > 0) {                                     // money law: CFO always has a vote, even for approved actions
      if (!venture_id) return { status: 'denied', reason: 'spending tools need a venture_id' };
      const c = ctx.cfo.decide({ venture_id, amount: cost, category: t.spend_category || 'other_opex', purpose: name });
      if (c.decision !== 'AUTHORIZED') return { status: 'denied', reason: `CFO: ${c.reason}`, cfo: c };
    }
    let auth = { decision: 'allow', reason: 'human approved' };
    if (!approved) auth = ctx.permissions.authorize({ agent_id, venture_id, level, cost, irreversible, tool: name });
    else if (venture_id && !ctx.ventures.canWork(venture_id)) auth = { decision: 'deny', reason: 'venture is not active' };
    if (auth.decision === 'deny') return { status: 'denied', reason: auth.reason };
    if (auth.decision === 'draft') {
      const d = ctx.permissions.queueDraft({ tool: name, input, agent_id, venture_id, cost });
      return { status: 'drafted', draft_id: d.id };
    }
    if (auth.decision === 'approve') {
      const a = ctx.permissions.queueApproval({ type: 'tool', tool: name, input, agent_id, venture_id, cost,
        summary: `${agent_id} wants to run ${name}${cost ? ` ($${cost})` : ''}: ${JSON.stringify(input).slice(0, 160)}`, reason: auth.reason });
      return { status: 'pending_approval', approval_id: a.id, reason: auth.reason };
    }
    try {
      const result = await t.handler(input, { agent_id, venture_id, ctx });
      if (cost > 0 && !(result && result.settled === false)) {   // unsettled = nothing actually paid yet
        ctx.permissions.commitSpend(agent_id, venture_id, cost, name);
        ctx.ledger.record({ venture_id, category: t.spend_category || 'other_opex', amount: cost, source: 'measured', memo: `tool ${name}` });
      }
      ctx.permissions.recordOutcome(agent_id, true); ctx.emit('tool.ok', { tool: name, cost }, venture_id);
      return { status: 'done', result };
    } catch (e) {
      ctx.permissions.recordOutcome(agent_id, false); ctx.emit('tool.failed', { tool: name, error: e.message }, venture_id);
      return { status: 'error', error: e.message };
    }
  }
  /** Run a human-approved queued tool call (still subject to CFO + venture-alive checks). */
  async function executeApproval(id) {
    const a = ctx.permissions.getApproval(id);
    if (!a || a.status !== 'approved' || a.type !== 'tool') throw new Error('approval is not an approved tool call');
    return invoke(a.tool, a.input, { agent_id: a.agent_id, venture_id: a.venture_id, approved: true });
  }

  /** Connect an MCP server (stdio) and expose its tools through the same permission gates. */
  async function connectMcp({ name, command, args, env, allow, overrides = {}, default_level = 2 }) {
    const client = await new McpClient({ command, args, env }).start(); mcpClients.set(name, client);
    const found = [];
    for (const t of await client.listTools()) {
      if (allow && !allow.includes(t.name)) continue;
      const ann = t.annotations || {}; const o = overrides[t.name] || {};
      const level = o.level ?? (ann.readOnlyHint ? 0 : ann.destructiveHint ? 4 : default_level);
      found.push(register({ name: `mcp.${name}.${t.name}`, owner: `mcp:${name}`, description: t.description || t.name,
        risk: o.risk || (level >= 3 ? 'high' : level === 2 ? 'medium' : 'low'), cost: o.cost || 0, required_permission: level,
        irreversible: Boolean(ann.destructiveHint), input_schema: t.inputSchema || null,
        handler: async (input) => (await client.callTool(t.name, input)).text }));
    }
    return found;
  }
  const closeAll = () => { for (const c of mcpClients.values()) c.close(); mcpClients.clear(); };
  return { register, list, get, invoke, executeApproval, connectMcp, closeAll };
}
module.exports = { makeTools };
