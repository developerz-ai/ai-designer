// Session tools for the agent loop — the changeset side of a turn, paired with the DOM tools
// (src/agent/tools/dom.ts). Where DOM tools mutate the ephemeral page, these manage the DURABLE
// record: `recordEdit` folds an accepted change into the session changeset, `undo`/`redo` walk its
// history, and `handoff` proposes shipping it. `handoff` is approval-gated in the loop (slice 04's
// `toolApproval`) and NEVER auto-runs — the agent never ships on its own (docs/idea/handoff.md,
// "Ship is user-triggered"); the loop reaches `handoff.execute` only after the user approves.
//
// SW-ONLY by usage, chrome-free by construction: the changeset store, the persist hook (→
// SessionStore, src/agent/session.ts), and the panel sink are injected, so this stays unit-testable
// with no `chrome.*`. Merged after the DOM tools in the loop; every mutation persists the changeset
// and streams it to the panel so the diff view stays live.

import { tool } from 'ai';
import { z } from 'zod';
import { foldMutationEvents } from '@/changeset/pending-mutations';
import type { ChangesetStore } from '@/changeset/store';
import { type Changeset, Edit } from '@/shared/changeset';
import { type MutationEvent, type SwToPanel, ToolResult } from '@/shared/messages';

/** Everything the session tools need, injected so the module stays chrome-free and testable. */
export interface SessionToolDeps {
  /** The live changeset for this turn's tab (seeded from / persisted back to the SessionStore). */
  readonly store: ChangesetStore;
  /** Persist the changeset after every mutation (→ `chrome.storage.session` via SessionStore). */
  readonly persist: (changeset: Changeset) => Promise<void> | void;
  /** Stream changeset events to the side-panel port (`edit-recorded` / `changeset`). */
  readonly emit: (event: SwToPanel) => void;
  /** Drain this turn tab's buffered recorder MutationEvents matching a selector value (#9 —
   *  `src/changeset/pending-mutations.ts`). Absent ⇒ no recorder fold (the model's Edit stands
   *  as-is) — unit tests and non-tab contexts inject nothing. */
  readonly drainRecorderEvents?: (selectorValue: string) => DrainRecorderResult;
}

/** One drain of the tab's recorder buffer — the shape `PendingMutations.drain` returns (#9
 *  review round 2). Declared structurally here so this module stays decoupled from the buffer
 *  implementation (and unit tests can inject a literal). */
export interface DrainRecorderResult {
  /** The drained events — empty on no match, multi-group ambiguity, or a gated rescue refusal. */
  readonly events: MutationEvent[];
  /** How many of the tab's events were dropped at the buffer cap since the last drain (the
   *  drain RESETS the counter — the loss is surfaced once, here, on the folded edit's intent). */
  readonly dropped: number;
  /** True when the single-group rescue fired (the exact selector match missed). */
  readonly rescued: boolean;
}

// `undo` / `redo` take no arguments; an empty object schema stops the model from inventing any.
const NoInput = z.object({});

// The agent's proposal to ship the session changeset. Approval-gated by the loop — carries only
// intent + summary; the real MCP `task(create)` (or downloadable MD report) is slice 07.
const HandoffInput = z.object({
  summary: z.string().describe('A concise, developer-facing summary of what changed and why.'),
  backend: z.string().optional().describe('Connected MCP backend id to ship to, when chosen.'),
});

const result = (data: unknown): ToolResult => ({ type: 'tool-result', ok: true, data });

/**
 * Build the session `ToolSet` for one turn, bound to the tab's changeset store. Each mutating tool
 * updates the store, persists the resulting changeset, and streams it to the panel; `handoff` is
 * inert until the user approves it in the loop.
 */
