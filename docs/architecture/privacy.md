# Privacy

Data-handling rules for what the extension collects, where it lives, and where it goes. BYOK inference; page content reaches only the user's chosen model + MCP; edits are ephemeral; the only durable output is a changeset → PR. See [principles.md](../idea/principles.md).

## Posture

- BYOK inference — the user's own OpenRouter key calls the user's own model. No proxying, no reselling.
- No first-party server in v0/v1; the SW talks to OpenRouter and the user's MCP backend directly.
- Page content, computed styles, a11y snapshots, resolved selectors, and screenshots go **only** to the user's chosen OpenRouter model and the user's chosen MCP backend (ai-dev / developerz.ai) — never a third party, never a first-party server.
- Live DOM/CSS edits are ephemeral: reload = clean page, never persisted to the site.
- The only durable output is a changeset → PR.
- Ship is a user action. Never auto-shipped, never auto-merged.

See [principles.md](../idea/principles.md), [security.md](security.md) Privacy posture.

## Data categories

| What | Where it lives | Where it goes | Retention |
|------|----------------|---------------|-----------|
| Design prompt + chat history | Side-panel memory (+ `chrome.storage.session` mirror) | Service worker → user's OpenRouter model only | Session (tab close / Clear session clears it). Per [mv3-worlds.md](mv3-worlds.md) SW ephemerality table. |
| Page DOM content, computed styles, a11y snapshots, resolved selectors | Content script → SW over the typed bus (Zod) | SW → user's OpenRouter model + user's chosen MCP backend only; never a third party or first-party server | In-memory / `chrome.storage.session`; never persisted to the site. Per [mv3-worlds.md](mv3-worlds.md), [security.md](security.md) threats table. |
| Screenshots (before/after, base64) | Content script capture → SW → recorder | To user's OpenRouter model (vision) + user's MCP backend with the changeset; nowhere else | Session; travel with the changeset, cleared with it. Per [changeset.md](changeset.md). |
| OpenRouter API key | `chrome.storage.local` as AES-GCM-256 ciphertext; non-extractable wrapping key in IndexedDB | Decrypted in the service worker only, for the OpenRouter call | Persistent until the user clears it (`clearOpenRouterKey`). Per [security.md](security.md) Key custody, `src/agent/key-store.ts`. |
| MCP token (OAuth/PAT) | `chrome.storage.local`, encrypted | Service worker only, for the user's chosen MCP backend | Persistent until revoked/cleared. |
| Current turn + changeset | `chrome.storage.session` | Stays in the extension; ships to the user's MCP backend only on explicit Ship | Tab/session. Per [changeset.md](changeset.md) Lifecycle. |
| Crash event (class + stack trace, NO page content) | Built in-browser, scrubbed before send | GlitchTip only (developerz.ai infra); public write-only DSN | Per GlitchTip retention. Per `src/shared/sentry.ts`. |
| Site DOM/CSS edits | Applied in the content script only | Nowhere — never persisted to the site, never sent anywhere | Ephemeral: gone on reload. Per [principles.md](../idea/principles.md), [changeset.md](changeset.md). |

## Key custody

The wrapping key is a **non-extractable** AES-GCM-256 `CryptoKey` (`generateKey({ extractable: false })`) held in IndexedDB; the `{ iv, ciphertext }` pair lives in `chrome.storage.local`; decrypt is service-worker-only. Because the key is non-extractable, JS can never read its raw bytes — the key cannot leak via a log line or across the message bus. No first-party server in v0/v1; the extension talks to OpenRouter and the user's MCP backend directly from the SW. See [security.md](security.md) Key custody, `src/agent/key-store.ts`.

## What reaches the user's model + MCP

- Design prompt + chat.
- DOM content, computed styles, a11y snapshots, resolved selectors.
- Before/after screenshots.
- The changeset (selectors, before/after CSS, frameworkHints, intent, screenshots) — on explicit Ship.

Page content goes to the user's chosen OpenRouter model and the user's chosen MCP backend only — never to a third party or a first-party server. See [handoff.md](handoff.md) Task spec table, [changeset.md](changeset.md).

## Crash reporting

GlitchTip, error events only. Public write-only DSN baked in the bundle (`src/shared/sentry.ts`). ALLOWLIST scrubbing (`scrubEvent`) rebuilds each event from a fixed set of non-page fields and drops breadcrumbs, exception free-form messages, page text, prompts, selectors, screenshots, `extra` / `contexts` / `request` / attachments. No Sentry Session Replay, no performance tracing — GlitchTip supports neither, and enabling Replay in an all_urls content script would record every page. See [security.md](security.md).

## Permissions

| Permission | Why |
|------------|-----|
| `sidePanel` | Durable UI surface; survives page navigation. |
| `storage` | `chrome.storage.local` (encrypted keys, MCP connections) + `chrome.storage.session` (turn, changeset). |
| `scripting` | Inject the content script for DOM tools. |
| `activeTab` | Page access only on explicit user gesture. |
| `tabs` | Capture screenshots; track the active tab for edits. |
| `host_permissions: https://openrouter.ai/*` | BYOK model endpoint; SW-only, CORS-exempt. |
| `host_permissions: https://glitchtip.infra.developerz.ai/*` | Crash ingest; SW-only, CORS-exempt. |
| `optional_host_permissions: <all_urls>` | Granted per-site, on demand. User can scope to one origin. Revocable. |

See [security.md](security.md) Least privilege, `wxt.config.ts`.

## Not done here

- No first-party server in v0/v1.
- No proxying or reselling of tokens — BYOK.
- No third-party telemetry of page contents.
- No Session Replay, performance tracing, or analytics.
- No remote code, no `eval` — Solid prebuilt to static JS, MV3 CSP.
- Live edits never persist to the site.
- No auto-ship, no auto-merge.

See [security.md](security.md) Threats & mitigations, [principles.md](../idea/principles.md).
