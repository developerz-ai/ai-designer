# Releasing

How a Developerz.ai Designer release is cut. Tag → CI builds the optimized zip → GitHub Release with the artifact attached.

## Versioning

- SemVer. The extension version in `wxt.config.ts` (manifest `version`) is the source of truth.
- Tag matches: `v1.4.0` → manifest `1.4.0`. Keep them in sync before tagging.

## Cut a release

```bash
# 1. Bump the version in wxt.config.ts (manifest.version), commit on main.
# 2. Tag and push.
git tag v1.4.0
git push origin v1.4.0
```

The `Release` workflow (`.github/workflows/release.yml`) then:

1. Installs deps (`bun install --frozen-lockfile`).
2. Builds the production Chrome zip (`bun run release` = `wxt build && wxt zip`).
3. Builds the Firefox zip (`wxt build -b firefox && wxt zip -b firefox`).
4. Creates a GitHub Release with auto-generated notes and both `.zip`s attached from `.output/`.

`workflow_dispatch` is also enabled for manual runs.

## The optimized build

Production builds go through WXT → Vite → Rollup:

- **Tree-shaking** — dead code eliminated across ES modules (background, content, side panel are separate entrypoints, each shaken independently).
- **JS minify** — esbuild minifier, `target: esnext`.
- **CSS minify** — SCSS compiled and minified (`cssMinify`), per-entrypoint.
- **No sourcemaps** in release (smaller zip; flip on for debugging).
- Output: one zip per browser target under `.output/`.

Dev builds (`bun run dev`) skip minification for fast HMR.

## CI gate

Every push/PR runs `.github/workflows/ci.yml` first: `lint`, `typecheck`, `test-unit`, `test-integration`, `build` (all parallel except `build`, which needs the rest green), plus `actionlint`. A tag won't produce a usable release if these are red — fix main first.

## Chrome Web Store (later)

The publish step is stubbed (commented) in `release.yml`. Enable it once the store listing exists and these secrets are set: `CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`.