export function createSessionTools(deps: SessionToolDeps) {
  const { store, persist, emit, drainRecorderEvents } = deps;

  return {
    recordEdit: tool({
      description:
        'Record an accepted change as a durable edit in the session changeset — the intent (why), ' +
        'the target selector, and the style/text changes. For attribute or class changes ' +
        '(setAttr/addClass/removeClass), ALSO fill `attrs` ({name, before, after} — null when the ' +
        'attribute is absent/removed) and/or `classes` ({name, op}) so the shipped changeset carries ' +
        'the structured delta, not just prose. For structural changes (insertNode/moveNode/' +
        "removeNode), fill `structural` the same way: {op: 'insert', html, position?, " +
        "refSelector?} / {op: 'move', refSelector, position?} / {op: 'remove'}. When " +
        'you made this change under device emulation ' +
        '(`setDevice`), set `breakpoint` to the device so the changeset and report show which ' +
        'viewport it targets. Set `selector` to the EXACT selector the mutation tool returned ' +
        'for the element — never a paraphrase: the recorder buffers the real deltas under that ' +
        'selector, and an exact match folds them in as ground truth. When the result has ' +
        '`rescued: true`, your selector was a paraphrase the recorder healed — adopt the ' +
        "result's `healedSelector` for subsequent calls on this element. This is what Ship " +
        'hands off; record after you have applied and visually verified a change.',
      inputSchema: Edit,
      outputSchema: ToolResult,
      execute: async (edit) => {
        // #9: fold the real recorder deltas buffered for this selector into the model's Edit —
        // the page's own mutation events are ground truth per mechanical family (changes/attrs/
        // classes/structural/text), so the durable record no longer depends on the model
        // restating its tool calls. Buffer empty ⇒ the Edit stands unchanged (back-compat).
        // SPILLOVER: a group holding several structural ops keeps the first in the folded edit;
        // each additional op becomes its own auto-recorded Edit (one op per Edit), recorded +
        // persisted + streamed right alongside. Events dropped at the buffer cap since the last
        // drain are surfaced ONCE, on the folded edit's intent (the drain reset the counter, so
        // the turn-end auto-finalize won't double-report) — a shipped changeset never silently
        // omits mutations.
        const drained = drainRecorderEvents?.(edit.selector.value);
        const events = drained?.events ?? [];
        const dropped = drained?.dropped ?? 0;
        const { folded, spillover } =
          events.length > 0 ? foldMutationEvents(edit, events) : { folded: edit, spillover: [] };
        const recorded =
          dropped > 0
            ? {
                ...folded,
                intent: `${folded.intent} (+${dropped} earlier events dropped at buffer cap)`,
              }
            : folded;
        store.record(recorded);
        for (const extra of spillover) store.record(extra);
        await persist(store.current);
        emit({ type: 'edit-recorded', edit: recorded });
        for (const extra of spillover) emit({ type: 'edit-recorded', edit: extra });
        // The spillover count rides the result so the model can pair session `undo`s with the
        // edits ONE recordEdit call created (1 + spillover). `rescued` surfaces the gated
        // single-group rescue (the drain matched no exact group but adopted the one plausibly-
        // same group — the model's selector was a paraphrase): with it, `healedSelector`
        // carries the ground-truth selector the fold adopted, so the model can use it for any
        // further calls on this element instead of its paraphrase.
        const rescued = drained?.rescued ?? false;
        return result({
          edits: store.size,
          spillover: spillover.length,
          rescued,
          ...(rescued ? { healedSelector: recorded.selector.value } : {}),
        });
      },
    }),
    undo: tool({
      description:
        'Remove the most recently recorded edit from the changeset. Reversible with `redo`. Takes ' +
        'no arguments.',
      inputSchema: NoInput,
      outputSchema: ToolResult,
      execute: async () => {
        const undone = store.undo();
        await persist(store.current);
        emit({ type: 'changeset', changeset: store.current });
        return result({ undone: undone !== undefined, edits: store.size });
      },
    }),
    redo: tool({
      description: 'Re-apply the most recently undone edit to the changeset. Takes no arguments.',
      inputSchema: NoInput,
      outputSchema: ToolResult,
      execute: async () => {
        const redone = store.redo();
        await persist(store.current);
        emit({ type: 'changeset', changeset: store.current });
        return result({ redone: redone !== undefined, edits: store.size });
      },
    }),
    handoff: tool({
      description:
        'Propose shipping the session changeset to a coding backend (opens a PR). Requires the ' +
        'user to approve — it never ships on its own. Provide a developer-facing summary of what ' +
        'changed and why.',
      inputSchema: HandoffInput,
      outputSchema: ToolResult,
      // Reached only after the user approves (loop `toolApproval.handoff`). The real dispatch —
      // MCP `task(create)` or a downloadable MD report — is slice 07; here we hand the assembled
      // changeset back so the SW can route it. Never auto-ships.
      execute: async ({ summary, backend }) =>
        result({ summary, backend, edits: store.size, sessionId: store.current.sessionId }),
    }),
  };
}
