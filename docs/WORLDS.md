# Worlds

A **world** is a self-contained station: its own Director, Bridge, rooms, desks, hallways, agents, connectors, ventures, ledger, goal, roadmap and journey. Worlds share only **settings** (model provider, guardrails, budgets) and the key vault.

Example: an *E-commerce* world with a research room, connected to a *Trading* world with its own research department. Each has its own goal and plan.

## Using worlds
- Header: click the world name to switch, or **+ New world**.
- **Worlds panel**: a map of your worlds and their portals, plus per-world cards (switch, connect, edit, delete).
- A new world starts with its own Director and asks for its own goal.
- World **types** (General, E-commerce, Trading, Content, Services, Product) set a color and a focus the Director reads, and break ties when classifying a goal.

## Portals
**Connect** opens a *portal* connector in each world (a gate on the floor). Portals are ordinary connectors, so hallways, capability checks and the Inspect panel work on them. Two ways to use one:

1. **Hallway into a portal**: finished work from a room is delivered to the other world. If that world's Inbox has hallways out, the work flows through them; otherwise the other world's **Director** receives it as a message.
2. **The Director messages a linked world**: `message_world {world, text}`. Immediate, no approval, and only to worlds you have linked.

Delivery is fire-and-forget: the receiving world does the work on its own budget and you see the result in that world.

## What is shared and what is not
| Shared | Per world |
|---|---|
| Model provider and Ollama settings | Agents, rooms, desks, hallways, connectors |
| Guardrail policy and budgets | Goal, roadmap, journey stage |
| The daily station budget (**summed across worlds**) | Ledger, ventures, Outbox, chat history |
| Key vault | Director |

Deleting a world removes its agents, connectors and saved keys, and closes portals that pointed at it. You cannot delete your last world.

## Data
`state.json` holds `{settings, worlds: {id: world}}`. Old single-station files load as a world named **Main**.
