# Retry-storm prevention

**Rule.** Every cross-boundary task create carries a stable idempotency key derived from
`changeset.sessionId` and the work the task carries. A retry or double Ship of the same work reuses
that key; distinct sessions, new edits in the same session and distinct fan-out problems get distinct keys, and every dispatched task is watched to terminal or explicitly failed.
A keyless create is allowed only when there is no changeset and therefore no session identity to
reuse. Held tasks are never hidden or redefined; no census, metric definition, schedule or root
`CLAUDE.md` changes as part of this rule, and no key configuration or provider restriction changes.

| Element | What it is |
|---|---|
| Demonstrated failure | A keyless `task(create)` on retry or double Ship mints a second task for the same session. Both tasks fail repeatedly (`native_harness_failed`) and age held: a retry storm, not two independent pieces of work. |
| Prevention invariant | The dispatch key is `<sessionId>:<digest>` (`dispatchKey` in `src/mcp/handoff.ts`), the digest covering page URL, repo, branch, edits and the focused problem but never the model-authored brief. Stable across replans and retries of the same work, distinct across sessions, across later Ships of new edits in one session, and across fan-out problems. The create is watched to terminal or explicitly failed. |
| Over-dedupe | The first cut keyed on the session alone and on `:problem:N` positions. A session outlives a Ship, so a second Ship with new edits deduped onto the first task, and a fan-out of a different problem deduped onto whichever task held that position: the new work was never dispatched. The digest closes both. |
| Repair evidence | PR #295, merged as `4928243e9ee2` (`fix(handoff): send stable idempotency key on task create`). `src/mcp/handoff.ts` adds `idempotencyKey` to `TaskSpecPayload` and `TaskCreateArgs`, derives it in `planTasks`, and sends it at the top level of `task(create)` in `dispatchTask`; `src/entrypoints/background.ts:855-857` documents the same key. |
| Regression test | `test/unit/handoff.test.ts` pins stable session-scoped keys across replans, different sessions, fan-out and the keyless no-changeset case, and uses a deduplicating fake backend to prove a Ship retry reuses the same task IDs, a re-authored report retry stays on its task, and a later Ship of new edits or a different fan-out problem opens a new one. |
| Related rule | [Hold idempotency](hold-idempotency.md) frames the K1 `key_held_older_24h` held-task reading. Cross-link it; do not duplicate the dispatch mechanics here. |

## Why this rule exists

The cause was diagnosed in code, not inferred from a metric: the schema already named `sessionId`
as the handoff idempotency key, but `task(create)` arguments carried no key. A retried or doubled
Ship therefore created a fresh task each time. Those duplicate tasks kept failing and aging held,
which is the retry-storm pattern. Suppressing the failures or reclassifying the held tasks would
hide the evidence; the fix is to make the retry represent the same task at the backend.

## How to comply

Before a merge touches the handoff path: derive the create key from `changeset.sessionId` plus a
digest of the stable dispatched work, keep it stable across retries and double Ship, give distinct
sessions, new edits and distinct fan-out problems distinct keys, and send it at the top level of
`task(create)`, not only inside the spec. Watch every dispatched task to terminal state or record an explicit failure;
never leave a create unanswered. Write keyless creates only for reports with no changeset. Keep the
`test/unit/handoff.test.ts` stable-key and deduplicating-retry cases green, and leave `CLAUDE.md`,
`.dz/schedules/`, census queries and metric definitions untouched.
