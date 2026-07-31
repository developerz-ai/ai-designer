#!/usr/bin/env bash
# One-shot local build → an unpacked extension you can load in the browser.
#   bun run local              chrome, plain build
#   bun run local --firefox    firefox (MV2 output dir)
#   bun run local --check      run the gate (lint + typecheck + unit + integration) first
#   bun run local --zip        also produce the distributable .zip
set -euo pipefail

cd "$(dirname "$0")/.."

BROWSER=chrome
CHECK=0
ZIP=0

for arg in "$@"; do
  case "$arg" in
    --firefox) BROWSER=firefox ;;
    --check)   CHECK=1 ;;
    --zip)     ZIP=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \?//' | head -6
      exit 0
      ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }

if [ ! -d node_modules ]; then
  step "installing dependencies"
  bun install
fi

# WXT generates .wxt/ (typed `#i18n`, auto-imports) via `wxt prepare` on postinstall.
# A stale checkout — pulled after a dep bump, or node_modules from an older lockfile —
# leaves it missing and every build/typecheck fails on "Cannot find module '#i18n'".
if [ ! -d .wxt ]; then
  step "generating WXT types"
  bunx wxt prepare || { step "stale node_modules — reinstalling"; bun install; }
fi

if [ "$CHECK" = 1 ]; then
  # One source of truth for the gate — see scripts/verify.sh (concurrent lint+typecheck,
  # then the whole suite in a single vitest pool).
  bash scripts/verify.sh
fi

step "building ($BROWSER)"
if [ "$BROWSER" = firefox ]; then
  bun run build:firefox
  OUT=build/firefox-mv2
else
  bun run build
  OUT=build/chrome-mv3
fi

if [ "$ZIP" = 1 ]; then
  step "zipping"
  if [ "$BROWSER" = firefox ]; then bun run zip:firefox; else bun run zip; fi
fi

ABS="$(cd "$OUT" && pwd)"

printf '\n\033[1;32m✓ built\033[0m  %s\n\n' "$ABS"
if [ "$BROWSER" = firefox ]; then
  cat <<EOF
Load it:
  1. about:debugging#/runtime/this-firefox
  2. Load Temporary Add-on… → pick $ABS/manifest.json
EOF
else
  cat <<EOF
Load it:
  1. chrome://extensions
  2. Developer mode → on
  3. Load unpacked → $ABS

Then: add your OpenRouter key in the side panel → settings (BYOK).
EOF
fi

if [ "$ZIP" = 1 ]; then
  printf '\nZips: %s\n' "$(cd build && ls -1 ./*.zip 2>/dev/null | tr '\n' ' ')"
fi

# Chrome builds also sign a .crx (scripts/pack-crx.sh, run by `bun run build`).
if [ "$BROWSER" = chrome ]; then
  printf 'CRX:  %s\n' "$(cd build && ls -1 ./*.crx 2>/dev/null | tr '\n' ' ')"
fi
