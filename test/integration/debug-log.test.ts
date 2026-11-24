import { beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_LOG_CAP, GlobalLogStore } from '@/agent/global-log';
import { SessionStore } from '@/agent/session';
import {
  errorLogEntry,
  type LogEntry,
  logEntryFor,
  mergeLogs,
  renderTurnLog,
} from '@/agent/turn-log';
import type { SwToPanel } from '@/shared/messages';

// Integration (P1): the pasteable debug log for errors that happen BEFORE any session exists.
// background.ts's user-message setup guards ("Open a web page…", "Add a model provider…",
// MISSING_KEY_ERROR) fire before `sessions.ensure`, and `SessionStore.appendLog` is a no-op
// without a session — so the user with the broken install always pasted an EMPTY log. The SW now
// keeps a STORAGE-BACKED SW-global ring (`agent/global-log.ts` — an in-memory one died with the
// ~30s-idle MV3 eviction and the paste was empty again a minute later) and `debug-log-get` merges
// it into the session's own entries. background.ts cannot be imported under Vitest (WXT
// `#imports`), so this drives the REAL GlobalLogStore/turn-log modules and mirrors only the
// handler glue — same approach as thread-memory.test.ts.

/** Mirrors background.ts's `postTurnlessError` log half (the panel push is irrelevant here). */
function postTurnlessError(globalLog: GlobalLogStore, message: string): void {
  const update: SwToPanel = { type: 'error', message };
  const entry = logEntryFor(update, Date.now());
  if (entry) globalLog.append(entry);
}

const context = {
  version: '0.0.0-test',
  model: '',
  providerHost: '',
  pageUrl: '(no tab)',
  tabId: -1,
};

beforeEach(() => {
  installStorageFakes();
});

describe('pre-session errors reach a copyable log', () => {
  it('an "Add a model provider" error with no session still renders a non-empty log', async () => {
    const globalLog = new GlobalLogStore();
    await globalLog.hydrate();
    const sessions = new SessionStore();

    // The setup guard fires with NO session anywhere (a fresh install mid-configuration).
    postTurnlessError(globalLog, 'Add a model provider in Settings to start.');

    // debug-log-get's merge: no conversation tab resolves, session log is empty — the global
    // ring alone must carry the failure.
    const log = mergeLogs(globalLog.all(), sessions.get(123)?.log ?? []);
    expect(log.length).toBeGreaterThanOrEqual(1);

    const markdown = renderTurnLog(context, log);
    expect(markdown).toContain('Add a model provider in Settings to start.');
    expect(markdown).not.toContain('No activity logged');
  });

  it('the pre-session error SURVIVES an SW eviction — a fresh worker still renders it', async () => {
    // Worker 1: the guard fires, the ring persists to chrome.storage.session.
    const first = new GlobalLogStore();
    await first.hydrate();
    postTurnlessError(first, 'Add a model provider in Settings to start.');

    // Worker 2: fresh module state (MV3 evicted the first), same storage.
    const woken = new GlobalLogStore();
    await woken.hydrate();
    const log = mergeLogs(woken.all(), []);
    expect(log.length).toBeGreaterThanOrEqual(1);
    const markdown = renderTurnLog(context, log);
    expect(markdown).toContain('Add a model provider in Settings to start.');
    expect(markdown).not.toContain('No activity logged');
  });

  it('hydrate MERGES with entries appended during the boot window rather than clobbering them', async () => {
    const first = new GlobalLogStore();
    await first.hydrate();
    first.append({ at: 100, kind: 'error', text: 'ERROR persisted before eviction' });

    const woken = new GlobalLogStore();
    // The read is in flight; an escaped error lands before it settles (the global listeners run
    // from the worker's first tick). Pre-merge, the append's persist clobbered the stored ring
    // and the hydrate then clobbered the append back — one of the two errors always lost.
    const hydrating = woken.hydrate();
    woken.append({ at: 200, kind: 'error', text: 'ERROR during boot window' });
    await hydrating;
    expect(woken.all().map((e) => e.text)).toEqual([
      'ERROR persisted before eviction',
      'ERROR during boot window',
    ]);
    // …and the write-back repaired storage too: a THIRD worker sees both.
    const third = new GlobalLogStore();
    await third.hydrate();
    expect(third.all().map((e) => e.text)).toEqual([
      'ERROR persisted before eviction',
      'ERROR during boot window',
    ]);
  });

  it('stays bounded at GLOBAL_LOG_CAP across appends and rehydrates', async () => {
    const store = new GlobalLogStore();
    await store.hydrate();
    for (let n = 0; n < GLOBAL_LOG_CAP + 25; n += 1) {
      store.append({ at: n, kind: 'note', text: `#${n}` });
    }
    expect(store.all()).toHaveLength(GLOBAL_LOG_CAP);
    const woken = new GlobalLogStore();
    await woken.hydrate();
    expect(woken.all()).toHaveLength(GLOBAL_LOG_CAP);
    expect(woken.all().at(-1)?.text).toBe(`#${GLOBAL_LOG_CAP + 24}`);
  });

  it('an escaped SW error with no last-turn tab lands in the global ring, not the void', async () => {
    const globalLog = new GlobalLogStore();
    await globalLog.hydrate();
    // Mirrors logEscapedError's no-tab branch (it used to `return` here).
    globalLog.append(
      errorLogEntry('UNHANDLED', new Error('AI_NoOutputGeneratedError'), Date.now()),
    );
    const markdown = renderTurnLog(context, mergeLogs(globalLog.all(), []));
    expect(markdown).toContain('UNHANDLED');
    expect(markdown).toContain('AI_NoOutputGeneratedError');
  });

  it('once a session exists, its entries and the pre-session ring merge chronologically', async () => {
    const globalLog = new GlobalLogStore();
    await globalLog.hydrate();
    const sessions = new SessionStore({ now: () => 1000 });
    await sessions.ensure(7, 'https://example.com', '00000000-0000-0000-0000-0000000000aa');

    postTurnlessError(globalLog, 'Add a model provider in Settings to start.');
    const later: LogEntry = { at: Date.now() + 1, kind: 'tool', text: '→ setStyle .cta' };
    await sessions.appendLog(7, later);

    const log = mergeLogs(globalLog.all(), sessions.get(7)?.log ?? []);
    expect(log.map((e) => e.kind)).toEqual(['error', 'tool']);
  });

  it('drops a malformed persisted ring instead of throwing on hydrate', async () => {
    await chrome.storage.session.set({ globalLog: { not: 'an array' } });
    const store = new GlobalLogStore();
    await expect(store.hydrate()).resolves.toBeUndefined();
    expect(store.all()).toEqual([]);
  });
});

// Minimal chrome.storage fake so the stores have something to persist to (as in
// thread-memory.test.ts — trimmed to the two areas these stores touch).
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
