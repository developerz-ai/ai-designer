# Reviewer instructions — developerz-ai/ai-designer

> Read by the developerz.ai reviewer at EVERY review of this repository, at the reviewed
> commit, as this repo's own layer of the reviewer's prompt — established by dz-runner setup mode.
> It refines the platform rules (a finding is cited or withheld; the bot always discloses)
> and never overrides them. Edit freely; keep it under 12,000 characters — past that it is cut.

## Stack

Bun + TypeScript + WXT + SolidJS. The gate is `bin/check` (`bun run verify`): a change that does not pass it is not proven, whatever its description says.

## Review conventions

- Hold every change to the three MV3 worlds: keys and network in the service worker only, DOM in the content script only, UI in the side panel only.
- Block any secret (OpenRouter key, MCP token) reachable from a content script or the page world.
- Block remote code, `eval`, `new Function`, or a dynamic import of remote code.
- Block business logic inside a Solid component — logic belongs in `src/agent/`, `src/dom/`, `src/mcp/`, `src/changeset/`.
- Block any cross-world message that is not Zod-validated in `src/shared/`, and any `any` on the bus.
- Block persisting live-page mutations to a server; the only durable output is the changeset plus the report.
- Block any handoff that fires without an explicit user action.
- Require a co-located `.scss` with the same basename for every new component, and tokens from `src/styles/_tokens.scss` instead of hardcoded values.
- Require a unit test for a new module and an integration test for a new cross-world flow.
- Require every new DOM primitive to be reversible and to emit a recorder event.
- Keep the manifest permission set least-privilege: a new permission needs a reason and a matching update to `test/unit/manifest-invariant.test.ts`.
- Keep service-worker state rehydratable from `chrome.storage.session` — no in-memory `Map` as the only copy.
- Flag a file over 200 LOC and a CSS-path selector that is not marked `fragile: true`.

## Gates that matter

- `bun run verify` is the gate: Biome lint, `tsgo --noEmit` typecheck, then unit + integration in one Vitest pool. A pull request is proven only when this is green on a clean checkout.
- CI adds `Build extension` (`bun run release`) and `Test (e2e)` (Playwright on the loaded extension); both are required checks before merge.
- `bun run gate` is the local full gate (verify + build + e2e); `bun run check` is lint + typecheck only.
- A change under `src/entrypoints/sidepanel/**` also needs `bun run build` — a passing typecheck is not the UI working.
- `bun run test:changed` runs only the specs related to the diff, for a fast inner loop.
- Manifest, permission and i18n changes are proven by `test/unit/manifest-invariant.test.ts` and the generated `_locales` output.

## Never flag

- Formatting or import order — Biome owns it and `bun run lint:fix` settles it.
- Generated or vendored output: `.wxt/`, `build/`, `coverage/`, `keys/*.pem`, `site/dist/`, `docs/design/designer/`.
- `site/` and `waitlist/` — separate sub-projects with their own lockfiles, workflows and CI.
- The worker caps (`DZ_TEST_WORKERS`, `DZ_E2E_WORKERS`) and the deliberately un-parallelized local suite — they keep a shared dev box responsive.
- Long explanatory comments next to a non-obvious decision — the house style asks for the reason, not just the rule.
- The unit / integration / e2e split and the `*.test.ts` / `*.spec.ts` naming — the repo's own convention.
- The MV3 architecture, the BYOK provider model and the MCP handoff — those are the product, not a smell.

