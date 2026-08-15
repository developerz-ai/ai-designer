import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore } from '@/agent/history-store';
import { SessionStore } from '@/agent/session';
import { toThreadView } from '@/agent/thread-view';
import { createSessionChangesetPersister } from '@/changeset/store';
import type { Changeset, Edit } from '@/shared/changeset';

// Integration: the `conversation-new` RPC's SW-side semantics, driven through the REAL cooperating
// modules (SessionStore, HistoryStore, the changeset persister, toThreadView) wired exactly the way
// background.ts's `case 'conversation-new'` does it. background.ts itself can't be imported under
// Vitest (WXT `#imports`), so this reproduces the handler glue 1:1 — the approach of
// history-flow.test.ts / debug-log.test.ts.
//
// The contract under test:
//   • ARCHIVE — every finished (or abort-settled) turn already reached history via `appendTurn`
//     keyed by the changeset's sessionId; the reset must leave that record intact.
//   • RESET — the next `thread-get` renders an EMPTY thread, the debug log and usage are wiped.
//   • RE-KEY, EDITS KEPT — the changeset's edits survive on BOTH mirrors (the live page still
//     carries them; Ship must stay truthful) under a FRESH sessionId, so the next turn opens a NEW
//     history conversation instead of extending the archived one.

const URL = 'https://example.com/pricing';
const SESSION_ID = '00000000-0000-0000-0000-0000000000aa';
const TAB = 7;

const edit: Edit = {
  intent: 'Recolor the CTA',
  selector: { value: '.cta', strategy: 'css-path', fragile: false },
  changes: [{ prop: 'background', before: '#fff', after: '#f97316' }],
  attrs: [],
  classes: [],
  frameworkHints: [],
};

function installStorageFakes(): void {
  const api = (store: Map<string, unknown>) => ({
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const names = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (store.has(name)) out[name] = store.get(name);
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [name, value] of Object.entries(items))
        store.set(name, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      return Promise.resolve();
    },
  });
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: api(new Map()), session: api(new Map()) },
  };
}

/** A session mid-conversation: one finished turn in the thread + history, one recorded edit on
 *  both changeset mirrors, a debug-log entry, some spend. */
async function seedConversation(sessions: SessionStore, history: HistoryStore) {
  const session = await sessions.ensure(TAB, URL, SESSION_ID);
  const withEdit: Changeset = { ...session.changeset, edits: [edit] };
  await sessions.setChangeset(TAB, withEdit);
  const persister = createSessionChangesetPersister(TAB);
  await persister.save({ changeset: withEdit, redoStack: [] });
  await sessions.appendMessages(
    TAB,
    { role: 'user', content: 'Recolor the CTA' },
    { role: 'assistant', content: 'Recolored it.' },
  );
  await sessions.appendLog(TAB, { at: 1000, kind: 'tool', text: '→ setStyle .cta' });
  await sessions.patch(TAB, { usage: { steps: 3, tokens: 1200 } });
  // The turn-done path's history append (background.ts's outcome handler), keyed by sessionId.
  await history.appendTurn({
    id: withEdit.sessionId,
    title: 'Recolor the CTA',
    url: URL,
    messages: [
      { role: 'user', content: 'Recolor the CTA' },
      { role: 'assistant', content: 'Recolored it.' },
    ],
  });
}

/** Mirrors background.ts `case 'conversation-new'`'s reset step 1:1: load the persister record,
 *  re-key the changeset to a fresh sessionId, save the SAME object to both mirrors, reset the
 *  session's thread/log/usage. (The abort + bounded settle-wait that precedes this in the handler
 *  IS the archive — the aborted turn's finalization appends to history through the normal
 *  turn-done path, which `seedConversation` above stands in for.) */
async function resetConversationGlue(sessions: SessionStore, tabId: number): Promise<void> {
  const persister = createSessionChangesetPersister(tabId);
  const priorState = await persister.load();
  const current = sessions.get(tabId);
  if (!current) return;
  const rekeyed = {
    ...(priorState?.changeset ?? current.changeset),
    sessionId: crypto.randomUUID(),
  };
  await persister.save({ changeset: rekeyed, redoStack: priorState?.redoStack ?? [] });
  await sessions.resetConversation(tabId, rekeyed);
}

beforeEach(() => {
  installStorageFakes();
});

