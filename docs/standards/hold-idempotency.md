# Hold idempotency

**Rule.** Every cross-boundary task dispatch carries a stable idempotency key derived from
`changeset.sessionId` and a digest of the work it dispatches, and is watched to terminal or explicitly failed. A keyless create is allowed
only when there is no changeset, and therefore no session identity to reuse. Held tasks are never
hidden or redefined; no key configuration or provider restriction changes as part of this rule.

| Element | What it is |
|---|---|
| Rendered reading | K1 `key_held_older_24h` = 137, a platform-wide census reading. `census-corpus.ts` / `census-metrics.ts` are not in this checkout: the number is not computed here. |
| Claimed key | `src/shared/changeset.ts:188-191` documents `sessionId` as the handoff idempotency key. |
| Missing key | At the pre-fix commit `e46d6408`, `src/agent/session.ts:112-114` and `src/entrypoints/background.ts:855-857` state no key is sent (`git show e46d6408:src/entrypoints/background.ts`); `src/mcp/handoff.ts` `planTasks` / `ship` then passed `task(create)` arguments without one. Those lines now say the opposite: they document the key as sent. |
| Failure | `src/mcp/backend.ts` and the task executor pass create arguments through unchanged, so a retry or double Ship minted a second task on the same session. Both tasks sit held on a key and age into the census reading. |
| Fix | Dispatch carries `idempotencyKey` = `<sessionId>:<digest of page URL, repo, branch, edits, problem>` both inside the spec and at the top level of `task(create)`. A retry of the same work reuses its task; new edits in the same session, or a different fan-out problem, open a new one. The model-authored brief is not in the digest, so a re-authored retry still dedupes. A report without a changeset dispatches keyless. `test/unit/handoff.test.ts` pins these paths. |

## Why this rule exists

The 137 reading is a fleet-wide symptom, not a metric defined by this repository. The repo's
concrete contribution is the ship dispatch: the schema already named `sessionId` as the
idempotency key, while the code sent none. Two dispatches of one session therefore created two
tasks. Both age held; suppressing or reclassifying them would hide the evidence, not fix the
cause.

## How to comply

Before a merge touches the handoff path: derive the dispatch key from `changeset.sessionId` plus a
digest of the stable dispatched work, keep it stable across retries and double Ship, and give distinct
sessions, new edits and distinct fan-out problems distinct keys. Watch every
dispatched task to terminal state or record an explicit failure; never leave a create unanswered.
Write keyless creates only for reports with no changeset. Root `CLAUDE.md`, `.dz/schedules/`,
census queries and metric definitions stay untouched. No API key configuration or provider
restriction changes, and no held task is hidden or redefined by this rule.
