# ADR 0001 — Side panel as primary UI surface

**Status:** accepted

## Context

The design conversation must outlive page reloads and navigation, run its own UI safely, and not fight the target page's CSS/z-index. Options: popup, injected in-page panel, devtools panel, side panel.

## Decision

Use the Chrome MV3 **side panel** as the primary UI. Render a prebuilt SolidJS app there.

## Consequences

- ✅ Survives navigation/reload — the chat + changeset persist across page changes.
- ✅ Own extension origin + CSP — safe to run the agent UI; holds no page trust.
- ✅ No z-index/style war with the page (unlike an injected panel).
- ➖ Side panel is Chromium-recent; Firefox parity needs the sidebar API (handled via WXT targets).
- ➖ DOM access still requires a content script — UI and DOM stay in separate worlds (see [../mv3-worlds.md](../mv3-worlds.md)).
