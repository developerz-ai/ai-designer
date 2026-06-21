---
name: live-edit
description: Implement or modify the in-browser live-edit engine — DOM mutation primitives, the element picker, stable-selector heuristics, and the changeset recorder. Use when touching src/dom, src/entrypoints/content.ts, or src/shared/changeset.ts, or when the task mentions live editing, DOM tools, selectors, or recording changes.
---

The live-edit engine runs in the **content script** (the only world with DOM access). See `docs/idea/live-edit.md` and `docs/architecture/changeset.md`.

## Rules

- Mutations are **ephemeral** and **reversible**. Apply CSS via an injected `<style>`, never inline styles you can't cleanly revert. Reload = clean page.
- Every accepted mutation emits a recorder event → one `Edit` in the `Changeset` (`src/shared/changeset.ts`).
- The content script has DOM but **no keys/network** — it talks to the service worker over the typed bus (`src/shared/messages.ts`).

## Stable selectors (`src/dom/selector.ts`)

Resolution order — most stable first:

1. `data-testid` / stable `data-*`
2. non-generated `id`
3. ARIA role + accessible name
4. unique text content
5. scoped CSS path → flag `fragile: true`

Always record the strategy used + fragility flag so the dev-agent can re-find the element in source.

## Capture per edit

Selector (+ strategy, fragility) · changed computed props only (before/after) · before/after screenshots · framework hints (Tailwind/CSS-module/styled markers) · the user's **intent** in words.

## When adding a mutation primitive

1. Add it to the content-script handler + the `DomTool` message schema (`src/shared/messages.ts`).
2. Make it reversible + emit a recorder event.
3. Expose it as an AI SDK `tool()` with a Zod `inputSchema` (see `docs/reference/agent-sdk.md`).
4. Unit-test the pure parts (selector/diff) under `test/unit/`.
