# NutBot: chat and player workspace study

Research date: 2026-10-28. The accompanying `prototypes.html` is a self-contained,
interactive design study with synthetic data. It does not connect to a model or
read stored games. The three layouts are alternatives for review, not installed
chat implementations.

## The job

Inspect a player's events, ask about that player, and follow the answer back to
the evidence without losing the player, conversation, or keyboard access.

## Problems verified in this repository

- The shared PromptBar draws a slash icon and a command name that already starts
  with `/`. Two marks are visible, although the submitted command has one slash.
- History, reports, selectors, and preferences occupy the footer below the
  composer. Expanding history competes with the conversation for height.
- NutBot has a lower layer than the player dialog. The Radix modal also disables
  interaction outside itself and traps focus. Changing z-index alone cannot make
  the outside chat accessible.
- Player tabs were remembered in browser storage. The viewer used `fit-content`
  height, so switching sections changed its size.
- The current context builder already includes the player from `?player=`.
  The integration needs to preserve that reference and make the chat reachable;
  it does not need a new player search system.

## Reusable projects

### assistant-ui — strongest candidate for the chat layer

- Repository: <https://github.com/assistant-ui/assistant-ui>
- Examples: <https://www.assistant-ui.com/examples>
- Custom backend/state adapter:
  <https://www.assistant-ui.com/docs/runtimes/custom/external-store>
- Current React package peer dependencies include React 18 and React 19:
  <https://github.com/assistant-ui/assistant-ui/blob/main/packages/react/package.json>
- MIT license: <https://github.com/assistant-ui/assistant-ui/blob/main/LICENSE>

Reusable thread, composer, thread-list, message and action primitives, streaming,
scroll management, and tool-call UI. Its external-store adapter accepts existing
messages and callbacks. AVN can retain its FastAPI stream, saved chats, permissions
and tools, and style the primitives with plain CSS and AVN roles. Any adoption
should live behind shared `@avn/ui` components rather than introducing another
look in Analytics. Do not run its default shadcn/Tailwind scaffolder in this app.
This is an integration recommendation, not a completed compatibility test.

Patterns used in the study: history separate from the composer; a stable input
at the bottom; message actions beside their answer; model settings in a menu;
conversation-first spacing. The modal and full-page official examples provide
useful alternatives to an always-visible narrow sidebar.

### CopilotKit — useful reference for shared application context

- Repository: <https://github.com/CopilotKit/CopilotKit>
- Context hook source:
  <https://github.com/CopilotKit/CopilotKit/blob/main/CopilotKit/packages/react-core/src/hooks/use-copilot-readable.ts>
- MIT license: <https://github.com/CopilotKit/CopilotKit/blob/main/LICENSE>

Supports agent-connected UI, shared state and human approval. Its application
context pattern fits an open player, filters and date range. Adopting the runtime
would require a bridge to AVN's ACP/stream contract; it is a broader change than
using assistant-ui for the chat surface. Prefer borrowing the context model unless
the broader runtime is needed.

### LibreChat — reference for a dedicated conversation workspace

- Repository: <https://github.com/LibreChat-AI/LibreChat>

A full self-hosted chat application with conversations, model switching, agents
and MCP support. Useful as a reference for history navigation and roomy message
layout. Forking the whole application would duplicate AVN's accounts, game
permissions, storage and shell, so it is a poor fit as an embedded replacement.

## The agent harness is already reused

`deploy/nutbot/package.json` pins upstream Claude ACP, Codex ACP and OpenCode.
`avn_analytics/nutbot_acp.py` imports the upstream ACP Python SDK. AVN owns the
application integration: authorised game tools, context, persistence and UI events.

- Claude adapter: <https://github.com/agentclientprotocol/claude-agent-acp>
- Codex adapter: <https://github.com/agentclientprotocol/codex-acp>
- Python SDK and client examples:
  <https://github.com/agentclientprotocol/python-sdk>

These are the appropriate pieces to keep reusing. The adapters run their upstream
agent runtimes and expose sessions, streaming and tools through ACP. A UI library
does not replace that runtime. A new generic agent loop is unnecessary for this
redesign. Adapt the chat surface to the current backend instead.

## Prototype options

1. **A — Roomy panel.** A larger conversation panel with history in the header.
   Opening a player keeps the viewer centred and offers NutBot as a tab inside
   that same viewer. Best for short questions while browsing dashboards.
2. **B — Chat workspace.** A dedicated page, a separate history rail, and a wide
   reading column. Player details remain a centred viewer with their own NutBot
   tab. Best for longer analyses; the dashboard is no longer visible beside chat.
3. **C — Player + NutBot.** A centred player workspace with events above and an
   embedded conversation below. Both remain visible without creating a third
   sidebar. On a phone, switch Events/Chat within the same viewer and keep the
   player reference attached. Best for the reported player-investigation task.

All three remove Cheap and bottom help paragraphs, move preferences away from
the input, show one slash per command, and keep prior conversations above the
message field. Saved reports are a secondary destination and saves are explicit
in the design. The report-saving backend policy is not changed by this study.

## Selection and implementation

Choose a layout before replacing the shared chat panel. A likely combination is
B for long analysis and C for player investigation, with A as the optional docked
mode. All modes should use one conversation state and one context model. Moving
the same chat into the player viewer avoids two disconnected conversations and
avoids fighting modal accessibility with a z-index override.
