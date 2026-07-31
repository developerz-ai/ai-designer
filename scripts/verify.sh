#!/usr/bin/env bash
# Local gate. Mirrors what CI checks, but ordered for a fast inner loop.
#   bun run verify          lint + typecheck (concurrent) → tests
#   bun run verify --check  lint + typecheck only, no tests
#   bun run verify --gate   everything above + build + E2E on the loaded extension
#
# lint and typecheck are independent processes, so they run at the same time.
# Tests run as ONE vitest invocation rather than test:unit then test:integration:
# a single process shares one worker pool across the whole suite, where two
# invocations each pay full startup and each parallelise over only half of it.
set -euo pipefail

cd "$(dirname "$0")/.."

MODE=full
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --gate)  MODE=gate ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \?//' | head -6; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }

step "lint + typecheck (concurrent)"
lint_log=$(mktemp); tc_log=$(mktemp)
trap 'rm -f "$lint_log" "$tc_log"' EXIT

bun run lint      >"$lint_log" 2>&1 & lint_pid=$!
bun run typecheck >"$tc_log"   2>&1 & tc_pid=$!

fail=0
wait "$lint_pid" || fail=1
wait "$tc_pid"   || fail=1

# Print both logs regardless, so one failure never hides the other's output.
printf '\033[1m-- lint --\033[0m\n';      cat "$lint_log"
printf '\033[1m-- typecheck --\033[0m\n'; cat "$tc_log"
[ "$fail" -eq 0 ] || { printf '\n\033[1;31m✗ lint/typecheck failed\033[0m\n'; exit 1; }

[ "$MODE" = check ] && { printf '\n\033[1;32m✓ check clean\033[0m\n'; exit 0; }

step "tests (unit + integration, one pool)"
bun run test

if [ "$MODE" = gate ]; then
  step "build"
  bun run build
  step "e2e (loaded extension)"
  bun run test:e2e
fi

printf '\n\033[1;32m✓ %s clean\033[0m\n' "$MODE"
