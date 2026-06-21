---
description: Run the full local gate — lint + typecheck + unit + integration. Run before declaring a change done or opening a PR.
---

You are running `/verify`. Goal: prove the change is green before claiming success.

Run, in order, and stop at the first failure:

```
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
```

If anything fails:
1. Read the error.
2. Fix the root cause — do NOT silence the check or weaken a type.
3. Re-run from the top.

If `src/entrypoints/sidepanel/**` changed, also `bun run build` and confirm the side panel bundle is produced. Type-check passing ≠ the UI working.

Report: each step's result and the final `.output/chrome-mv3` build size if you built.
