# 09 — On-page agent-decision overlay (opt-in)

> Part of [`overview.md`](overview.md). Depends on: 04 (stream events), 05 (picker/overlay host). World: **content script** (renders) fed by **service worker** stream. Spec: `.codegraph/vision.txt` ("inject … a bit overlay on the site … see how the agent operates"), `docs/idea/ui.md:19-23`.

## Why
Optional overlay injected on the page showing how the agent operates live — its decisions, current tool call, targeted element — so the user watches it work in context (not only in the panel). Focus/picker plumbing already exists (`stores/focus.ts`, `SwToPanel` `focus`/`picker-state`, `relay.ts`); add an agent-decision surface.

## Files to change
- `src/dom/overlay.ts` — **new** (content). Shadow-DOM overlay host (isolate from page CSS): renders the current step ("querying .hero", "setStyle → padding"), highlights the element the agent is acting on (reuse picker highlight from 05), a compact step log. Toggle on/off; never blocks page interaction (pointer-events tuned).
- `src/shared/messages.ts:227-238` — reuse `SwToPanel` `tool-call`/`step-start` (from 04); add a `ContentToSw`/config flag `overlay-enabled`. The SW forwards agent step events to the content script (not only the panel) when the overlay is on.
- `src/entrypoints/background.ts` — when overlay enabled, mirror step/tool-call events to the active tab's content script.
- `src/entrypoints/content.ts` — mount/unmount `dom/overlay.ts` on the enable flag; render forwarded events.
- `src/entrypoints/sidepanel/components/` — an overlay toggle (in `ReadinessDropdown` 03 header or composer 11); persists in `chrome.storage.local`.

## Steps
1. `dom/overlay.ts`: shadow-host, step-log + element highlight, non-blocking; enable/disable.
2. SW forwards agent step events to content when enabled (add tab-targeted send).
3. Wire toggle in the panel; persist preference.
4. Reuse 05's highlight rendering to avoid duplication.

## Tests
- Unit (jsdom): overlay mount/unmount; renders a step event; highlight targets a selector; disabled = no DOM added.
- Integration: `tool-call` stream event with overlay enabled → content receives + renders; disabled → nothing forwarded.
- E2E: enable overlay → run a turn → overlay shows steps + highlights the mutated element; toggle off removes it.
- `bun run typecheck`, `bun run lint`.

## Done when
- With the overlay enabled, the page shows the agent's live decisions + highlights the element under action, non-blocking, CSS-isolated.
- Toggle persists; disabled adds nothing to the page. Gate green.
