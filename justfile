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

# Full local gate: lint + typecheck + unit + integration
verify:
    bun run lint
    bun run typecheck
    bun run test:unit
    bun run test:integration

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
