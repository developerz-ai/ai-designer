## Task List

I'll explore the codebase to create a comprehensive plan for adding GlitchTip/Sentry error tracking to this Chrome extension.Explore the codebase structure to understand:

1. Entry points - find ALL entry points defined in the extension. Look for:
   - wxt.config.ts or similar build config
   - manifest.json or manifest configuration
   - src/entrypoints/ directory structure
   - Any background/service worker files
   - Any content script files
   - Any popup/sidepanel files

2. Package configuration - find:
   - package.json (dependencies and scripts)
   - Any lock files (bun.lockb, package-lock.json, etc.)

3. MV3 configuration - find:
   - Where host_permissions are configured
   - Where CSP is configured
   - Any permissions-related configuration

4. Build and test configuration:
   - wxt.config.ts or similar
   - vitest config files
   - biome config
   - tsconfig

Use medium breadth - check the main configuration locations and entry points.

Return a structured summary with file paths and key findings for each area.Based on my exploration, here's the master plan for adding GlitchTip error tracking:

---

# MASTER PLAN: GlitchTip Error Tracking Integration

### PR 1: Add Sentry + GlitchTip MCP Config

**Architecture:** Sentry client initialized in each MV3 execution world (SW, content script, sidepanel) with shared DSN. Host permission added for ingest endpoint. .mcp.json for MCP discovery.

- [x] `[coding]` Add @sentry/browser dependency
  - `package.json` — add `"@sentry/browser": "^8.0.0"` to dependencies

- [x] `[coding]` Add GlitchTip host permission
  - `wxt.config.ts:26` — add `'https://glitchtip.infra.developerz.ai/*'` to `host_permissions` array

- [x] `[coding]` Create Sentry init module (shared helper)
  - `src/shared/sentry.ts` — new file: export `initSentry()` helper with guards for empty DSN, environment detection, release from package.json version

- [ ] `[coding]` Initialize Sentry in service worker
  - `src/entrypoints/background.ts:1` — import `initSentry` from `@/shared/sentry`
  - `src/entrypoints/background.ts:19` — call `initSentry()` at top of `defineBackground` callback (earliest possible)

- [ ] `[coding]` Initialize Sentry in content script
  - `src/entrypoints/content.ts:1` — import `initSentry` from `@/shared/sentry`
  - `src/entrypoints/content.ts:11` — call `initSentry()` at top of `main()` function

- [ ] `[coding]` Initialize Sentry in side panel
  - `src/entrypoints/sidepanel/main.tsx:1` — import `initSentry` from `@/shared/sentry`
  - `src/entrypoints/sidepanel/main.tsx:5` — call `initSentry()` before render (after root check, line 7)

- [ ] `[coding]` Create .mcp.json at repo root
  - `.mcp.json` — new file: `{"type":"http","url":"https://glitchtip.infra.developerz.ai/mcp"}`

- [ ] `[general]` Add unit test for Sentry init helper
  - `test/unit/sentry.test.ts` — new file: test guard for empty DSN, verify options passed to Sentry.init (integrations for unhandled error + promise rejection)

- [ ] `[general]` Verify gate passes
  - Run `bun run lint`, `bun run typecheck`, `bun run test:unit`, `bun run test:integration` — all must pass

---

## Success Criteria

1. **Builds clean:** `bun run build` completes without errors, extension loads in Chrome
2. **Gate passes:** `bun run lint`, `bun run typecheck`, `bun run test:unit`, `bun run test:integration` all green
3. **DSN committed:** Public GlitchTip DSN in `src/shared/sentry.ts` (safe to ship)
4. **Host permission granted:** `glitchtip.infra.developerz.ai` in `host_permissions`
5. **.mcp.json exists:** At repo root with correct HTTP MCP endpoint

---

## Implementation Notes

**Sentry.init options (src/shared/sentry.ts):**
```typescript
import * as Sentry from '@sentry/browser';

const DSN = 'https://bf037adaf792452d8b77377abb682bd4@glitchtip.infra.developerz.ai/2';

export function initSentry() {
  if (!DSN) return; // guard
  const release = `@developerz-ai/designer@${VERSION}`; // from package.json
  const environment = 'production'; // or detect via chrome.runtime.getManifest()
  
  Sentry.init({
    dsn: DSN,
    release,
    environment,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration(), // optional
    ],
    tracesSampleRate: 1.0,
    // Capture unhandled errors + promise rejections by default
  });
}
```

**Three-world MV3 consideration:** Each execution context needs its own Sentry.init call (service worker, content script, sidepanel). No shared state across worlds.

**PLANNING COMPLETE**