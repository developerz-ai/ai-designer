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

# From the built manifest, not package.json — in CI the git tag drives the version
# (wxt.config.ts), so package.json would name the file after a stale number.
VERSION="$(node -p "require('./$SRC/manifest.json').version")"
NAME="$(basename "$SRC")"                      # chrome-mv3
CRX="build/designer-${VERSION}-${NAME}.crx"

mkdir -p "$(dirname "$KEY_PATH")"
# Sweep older versions of this target first — the filename carries the version, so without
# this build/ accumulates one .crx per version ever built and "the latest one" gets ambiguous.
rm -f "build/designer-"*"-${NAME}.crx"
bunx crx3 -p "$KEY_PATH" -o "$CRX" -- "$SRC" > /dev/null

# The manifest pins `key` (wxt.config.ts) and the .crx carries a signature. Chrome refuses
# to install a .crx where the two disagree, and the failure surfaces as an opaque
# "package is invalid" at install time — catch it here instead.
SIGNING_PUB="$(env -u CRX_PUBLIC_KEY -u CRX_PRIVATE_KEY CRX_KEY_PATH="$KEY_PATH" bun scripts/crx-key.ts --key)"
MANIFEST_PUB="$(node -p "require('./$SRC/manifest.json').key || ''")"

if [ -n "$MANIFEST_PUB" ] && [ "$MANIFEST_PUB" != "$SIGNING_PUB" ]; then
  echo "pack-crx: $SRC/manifest.json 'key' does not match the signing key ($KEY_PATH)." >&2
  echo "          Rebuild so both come from the same PEM — Chrome rejects the mismatch." >&2
  exit 1
fi

if [ "$NEW_KEY" = 1 ] && [ "$CLEANUP_KEY" = 0 ]; then
  printf '\033[1;33m! generated a new signing key at %s — back it up; it defines the extension ID\033[0m\n' "$KEY_PATH"
fi
printf '\033[1;32m✓ crx\033[0m     %s\n' "$CRX"
printf '  id      %s\n' "$(env -u CRX_PUBLIC_KEY CRX_KEY_PATH="$KEY_PATH" bun scripts/crx-key.ts --id)"
