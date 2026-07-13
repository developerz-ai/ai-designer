# 16 — Responsive / mobile checking

> Part of [`overview.md`](overview.md). Depends on: 13 (viewport + screenshot + vision), 15 (quiescence), 05 (read). World: **service worker** (device emulation + capture) + **content script** (measure). Roadmap: v2 "Responsive capture" (`docs/idea/roadmap.md:36`) — pulled forward.

## Why
User: "also check how site looks on mobile". Sites are responsive; the agent must **see and test mobile/tablet/desktop**, not just the current viewport — copy needs "make it work on mobile like nvidia", debug needs "the nav is broken on phones", and edits should hold across breakpoints. `agent.md`'s catalog has `setViewport` but nothing drives multi-breakpoint capture or detects responsive problems.

## Emulation mechanism — decision needed
Real mobile emulation is more than a width change (needs DPR, touch, mobile UA, so media queries + `@media (pointer)` + UA-sniffing sites respond correctly):
- **Preferred**: `chrome.debugger` + CDP `Emulation.setDeviceMetricsOverride` / `setTouchEmulationEnabled` / `Network.setUserAgentOverride` for true device emulation (DPR, touch, UA). Requires the `debugger` permission (add to `wxt.config.ts`; note the visible "being debugged" banner — surface it to the user).
- **Fallback (no debugger perm)**: content-script viewport resize + `<meta viewport>`/DPR override + dispatch touch-capable flags — approximates layout, not UA/touch. Use when the user declines `debugger`.
- The executor picks per available permission; expose device **presets** either way (iPhone SE/15, Pixel, iPad, plus custom W×H).

## Tools / capability to add
| Tool | Args | Returns |
|------|------|---------|
| `setDevice` | `preset \| {width,height,dpr,touch,ua}` | applies emulation (CDP or fallback); returns applied metrics. |
| `responsiveCapture` | `breakpoints[]?` | screenshots across breakpoints (default mobile/tablet/desktop) → image set for the vision model + report. |
| `checkResponsive` | `Target?` | **responsive problem scan** at a breakpoint (see below). |

## Responsive problem detection (`src/dom/responsive.ts`, content)
Scan at each breakpoint for real mobile bugs:
- **Horizontal overflow** / unintended scroll (`scrollWidth > clientWidth`, offending elements).
- **Tap targets** too small (`< ~44×44px`) / overlapping.
- **Text** below legible size; content **clipped**/truncated; fixed widths forcing overflow.
- **Images/media** not scaling (`readImages` 13 at width); **layout break** (columns not stacking).
- **Nav**: hamburger present/works; off-canvas menu opens (drive via 13 + 15 recipes).
- **CLS / viewport-unit bugs** (`100vh` mobile browser chrome), sticky/fixed overlap.
Feed findings to debug mode (06) + the report (07).

## Files to change
- `src/dom/responsive.ts` — **new** (content). Overflow/tap-target/text/clip/scaling scans + measurements.
- `src/agent/tools/responsive.ts` — **new**. `setDevice` / `responsiveCapture` / `checkResponsive` `tool()`s.
- `src/entrypoints/background.ts` — CDP emulation via `chrome.debugger` (attach/detach lifecycle, restore on turn end); capture per breakpoint; fallback path.
- `src/shared/messages.ts` — `DevicePreset`, `ResponsiveFinding`, `ResponsiveCapture` schemas + DomTool/result variants; extend/keep `setViewport`.
- `wxt.config.ts:12-35` — add `debugger` permission (optional if fallback preferred); request at first responsive use, surface the debugging banner.
- `src/agent/system-prompt.ts` (04) + `modes.ts` (06) — doctrine: **check mobile + tablet, not just desktop**; when copying, match the reference's responsive behavior; record edits noting the breakpoint; flag responsive problems in debug.
- `src/changeset/*` + `07` report — record which breakpoint an edit targets; report responsive findings + per-breakpoint screenshots.
- `src/entrypoints/sidepanel/components/chat/Composer.tsx` (11) — optional device-preset quick toggle (desktop/tablet/mobile) for the user to steer.

## Steps
1. `responsive.ts` scans (overflow/tap/text/clip/scaling), measurement-based + bounded.
2. `setDevice` via CDP (attach `chrome.debugger`, set device metrics/touch/UA) + resize fallback; restore on turn end.
3. `responsiveCapture` (multi-breakpoint screenshots) + `checkResponsive` findings.
4. Wire into agent tools + system-prompt doctrine + debug mode + report.
5. Optional composer device toggle.

## Tests
- Unit (jsdom): `responsive.ts` detects overflow / small tap targets / non-scaling image on fixtures at a given width; `ResponsiveFinding` schema.
- Integration: `setDevice` applies metrics (mock `chrome.debugger`); fallback path when `debugger` denied; `responsiveCapture` returns N images; findings feed the report input.
- E2E (loaded extension): load a fixture with a mobile overflow bug → `checkResponsive` flags it; `responsiveCapture` yields mobile+desktop shots; an edit made at mobile is recorded with its breakpoint.
- `bun run typecheck`, `bun run lint`.

## Done when
- Agent emulates real devices (DPR/touch/UA via CDP, or an approximating fallback) and captures the page across mobile/tablet/desktop for the vision model + report.
- Agent detects responsive problems (overflow, tap targets, text size, clipping, non-scaling media, broken nav) and folds them into debug + the report.
- Copy matches a reference's responsive behavior; edits record their target breakpoint. Gate green.
