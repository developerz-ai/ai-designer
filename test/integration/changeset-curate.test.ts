// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { applyChangesetOp, type ChangesetOp, readChangeset } from '@/changeset/panel-ops';
import {
  ChangesetStore,
  createSessionChangesetPersister,
  type SessionStorageArea,
} from '@/changeset/store';
import { type Changeset, type Edit, emptyChangeset } from '@/shared/changeset';
import { ChangesetResult, PanelToSw } from '@/shared/messages';

// Integration — the diff-review changeset curation RPCs (changeset-get / -undo / -redo / -clear /
// -remove-edit, slice 10) end to end through the REAL cooperating SW modules the way
// background.ts wires them (src/entrypoints/background.ts lines ~998-1049): the message switch
// resolves a target tab, builds a REAL `createSessionChangesetPersister` over the storage area,
// applies the turn-in-flight busy guard (`turnAbort`), delegates to the REAL panel-ops
// (`readChangeset` / `applyChangesetOp`), mirrors onto the SessionStore best-effort, and pushes the
// curated changeset back to the panel. Every reply is parsed with the REAL `ChangesetResult` zod
// schema (and every inbound message with the REAL `PanelToSw`), so schema conformance is enforced
// on each dispatch — a non-conforming reply throws inside `dispatch`, failing the test.
//
// background.ts imports the WXT `#imports` virtual module and can't be imported under Vitest, so its
// five `handle()` cases are reproduced 1:1 in `dispatch` below (mirrors key-rpcs.test.ts).
// REAL vs faked: real = panel-ops, ChangesetStore, session persister, all zod schemas.
// Faked = SessionStorageArea (Map-backed, JSON round-tripping like real storage), the target-tab
// resolution (chrome.tabs.query), the SessionStore mirror (`sessions.setChangeset`), the panel push
// (`postToPanel`), and the SW-lifetime `turnAbort` flag. No `chrome` global is installed — the
// persister takes the fake area by injection, so node env suffices.

const TAB_ID = 7;
const KEY = `changeset:${TAB_ID}`;
const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const URL = 'https://example.com/pricing';

const seed = (): Changeset => emptyChangeset(URL, '2026-07-23T00:00:00Z', SESSION_ID);

// A minimal valid Edit tagged by intent so tests can assert history order by name
// (mirrors test/unit/changeset-store.test.ts).
const edit = (intent: string): Edit => ({
  intent,
  selector: { value: `#${intent}`, strategy: 'id', fragile: false },
  changes: [{ prop: 'color', before: null, after: '#000' }],
  frameworkHints: [],
});

const intents = (cs: Changeset | null | undefined): string[] =>
  cs?.edits.map((e) => e.intent) ?? [];

