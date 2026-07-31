#!/usr/bin/env bash
# Pack a built Chrome target into a signed .crx3.
#   bash scripts/pack-crx.sh [build-dir]     default: build/chrome-mv3
#
# Signing key resolution, in order:
#   1. $CRX_PRIVATE_KEY  — PEM *contents* (CI secret). Written to a temp file, wiped on exit.
#   2. $CRX_KEY_PATH     — path to a PEM.
#   3. keys/designer.pem — local default; generated on first run, then reused.
#
# The key IS the extension ID (the ID is a hash of the public key). Lose it and every
# install becomes a different extension. keys/ is gitignored — back the PEM up out of band.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="${1:-build/chrome-mv3}"

if [ ! -d "$SRC" ]; then
  echo "pack-crx: no build at $SRC — run \`bun run build\` first" >&2
  exit 1
fi

KEY_PATH="${CRX_KEY_PATH:-keys/designer.pem}"
CLEANUP_KEY=0

if [ -n "${CRX_PRIVATE_KEY:-}" ]; then
  KEY_PATH="$(mktemp)"
  CLEANUP_KEY=1
  printf '%s\n' "$CRX_PRIVATE_KEY" > "$KEY_PATH"
  chmod 600 "$KEY_PATH"
fi

# shellcheck disable=SC2317  # invoked via trap
# `if`, not `&&` — a trailing false test would become the script's exit status under `set -e`.
cleanup() { if [ "$CLEANUP_KEY" = 1 ]; then rm -f "$KEY_PATH"; fi }
trap cleanup EXIT

NEW_KEY=0
[ -f "$KEY_PATH" ] || NEW_KEY=1

VERSION="$(node -p "require('./package.json').version")"
NAME="$(basename "$SRC")"                      # chrome-mv3
CRX="build/designer-${VERSION}-${NAME}.crx"

mkdir -p "$(dirname "$KEY_PATH")"
bunx crx3 -p "$KEY_PATH" -o "$CRX" -- "$SRC" > /dev/null

if [ "$NEW_KEY" = 1 ] && [ "$CLEANUP_KEY" = 0 ]; then
  printf '\033[1;33m! generated a new signing key at %s — back it up; it defines the extension ID\033[0m\n' "$KEY_PATH"
fi
printf '\033[1;32m✓ crx\033[0m     %s\n' "$CRX"
