# Coding Style

## Workflow

- TDD encouraged: write tests before implementation
- Pre-commit gate: `bun run lint`, `bun run typecheck`, `bun run test:unit`, `bun run test:integration` must all pass
- New modules require unit tests; cross-world flows require integration tests
- No auto-ship — "Ship" is user-triggered

## Code Style

- **Formatting**: 2-space indent, 100-char line width, single quotes, semicolons always, trailing commas all, arrow parens always (Biome)
- **Imports**: Use `import type` for types-only imports (enforced)
- **No `any`**: Explicit `any` is an error; use proper types or `unknown`
- **File organization**: One responsibility per module. Split when files do two things

## Testing

- **Unit**: `test/unit/*.test.ts` — run with `bun run test:unit`
- **Integration**: `test/integration/*.test.ts` — run with `bun run test:integration`
- **E2E**: `test/e2e/*.spec.ts` — run with `bun run test:e2e`
- **Watch mode**: `bun run test:watch` (Vitest)
- Example: `test/unit/messages.test.ts`, `test/e2e/smoke.spec.ts`

## Project-Specific (MV3 + SolidJS)

- **Three worlds**: Keys/network in background service worker only; DOM access in content script only; UI in side panel only
- **Message bus**: Zod-validated messages between worlds; no `any` across the bus
- **SolidJS SRP**: One component per `.tsx` file with co-located `.scss` (same basename); no business logic in components
- **State**: Use signals/stores (`createSignal`, `createStore`); never prop-drill more than one level
- **SCSS**: Scope to root class (`.component-name { }`); use tokens from `src/styles/_tokens.scss` — never hardcode hex/px
- **Security**: No remote code, no `eval`; Solid is prebuilt to static JS; keys live in `chrome.storage.local` (BYOK), never committed