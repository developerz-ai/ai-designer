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
5. **Publishes to the Chrome Web Store** — the four `CWS_*` repo secrets have been configured since 2026-08-15 ([STORE-SETUP.md](STORE-SETUP.md)). The secret-guarded step rebuilds the store zip with `CWS_UPLOAD=1` (drops the manifest `key`) and uploads it with `--auto-publish`; a successful upload enters Chrome Web Store review. If `CWS_EXTENSION_ID` is unavailable, the guarded upload skips and the tag remains a GitHub-Release-only build.

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

`.github/workflows/ci.yml` is the source of truth. It defines six jobs, and this is the whole gate:

| Job | Runs | Needs |
|--|--|--|
| `Lint` | `bun run lint` | — |
| `Typecheck` | `bun run postinstall` → `bun run typecheck` | — |
| `Test (unit + integration)` | `bun run test` — ONE job, one vitest pool over unit + integration | — |
| `Build extension` | `bun run release`, then the emitted image-worker check; uploads `extension-zip` | `Lint`, `Typecheck` |
| `Test (e2e)` | `bun run build` → Playwright Chromium → `bun run test:e2e` | `Lint`, `Typecheck` |
| `actionlint` | downloads actionlint 1.7.12, lints the workflows | — |

This section used to name the unit suite and the integration suite as separate CI jobs, all of them
parallel except `build`. That was wrong on both counts. The two were merged into the single
`Test (unit + integration)` job — one `vitest run` shares a worker pool across the whole suite where
two invocations each paid full startup — and `build` and `Test (e2e)` both gate on `Lint` and
`Typecheck`. The workflow was right; this doc was stale. Fix main first: a tag won't produce a
usable release while these are red.

### Locally: `./bin/check`

`./bin/check` is the executable mirror of the three validation jobs. The steps are `bun run verify`
(`scripts/verify.sh`): `bun run postinstall`, then `bun run lint` and `bun run typecheck`
concurrently, then ONE `bun run test` — followed by the advisory actionlint probe below, which is
reported but never part of the exit status.

- **Mirrored** — `Lint`, `Typecheck`, `Test (unit + integration)`. Same commands, same scope as CI.
- **CI-only** — `Build extension` and `Test (e2e)`. `bun run gate` runs part of each locally:
  `bun run build` then `bun run test:e2e` (`scripts/verify.sh:89-94`) — never `bun run release`,
  so no `.zip` and no `.crx` land in `build/`. Three steps of those jobs stay CI-only: the zip,
  the emitted image-worker check (`DZ_REQUIRE_IMAGE_WORKER_BUILD=1 bun run test
  test/unit/image-encode-bundling.test.ts`) and the `extension-zip` upload. The gate reports the
  job rather than claiming to reproduce it.
- **CI-only** — `actionlint`. It is not a dependency of this repo (CI downloads the binary at job
  time), so `bin/check` probes `PATH`: it runs and reports actionlint when present, reports it
  skipped when absent, and never makes its absence fatal. A tool the checkout cannot install must
  not fail the gate.

`test/unit/check-pipeline.test.ts` enforces the mirror, so it cannot drift into prose: it parses the
jobs and `run:` steps out of `ci.yml` and fails if a step of a mirrored job is missing from
`scripts/verify.sh`, if a job is renamed, or if `bin/check`'s coverage table stops naming a job.
Change `ci.yml` and the gate in the same commit.

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

Publishing is active in `release.yml`: its secret-guarded upload uses the configured
`CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, and `CWS_REFRESH_TOKEN` secrets
to upload the store-specific zip with `--auto-publish`. The workflow does not expose their
values. See [STORE-SETUP.md](./STORE-SETUP.md) for credential rotation and recovery.

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
