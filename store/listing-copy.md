# Chrome Web Store listing copy — Developerz.ai Designer

Dashboard paste source for #26. Character limits verified against the store's
current caps (name 45, short description 132).

## Name (45 max)

Developerz.ai Designer

## Short description (132 max, 126 used)

Chat with an AI agent that live-edits any page's design, then ships the changeset to your coding agent as a real PR.

## Detailed description

Designer turns "move that button up and make it pop" into a shipped pull request.

Chat with an agent in the side panel. It edits the page you're on — styles,
text, attributes, classes, whole nodes — live in front of you. Every accepted
edit lands in a reviewable changeset with before/after values, stable
selectors, and framework hints. Undo anything. When it looks right, hit Ship:
the changeset goes over MCP to your ai-dev backend, which makes the real code
change and opens the PR. No MCP backend? You get a Markdown report to paste
into any coding agent instead.

WHAT IT DOES
- Live DOM/CSS editing from plain-English chat
- Element picker with stable, source-mappable selectors (data-attrs, roles,
  text — never brittle nth-child chains)
- Diff review: every edit with before/after values, undo/redo, curation
- Screenshots, responsive breakpoints, and design-token reads for the agent
- Ship over MCP to ai-dev/developerz.ai, or download a Markdown report

PRIVACY BY DESIGN
- BYOK: your own model key, stored encrypted in your browser, never resold
- Keys and network calls live only in the extension's service worker
- Page content goes only to your model provider and your configured MCP
  backend — nowhere else
- Live edits are ephemeral; the only durable output is the changeset you ship

Built by developerz.ai. Open roadmap at github.com/developerz-ai/ai-designer.

## Category

Developer Tools

## Permission justifications (dashboard "why" fields)

- host_permissions (<all_urls>): the agent must read and live-edit the DOM of
  the page the user is designing, on any site the user chooses.
- activeTab + scripting: inject the content script that applies live edits.
- sidePanel: the chat UI surface.
- storage: BYOK keys (encrypted) + session changeset persistence.
- downloads: Markdown report fallback export.
- debugger: device emulation for responsive screenshots.
- tabs: resolve which tab the design session targets.
