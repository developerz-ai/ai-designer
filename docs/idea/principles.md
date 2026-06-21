# Principles

Non-negotiables. Read before designing anything.

| | |
|--|--|
| Thin orchestrator | The extension *designs* and *delegates*. Real coding lives in [ai-dev](mcp.md) / developerz.ai. We don't reimplement a coding agent. |
| BYOK | OpenRouter key for design inference, MCP token for the dev backend. We never resell tokens. |
| Live edits are ephemeral | Page mutations never persist to the site. Reload = clean page. The only durable output is a changeset and a PR. |
| Source of truth is the repo | The page is a preview. Nothing ships except as a reviewable code change. No silent prod writes. |
| Intent over pixels | A changeset records *what you meant* ("full-bleed hero"), not just a CSS dump. The dev-agent maps intent to the codebase's own conventions. |
| Stable selectors | Capture resilient selectors (data-attrs, roles, text) — never brittle nth-child chains that break on the next render. |
| Human in the loop | Design is a conversation; shipping is a PR. The agent never auto-merges. |
| Least privilege | Content script touches the DOM, nothing else. Network/keys live in the service worker. Host permissions are opt-in per site. |
| Privacy | Page content and screenshots go only to the user's chosen model + their chosen MCP. No third-party telemetry of page contents. |
| Model-agnostic | OpenRouter means any model. No lock-in to one vendor; pick per task and budget. |
| SolidJS, prebuilt | UI is a prebuilt static Solid bundle loaded by the extension — no runtime eval, CSP-clean (MV3). |
| Tested | Unit + integration on the agent loop and changeset recorder; E2E on a real loaded extension. See [testing.md](testing.md). |

## Trust contract

- The extension **shows** every edit before it's recorded, and **shows** the full changeset before handoff.
- Handoff is explicit. "Ship it" is a button, not an inference.
- Every dispatched task is auditable on the MCP backend (ai-dev logs task → PR).
