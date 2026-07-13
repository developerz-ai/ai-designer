# 13 — Browser-control + vision/image tools

> Part of [`overview.md`](overview.md). Depends on: 04 (tool derivation + loop), 05 (content DOM exec), 06 (browse). World: **content script** (interaction) + **service worker** (tabs/capture/vision). Inspiration: Playwright MCP tool set (`browser_navigate/click/type/wait_for/snapshot/take_screenshot/tabs/...`) — mirror the *capabilities*, but proxy over our typed bus, not Playwright.

## Why
User: "they need tools, how to control the browser and check images etc". Today the agent can read/mutate DOM (05) and snapshot a ref site (06) — but it can't **drive** the page (click a filter, scroll a carousel, fill a field, wait for a load, switch tabs) or **see/verify images** (read what's on screen, check a mutation looked right, spot broken/oversized images). Copy needs "scroll + capture the whole page"; debug needs "click the broken button, watch console, screenshot the failure". These are first-class agent tools.

## Tool catalog to add (each = `DomTool` schema in `messages.ts` + `tool()` in `src/agent/tools/`)

**Navigation / control (content script, proxied):**
| Tool | Args | Notes |
|------|------|-------|
| `navigate` | `url` | SW drives `chrome.tabs.update`; wait for load. |
| `navigateBack` / `reload` | — | history + reload. |
| `click` | `selector` \| focused-pick | uses `dom/selector.ts`; scrolls into view first. |
| `type` | `selector, text, submit?` | sets value + fires input/change; `submit` presses Enter. |
| `pressKey` | `key` | keyboard events. |
| `hover` | `selector` | pointer events (reveal menus). |
| `scrollTo` | `selector` \| `y` | element into view or absolute. |
| `selectOption` | `selector, value` | `<select>` / listbox. |
| `waitFor` | `selector? \| text? \| timeMs? \| networkIdle?` | resolve when condition met or timeout (bounded). |
| `tabs` | `action: list\|open\|close\|activate, ...` | multi-tab (copy = own tab + ref tab). SW-owned. |
| `handleDialog` | `accept, promptText?` | alert/confirm/prompt (`beforeunload` etc.). |

**Vision / images (SW does capture + feeds model):**
| Tool | Args | Notes |
|------|------|-------|
| `screenshot` | `selector? \| fullPage?` | extend 05: add **full-page** (scroll-stitch) + element crop. Returns PNG bytes → image content part for the **vision-capable** model (`agent-sdk.md:63-66`). |
| `readImages` | `selector?` | enumerate `<img>`/`background-image`: `src`, `alt`, natural vs rendered size, **broken** (naturalWidth 0), oversized/CLS risk. Debug + copy signal. |
| `inspectVisually` | `selector?, question` | screenshot the region → ask the vision model a question ("does the CTA contrast?", "is the hero image cropped?"); returns the model's verdict for self-correction. |

## Iframes + multiple tabs — load-bearing
The agent must operate across **frames** and **tabs**, not just the top document.

- **Iframes**: content scripts run **per-frame**. Set `all_frames: true` (WXT content-script config) so the script injects into child frames; give each frame a stable **frameId** (`chrome.webNavigation.getAllFrames` / message `sender.frameId`). Every DOM/control tool takes an optional `frame` target `{ frameId }` (or a frame-path selector for the picker). SW routes a tool to the right frame via `chrome.tabs.sendMessage(tabId, msg, { frameId })`.
  - **Cross-origin iframes**: no cross-frame DOM reach — each frame is addressed on its own via its injected script (never by reaching *into* it from the parent). Same-origin frames may be walked directly.
  - Picker (05) must resolve which frame an element lives in and tag the pick with `frameId`; `query`/`screenshot` results carry `frameId` + frame offset so coordinates compose.
  - `webNavigation` permission needed to enumerate frames — add to `wxt.config.ts`.
- **Other tabs**: the `tabs` tool (below) opens/activates/closes tabs; control/read/vision tools take an optional `tabId` (default = active tab). Copy = own tab + reference tab open simultaneously; the agent addresses each by `tabId`. SW owns the tab registry + per-tab session/changeset (`sessions` map, `background.ts:27`).

