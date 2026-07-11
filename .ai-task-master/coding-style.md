# Coding Style

## Workflow

- **Gate before commit:** `bun run lint && bun run typecheck && bun run test:unit && bun run test:integration` (or `just verify`).
- PR must be green — CI runs lint, typecheck, unit, integration, build in parallel.
- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`. Keep PRs small + SRP. Never force-push shared branches.
- New module → unit test. New cross-world flow → integration test.

## Code Style

- **Format:** 2-space indent, 100 char width, LF endings, single quotes, always semicolons, trailing commas everywhere, always parenthesized arrow params.
- **Imports:** `useImportType`/`useExportType` enforced — use `import type` for types. Organize imports on (Biome assist). Path alias `@/*` → `./src/*`.
- **Strict TS:** `noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `isolatedModules` all on. No `any` (linter error). Avoid non-null assertions (warn).
- **SolidJS + SRP:** One component = one `.tsx` + co-located `.scss` (same basename). No business logic in components — logic lives in `src/agent/`, `src/dom/`, `src/mcp/`, `src/changeset/`. Components render + dispatch only. State via signals/stores; never prop-drill more than one level — lift to a store. Derive with `createMemo`; side effects in `createEffect`. No manual DOM in components.
- **SCSS:** Co-located, scoped to root class (`.chat-panel { ... }`), BEM-ish children. Tokens (colors, spacing, radius) in `src/styles/_tokens.scss` — never hardcode a hex/px that exists as a token.

## Testing

- **Unit:** `test/unit/**/*.test.ts` — run `bun run test:unit`. One test per new module. Mock model + network; run selector/changeset/schema logic for real.
- **Integration:** `test/integration/**/*.test.ts` — run `bun run test:integration`. Required for any new cross-world flow.
- **E2E:** Playwright — `bun run test:e2e`.
- **All tests:** `bun run test` (Vitest). Watch: `bun run test:watch`.
- **Glob:** `**/*.test.ts`.

## Project-Specific

**MV3 three worlds — load-bearing, never cross them:**

| Concern | Allowed location | Forbidden |
|---|---|---|
| Keys + network | Service worker (`src/entrypoints/background.ts`) | Content script, side panel |
| DOM access | Content script (`src/entrypoints/content.ts`) | Service worker |
| UI | Side panel (`src/entrypoints/sidepanel/`) | Either other world |

- Messages between worlds: Zod-validated in `src/shared/`. No `any` across the bus.
- Service worker is ephemeral — persist state to `chrome.storage.session`.
- No remote code, no `eval` — Solid is prebuilt to static JS.
- BYOK — OpenRouter key stored encrypted in `chrome.storage.local`, never in repo. Never commit secrets.
- Only durable output = changeset → PR. Never persist live page mutations to any server.
- "Ship" is always user-triggered — never auto-ship.
- House style for docs/config: lead with the rule, fragments over sentences, tables for structured data, no meta-framing.
