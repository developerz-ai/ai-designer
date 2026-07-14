# Getting started

Install → configure a provider → go green → Start.

## Install

1. Chrome Web Store listing (or load unpacked from a `bun run build` output for dev builds).
2. Pin the extension, open any tab, click the icon — the side panel opens and docks.

## Configure a provider (BYOK)

Settings tab → pick a base URL preset or paste your own:

| Preset | Base URL | Notes |
|--------|----------|-------|
| OpenRouter | `https://openrouter.ai/api/v1` | Bundled default, widest model choice |
| OpenAI | `https://api.openai.com/v1` | Use your own OpenAI key |
| Custom | anything OpenAI-compatible `/v1` | Self-hosted, local (Ollama/vLLM), other vendors |

Paste your API key, pick a model from the **Refresh** list, save. The key is AES-GCM-encrypted and stored only in your browser — see [Privacy & keys](privacy-keys.md). Nothing is sent anywhere until you start chatting.

Custom base URLs prompt a one-time host-permission grant (Chrome asks you to allow the extension to talk to that domain).

## MCP backend — optional

MCP tab → connect a backend (e.g. ai-dev / developerz.ai) if you want **Ship** to open a real PR. Skip this and the extension still works fully — edits land as a downloadable Markdown report instead. See [Ship or report](ship-or-report.md).

## Readiness pill

The header shows a status pill:

| Pill | Meaning |
|------|---------|
| **Setup needed** | Provider and/or model missing — click through the checklist, each row deep-links to the fix |
| **Ready** | Provider + model configured. MCP is a bonus, not a blocker |
| **Running…** | A turn is in flight |

Click the pill to expand the checklist (Provider, Model, Host permission, MCP backend).

## Start

Once **Ready**, click **Start**. This unlocks the chat composer — the extension only ever acts on a page after you explicitly start a session. Click **Stop** any time to cancel an in-flight turn.

## First message

Type what you want in plain language: *"Make the hero full-bleed, CTA orange, tighten the nav spacing."* The agent reads the page, mutates it live, looks at the result, and self-corrects — one message can drive many steps. Watch it happen on the page in real time.

Optional: flip on the **on-page overlay** (Settings) to see each tool-call step mirrored live on the page as a small floating card — a Cursor-style highlight of exactly what's being read or changed.

Next: [Using copy mode](using-copy.md) or [Using debug mode](using-debug.md).
