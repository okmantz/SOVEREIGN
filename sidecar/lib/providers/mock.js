'use strict';
// Offline provider so the whole station runs with no key and no bill.
// For the Director it returns a deterministic starter plan; for agents it returns a stub deliverable.
const { money } = require('../util');

function starterPlan(state) {
  const m = state.mission;
  const cap = m ? m.capitalCents : 50000;
  const budget = Math.max(2000, Math.round(cap * 0.2));
  return {
    say: `Mission received${m ? ': ' + money(m.targetCents) + ' verified profit' : ''}. I'm proposing seven agents, each with their own desk, wired as one pipeline: Research → Copy → Review → Outreach → Outbox, plus a Ledger vault reading Stripe and an Ad bay reading Facebook Ads. First venture is a small outreach-led service pilot capped at ${money(budget)} loss. Approve and I'll start.`,
    actions: [
      { type: 'create_room', ref: 'lab', name: 'Research lab', kind: 'lab', w: 8, h: 5 },
      { type: 'create_room', ref: 'studio', name: 'Content studio', kind: 'studio', w: 8, h: 5 },
      { type: 'create_room', ref: 'review', name: 'Review chamber', kind: 'review', w: 8, h: 5 },
      { type: 'create_room', ref: 'market', name: 'Outreach floor', kind: 'market', w: 8, h: 5 },
      { type: 'create_room', ref: 'vault', name: 'Ledger vault', kind: 'vault', w: 8, h: 5 },
      { type: 'create_room', ref: 'adbay', name: 'Ad bay', kind: 'adbay', w: 8, h: 5 },
      { type: 'create_agent', name: 'Scout', role: 'researcher' },
      { type: 'create_agent', name: 'Quill', role: 'copywriter' },
      { type: 'create_agent', name: 'Cato', role: 'critic' },
      { type: 'create_agent', name: 'Prospect', role: 'lead_generator' },
      { type: 'create_agent', name: 'Herald', role: 'email_marketer' },
      { type: 'create_agent', name: 'Tally', role: 'finance' },
      { type: 'create_agent', name: 'Pilot', role: 'ad_manager' },
      { type: 'create_connector', ref: 'stripe', kind: 'stripe', name: 'Stripe', near: 'vault' },
      { type: 'create_connector', ref: 'mail', kind: 'email', name: 'Outbound email', near: 'market' },
      { type: 'create_connector', ref: 'ads', kind: 'meta_ads', name: 'Facebook Ads', near: 'adbay' },
      { type: 'create_hallway', from: 'inbox', to: 'room:lab' },
      { type: 'create_hallway', from: 'room:lab', to: 'room:studio' },
      { type: 'create_hallway', from: 'room:studio', to: 'room:review' },
      { type: 'create_hallway', from: 'room:review', to: 'room:market' },
      { type: 'create_hallway', from: 'room:market', to: 'connector:mail' },
      { type: 'create_hallway', from: 'room:market', to: 'outbox' },
      { type: 'create_hallway', from: 'connector:stripe', to: 'room:vault' },
      { type: 'create_hallway', from: 'room:vault', to: 'outbox' },
      { type: 'create_hallway', from: 'connector:ads', to: 'room:adbay' },
      { type: 'create_hallway', from: 'room:adbay', to: 'outbox' },
      { type: 'create_venture', name: 'Local lead-gen pilot', thesis: 'Sell booked-appointment lead generation to local service businesses via direct outreach.', budgetCents: budget, maxLossCents: budget }
    ]
  };
}

async function complete({ state, agent, messages, purpose }) {
  const last = (messages[messages.length - 1] || {}).content || '';
  let text;
  if (purpose === 'director') {
    const crew = Object.values(state.agents).filter((a) => a.role !== 'director');
    const m = /(?:tell|ask|have)\s+([\w-]+)\s+to\s+(.+)/i.exec(last), who = m && crew.find((a) => a.name.toLowerCase() === m[1].toLowerCase());
    if (who) text = JSON.stringify({ say: `On it. I've asked ${who.name} to do that. The result will land in the Outbox.`, actions: [{ type: 'assign_task', agent: who.name, instructions: m[2].trim() }] });
    else if (crew.length === 0) text = JSON.stringify(starterPlan(state));
    else text = JSON.stringify({ say: `The station has ${crew.length} agents. Send work through the Inbox, or ask me for another venture and I'll plan it. (You're on the offline demo model. Connect a real one in Settings for real planning.)`, actions: [] });
  } else {
    text = `[${agent.name}, offline demo model] Got it: "${last.replace(/\s+/g, ' ').slice(0, 140)}". Connect a real model in Settings to get real work.`;
  }
  return { text, tokensIn: Math.ceil(last.length / 4), tokensOut: Math.ceil(text.length / 4), costCents: 0, model: 'mock-1' };
}

module.exports = { complete, starterPlan };
