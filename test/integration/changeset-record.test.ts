import { describe, expect, it } from 'vitest';
import { createSessionTools } from '@/agent/tools/session';
import { ChangesetStore } from '@/changeset/store';
import { createDomExecutor } from '@/dom/execute';
import { createMutator } from '@/dom/mutate';
import { createRecorder } from '@/dom/recorder';
import { reduceChangeset } from '@/entrypoints/sidepanel/stores/changeset';
import { type ChatMessage, reduceChat } from '@/entrypoints/sidepanel/stores/chat';
import { Changeset, type Edit, emptyChangeset } from '@/shared/changeset';
import type { ContentToSw, SwToPanel, ToolResult } from '@/shared/messages';
import { relayToPanel } from '@/shared/relay';

// Integration — the changeset FOLD-BACK seam: an accepted live edit travels content -> SW -> panel.
// A real DOM mutation (createDomExecutor + createMutator + createRecorder on jsdom, exactly as
// dom-execute.test.ts drives it) produces a GENUINE `recorder-event` (ContentToSw), and that same
// accepted change is folded into a per-tab `ChangesetStore` through the REAL `recordEdit`/`undo`/
// `redo` session tools; the store's `emit` port (the `edit-recorded`/`changeset` SwToPanel stream)
// is folded by the REAL panel stores (`stores/chat.ts` reduceChat, `stores/changeset.ts`
// reduceChangeset). Nothing here is mocked but the two capture arrays and the wiring that
// reproduces background.ts's `user-message` case (it constructs the ChangesetStore + createSessionTools
// with `emit: postToPanel` — background.ts imports the WXT `#imports` virtual module and can't be
// imported under Vitest, so the wiring is reproduced 1:1).
//
// REAL vs faked: real = dom executor/mutator/recorder, ChangesetStore, createSessionTools,
// relayToPanel, panel reduceChat/reduceChangeset, all Zod schemas. Faked = the ContentToSw/SwToPanel
// capture arrays only. Note the actual code path: background.ts folds the intent-tagged `Edit` via
// the `recordEdit` tool (the raw `recorder-event` is separately RELAYED to the panel as a display
// chip via relay.ts — asserted here too); the two are distinct records of the one accepted mutation.
// No existing integration test wires the SW ChangesetStore emit THROUGH to the panel stores — the
// ChangesetStore integration tests (agent-loop/responsive-report/history-flow) pass
// `emit: () => undefined`; the unit tests fold hand-built messages. This proves the whole seam.

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const URL = 'http://localhost:3000/pricing';

const data = <T>(r: ToolResult): T => r.data as T;

// Mirror background.ts's user-message changeset wiring: a per-tab ChangesetStore + the session tools
// bound to it, with `emit` = postToPanel (captured) and `persist` = the SessionStore mirror (captured).
function makeSw() {
  const toPanel: SwToPanel[] = [];
  const persisted: Changeset[] = [];
  const store = new ChangesetStore(emptyChangeset(URL, '2026-07-14T00:00:00Z', SESSION_ID));
  const tools = createSessionTools({
    store,
    persist: (changeset) => {
      persisted.push(changeset);
    },
    emit: (event) => toPanel.push(event),
  });
  return { store, tools, toPanel, persisted };
}

// A live jsdom edit driven through the real executor -> a genuine recorder-event on the content bus.
function driveMutation(html: string): {
  emitted: ContentToSw[];
  exec: ReturnType<typeof createDomExecutor>['exec'];
} {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
  const emitted: ContentToSw[] = [];
  const recorder = createRecorder(
    (m) => emitted.push(m),
    () => 1_752_460_800_000,
  );
  const executor = createDomExecutor({ mutator: createMutator(document), recorder, doc: document });
  return { emitted, exec: executor.exec };
}

const runTool = (execute: unknown, input: unknown): Promise<ToolResult> =>
  (execute as (i: unknown, o: Record<string, unknown>) => Promise<ToolResult>)(input, {});

