# Contributing

Developerz.ai Designer — Chrome MV3 extension. Chat → live-edit the page → ship the change as a real PR via MCP.

## Setup

```bash
bun install        # also runs `wxt prepare` (generates types)
bun run dev        # WXT dev build + HMR
```

Load the extension:

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `.output/chrome-mv3`.
3. Open the side panel, add your **OpenRouter** key (BYOK, stored locally), connect an MCP backend (ai-dev).

`just` users: `just dev`, `just verify`, `just build` (see `justfile`).

## Dev loop

| Step | Command |
|------|---------|
| Dev (HMR) | `bun run dev` |
| Verify (gate) | `bun run lint && bun run typecheck && bun run test:unit && bun run test:integration` (or `just verify`) |
| Build | `bun run build` → `.output/chrome-mv3` |
| Release zip | `bun run release` |

## Architecture rules (load-bearing)

MV3 three worlds — keep them separate:

- **Keys + network → service worker only** (`src/entrypoints/background.ts`). Never in a content script.
- **DOM → content script only** (`src/entrypoints/content.ts`). Proxy via the typed Zod bus.
- **UI → side panel only** (`src/entrypoints/sidepanel/`).
- No remote code / `eval`. Service worker is ephemeral — persist state to `chrome.storage.session`.

SolidJS + SRP:

- One component = one `.tsx` + co-located `.scss` (same basename).
- No business logic in components — it lives in `src/agent|dom|mcp|changeset`.
- Tokens in `src/styles/_tokens.scss`; don't hardcode token values.

Full detail: `CLAUDE.md`, `docs/architecture/`, `.claude/skills/`.

## Tests

- New module → unit test (`test/unit/`). New cross-world flow → integration test (`test/integration/`).
- Mock the model + network; run selector/changeset/schema logic for real. See `docs/idea/testing.md`.

## Commits & PRs

- Conventional-ish: `feat:`, `fix:`, `docs:`, `chore:`, `test:`.
- PR must be green (CI runs lint, typecheck, unit, integration, build in parallel on Blacksmith 2vcpu).
- Keep PRs small + SRP. Never commit keys/tokens — BYOK.
- Never force-push shared branches.
