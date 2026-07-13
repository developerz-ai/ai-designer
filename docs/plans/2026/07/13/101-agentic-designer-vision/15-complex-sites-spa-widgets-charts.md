# 15 — Complex sites: SPA, shadow DOM, widgets, canvas/WebGL charts

> Part of [`overview.md`](overview.md). Depends on: 05 (DOM/picker/selector), 13 (control + vision + frames), 14 (describe/identity). World: **content script** (+ a **page-world (MAIN)** bridge) + **service worker** (vision). This is the robustness slice — without it the agent breaks on real apps.

## Why
Real sites are SPAs with async hydration, **web-component widgets behind shadow DOM** (datetime pickers, comboboxes, sliders, modals), **virtualized lists**, and **real charts drawn on `<canvas>`/WebGL/SVG that have no inspectable DOM**. Today `selector.ts:121` `cssPath` walks `parentElement` to the document root — it **can't pierce shadow roots**; the isolated content world **can't read page JS** (Chart.js/ECharts instances, framework internals); there's no hydration-await. The agent must **see, think, and control** these, not just simple static DOM.

## Capability gaps + approach

**A. SPA / framework detection + hydration awaiting**
- Detect framework (React/Vue/Svelte/Angular/Solid/Next/etc.) + chart/UI libs from globals + markers → **page-facts** (cache per URL for the session; `agent.md` Memory). Feeds `frameworkHints` on edits (better source-mapping) + selector strategy.
- **Await quiescence** before reading/acting: framework-ready signal + `MutationObserver` idle + network-idle + `requestIdleCallback`. Extend 13's `waitFor` with a `hydrated`/`quiescent` condition. SPA client-side route changes: detect `history.pushState`/`popstate`, re-derive page-facts.

