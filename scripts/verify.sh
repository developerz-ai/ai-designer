#!/usr/bin/env bash
# Local gate. Mirrors the CI validation jobs in .github/workflows/ci.yml, ordered for a fast
# inner loop. `bin/check` is the entry point — it prints the job-by-job coverage table.
#   bun run verify          postinstall + lint + typecheck (concurrent) → tests
#   bun run verify --check  postinstall + lint + typecheck only, no tests
#   bun run verify --gate   everything above + build + E2E on the loaded extension
#
# Source of truth is .github/workflows/ci.yml. Mirrored here, job for job:
#   lint       ci.yml:44   bun run lint
#   typecheck  ci.yml:56   bun run postinstall, then ci.yml:58 bun run typecheck
#   test       ci.yml:75   bun run test — ONE job over unit + integration
#
# CI-only, deliberately not run here: `build` (a release build on a clean runner), `test-e2e`
# (needs that build plus Playwright Chromium) — `--gate` runs both — and `actionlint`, which
# has no in-checkout tool: it is not a dependency and ci.yml downloads the binary at job time.
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

# ci.yml:55-56 runs `bun run postinstall` (wxt prepare → .wxt/) before typecheck, and typecheck
# resolves `#i18n` through .wxt/i18n/index.ts (tsconfig.json:32). Without this step a checkout
# that has node_modules but no `.wxt/` fails typecheck here for a reason CI never has.
step "wxt prepare (postinstall)"
# Own failure banner, for the same reason the test step below has one: run bare under `set -e`,
# a broken wxt.config or a stale `.wxt/` aborted printing no ✗ line at all — while bin/check:70
# tells the reader the failing step IS the ✗ line scripts/verify.sh printed.
# `status=$?` is captured BEFORE the banner: `printf` overwrites `$?`, so an `exit $?` after it
# would exit 0 and report a red gate as clean. The step's own code is what bin/check:70 prints as
# `✗ gate FAILED (exit %s)`, so collapsing it to 1 hides how the step failed.
if bun run postinstall; then
  :
else
  status=$?
  printf '\n\033[1;31m✗ wxt prepare (postinstall) failed\033[0m\n'
  exit "$status"
fi

step "lint + typecheck (concurrent)"
lint_log=$(mktemp); tc_log=$(mktemp)
trap 'rm -f "$lint_log" "$tc_log"' EXIT

bun run lint      >"$lint_log" 2>&1 & lint_pid=$!
bun run typecheck >"$tc_log"   2>&1 & tc_pid=$!

status=0
wait "$lint_pid" || status=$?
# Two concurrent steps cannot both supply one exit status, so the LAST one to fail names it —
# typecheck over lint. bin/check's `✗ gate FAILED (exit %s)` then prints a real code, not a 1.
wait "$tc_pid"   || status=$?

# Print both logs regardless, so one failure never hides the other's output.
printf '\033[1m-- lint --\033[0m\n';      cat "$lint_log"
printf '\033[1m-- typecheck --\033[0m\n'; cat "$tc_log"
if [ "$status" -ne 0 ]; then
  printf '\n\033[1;31m✗ lint/typecheck failed\033[0m\n'
  exit "$status"
fi

[ "$MODE" = check ] && { printf '\n\033[1;32m✓ check clean\033[0m\n'; exit 0; }

step "tests (unit + integration, one pool)"
# Own failure banner: each step names itself on the way out, so a red gate says WHICH step failed
# instead of leaving the reader to guess from the tail of the log (bin/check prints the verdict).
if bun run test; then
  :
else
  status=$?
  printf '\n\033[1;31m✗ tests failed\033[0m\n'
  exit "$status"
fi

if [ "$MODE" = gate ]; then
  step "build"
  bun run build
  step "e2e (loaded extension)"
  bun run test:e2e
fi

printf '\n\033[1;32m✓ %s clean\033[0m\n' "$MODE"
