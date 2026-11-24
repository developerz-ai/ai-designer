# Reviewer instructions — developerz-ai/ai-designer

> Read by the developerz.ai reviewer at EVERY review of this repository, at the reviewed
> commit, as this repo's own layer of the reviewer's prompt. It refines the platform rules
> (a finding is cited or withheld; the bot always discloses) and never overrides them.
> `CLAUDE.md` is the source of truth; this file is its review-time distillation.
> Keep it under 12,000 characters — past that it is cut.

## Stack

Bun + TypeScript + WXT + SolidJS. The gate is `bin/check` (`bun run verify`): a change that does not pass it is not proven, whatever its description says.

Chrome MV3 extension (also built for Firefox). Agent: AI SDK (`ToolLoopAgent`) over an
OpenAI-compatible provider, BYOK. Handoff: MCP over Streamable HTTP (`@ai-sdk/mcp`) or a
Markdown report download. Zod on every message, SCSS co-located with components, Biome,
Vitest (unit + integration, jsdom) and Playwright (E2E on the built extension). `waitlist/`
and `site/` are separate deployables with their own CI (`waitlist.yml`, `site.yml`).

## What to reject

**The three MV3 worlds (load-bearing, `docs/architecture/mv3-worlds.md`)**
- A provider key, MCP token or any network call (`fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource`, an AI SDK or MCP client) outside the service worker
  (`src/entrypoints/background.ts`, `src/agent/`, `src/mcp/`, `src/changeset/`). A content
  script and the page world share the page's reach; a credential there is a leak.
- DOM access (`document`, `window` reads, `MutationObserver`) in the service worker or in
  `src/agent/`. The worker has no DOM: page reads and writes go over the typed bus to
  `src/entrypoints/content.ts` and `src/dom/`.
- UI outside `src/entrypoints/sidepanel/`.
- A message crossing worlds that is not parsed by a Zod schema in `src/shared/`, or `any` /
  an unchecked cast on a bus payload.
- In the MAIN-world bridge (`src/entrypoints/injected.content.ts`): `eval`, `new Function`,
  an injected `<script>`, a string-to-code path, or a `pageCall` path that skips the path
  guard or the identity check against an aliased `eval`/`Function`. Results crossing back
  from a hostile page must be marshalled, never trusted as typed.
- Remote code of any kind: a CDN script, a dynamic `import()` of a URL, a remote font or icon
  fetch (icons are FontAwesome SVG-core inline).
- A new `permissions` or `host_permissions` entry in `wxt.config.ts`. Host access is
  `activeTab` plus opt-in `optional_host_permissions`; widening it needs a reason in the
  PR and a matching line in the privacy docs (`docs/architecture/privacy.md`).

**Secrets and privacy (`docs/architecture/security.md`)**
- A key or token written anywhere but `chrome.storage.local` through the encrypted store
  (`src/agent/key-store.ts`), logged, rendered in the panel DOM, put in an error message or
  sent to anything but the user's chosen provider or MCP server.
- Page content, screenshots or changesets sent to any third party (telemetry, analytics,
  crash reporting with page data).
- A committed key, `.env` value or signing material (the CRX signing key is never committed).

**Architecture (SolidJS + SRP)**
- Business logic in a component. Components render and dispatch; logic lives in
  `src/agent/`, `src/dom/`, `src/mcp/`, `src/changeset/`.
- A component without its co-located `.scss` of the same basename when it has styles, or
  styles placed in another component's file.
- Prop drilling more than one level (lift to a store), manual DOM work in a component,
  derived state recomputed in a `createEffect` instead of a `createMemo`.
- A module doing two things (split it), or a file that grew a second responsibility.
- A hardcoded colour, spacing, radius or duration that exists as a token in
  `src/styles/_tokens.scss`.

**Changeset and handoff**
- A live page mutation persisted anywhere but the changeset. Reload must give a clean page.
- A mutation recorded without an undo that inverts it exactly.
- A brittle selector (nth-child chain, generated class hash) where the selector engine can
  give a stable one (data attribute, role, text).
- Shipping without an explicit user action: "Ship" is a button, never an inference. Any path
  that auto-ships, auto-merges or creates an MCP task without the user's click.
- An MCP task payload that drops the changeset or the report, or a Markdown report that no
  longer round-trips through `toMarkdown`.

**Tests (`docs/idea/testing.md`)**
- A new module without a unit test under `test/unit/`; a new cross-world flow without an
  integration test under `test/integration/`.
- A test that hits a live model, a real MCP backend or the network. Mock the model and the
  network; run selector, changeset and schema logic for real.
- A bug fix with no test that fails before it.
- A skipped, `.only`, or loosened assertion added to get green.

**CI and release**
- A change to `.github/`, `scripts/pack-crx.sh`, `scripts/crx-key.ts`, `store/` or `keys/` from
  an outside contributor (members own that pipeline; see the policy's `non_goals`).
- A CI job renamed, added or removed without the matching change to `scripts/verify.sh`,
  `bin/check`'s coverage table and `test/unit/check-pipeline.test.ts` (it parses `ci.yml` and
  fails on drift). A required check name must stay listed in `.dz/maintainer/maintainer.yml`.
- A version bump, tag or store submission outside a release PR. Releases are manual here.
- Internal infrastructure facts (private hostnames, internal zones, setup tooling names) in
  shipped code, the manifest or public docs: the public-tree guard
  (`test/unit/public-tree.test.ts`) refuses them.

## Gates that matter

- `Lint`, `Typecheck`, `Test (unit + integration)`, `Build extension`, `Test (e2e)` in
  `ci.yml`, plus `Waitlist tests` when `waitlist/` changes and `Public-tree guard`. A change is
  proven when those are green on its head; `bun run verify` is the local mirror of the first
  three.
- A change to the agent loop, the bus or a DOM tool is proven by a test that drives it, not by
  a description of manual testing.

## Never flag

- `build/`, `.wxt/`, `coverage/`, `dist/`, `bun.lock`, `docs/design/designer/`: generated,
  vendored or exported.
- Formatting and import order: Biome owns them (`bun run lint`).
- Mocked models in integration tests: deterministic agent-loop tests are the design.
- `bunx` in CI to resolve the Playwright version: intended.
- The `.dz/` directory's own layout: the platform owns it.
- Docs house style (fragments over sentences, tables): chosen on purpose.