// Minimal in-memory chrome.storage.session-shaped fake, round-tripping values through JSON to
// mirror storage serialization (copied from test/unit/changeset-store.test.ts's fakeArea).
function fakeArea(): SessionStorageArea & { backing: Map<string, unknown> } {
  const backing = new Map<string, unknown>();
  return {
    backing,
    get(keys) {
      const names = keys == null ? [...backing.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (backing.has(name)) out[name] = backing.get(name);
      return Promise.resolve(out);
    },
    set(items) {
      for (const [name, value] of Object.entries(items))
        backing.set(name, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
    remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) backing.delete(k);
      return Promise.resolve();
    },
  };
}

// --- SW-lifetime state the handlers close over (reset per test) --------------

let area: ReturnType<typeof fakeArea>;
// resolveTargetTab: the active tab of the last-focused window — the handlers only read `tab?.id`.
let activeTab: { id: number } | undefined;
// The turn-in-flight guard: set while an agent turn runs (background.ts `turnAbort`).
let turnAbort: AbortController | null;
// Panel push recorder (background.ts `postToPanel`).
let pushed: unknown[];
const postToPanel = (msg: unknown): void => {
  pushed.push(msg);
};
// SessionStore mirror fake: records calls, can be told to fail (an evicted tab's setChangeset
// throws — background wraps it in .catch, so the op must still succeed).
const sessions = {
  setChangesetCalls: [] as { tabId: number; changeset: Changeset }[],
  failSetChangeset: false,
  setChangeset(tabId: number, changeset: Changeset): Promise<void> {
    this.setChangesetCalls.push({ tabId, changeset });
    return this.failSetChangeset ? Promise.reject(new Error('no live session')) : Promise.resolve();
  },
};

const resolveTargetTab = (): Promise<{ id: number } | undefined> => Promise.resolve(activeTab);

// The five curation messages, narrowed off the real PanelToSw union.
type CurationMsg = Extract<
  PanelToSw,
  {
    type:
      | 'changeset-get'
      | 'changeset-undo'
      | 'changeset-redo'
      | 'changeset-clear'
      | 'changeset-remove-edit';
  }
>;

// Reproduces background.ts's changeset `handle()` cases 1:1, including the reply shape:
// every branch's reply goes through the REAL ChangesetResult schema before returning.
async function dispatch(raw: CurationMsg): Promise<ChangesetResult> {
  // The SW listener safe-parses inbound with PanelToSw before handle() — parse here too so a
  // malformed test message fails loudly at the boundary, not in a later assertion.
  const msg = PanelToSw.parse(raw) as CurationMsg;
  switch (msg.type) {
    case 'changeset-get': {
      const tab = await resolveTargetTab();
      if (tab?.id === undefined)
        return ChangesetResult.parse({
          ok: true,
          changeset: null,
          canUndo: false,
          canRedo: false,
        });
      const persister = createSessionChangesetPersister(tab.id, area);
      return ChangesetResult.parse({ ok: true, ...(await readChangeset(persister.load)) });
    }
    case 'changeset-undo':
    case 'changeset-redo':
    case 'changeset-clear':
    case 'changeset-remove-edit': {
      const tab = await resolveTargetTab();
      if (tab?.id === undefined)
        return ChangesetResult.parse({
          ok: false,
          changeset: null,
          canUndo: false,
          canRedo: false,
        });
      const tabId = tab.id;
      const persister = createSessionChangesetPersister(tabId, area);
      // Reject while a turn is in flight: the running turn owns its own ChangesetStore and persists
      // after every tool call, so a panel op loading a fresh store from storage would clobber it.
      if (turnAbort)
        return ChangesetResult.parse({
          ok: false,
          busy: true,
          ...(await readChangeset(persister.load)),
        });
      const op: ChangesetOp =
        msg.type === 'changeset-undo'
          ? { kind: 'undo' }
          : msg.type === 'changeset-redo'
            ? { kind: 'redo' }
            : msg.type === 'changeset-clear'
              ? { kind: 'clear' }
              : { kind: 'remove', index: msg.index };
      const result = await applyChangesetOp(
        {
          load: persister.load,
          save: persister.save,
          // Mirror onto the SessionStore so a subsequent Ship/report read sees the curated record.
          // Best-effort: a throwing mirror must not fail the curation.
          mirror: (cs) =>
            sessions
              .setChangeset(tabId, cs)
              .then(() => undefined)
              .catch(() => undefined),
        },
        op,
      );
      if (result.changeset) postToPanel({ type: 'changeset', changeset: result.changeset });
      return ChangesetResult.parse({ ok: true, ...result });
    }
  }
}

// Seed the durable record the way the agent's recordEdit tool does: a REAL ChangesetStore whose
// persist port is the REAL session persister over the fake area (no hand-crafted storage JSON).
async function seedEdits(...edits: string[]): Promise<void> {
  const persister = createSessionChangesetPersister(TAB_ID, area);
  const store = new ChangesetStore(seed(), { persist: persister.save });
  for (const intent of edits) store.record(edit(intent));
  await Promise.resolve(); // let the fire-and-forget persist settle
}

// A FRESH persister over the same area — proves a mutation went through storage, not just memory.
const freshLoad = () => createSessionChangesetPersister(TAB_ID, area).load();

beforeEach(() => {
  area = fakeArea();
  activeTab = { id: TAB_ID };
  turnAbort = null;
  pushed = [];
  sessions.setChangesetCalls = [];
  sessions.failSetChangeset = false;
});

describe('integration: changeset-get (diff-review curation)', () => {
  it('returns the empty view for a tab with no persisted changeset', async () => {
    const res = await dispatch({ type: 'changeset-get' });
    expect(res).toEqual({ ok: true, changeset: null, canUndo: false, canRedo: false });
  });

  it('reports seeded edits with canUndo true, straight from storage', async () => {
    await seedEdits('a', 'b');

    const res = await dispatch({ type: 'changeset-get' });
    expect(res.ok).toBe(true);
    expect(intents(res.changeset)).toEqual(['a', 'b']);
    expect(res.canUndo).toBe(true);
    expect(res.canRedo).toBe(false);
    expect(res.changeset?.sessionId).toBe(SESSION_ID);
  });

  it('still replies when no target tab resolves; mutators report not-ok', async () => {
    activeTab = undefined;

    expect(await dispatch({ type: 'changeset-get' })).toEqual({
      ok: true,
      changeset: null,
      canUndo: false,
      canRedo: false,
    });
    expect(await dispatch({ type: 'changeset-undo' })).toEqual({
      ok: false,
      changeset: null,
      canUndo: false,
      canRedo: false,
    });
  });
});

describe('integration: changeset mutators walk the durable history', () => {
  it('undo drops the last edit and persists the redo stack through storage', async () => {
    await seedEdits('a', 'b');

    const res = await dispatch({ type: 'changeset-undo' });
    expect(res).toMatchObject({ ok: true, canUndo: true, canRedo: true });
    expect(intents(res.changeset)).toEqual(['a']);

    // Durability: a fresh persister sees both the mutation AND the redo tail.
    const persisted = await freshLoad();
    expect(intents(persisted?.changeset)).toEqual(['a']);
    expect(persisted?.redoStack.map((e) => e.intent)).toEqual(['b']);
  });

  it('redo re-applies the undone edit and drains the redo stack', async () => {
    await seedEdits('a', 'b');
    await dispatch({ type: 'changeset-undo' });

    const res = await dispatch({ type: 'changeset-redo' });
    expect(res).toMatchObject({ ok: true, canUndo: true, canRedo: false });
    expect(intents(res.changeset)).toEqual(['a', 'b']);

    const persisted = await freshLoad();
    expect(intents(persisted?.changeset)).toEqual(['a', 'b']);
    expect(persisted?.redoStack).toEqual([]);
  });

  it('clear wipes the edits durably but keeps the changeset identity', async () => {
    await seedEdits('a', 'b');

    const res = await dispatch({ type: 'changeset-clear' });
    expect(res).toMatchObject({ ok: true, canUndo: false, canRedo: false });
    expect(res.changeset?.edits).toEqual([]);
    expect(res.changeset?.sessionId).toBe(SESSION_ID);
    expect(res.changeset?.url).toBe(URL);

    const persisted = await freshLoad();
    expect(persisted?.changeset.edits).toEqual([]);
    expect(persisted?.changeset.sessionId).toBe(SESSION_ID);
  });

  it('remove-edit drops the edit at the index', async () => {
    await seedEdits('a', 'b', 'c');

    const res = await dispatch({ type: 'changeset-remove-edit', index: 1 });
    expect(res).toMatchObject({ ok: true, canUndo: true, canRedo: false });
    expect(intents(res.changeset)).toEqual(['a', 'c']);
    expect(intents((await freshLoad())?.changeset)).toEqual(['a', 'c']);
  });

  it('remove-edit forks history — an earned redo tail is dropped, durably', async () => {
    await seedEdits('a', 'b', 'c');
    await dispatch({ type: 'changeset-undo' }); // c -> redo stack, edits [a, b]
    expect((await dispatch({ type: 'changeset-get' })).canRedo).toBe(true);

    const res = await dispatch({ type: 'changeset-remove-edit', index: 0 }); // drop a
    expect(res).toMatchObject({ ok: true, canUndo: true, canRedo: false });
    expect(intents(res.changeset)).toEqual(['b']);

    // The fork is durable: a fresh load shows no redo tail, and a redo is now a no-op.
    expect((await freshLoad())?.redoStack).toEqual([]);
    const redo = await dispatch({ type: 'changeset-redo' });
    expect(redo.canRedo).toBe(false);
    expect(intents(redo.changeset)).toEqual(['b']);
  });

  it('remove-edit out of range is an idempotent no-op', async () => {
    await seedEdits('a');

    const res = await dispatch({ type: 'changeset-remove-edit', index: 5 });
    expect(res.ok).toBe(true);
    expect(intents(res.changeset)).toEqual(['a']);
    expect(intents((await freshLoad())?.changeset)).toEqual(['a']);
  });

  it('mirrors the curated record onto the SessionStore and pushes it to the panel', async () => {
    await seedEdits('a', 'b');

    await dispatch({ type: 'changeset-undo' });

    expect(sessions.setChangesetCalls).toHaveLength(1);
    expect(sessions.setChangesetCalls[0]?.tabId).toBe(TAB_ID);
    expect(intents(sessions.setChangesetCalls[0]?.changeset)).toEqual(['a']);

    expect(pushed).toHaveLength(1);
    const push = pushed[0] as { type: string; changeset: Changeset };
    expect(push.type).toBe('changeset');
    expect(intents(push.changeset)).toEqual(['a']);
  });
});

describe('integration: busy guard (turn in flight)', () => {
  it('rejects all four mutators with busy:true, storage untouched; get is still served', async () => {
    await seedEdits('a', 'b');
    const storedBefore = area.backing.get(KEY);
    turnAbort = new AbortController();

    const mutators = [
      { type: 'changeset-undo' },
      { type: 'changeset-redo' },
      { type: 'changeset-clear' },
      { type: 'changeset-remove-edit', index: 0 },
    ] as const;
    for (const msg of mutators) {
      const res = await dispatch(msg);
      expect(res).toMatchObject({ ok: false, busy: true, canUndo: true, canRedo: false });
      // The current state is echoed back so the panel can reflect it.
      expect(intents(res.changeset)).toEqual(['a', 'b']);
    }

    // Nothing reached storage, the mirror, or the panel.
    expect(area.backing.get(KEY)).toEqual(storedBefore);
    expect(sessions.setChangesetCalls).toHaveLength(0);
    expect(pushed).toHaveLength(0);

    // changeset-get is a pure read — still served while a turn runs.
    const get = await dispatch({ type: 'changeset-get' });
    expect(get).toMatchObject({ ok: true, canUndo: true, canRedo: false });
    expect(intents(get.changeset)).toEqual(['a', 'b']);
  });
});

describe('integration: mirror is best-effort', () => {
  it('a throwing SessionStore mirror does not fail the op — the persister stays source of truth', async () => {
    await seedEdits('a', 'b');
    sessions.failSetChangeset = true;

    const res = await dispatch({ type: 'changeset-undo' });
    expect(res).toMatchObject({ ok: true, canUndo: true, canRedo: true });
    expect(intents(res.changeset)).toEqual(['a']);
    expect(sessions.setChangesetCalls).toHaveLength(1); // the mirror was attempted

    // The durable record still mutated.
    const persisted = await freshLoad();
    expect(intents(persisted?.changeset)).toEqual(['a']);
    expect(persisted?.redoStack.map((e) => e.intent)).toEqual(['b']);
  });
});
