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
import type { ChangesetStore } from '@/changeset/store';
import { type Changeset, Edit } from '@/shared/changeset';
import { type SwToPanel, ToolResult } from '@/shared/messages';

/** Everything the session tools need, injected so the module stays chrome-free and testable. */
export interface SessionToolDeps {
  /** The live changeset for this turn's tab (seeded from / persisted back to the SessionStore). */
  readonly store: ChangesetStore;
  /** Persist the changeset after every mutation (→ `chrome.storage.session` via SessionStore). */
  readonly persist: (changeset: Changeset) => Promise<void> | void;
  /** Stream changeset events to the side-panel port (`edit-recorded` / `changeset`). */
  readonly emit: (event: SwToPanel) => void;
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
  const { store, persist, emit } = deps;

  return {
    recordEdit: tool({
      description:
        'Record an accepted change as a durable edit in the session changeset — the intent (why), ' +
        'the target selector, and the style/text changes. When you made this change under device ' +
        'emulation (`setDevice`), set `breakpoint` to the device so the changeset and report show ' +
        'which viewport it targets. This is what Ship hands off; record after you have applied and ' +
        'visually verified a change.',
      inputSchema: Edit,
      outputSchema: ToolResult,
      execute: async (edit) => {
        store.record(edit);
        await persist(store.current);
        emit({ type: 'edit-recorded', edit });
        return result({ edits: store.size });
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
