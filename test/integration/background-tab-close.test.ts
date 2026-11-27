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

it('closing a tab removes its session and changeset records', async () => {
  const session: Record<string, unknown> = {
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
  const removed: Array<(id: number) => void> = [];
  const event = { addListener: () => {} };
  vi.stubGlobal('chrome', {
    storage: { session: area(session), local: area({}) },
    runtime: {
      onMessage: event,
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
  // A session record for tab 7, written the way SessionStore writes it.
  session['session:7'] = { stand: 'in' };

  for (const listener of removed) listener(7);

  await vi.waitFor(() => {
    expect(session['changeset:7']).toBeUndefined();
    expect(session['session:7']).toBeUndefined();
  });
  expect(session['changeset:8']).toEqual({ kept: true }); // another tab's record is untouched
});
