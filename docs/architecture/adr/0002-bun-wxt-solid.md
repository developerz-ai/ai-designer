# ADR 0002 — Bun + WXT + SolidJS

**Status:** accepted

## Context

Need a fast, typed build for an MV3 extension with multiple entrypoints (service worker, content script, side panel), HMR in dev, and CSP-clean output (no remote code / eval). Team already standardizes on Bun + Solid across developerz.ai and tesote.ai.

## Decision

Build with **Bun** + **TypeScript**, **WXT** for the extension toolchain (manifest gen, entrypoints, cross-browser, HMR), and **SolidJS** (via `@wxt-dev/module-solid`) for the side panel UI. Styling in **SCSS**, components built to SRP.

## Consequences

- ✅ WXT handles MV3 boilerplate, manifest, and Firefox/Chrome targets.
- ✅ Solid prebuilds to static JS — satisfies MV3 CSP (no runtime eval).
- ✅ Consistent with sibling repos → shared mental model, easy cross-pollination.
- ✅ Bun = fast install/test/build in CI.
- ➖ Smaller ecosystem than React for extension-specific examples; mitigated by WXT docs.