**B. Shadow DOM + web components**
- Extend `src/dom/selector.ts` (`resolveSelector`/`pickUnique`/`cssPath`) to be **shadow-aware**: walk `composedPath()` / `getRootNode()`; emit a shadow-crossing selector as an **ordered host-path** (`hostSelector >>> innerSelector` segments — since CSS `querySelector` can't cross shadow boundaries, resolution replays the path root→host→shadowRoot→…). Add a `shadow` strategy to `SelectorStrategy` (`src/shared/changeset.ts:7`).
- **Open** roots: pierce + resolve. **Closed** roots: cannot pierce — flag `fragile` + fall back to **coordinate/vision** interaction (13 screenshot + click-at-point). Document the limit.
- Picker (05, `PickerCmd`) must resolve which shadow root / frame an element lives in and tag the pick accordingly (extends the 13 `{tabId, frameId}` target with a shadow host-path).

**C. Virtualized / dynamic content**
- Lists that render on scroll: `scrollTo` + `waitFor(quiescent)` + re-`query`; don't assume the DOM is complete. Bounded scan (cap passes, `log` truncation).

**D. Complex-widget interaction recipes** (built on 13 control tools)
- A small **recipe library** `src/dom/widgets.ts` for common patterns the agent invokes: **datetime/date-range pickers** (open → navigate months → pick), **combobox/autocomplete** (focus → type → wait options → arrow/Enter), **slider** (focus → arrow keys / drag to value), **toggle/switch**, **modal/dialog** (open/confirm/dismiss + focus-trap aware), **tabs/accordion**, **carousel** (next/prev + wait), **drag-drop** (pointer sequence). Each is a sequence of `click/type/pressKey/hover/waitFor` with the widget's ARIA contract (`role=combobox/listbox/dialog/slider`) as the anchor — robust to styling.

**E. Canvas / WebGL / SVG "real charts"**
- Canvas/WebGL charts have **no element per data point** → the agent **reads them with vision** (13 `screenshot` + 14 `describe`/`inspectVisually`: "what does this chart show — axes, series, trend, outliers?").
- Also **probe the underlying data via the page-world bridge**: detect the chart lib (Chart.js `Chart.instances`, ECharts `echarts.getInstanceByDom`, Highcharts `Highcharts.charts`, D3 `__data__`, Recharts/SVG DOM) and extract series/labels when reachable — richer than pixels. SVG charts: real DOM, but per-datum; use `readImages`/`describe` + DOM.
- Interaction: hover a data region → read the tooltip DOM that appears (many canvas charts render HTML tooltips) → captures values without pixel-reading.

**F. Page-world (MAIN) bridge** — new mechanism
- `src/entrypoints/injected.ts` — **new**, runs in the page's **MAIN world** (`world: 'MAIN'` content script or injected `<script>`), the only place that can read page JS globals (framework internals, chart instances). It exposes a **narrow, read-mostly** RPC to the isolated content script via `window.postMessage` with an origin/nonce guard. **Never** carries keys/secrets (three-worlds: MAIN world == page world, untrusted). Used for framework/chart detection + data extraction only.

## Files to change
- `src/dom/selector.ts:41-137` — shadow-aware resolution + host-path selectors; add `shadow` strategy.
- `src/shared/changeset.ts:7` + `src/shared/messages.ts` — `SelectorStrategy` gains `shadow`; add `PageFacts`, `WidgetRecipe`, `ChartRead` schemas + `describe`/`waitFor` condition extensions.
- `src/dom/page-facts.ts` — **new** (content). Framework + lib detection (via injected bridge), cached per URL.
- `src/dom/widgets.ts` — **new** (content). The recipe library (D).
- `src/dom/charts.ts` — **new** (content). Chart-lib detection + data extraction via the bridge; falls back to vision.
- `src/entrypoints/injected.ts` — **new** (MAIN world) + register in `wxt.config.ts` (a `world: 'MAIN'` content script or `chrome.scripting.executeScript({ world: 'MAIN' })`).
- `src/entrypoints/content.ts` — quiescence/hydration await; route widget/chart/page-facts requests; postMessage bridge client (origin+nonce guarded).
- `src/agent/tools/*` (04/13/14) — expose `waitFor(hydrated|quiescent)`, `readChart`, and let `describe`/`inspectVisually` target charts; register `page-facts` as agent context.
- `src/agent/system-prompt.ts` (04) — teach the doctrine: **detect SPA/framework first; await hydration; for shadow/closed or canvas, switch to vision + coordinates; use ARIA contracts for widgets; probe chart data before pixel-reading.**

## Steps
1. `injected.ts` MAIN-world bridge (postMessage + nonce/origin guard, read-only); page-facts detection.
2. Shadow-aware `selector.ts` (+ `shadow` strategy) + picker frame/shadow tagging.
3. `waitFor(hydrated|quiescent)`; SPA route-change re-derivation.
4. `widgets.ts` recipe library keyed on ARIA roles.
5. `charts.ts` lib-detection + data extraction; vision fallback via 13/14.
6. Wire page-facts into agent context + `frameworkHints`; extend the system prompt doctrine.

## Tests
- Unit (jsdom): shadow-aware `resolveSelector` produces + replays a host-path selector (open root); closed root → `fragile` + vision fallback flag; `page-facts` detects a framework from injected markers; widget recipe emits the right event sequence for a `role=combobox` fixture.
- Integration: MAIN-world bridge round-trip (postMessage nonce guard rejects spoofed origin); `readChart` extracts series from a mock Chart.js global, falls back to `describe` when absent; `waitFor(quiescent)` resolves after mutations settle + times out.
- E2E (loaded extension): drive a real datetime picker + a combobox on a fixture SPA; read a `<canvas>` chart via vision + via the bridge; virtualized list scroll-to-load + re-query.
- `bun run typecheck`, `bun run lint`.

## Done when
- Agent detects SPA/framework + waits for hydration before acting; survives client-side route changes.
- Agent resolves + drives elements inside **open shadow DOM / web-component widgets** (datetime pickers, comboboxes, sliders, modals) via ARIA-anchored recipes; closed-shadow/canvas fall back to vision + coordinates, flagged fragile.
- Agent **reads real charts** (canvas/WebGL/SVG) via vision **and** via a guarded MAIN-world data probe; never leaks secrets to the page world.
- Virtualized content is scanned by scroll+re-query. Gate green.
