# Privacy & keys

BYOK. Page content goes only to your chosen model + your chosen MCP backend. Nothing is proxied, resold, or sent to a first-party server.

## Your API key

- You paste your own key for your own model provider (OpenRouter, OpenAI, or any OpenAI-compatible endpoint).
- Encrypted with AES-GCM-256 before it touches disk, using a non-extractable WebCrypto key held in IndexedDB — the raw key bytes can never be read back out by JavaScript, so it can't leak via a log line or across the extension's internal message bus.
- Decrypted only inside the service worker, only for the moment of the API call. Never touches the content script (the part of the extension that shares the page's world) or the side panel.
- Persists until you clear it in Settings.

## MCP tokens

Same custody model as the API key — encrypted at rest, decrypted service-worker-only, used only for calls to the backend you connected (API key or OAuth/PKCE, your choice per backend).

## What reaches your model

- Your chat messages.
- Page DOM content, computed styles, accessibility snapshots, resolved element selectors.
- Screenshots (before/after), when the model supports vision.

All of it goes to **the model you configured** — nothing else. No developerz.ai server sits in that path.

## What reaches your MCP backend

Only on explicit **Ship**: the changeset (selectors, before/after CSS, framework hints, your stated intent, screenshots) and, for debug sessions, the report. Browsing a reference site in copy mode, chatting, and every live edit before Ship touch only your model — the MCP backend sees nothing until you click Ship.

## What never leaves your browser

- Live DOM/CSS edits themselves — they're applied in the content script only, gone on page reload, never sent anywhere. The only durable output of a session is a PR or a downloaded `.md` file.
- Reference-site content browsed in copy mode isn't stored anywhere beyond the session — it's read, distilled into design tokens, and used in that turn.

## Crash reporting

If the extension crashes, an error event (exception class + stack trace only) goes to GlitchTip (developerz.ai's own crash tool, public write-only ingest key baked into the build). Every event is rebuilt from an allowlist before sending — no page text, no prompts, no selectors, no screenshots, no breadcrumbs ride along. No session replay, no performance tracing, no analytics.

## Permissions the extension asks for, and why

| Permission | Why |
|------------|-----|
| Side panel | The UI surface — stays open across page navigation |
| Storage | Encrypted keys + MCP connections (`local`); the in-progress turn/changeset (`session`) |
| Scripting | Currently unused — the content script is registered statically in the manifest; slated for the least-privilege review (#23) |
| Active tab | Only touches a page after you've explicitly interacted with the extension |
| Tabs | Screenshot capture, tracking which tab is being edited |
| Identity | The OAuth (PKCE) consent window when you connect an MCP backend — tokens stay in the service worker |
| Web navigation | Enumerating a page's frames so tools can address iframes |
| Debugger | Device emulation for responsive checks (`setDevice`) — this one triggers Chrome's "started debugging" banner while active |
| Your model's host | e.g. `openrouter.ai` — the only network destination for inference |
| Any site (optional) | Requested per-origin, on demand, only when you point the agent at a page. Revocable any time in `chrome://extensions` |

## What we never do

- No first-party server holding your keys or your page content.
- No proxying or reselling of your API usage.
- No auto-ship, no auto-merge — every durable output is a click you made.
- No remote code — the entire UI is prebuilt static JS; the extension can't fetch and run new code post-install.

See [Ship or report](ship-or-report.md) for what specifically travels with a Ship vs. a Download.
