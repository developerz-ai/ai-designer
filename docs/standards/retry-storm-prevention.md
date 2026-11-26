# Retry-storm prevention

**Rule.** Every cross-boundary task create carries a stable idempotency key derived from
`changeset.sessionId`. A retry or double Ship reuses that key, distinct sessions and fan-out
positions get distinct keys, and every dispatched task is watched to terminal or explicitly failed.
A keyless create is allowed only when there is no changeset and therefore no session identity to
reuse. Held tasks are never hidden or redefined; no census, metric definition, schedule or root
`CLAUDE.md` changes as part of this rule, and no key configuration or provider restriction changes.

| Element | What it is |
|---|---|
| Demonstrated failure | A keyless `task(create)` on retry or double Ship mints a second task for the same session. Both tasks fail repeatedly (`native_harness_failed`) and age held: a retry storm, not two independent pieces of work. |
| Prevention invariant | The dispatch key is derived from `changeset.sessionId`, stable across replans and retries, distinct across sessions, and suffixed `:problem:N` for fan-out. The create is watched to terminal or explicitly failed. |
| Repair evidence | PR #295, merged as `4928243e9ee2` (`fix(handoff): send stable idempotency key on task create`). `src/mcp/handoff.ts` adds `idempotencyKey` to `TaskSpecPayload` and `TaskCreateArgs`, derives it in `planTasks`, and sends it at the top level of `task(create)` in `dispatchTask`; `src/entrypoints/background.ts:855-857` documents the same key. |
| Regression test | `test/unit/handoff.test.ts:177-218` pins stable session-derived keys across replans, different sessions, fan-out and the keyless no-changeset case; `:268-296` uses a deduplicating fake backend to prove a Ship retry reuses the same task IDs and creates no extra tasks. Removing the key additions produced `2 failed | 26 passed`; restored, 28 passed. |
| Related rule | [Hold idempotency](hold-idempotency.md) frames the K1 `key_held_older_24h` held-task reading. Cross-link it; do not duplicate the dispatch mechanics here. |

## Why this rule exists

The cause was diagnosed in code, not inferred from a metric: the schema already named `sessionId`
as the handoff idempotency key, but `task(create)` arguments carried no key. A retried or doubled
Ship therefore created a fresh task each time. Those duplicate tasks kept failing and aging held,
which is the retry-storm pattern. Suppressing the failures or reclassifying the held tasks would
hide the evidence; the fix is to make the retry represent the same task at the backend.

## How to comply

Before a merge touches the handoff path: derive the create key from `changeset.sessionId`, keep it
stable across retries and double Ship, give distinct sessions and fan-out positions distinct keys,
and send it at the top level of `task(create)`, not only inside the spec. Require the same ordered
problem list on retry. Watch every dispatched task to terminal state or record an explicit failure;
never leave a create unanswered. Write keyless creates only for reports with no changeset. Keep the
`test/unit/handoff.test.ts` stable-key and deduplicating-retry cases green, and leave `CLAUDE.md`,
`.dz/schedules/`, census queries and metric definitions untouched.
