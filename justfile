# Developerz.ai Designer — task runner. `just <recipe>` (https://github.com/casey/just)

# List recipes
default:
    @just --list

# Install deps + prepare WXT types
setup:
    bun install

# Dev (Chrome, HMR)
dev:
    bun run dev

# Dev (Firefox)
dev-firefox:
    bun run dev:firefox

# Production build (tree-shaken, minified) → .output/chrome-mv3
build:
    bun run build

# Build + zip both browsers for release
release:
    bun run release

# Full local gate: lint + typecheck (concurrent) → unit + integration in one pool
verify:
    bash scripts/verify.sh

# Fast inner-loop check: lint + typecheck only, concurrently. No tests.
check:
    bash scripts/verify.sh --check

# Everything CI runs, including a real build + E2E on the loaded extension
gate:
    bash scripts/verify.sh --gate

# One-shot local build → unpacked extension + load instructions
local *ARGS:
    bun run local {{ARGS}}

# Lint (Biome)
lint:
    bun run lint

# Auto-fix lint + format
fix:
    bun run lint:fix

# Typecheck
typecheck:
    bun run typecheck

# All tests
test:
    bun run test

# E2E (needs a browser)
e2e:
    bun run test:e2e

# Remove build output + caches
clean:
    rm -rf .output .wxt coverage
