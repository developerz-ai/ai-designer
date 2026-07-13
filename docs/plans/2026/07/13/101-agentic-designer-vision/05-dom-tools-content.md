# 05 — DOM execution + picker + recorder (content script)

> Part of [`overview.md`](overview.md). Depends on: 04 (tools call in). World: **content script only** (DOM). Spec: `docs/idea/live-edit.md`, `docs/architecture/changeset.md`. Skill: `live-edit`, `scaffold-tool`.

## Why
`content.ts:22-47` `exec()` is entirely stubbed (returns empty ok); picker + recorder are TODO comments (`:58-59`). `relay.ts:15-19` has 2 TODO cases. Make the DOM tools real so the agent's calls (04) actually mutate the page and record edits.

## Files to change
- `src/dom/mutate.ts` — **new**. Real implementations for each mutation: `setStyle` (extend `ensureSheet` at `content.ts:49-56` with reversible per-element rules), `setText`/`setAttr`, `addClass`/`removeClass`, `insertNode`/`moveNode`/`removeNode`, `injectCss`, `setViewport`. Each **reversible** (store prior value) + returns computed result for the model.
- `src/dom/read.ts` — **new**. `query` (uses `src/dom/selector.ts` `resolveSelector` for stable selectors + fragility flag), `getStyles` (relevant computed subset), `a11ySnapshot` (role/name tree), `screenshot` (element crop / viewport — via `chrome.tabs.captureVisibleTab` proxied from SW, since content can't capture directly; content returns the crop rect, SW captures).
- `src/dom/picker.ts` — **new**. Element-picker overlay: hover highlight w/ tag + dims + resolved selector + fragility badge (`ui.md:19-23`); click → focus "this"; shift-click multi-select. Emits `ContentToSw` `pick` events (already in the union) → `relay.ts` → `focus` stream (plumbing exists in `stores/focus.ts`).
- `src/dom/recorder.ts` — **new**. Observe mutations → `MutationEvent` (`messages.ts:183-207`) → `ContentToSw`; SW builds the `Changeset` (`07`).
- `src/entrypoints/content.ts:22-59` — replace stubbed `exec()` switch with dispatch into `dom/mutate.ts` + `dom/read.ts`; init picker + recorder; keep the Zod gate (`:15-20`).
- `src/shared/relay.ts:15-19` — complete the 2 TODO cases (pick/mutation → stream events).
- `src/entrypoints/background.ts` — add `screenshot` capture handler (`chrome.tabs.captureVisibleTab`) the content script requests; only the SW has `tabs` capture.

## Steps
1. `dom/mutate.ts`: reversible primitives; each returns `{ok, computed}`; store undo info keyed by selector.
2. `dom/read.ts`: wire `selector.ts`; screenshot = content computes rect → asks SW to capture → returns PNG bytes to the tool result (for vision self-correction in 04).
3. `dom/picker.ts` + overlay chrome (shadow-DOM host to avoid page CSS bleed); emit picks.
4. `dom/recorder.ts`: mutation → event; finalize on `recordEdit` (04 session tool).
5. Rewrite `content.ts exec()` to route to the new modules; complete `relay.ts`.
6. Verify against a real loaded extension (skill: `test-extension`) — the SW-stub path from 04 now hits real DOM.

## Tests
- Unit (jsdom): `dom/mutate` reversibility (apply→undo restores); `dom/read` query returns stable selector + fragility; `relay.ts` new cases (extend `test/unit/relay.test.ts`).
- Integration: DomTool over the bus → real jsdom mutation → `ToolResult` shape; picker pick → `focus` stream event (extend `test/unit/focus.test.ts` path).
- E2E (Playwright, loaded extension): agent-driven `setStyle` visibly changes a fixture page; picker highlights + selects; screenshot returns bytes.
- `bun run typecheck`, `bun run lint`.

## Done when
- Every DOM tool mutates/reads the real page reversibly and returns a typed result the model can reason over.
- Picker overlay highlights + selects and streams focus to the panel; mutations record to the changeset.
- Screenshots flow back for vision self-correction. Gate green.
