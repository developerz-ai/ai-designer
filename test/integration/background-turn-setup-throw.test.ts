import { afterEach, expect, it, vi } from 'vitest';

// The REAL background.ts (stubbed `chrome`, as background.test.ts boots it). A turn whose SETUP
// throws after it installed its abort controller (here: the session write fails) must not leave the
// worker believing a turn is running — that pinned `session-get` to turnRunning:true, so every
// panel reconnect showed "streaming" with send disabled until the worker was evicted.

vi.mock('#imports', () => ({ defineBackground: (callback: () => void) => callback }));
vi.mock('@/agent/config-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agent/config-store')>()),
  getProviderConfig: async () => ({ baseURL: 'http://localhost:1234/v1', model: 'test' }),
  migrateLegacyProvider: async () => {},
}));
vi.mock('@/agent/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agent/provider')>()),
  createProvider: () => ({}),
  keyMissing: () => false,
}));
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

it('a turn whose setup throws releases the running-turn state', async () => {
  const area = (failSessionWrites: boolean) => {
    const data: Record<string, unknown> = {};
    return {
      get: async (key: string | string[] | null) => {
        if (key === null) return { ...data };
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
      },
      set: async (items: Record<string, unknown>) => {
        if (failSessionWrites && Object.keys(items).some((k) => k.startsWith('session:'))) {
          throw new Error('QUOTA_BYTES quota exceeded');
        }
        Object.assign(data, items);
      },
      remove: async (key: string | string[]) => {
        for (const k of Array.isArray(key) ? key : [key]) delete data[k];
      },
    };
  };
  type Listener = (raw: unknown, sender: object, reply: (value: unknown) => void) => unknown;
  const listeners: Listener[] = [];
  const event = { addListener: () => {} };
  vi.stubGlobal('chrome', {
    storage: { session: area(true), local: area(false) },
    runtime: {
      onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
      onConnect: event,
      onInstalled: event,
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    tabs: {
      query: async () => [{ id: 7, url: 'https://shop.example/' }],
      get: async () => ({ id: 7, url: 'https://shop.example/' }),
      sendMessage: async () => ({}),
      onRemoved: event,
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
  const rpc = (message: object) =>
    new Promise<Record<string, unknown>>((resolve) => {
      for (const listener of listeners)
        listener(message, {}, (value) => resolve(value as Record<string, unknown>));
    });

  const sent = await rpc({ type: 'user-message', text: 'make it pop' });
  expect(sent.ok).toBe(false);
  expect(String(sent.error)).toContain('quota');

  const state = await rpc({ type: 'session-get' });
  expect(state.turnRunning).toBe(false);
});
