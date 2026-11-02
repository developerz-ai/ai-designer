# Releasing

How a Developerz.ai Designer release is cut. Tag → CI builds the optimized zip → GitHub Release with the artifact attached.

## Versioning

**The git tag is the version.** `wxt.config.ts` reads `GITHUB_REF_NAME` (or `EXT_VERSION`
locally) and writes it into the manifest — nothing to bump by hand, nothing to keep in sync.

| Tag | manifest `version` | manifest `version_name` |
|--|--|--|
| `v1.4.0` | `1.4.0` | — |
| `v1.4.0-beta.1` | `1.4.0` | `1.4.0-beta.1` |
| *(branch push, no tag)* | `package.json` version | — |

Chrome's `version` is 1–4 dot-separated integers, so a prerelease suffix can only live in
`version_name`. Both stores reject an upload whose version is not **higher** than the
published one — always tag forward, never re-tag.

## Cut a release

```bash
git tag v1.4.0
git push origin v1.4.0
```

The `Release` workflow (`.github/workflows/release.yml`) then:

1. Installs deps (`bun install --frozen-lockfile`).
2. Builds the production Chrome zip + signed `.crx` (`bun run release` = `wxt build && pack-crx && wxt zip`). Signed with the `CRX_PRIVATE_KEY` repo secret when set — that key fixes the extension ID.
3. Builds the Firefox zip (`wxt build -b firefox && wxt zip -b firefox`).
4. Creates a GitHub Release with auto-generated notes, both `.zip`s and the `.crx` attached from `build/`.
5. **Publishes to the Chrome Web Store** — only when the `CWS_*` repo secrets are set ([STORE-SETUP.md](STORE-SETUP.md)); without them the step skips and the tag is a GitHub-Release-only build. The store zip is rebuilt with `CWS_UPLOAD=1` (drops the manifest `key`) and uploaded with `--auto-publish`, so a green tag goes straight into store review.

`workflow_dispatch` is also enabled for manual runs.

Store listing content (description, screenshots, permission justifications) lives in
[store/LISTING.md](store/LISTING.md); regenerate the screenshots with `bun run store:shots`.

## The optimized build

Production builds go through WXT → Vite → Rollup:

- **Tree-shaking** — dead code eliminated across ES modules (background, content, side panel are separate entrypoints, each shaken independently).
- **JS minify** — esbuild minifier, `target: esnext`.
- **CSS minify** — SCSS compiled and minified (`cssMinify`), per-entrypoint.
- **No sourcemaps** in release (smaller zip; flip on for debugging).
- Output: one zip per browser target under `build/`, plus a signed `.crx` for Chrome.

Dev builds (`bun run dev`) skip minification for fast HMR.

## CI gate

Every push/PR runs `.github/workflows/ci.yml` first — six jobs:

| Job | Command | Needs |
|--|--|--|
| `lint` | `bun run lint` (Biome) | — |
| `typecheck` | `bun run typecheck` (tsgo) | — |
| `test` | `bun run test` — **one** job, unit + integration in a single `vitest run` | — |
| `build` | `bun run release` (build + zip) | `lint`, `typecheck` |
| `test-e2e` | `bun run build`, then `bun run test:e2e` | `lint`, `typecheck` |
| `actionlint` | `./actionlint -color`, pinned to 1.7.12 | — |

`build` and `test-e2e` wait on the two cheapest jobs only — the `test` job is off the critical path. A tag won't produce a usable release if any of the six is red — fix main first.

### The local mirror

`bin/check` runs the same six gates, in this order:

1. `bun run verify` — lint + typecheck (concurrent), then the unit + integration suite.
2. `bun run release` — the `build` job (build + zip).
3. `bun run test:e2e` — the `test-e2e` job; locally it reuses the release build, CI builds independently.
4. `actionlint -color` — the `actionlint` job, last.

It installs nothing and downloads nothing. `actionlint` resolves from an executable `./actionlint` in the repo root, else `actionlint` on `PATH`.

**A missing actionlint is reported, not fatal.** With neither path present, `bin/check` prints a loud warning on stderr naming the CI job it mirrors (`actionlint`), the pinned version (1.7.12), the release URL (<https://github.com/rhysd/actionlint/releases/tag/v1.7.12>) and the literal token `NOT RUN` — then runs the remaining gates and exits 0 if they pass. `bin/setup` never provisions actionlint, so this is the default on a fresh box.

With actionlint present it runs last, and a non-zero exit fails the gate — no later command runs. Once every gate passes, `bin/check` prints a coverage summary: each ci.yml job and whether it ran locally, `NOT RUN` for a skipped actionlint.

`.githooks/pre-commit` execs `bin/check`, so a commit that would fail CI fails here first. One exception: with no actionlint installed locally, `bin/check` skips the `actionlint` job and still exits 0, so a commit that only fails CI's actionlint job passes the hook and is caught by CI instead.

### Other workflows are separate pipelines

`release.yml`, `site.yml`, `site-deploy.yml`, `waitlist-deploy.yml` and `store-assets.yml` are their own pipelines with their own gates — `site.yml` lints, typechecks and builds the separate `site/` sub-project. `bin/check` mirrors `ci.yml` only; it never runs those.

## Signing key + extension ID

The extension ID is `sha256(public key)`. `scripts/crx-key.ts` is the one source of truth:

```bash
bun run crx:id      # print the id + public key
bun run crx:key     # generate keys/designer.pem if missing (first build does this)
```

Resolution order — `$CRX_PUBLIC_KEY` → `$CRX_PRIVATE_KEY` (PEM contents, the CI secret) →
`$CRX_KEY_PATH` → `keys/designer.pem`. The build pins the public half into the manifest
(`key`) so an unpacked dev build, the `.crx`, and self-hosted installs all share one ID.
That is load-bearing for MCP OAuth: the redirect is `https://<id>.chromiumapp.org/`
(`src/mcp/auth.ts`), and it has to be registered with the provider up front.

`keys/` is gitignored. **Back the PEM up** — losing it means a new ID for every existing
install. Put it in CI once:

```bash
gh secret set CRX_PRIVATE_KEY < keys/designer.pem
```

`scripts/pack-crx.sh` fails the build if the manifest `key` and the signing key disagree —
Chrome reports that mismatch only as an opaque "package is invalid" at install time.

## Chrome Web Store

The store assigns its **own** key, so store uploads must omit the manifest `key`:

```bash
bun run zip:store   # CWS_UPLOAD=1 → build/*-chrome.zip with no `key` field
```

Publishing is stubbed (commented) in `release.yml`. Enable it once the listing exists and
these secrets are set: `CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`,
`CWS_REFRESH_TOKEN`. See [STORE-SETUP.md](./STORE-SETUP.md) for how to obtain each one.

## Firefox Add-ons (AMO)

AMO signs the `.xpi` itself; there is no local key. `web-ext sign` (or the `addons.mozilla.org`
API) needs `AMO_JWT_ISSUER` + `AMO_JWT_SECRET`. Also in [STORE-SETUP.md](./STORE-SETUP.md).

## Manual QA before publishing

`.crx` files cannot be drag-installed in current Chrome — that path is blocked outside the
store and enterprise policy. QA the unpacked build:

```bash
bun run local              # build + print the load-unpacked path and the extension id
# chrome://extensions → Developer mode → Load unpacked → build/chrome-mv3
```

The `.crx` still matters for self-hosted distribution and for proving the signing key works.