describe('changeset fold-back: recorder mutation -> SW ChangesetStore -> panel stores', () => {
  it('folds a real edit into the store and streams edit-recorded into the panel chat store', async () => {
    // 1) A genuine live mutation produces a real recorder-event on the content bus.
    const { emitted, exec } = driveMutation('<button id="cta">Buy</button>');
    const applied = exec({ type: 'setStyle', selector: '#cta', props: { color: 'rgb(1, 2, 3)' } });
    expect(applied.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const recorderEvent = emitted[0];
    if (recorderEvent?.type !== 'recorder-event') throw new Error('expected a recorder-event');
    expect(recorderEvent.event.kind).toBe('setStyle');

    // The raw recorder-event is NOT relayed to the panel (relay.ts) — no panel store consumes it;
    // the fold-back reaches the panel as an intent-tagged `edit-recorded` via `recordEdit` below.
    expect(relayToPanel(recorderEvent)).toBeNull();

    // 2) The accepted change is recorded as an intent-tagged Edit, GROUNDED in the recorder-event's
    // real selector, through the REAL recordEdit tool into the real ChangesetStore.
    const { store, tools, toPanel, persisted } = makeSw();
    const edit: Edit = {
      intent: 'Make the primary CTA blue',
      selector: recorderEvent.event.selector,
      changes: [{ prop: 'color', before: recorderEvent.event.before, after: 'rgb(1, 2, 3)' }],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    const res = await runTool(tools.recordEdit.execute, edit);
    expect(res.ok).toBe(true);
    expect(data<{ edits: number }>(res).edits).toBe(1);

    // The store now holds a valid Changeset entry shaped end-to-end.
    const parsed = Changeset.safeParse(store.current);
    expect(parsed.success).toBe(true);
    expect(store.current.edits).toHaveLength(1);
    expect(store.current.edits[0]?.selector.value).toBe('#cta');
    expect(store.current.edits[0]?.changes[0]?.after).toBe('rgb(1, 2, 3)');
    // Persisted to the SessionStore mirror (background.ts's `persist` port).
    expect(persisted.at(-1)?.edits).toHaveLength(1);

    // 3) The emitted `edit-recorded` folds into the REAL panel chat store's in-flight bubble.
    let messages: ChatMessage[] = reduceChat([], { type: 'token', text: 'Recorded that edit.' });
    for (const msg of toPanel) messages = reduceChat(messages, msg);
    const assistant = messages.at(-1);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.edits).toEqual([edit]);
  });

  it('drives undo/redo through the store and reflects the full changeset in the panel changeset store', async () => {
    const { store, tools, toPanel } = makeSw();
    const edit: Edit = {
      intent: 'Bump the heading size',
      selector: { value: '#h', strategy: 'id', fragile: false },
      changes: [{ prop: 'font-size', before: '16px', after: '24px' }],
      attrs: [],
      classes: [],
      frameworkHints: [],
    };
    await runTool(tools.recordEdit.execute, edit);

    // recordEdit emits `edit-recorded` (not `changeset`), so the panel changeset store is still empty:
    // it only adopts a full `changeset` push (real reduceChangeset behaviour).
    let changeset = toPanel.reduce<Changeset | null>((acc, m) => reduceChangeset(acc, m), null);
    expect(changeset).toBeNull();

    // undo removes the edit and streams the full changeset -> the panel store adopts the empty set.
    const undo = await runTool(tools.undo.execute, {});
    expect(data<{ undone: boolean }>(undo).undone).toBe(true);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(true);
    changeset = toPanel.reduce<Changeset | null>((acc, m) => reduceChangeset(acc, m), null);
    expect(changeset?.edits).toEqual([]);

    // redo re-applies it and streams again -> the panel store reflects the restored edit end-to-end.
    const redo = await runTool(tools.redo.execute, {});
    expect(data<{ redone: boolean }>(redo).redone).toBe(true);
    expect(store.current.edits).toHaveLength(1);
    changeset = toPanel.reduce<Changeset | null>((acc, m) => reduceChangeset(acc, m), null);
    expect(changeset?.edits).toHaveLength(1);
    expect(changeset?.edits[0]?.changes[0]?.after).toBe('24px');
    expect(changeset?.sessionId).toBe(SESSION_ID);
  });
});
