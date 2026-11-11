<p align="center">
  <img src="assets/logo.png" alt="Developerz.ai Designer" width="300">
</p>

# Developerz.ai Designer

> **Design in the live page. Ship the real code.**

Chrome extension. Open any page — your prod app or `localhost` — open a side-panel chat, and tell an agent what to change. It mutates the live DOM/CSS instantly so you *see* it. When you like it, click **Ship** and the agent hands the change off over **MCP** to a dev-agent backend ([developerz.ai MCP endpoint](https://mcp.developerz.ai/v1/mcp)) that makes the real code change and opens a PR.

Not a page builder. Not a Figma clone. It edits **your codebase**, and the only durable output is a reviewable PR.

## The loop

```
You ─chat─► Agent ─DOM tools─► live page (ephemeral)
              │                    │ iterate, see it instantly
              │ "Ship"             ▼
              └─► changeset (selectors, styles, screenshots, intent)
                     │ MCP
                     ▼
              developerz.ai ─► real code edit ─► PR ─► CI
```

## Why

- Design tools produce mockups, not code — someone re-implements them by hand.
- DevTools edits the live page, but the edits vanish on reload and never reach the repo.
- Coding agents write from text prompts, blind to what the page actually looks like.

The gap: **what you see** (the rendered page) and **what you change** (the source) are disconnected. Designer closes it — design on the real page, ship a real PR, one conversation.

## How it works

| Step | Where | What happens |
|------|-------|--------------|
| Talk | Side-panel chat | "Make the hero full-bleed, CTA orange, tighten the nav." Attach mockups (button, paste or drop) and the agent redesigns the live page towards them. |
| See | Live page | Agent mutates real DOM/CSS. Instant. You react, refine. |
| Accept | Side-panel chat | Each change recorded as a structured changeset entry (edit chips + undo). |
| Ship | MCP handoff | Changeset → dev-agent → finds source → edits code → PR. |
| Verify | PR / CI | Real change, tested, reviewable. You merge. |

- **Live edits are ephemeral.** Mutations never persist to the site. Reload = clean page.
- **BYOK.** OpenRouter key for the design agent. MCP token for the dev backend. We never resell tokens.
- **Human in the loop.** "Ship" is a button, not an inference. The agent never auto-merges.

## Install

1. **Chrome Web Store — recommended.** Install [developerz.ai Designer](https://chromewebstore.google.com/detail/developerzai-designer/hjgggflaedpmilakacheejggngennfhm).
2. **GitHub Release — zip / load unpacked.** Download the Chrome zip from the [latest release](https://github.com/developerz-ai/ai-designer/releases/latest), unzip it, then open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the unzipped extension directory.
3. **Source build — contributors.** Install Bun, clone this repository, then run:

   ```bash
   bun run local # installs/prepares if needed, builds, and prints the load-unpacked path
   ```

   Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose `build/chrome-mv3`.

After any installation: add your OpenRouter key in side-panel settings (BYOK; encrypted and used only in the service worker), optionally connect a backend in the MCP tab, then open a page and start designing.

For a source live-reload loop, run `bun install && bun run dev` (WXT dev server, HMR).

| `bun run local` | |
|--|--|
| *(no flags)* | chrome, plain build → `build/chrome-mv3` |
| `--firefox` | firefox MV2 → `build/firefox-mv2` — **experimental**: the toolbar button toggles the sidebar, but every `chrome.debugger`-backed tool (screenshots, device emulation, responsive scan, visual inspect) is unavailable there, and the build has no real-Firefox test coverage |
| `--check` | run the gate (lint + typecheck + unit + integration) first |
| `--zip` | also produce the distributable `.zip` |

Chrome source builds sign `build/designer-<version>-chrome-mv3.crx` with `keys/designer.pem` (generated on first build and gitignored). Back it up: it defines the extension ID.

Release build (tree-shaken, minified, optimized CSS/JS):

```bash
bun run release            # build + sign .crx + zip → build/*.zip, build/*.crx
```

## Stack

| Component | Technology |
|-----------|-----------|
| Extension | Chrome MV3 — side panel, content scripts, service worker |
| UI | [SolidJS](https://www.solidjs.com/) + SCSS — prebuilt static bundle (CSP-clean) |
| Agent | [Vercel AI SDK](https://github.com/vercel/ai) loop in the service worker, BYOK |
| Inference | [OpenRouter](https://openrouter.ai/docs) — model-agnostic |
| Handoff | [MCP](https://modelcontextprotocol.io/) → [developerz.ai](https://developerz.ai) |
| Build | [Bun](https://bun.sh/) + TypeScript + [WXT](https://wxt.dev/) |
| Tests | [Vitest](https://vitest.dev/) unit + integration, [Playwright](https://playwright.dev/) E2E |
| Lint | [Biome](https://biomejs.dev/) |

## Docs

| | |
|--|--|
| [docs/](docs/README.md) | The docs index — one row per area and per docs-root page |
| [docs/idea/](docs/idea/README.md) | Vision, the design→ship loop, principles, surfaces |
| [docs/architecture/](docs/architecture/README.md) | Components, MV3 worlds, agent loop, handoff, security, ADRs |
| [docs/wiki/](docs/wiki/README.md) | User guide: install, copy/debug modes, ship-or-report, history, keys |
| [Privacy policy](docs/architecture/privacy.md) | Data handling: BYOK inference, ephemeral edits, changeset-only durable output |
| [docs/RELEASING.md](docs/RELEASING.md) · [docs/STORE-SETUP.md](docs/STORE-SETUP.md) · [docs/store/LISTING.md](docs/store/LISTING.md) | Release: tag → signed build → GitHub Release. Store accounts + the CI secrets to publish. The paste-ready dashboard listing |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [store/README.md](store/README.md) | Setup, checks and conventions; the store assets and how to regenerate them |

## Status

**v1.1.0 shipped.** The Chrome extension provides side-panel chat, live DOM/CSS edits with changesets and undo/redo, and user-triggered MCP handoff to developerz.ai for a real code change and PR; it can download a Markdown report when no backend is connected.

**Planned work.** Continue improving the design loop, diagnostics, browser control, and connected-backend workflows; see the [roadmap](docs/idea/roadmap.md).
