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

`workflow_dispatch` is also enabled for manual runs.

## The optimized build

Production builds go through WXT → Vite → Rollup:

- **Tree-shaking** — dead code eliminated across ES modules (background, content, side panel are separate entrypoints, each shaken independently).
- **JS minify** — esbuild minifier, `target: esnext`.
- **CSS minify** — SCSS compiled and minified (`cssMinify`), per-entrypoint.
- **No sourcemaps** in release (smaller zip; flip on for debugging).
- Output: one zip per browser target under `build/`, plus a signed `.crx` for Chrome.

Dev builds (`bun run dev`) skip minification for fast HMR.

## CI gate

Every push/PR runs `.github/workflows/ci.yml` first: `lint`, `typecheck`, `test-unit`, `test-integration`, `build` (all parallel except `build`, which needs the rest green), plus `actionlint`. A tag won't produce a usable release if these are red — fix main first.

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