describe('conversation-new: archive survives, thread resets, changeset survives re-keyed', () => {
  it('the next thread-get renders an empty thread while history keeps the archived conversation', async () => {
    const sessions = new SessionStore({ now: () => 1000 });
    const history = new HistoryStore({ now: () => 1000 });
    await seedConversation(sessions, history);
    expect(toThreadView(sessions.get(TAB)?.messages ?? [])).toHaveLength(2); // sanity

    await resetConversationGlue(sessions, TAB);

    // thread-get for this tab now renders an empty thread…
    expect(toThreadView(sessions.get(TAB)?.messages ?? [])).toEqual([]);
    // …the conversation's debug log and spend went with it…
    expect(sessions.get(TAB)?.log).toEqual([]);
    expect(sessions.get(TAB)?.usage).toEqual({ steps: 0, tokens: 0 });
    expect(sessions.get(TAB)?.status).toBe('idle');
    // …and the ARCHIVE is intact: history still holds the full conversation under the old id.
    expect(history.get(SESSION_ID)?.messages).toEqual([
      { role: 'user', content: 'Recolor the CTA' },
      { role: 'assistant', content: 'Recolored it.' },
    ]);
  });

  it('the changeset EDITS survive on both mirrors under a fresh sessionId', async () => {
    const sessions = new SessionStore({ now: () => 1000 });
    const history = new HistoryStore({ now: () => 1000 });
    await seedConversation(sessions, history);

    await resetConversationGlue(sessions, TAB);

    const sessionMirror = sessions.get(TAB)?.changeset;
    const persisterMirror = (await createSessionChangesetPersister(TAB).load())?.changeset;
    // The recorded work is still shippable — the live page still carries it.
    expect(sessionMirror?.edits).toEqual([edit]);
    expect(persisterMirror?.edits).toEqual([edit]);
    // Re-keyed, identically on both mirrors (the persister is what the next turn loads FIRST).
    expect(sessionMirror?.sessionId).not.toBe(SESSION_ID);
    expect(persisterMirror?.sessionId).toBe(sessionMirror?.sessionId);
  });

  it('the next turn opens a NEW history conversation; the archived one is untouched', async () => {
    const sessions = new SessionStore({ now: () => 1000 });
    const history = new HistoryStore({ now: () => 2000 });
    await seedConversation(sessions, history);

    await resetConversationGlue(sessions, TAB);

    // The next turn's history append keys off the re-keyed changeset (background.ts uses
    // `changesetStore.current.sessionId`, seeded from the persister record).
    const nextId = sessions.get(TAB)?.changeset.sessionId;
    expect(nextId).toBeDefined();
    await history.appendTurn({
      id: nextId as string,
      title: 'Now tighten the spacing',
      url: URL,
      messages: [{ role: 'user', content: 'Now tighten the spacing' }],
    });

    expect(history.size).toBe(2); // a genuinely new conversation, not an extension
    expect(history.get(SESSION_ID)?.title).toBe('Recolor the CTA');
    expect(history.get(SESSION_ID)?.messages).toHaveLength(2); // archived thread unchanged
    expect(history.get(nextId as string)?.title).toBe('Now tighten the spacing');
  });

  it('the reset survives an SW eviction — a woken worker sees the fresh thread and the kept edits', async () => {
    const sessions = new SessionStore({ now: () => 1000 });
    const history = new HistoryStore({ now: () => 1000 });
    await seedConversation(sessions, history);
    await resetConversationGlue(sessions, TAB);
    const freshId = sessions.get(TAB)?.changeset.sessionId;

    // Fresh module state (MV3 evicted the worker), same storage.
    const woken = new SessionStore();
    await woken.hydrate();
    expect(toThreadView(woken.get(TAB)?.messages ?? [])).toEqual([]);
    expect(woken.get(TAB)?.changeset.edits).toEqual([edit]);
    expect(woken.get(TAB)?.changeset.sessionId).toBe(freshId);

    const revivedHistory = new HistoryStore();
    await revivedHistory.hydrate();
    expect(revivedHistory.get(SESSION_ID)?.messages).toHaveLength(2);
  });

  it('a sticky mode does not leak into the fresh conversation', async () => {
    const sessions = new SessionStore({ now: () => 1000 });
    const history = new HistoryStore({ now: () => 1000 });
    await seedConversation(sessions, history);
    await sessions.patch(TAB, { lastMode: 'debug' });

    await resetConversationGlue(sessions, TAB);

    expect(sessions.get(TAB)?.lastMode).toBeUndefined();
  });
});
