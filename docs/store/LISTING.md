# Chrome Web Store listing — Developerz.ai Designer

Everything the CWS dashboard asks for, in the order it asks. Paste-ready. Screenshots +
promo tile: `bun run store:shots` → `docs/store/assets/`.

## Basics

| Field | Value |
|--|--|
| Name | Developerz.ai Designer |
| Summary (≤132 chars) | Chat with an AI agent that live-edits any page's design in your browser — then ships the changes as a real PR or a handoff brief. |
| Category | Developer Tools |
| Language | English |

## Description

Developerz.ai Designer is an AI design agent that works directly on the page you're looking at.

Open the side panel, describe what you want — "make the hero match this mockup", "why does the pricing table overflow on mobile?" — and the agent edits the live DOM and CSS in real time, right in your tab. Point it at an element with the picker, attach reference mockups, or let it diagnose layout, contrast, and responsiveness problems itself.

Nothing is lost when the tab closes: every accepted edit is recorded into a changeset with undo/redo, and when you're happy you Ship it — either as a task to your connected developerz.ai backend (a real pull request in minutes, over MCP) or as a Markdown handoff brief you can paste into any coding agent.

WHAT IT DOES
• Live design edits — colors, spacing, typography, structure — applied to the real page as you chat
• Element picker + multi-select: ground the conversation in the exact element you mean
• Reference images: attach mockups and ask the agent to match them
• Debug mode: viewport, scroll, contrast and performance diagnostics with confirmed findings
• Responsive scanning and device emulation
• Changeset with per-edit undo/redo and a Diff view
• Ship: MCP task to your backend → PR, or a standalone Markdown report
• Session history — your last 10 conversations and reports, stored locally

BRING YOUR OWN KEY
You connect your own OpenAI-compatible model provider (e.g. OpenRouter). Your API key is encrypted and stored only in your browser (chrome.storage.local), used only in the extension's service worker, and never sent anywhere except directly to the provider you configured. No accounts, no usage analytics, no middleman servers. The only thing ever sent to us is an anonymous crash report (error class + stack trace of the extension's own code) with page content scrubbed out by allowlist — see the privacy policy.

PRIVACY BY ARCHITECTURE
Page content is read only when you ask the agent to work on a page, and it is sent only to your configured model provider. Live page edits are never persisted to any server. The only durable outputs are the changeset and report you explicitly export or ship. Full policy: https://github.com/developerz-ai/ai-designer/blob/main/docs/architecture/privacy.md

Open source: https://github.com/developerz-ai/ai-designer

## Privacy practices tab

**Single purpose description:**
AI-assisted live design editing of the current web page: the user chats with an agent that edits the page's DOM/CSS in their tab and exports the result as a changeset/report or a pull-request task.

**Privacy policy URL:** https://github.com/developerz-ai/ai-designer/blob/main/docs/architecture/privacy.md

**Data usage declarations:** the extension does NOT sell or transfer user data. Page content and chat messages go only to the user's own configured model provider (BYOK) and, when the user explicitly ships, to the MCP backend the user connected. No usage analytics. Anonymous crash reports (error class + extension stack trace only; page content, prompts, selectors and screenshots scrubbed by allowlist before send — `src/shared/sentry.ts`) go to the developer's self-hosted GlitchTip — declare under the error/crash-data category in the data-usage form.

## Permission justifications

Verified against `wxt.config.ts` (`sidePanel, storage, activeTab, tabs, identity,
webNavigation, debugger, scripting` + optional `<all_urls>`).

| Permission | Justification (paste into the dashboard) |
|--|--|
| `sidePanel` | The entire product UI is a side panel (chat + settings + diff + history). |
| `storage` | Stores the user's encrypted provider API key, settings, the recorded changeset, and the last-10-sessions history — all locally, never synced to a server. |
| `activeTab` + optional `<all_urls>` | The agent live-edits the DOM/CSS of the page the user is working on. Broad host access is OPTIONAL and requested at runtime for the sites the user chooses to design on; it is not required to install or start. |
| `scripting` | Re-injects the declared DOM-bridge content script (which applies the user's requested design edits and mounts the element picker) into tabs that predate an install/update. |
| `tabs` | Resolves which tab a design conversation belongs to, follows the user's tab switches, and opens/activates tabs when the agent is asked to browse or compare pages. |
| `debugger` | Chrome DevTools Protocol `Emulation.setDeviceMetricsOverride` only — true device emulation for the responsive-design scanner and device-accurate captures. Called exclusively from the service worker; never exposed to page content; detached as soon as emulation ends. |
| `webNavigation` | Frame-tree enumeration (`getAllFrames`) so the agent can target a specific iframe, and cross-document commit detection so edits recorded against a page the tab has left are cleared instead of mis-attributed. |
| `identity` | OAuth 2.0 (PKCE) sign-in to the user's own MCP backend via `launchWebAuthFlow`; tokens stored locally, revocable in the MCP UI. |
| host `https://openrouter.ai/*` | The BYOK model endpoint the service worker calls directly with the user's own key (CORS-exempt static grant). |
| host `https://glitchtip.infra.developerz.ai/*` | Self-hosted crash-report ingest (allowlist-scrubbed, no page content). |

## Graphics

| Asset | Size | Source |
|--|--|--|
| Icon | 128×128 | `src/public/icon/icon-128.png` (in the bundle) |
| Screenshots ×5 | 1280×800 | `bun run store:shots` → `docs/store/assets/shot-*.png` |
| Small promo tile | 440×280 | `bun run store:shots` → `docs/store/assets/promo-440x280.png` |
| Marquee (optional) | 1400×560 | skip for v1 |

## Review-risk notes (internal, not for the dashboard)

- `debugger` routinely triggers extended manual review. The justification above names the
  exact CDP call and the SW-only custody — answer follow-ups from `docs/architecture/`.
- BYOK key custody questions: `chrome.storage.local`, AES-GCM-encrypted, service-worker
  only, no remote code (Solid prebuilt, no eval, CSP-clean).
- First submission must be a manual upload (that mints the item ID → `CWS_EXTENSION_ID`
  secret); CI takes over from the second version. See STORE-SETUP.md.
