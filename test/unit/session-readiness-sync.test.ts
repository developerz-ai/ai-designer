import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelToSw, ReadinessState } from '@/shared/messages';

// The readiness pill's "Page access" row is a host-permission verdict the SW computes only when
// asked. Two ways it went stale: Start's own grant prompt resolved without a re-pull, and nothing
// listened for a grant/revoke made elsewhere (chrome://extensions, another panel). Also: Start and
// Stop treated an `{ ok: false }` reply — which satisfies `OkResult` — as success.

const NEEDED: ReadinessState = {
  provider: 'ok',
  model: 'ok',
  apiKey: 'ok',
  hostPermission: 'granted',
  pageAccess: 'needed',
  mcp: { connected: 0, total: 0 },
  ready: true,
};
const GRANTED: ReadinessState = { ...NEEDED, pageAccess: 'granted' };

let sent: PanelToSw[] = [];
let pageAccess: ReadinessState['pageAccess'] = 'needed';
const added: Array<() => void> = [];
const removed: Array<() => void> = [];

function installChromeFake(opts: {
  grant: Promise<boolean>;
  reply?: (m: PanelToSw) => unknown;
}): void {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      connect: () => ({
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
      }),
      sendMessage: vi.fn(async (m: unknown) => {
        const msg = m as PanelToSw;
        sent.push(msg);
        const custom = opts.reply?.(msg);
        if (custom !== undefined) return custom;
        if (msg.type === 'readiness') {
          return { ok: true, state: pageAccess === 'granted' ? GRANTED : NEEDED };
        }
        if (msg.type === 'session-get') {
          return { ok: true, state: 'idle', turnRunning: false, tabId: null };
        }
        return { ok: true };
      }),
    },
    permissions: {
      request: vi.fn(() => opts.grant),
      onAdded: { addListener: (f: () => void) => void added.push(f) },
      onRemoved: { addListener: (f: () => void) => void removed.push(f) },
    },
  };
}

const readinessPulls = () => sent.filter((m) => m.type === 'readiness').length;

beforeEach(() => {
  vi.resetModules();
  sent = [];
  pageAccess = 'needed';
  added.length = 0;
  removed.length = 0;
});

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
  vi.restoreAllMocks();
});

describe('readiness follows host-permission changes', () => {
  it('re-pulls readiness on chrome.permissions.onAdded and onRemoved', async () => {
    installChromeFake({ grant: Promise.resolve(true) });
    const readiness = await import('@/entrypoints/sidepanel/stores/readiness');
    readiness.initReadinessStore();
    await vi.waitFor(() => expect(readiness.state()?.pageAccess).toBe('needed'));

    pageAccess = 'granted';
    for (const f of added) f();
    await vi.waitFor(() => expect(readiness.state()?.pageAccess).toBe('granted'));

    pageAccess = 'needed';
    for (const f of removed) f();
    await vi.waitFor(() => expect(readiness.state()?.pageAccess).toBe('needed'));
  });

  it('re-pulls readiness once the Start grant prompt resolves granted', async () => {
    let resolveGrant: (v: boolean) => void = () => {};
    installChromeFake({
      grant: new Promise<boolean>((r) => {
        resolveGrant = r;
      }),
    });
    const session = await import('@/entrypoints/sidepanel/stores/session');
    const readiness = await import('@/entrypoints/sidepanel/stores/readiness');

    await session.startSession(); // Start never waits on the prompt
    expect(readinessPulls()).toBe(0);

    pageAccess = 'granted';
    resolveGrant(true);
    await vi.waitFor(() => expect(readiness.state()?.pageAccess).toBe('granted'));
  });

  it('does not re-pull when the Start grant is denied', async () => {
    installChromeFake({ grant: Promise.resolve(false) });
    const session = await import('@/entrypoints/sidepanel/stores/session');

    await session.startSession();
    await new Promise((r) => setTimeout(r, 0));

    expect(readinessPulls()).toBe(0);
  });
});

describe('session actions check the reply', () => {
  it('surfaces a refused session-start', async () => {
    installChromeFake({
      grant: Promise.resolve(false),
      reply: (m) => (m.type === 'session-start' ? { ok: false, error: 'no tab' } : undefined),
    });
    const session = await import('@/entrypoints/sidepanel/stores/session');

    await session.startSession();

    expect(session.error()).toBe('no tab');
  });

  it('surfaces a refused session-stop', async () => {
    installChromeFake({
      grant: Promise.resolve(false),
      reply: (m) => (m.type === 'session-stop' ? { ok: false } : undefined),
    });
    const session = await import('@/entrypoints/sidepanel/stores/session');

    await session.stopSession();

    expect(session.error()).toBeTruthy();
  });
});
