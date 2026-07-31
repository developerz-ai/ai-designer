import { beforeEach, describe, expect, it } from 'vitest';
import {
  readSessionLifecycle,
  reconcileTurnStatus,
  writeSessionLifecycle,
} from '@/agent/session-lifecycle';

// #165 S5 unit: the session tri-state survives service-worker eviction, and a per-tab turn status
// left at `'running'` by an evicted worker is reported as the orphan it is.
//
// The shipped failure: a turn stalls without stream traffic (slow provider, a 30s `waitFor`, a
// `chrome.debugger.attach` awaiting the user) → the SW's idle timer kills the worker → the panel
// reconnects to a cold worker whose module-level tri-state is `'idle'`, which pushes nothing and
// offers nothing to ask. The in-flight assistant bubble is only closed by `turn-done` / `error` /
// a non-running `session-state`, none of which can now arrive: a permanent spinner.

function installChromeStorageSessionFake(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  const session = {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const names = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (store.has(name)) out[name] = store.get(name);
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [name, value] of Object.entries(items)) store.set(name, value);
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      return Promise.resolve();
    },
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { session } };
  return store;
}

let store: Map<string, unknown>;
beforeEach(() => {
  store = installChromeStorageSessionFake();
});

describe('session lifecycle persistence', () => {
  it('defaults to idle on a fresh install', async () => {
    expect(await readSessionLifecycle()).toBe('idle');
  });

  it('survives a worker restart — a running session reads back as running', async () => {
    await writeSessionLifecycle('running');
    // A "new worker": nothing in memory, only chrome.storage.session.
    expect(await readSessionLifecycle()).toBe('running');
  });

  it('drops a corrupt persisted value rather than trusting it', async () => {
    store.set('sessionLifecycle', 'paused');
    expect(await readSessionLifecycle()).toBe('idle');
  });

  it('never throws when storage is unavailable — a read must not brick the reconnect path', async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        session: {
          get: () => Promise.reject(new Error('storage gone')),
          set: () => Promise.reject(new Error('storage gone')),
        },
      },
    };
    expect(await readSessionLifecycle()).toBe('idle');
    await expect(writeSessionLifecycle('running')).resolves.toBeUndefined();
  });
});

describe('reconcileTurnStatus', () => {
  it('reports a persisted running turn with no live turn as STOPPED — the orphan case', () => {
    // The worker was evicted mid-turn; the woken worker never resumes it.
    expect(reconcileTurnStatus('running', false)).toBe('stopped');
  });

  it('keeps running while a turn is genuinely in flight', () => {
    expect(reconcileTurnStatus('running', true)).toBe('running');
  });

  it('reports running when a live turn outran its own persisted stamp', () => {
    expect(reconcileTurnStatus('idle', true)).toBe('running');
  });

  it('passes idle / stopped through, and treats an unknown tab as idle', () => {
    expect(reconcileTurnStatus('idle', false)).toBe('idle');
    expect(reconcileTurnStatus('stopped', false)).toBe('stopped');
    expect(reconcileTurnStatus(undefined, false)).toBe('idle');
  });
});
