import { afterEach, expect, it, vi } from 'vitest';

// The REAL background.ts (booted with a stubbed `chrome`, as background.test.ts does): closing a
// tab must drop its turn thread and changeset from chrome.storage.session. Both carry screenshots,
// and the session quota is ~10MB — a record per closed tab used to stay until browser restart.

vi.mock('#imports', () => ({ defineBackground: (callback: () => void) => callback }));
vi.mock('@/mcp/manager', () => ({
  McpManager: class {
    async hydrate() {}
    async list() {
      return [];
    }
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const turnSession = (tabId: number, url: string) => ({
  tabId,
  url,
  changeset: {
    url,
    createdAt: '2026-07-14T00:00:00.000Z',
    sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    edits: [],
    stylesheets: [],
  },
  messages: [{ role: 'user', content: `design tab ${tabId}` }],
  updatedAt: 1,
});

it('closing a tab removes its session and changeset records', async () => {
  const session: Record<string, unknown> = {
    // Valid sessions for BOTH tabs, present before boot so the worker hydrates them into its cache.
    'session:7': turnSession(7, 'https://shop.example/'),
    'session:8': turnSession(8, 'https://other.example/'),
    'changeset:7': {
      changeset: {
        url: 'https://shop.example/',
        createdAt: '2026-07-14T00:00:00.000Z',
        sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        edits: [],
        stylesheets: [],
      },
      redoStack: [],
    },
    'changeset:8': { kept: true },
  };
  const area = (data: Record<string, unknown>) => ({
    get: async (key: string | string[] | null) => {
      if (key === null) return { ...data };
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    },
    remove: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) delete data[k];
    },
  });
  type Listener = (raw: unknown, sender: object, reply: (value: unknown) => void) => unknown;
  const listeners: Listener[] = [];
  const removed: Array<(id: number) => void> = [];
  const event = { addListener: () => {} };
  vi.stubGlobal('chrome', {
    storage: { session: area(session), local: area({}) },
    runtime: {
      onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
      onConnect: event,
      onInstalled: event,
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    tabs: {
      query: async () => [],
      get: async () => undefined,
      sendMessage: async () => ({}),
      onRemoved: { addListener: (listener: (id: number) => void) => removed.push(listener) },
    },
    webNavigation: { onCommitted: event },
    sidePanel: {
      setPanelBehavior: async () => {},
      setOptions: async () => {},
      open: async () => {},
    },
    action: { onClicked: event },
  });
  const { default: start } = await import('@/entrypoints/background');
  (start as unknown as () => void)();
  const threadGet = (tabId: number) =>
    new Promise<Record<string, unknown>>((resolve) => {
      for (const listener of listeners)
        listener({ type: 'thread-get', tabId }, {}, (value) =>
          resolve(value as Record<string, unknown>),
        );
    });
  expect((await threadGet(7)).ok).toBe(true); // hydrated: the cache holds tab 7's thread

  for (const listener of removed) listener(7);

  await vi.waitFor(() => {
    expect(session['changeset:7']).toBeUndefined();
    expect(session['session:7']).toBeUndefined();
  });
  // The in-memory cache forgot it too, not just storage.
  expect(await threadGet(7)).toMatchObject({ ok: false });
  // Another tab's records — session AND changeset — are untouched.
  expect(session['changeset:8']).toEqual({ kept: true });
  expect(session['session:8']).toBeDefined();
  expect(await threadGet(8)).toMatchObject({ ok: true, tabId: 8 });
});