## Files to change
- `src/shared/messages.ts:98-129` — extend the `DomTool` union + typed `ToolResult` variants for every tool above (Zod, no `any`). Add `NavIntent`, `WaitCondition`, `ImageInfo`, `TabsCmd`, and a shared **`Target` = `{ tabId?, frameId? }`** carried by every DOM/control/vision tool. Add a `frames` tool (`action: list` → per-frame `{frameId, url, origin, isMain}`).
- `src/agent/tools/interact.ts` — **new**. `tool()` wrappers for navigate/click/type/pressKey/hover/scrollTo/selectOption/waitFor/handleDialog → bus → content.
- `src/agent/tools/tabs.ts` — **new**. `tabs` tool → SW `chrome.tabs.*` (SW-only; content can't).
- `src/agent/tools/vision.ts` — **new**. `screenshot` (full-page stitch) + `readImages` + `inspectVisually`; `inspectVisually` runs a **sub-call to the vision model** with the captured image and returns a verdict (keep cost-aware — only when asked, `agent.md:38-41`).
- `src/dom/interact.ts` — **new** (content). Real implementations: scroll-into-view + click, input/change dispatch, key events, hover, select, `waitFor` (MutationObserver + timeout), dialog handling.
- `src/dom/images.ts` — **new** (content). `readImages` enumeration + broken/oversize detection.
- `src/entrypoints/content.ts` — route the new DomTool cases into `dom/interact.ts` + `dom/images.ts` (extends the 05 dispatch); report its own `sender.frameId` so the SW can target it.
- `src/entrypoints/content.ts` config (WXT) — set `all_frames: true` + `match_about_blank` so child frames get the script.
- `src/entrypoints/background.ts` — `navigate`/`tabs`/`frames`/full-page-capture handlers (SW owns tabs + `captureVisibleTab` + `webNavigation.getAllFrames`); route tools with `chrome.tabs.sendMessage(tabId, msg, { frameId })`; scroll-stitch for full-page screenshot.
- `wxt.config.ts:12-35` — add `webNavigation` permission (frame enumeration).
- `src/agent/loop.ts` (04) — register the new tools; `system-prompt.ts` (04) — teach the agent when to drive vs mutate vs look (e.g. "to verify a visual change, `inspectVisually`; to reproduce a bug, `click`+`waitFor`+`screenshot`").
- `src/agent/budget.ts` (04) — count vision sub-calls; cap `waitFor`/navigation loops (don't spin).

## Steps
1. Schemas first (`messages.ts`) — all new tools typed end-to-end.
2. `dom/interact.ts` + `dom/images.ts` (content) with reversibility where relevant (navigation is not reversible — flag in changeset/report).
3. SW handlers: tabs lifecycle, full-page stitch capture, dialog.
4. `src/agent/tools/{interact,tabs,vision}.ts` derivations; register in the loop; extend the system prompt + budget.
5. Guardrails: `waitFor` bounded; `navigate` confirms before leaving an unsaved live-edit session (edits are ephemeral — warn, per `principles.md`); dialogs auto-handled only when the agent initiated the action.
6. Vision cost: `inspectVisually`/full-page screenshot only on demand; cheap model for control, vision model only when an image is in play (`agent-loop.md:46-49`).

## Tests
- Unit (jsdom): `dom/interact` click/type/scroll/waitFor (MutationObserver resolves + times out); `dom/images` broken/oversize detection; new `messages` schemas validate + reject bad input.
- Integration: each control tool over the bus → content effect → typed result; `waitFor` timeout path; `tabs` open/activate/close via mocked `chrome.tabs`; `inspectVisually` with a mocked vision model returns a verdict; abort cancels a pending `waitFor`.
- E2E (loaded extension, Playwright): agent drives a fixture — click a control, `waitFor` new content, full-page screenshot, `readImages` flags a broken `<img>`; navigate across two fixture pages.
- `bun run typecheck`, `bun run lint`.

## Done when
- Agent can navigate, click, type, hover, scroll, select, wait, and manage tabs on the live page via typed, bounded tools.
- Every DOM/control/vision tool accepts a `{ tabId?, frameId? }` target; the agent operates inside **iframes** (incl. cross-origin, each addressed via its own injected frame script) and across **multiple tabs** simultaneously.
- Agent can capture full-page + element screenshots, enumerate/verify images (broken/oversize), and ask the vision model to check its own result.
- Control + vision tools are budget-bounded and registered in the loop; navigation warns before discarding an ephemeral edit session. Gate green.
