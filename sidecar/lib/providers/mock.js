'use strict';
// Offline provider so the whole station runs with no key and no bill.
// For the Director it returns a deterministic starter plan; for the crew it returns a stub deliverable.
const { money } = require('../util');

function starterPlan(state) {
  const m = state.mission;
  const cap = m ? m.capitalCents : 50000;
  const budget = Math.max(2000, Math.round(cap * 0.2));
  return {
    say: `Mission received${m ? ': ' + money(m.targetCents) + ' verified profit' : ''}. I'm proposing a five-person crew wired as one pipeline: Research → Build → Review → Outreach → Outbox, with a Ledger vault watching Stripe. First venture is a small outreach-led service pilot capped at ${money(budget)} loss. Approve and I'll start.`,
    actions: [
      { type: 'create_room', ref: 'lab', name: 'Research lab', kind: 'lab', w: 8, h: 5 },
      { type: 'create_room', ref: 'shop', name: 'Build shop', kind: 'workshop', w: 8, h: 5 },
      { type: 'create_room', ref: 'review', name: 'Review chamber', kind: 'review', w: 8, h: 5 },
      { type: 'create_room', ref: 'market', name: 'Outreach floor', kind: 'market', w: 8, h: 5 },
      { type: 'create_room', ref: 'vault', name: 'Ledger vault', kind: 'vault', w: 8, h: 5 },
      { type: 'create_desk', ref: 'd1', room: 'lab' }, { type: 'create_desk', ref: 'd2', room: 'shop' },
      { type: 'create_desk', ref: 'd3', room: 'review' }, { type: 'create_desk', ref: 'd4', room: 'market' },
      { type: 'create_desk', ref: 'd5', room: 'vault' },
      { type: 'create_agent', name: 'Scout', role: 'researcher', desk: 'd1' },
      { type: 'create_agent', name: 'Forge', role: 'builder', desk: 'd2' },
      { type: 'create_agent', name: 'Cato', role: 'critic', desk: 'd3' },
      { type: 'create_agent', name: 'Herald', role: 'outreach', desk: 'd4' },
      { type: 'create_agent', name: 'Tally', role: 'finance', desk: 'd5' },
      { type: 'create_connector', ref: 'stripe', kind: 'stripe', name: 'Stripe', near: 'vault' },
      { type: 'create_connector', ref: 'mail', kind: 'email', name: 'Outbound email', near: 'market' },
      { type: 'create_hallway', from: 'inbox', to: 'room:lab' },
      { type: 'create_hallway', from: 'room:lab', to: 'room:shop' },
      { type: 'create_hallway', from: 'room:shop', to: 'room:review' },
      { type: 'create_hallway', from: 'room:review', to: 'room:market' },
      { type: 'create_hallway', from: 'room:market', to: 'connector:mail' },
      { type: 'create_hallway', from: 'room:market', to: 'outbox' },
      { type: 'create_hallway', from: 'connector:stripe', to: 'room:vault' },
      { type: 'create_hallway', from: 'room:vault', to: 'outbox' },
      { type: 'create_venture', name: 'Local lead-gen pilot', thesis: 'Sell booked-appointment lead generation to local service businesses via direct outreach.', budgetCents: budget, maxLossCents: budget }
    ]
  };
}

async function complete({ state, agent, messages, purpose }) {
  const last = (messages[messages.length - 1] || {}).content || '';
  let text;
  if (purpose === 'director') {
    const crew = Object.values(state.agents).filter((a) => a.role !== 'director');
    if (crew.length === 0) text = JSON.stringify(starterPlan(state));
    else text = JSON.stringify({ say: `The crew is staffed (${crew.length} agents). Send work through the Inbox, or tell me to propose another venture, and I'll plan it. (Offline demo model: connect a real one in Settings for real planning.)`, actions: [] });
  } else {
    text = `[${agent.name}, offline demo model] Handled: "${last.replace(/\s+/g, ' ').slice(0, 140)}". Connect a real model in Settings to get real work.`;
  }
  return { text, tokensIn: Math.ceil(last.length / 4), tokensOut: Math.ceil(text.length / 4), costCents: 0, model: 'mock-1' };
}

module.exports = { complete, starterPlan };
