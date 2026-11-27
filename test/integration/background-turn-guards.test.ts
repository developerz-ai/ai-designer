import { afterEach, expect, it, vi } from 'vitest';

// The REAL background.ts (stubbed `chrome`, as background.test.ts boots it): a `user-message` its
// guards refuse must REJECT the ack. It used to post an unstamped stream error and ack
// `{ ok: true }` with no turnId; the panel, streaming for that send, kept send disabled forever.

vi.mock('#imports', () => ({ defineBackground: (callback: () => void) => callback }));
const state = vi.hoisted(() => ({
  config: null as null | { baseURL: string; model: string },
  keyMissing: false,
}));
vi.mock('@/agent/config-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agent/config-store')>()),
  getProviderConfig: async () => state.config,
  migrateLegacyProvider: async () => {},
}));
vi.mock('@/agent/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agent/provider')>()),
  keyMissing: () => state.keyMissing,
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

const TAB = { id: 7, url: 'https://shop.example/' };
const cases = [
  {
    name: 'no web page',
    tabs: [],
    config: null,
    keyMissing: false,
    error: 'Open a web page to start designing.',
  },
  {
    name: 'no provider',
    tabs: [TAB],
    config: null,
    keyMissing: false,
    error: 'Add a model provider in Settings to start.',
  },
  {
    name: 'missing key',
    tabs: [TAB],
    config: { baseURL: 'https://openrouter.ai/api/v1', model: 'test' },
    keyMissing: true,
    error: 'MISSING_KEY',
  },
];

it.each(cases)('a user-message refused for $name rejects its ack with the reason', async (c) => {
  state.config = c.config;
  state.keyMissing = c.keyMissing;
  vi.resetModules();
  const area = () => {
    const data: Record<string, unknown> = {};
    return {
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
    };
  };
  type Listener = (raw: unknown, sender: object, reply: (value: unknown) => void) => unknown;
  const listeners: Listener[] = [];
  const event = { addListener: () => {} };
  vi.stubGlobal('chrome', {
    storage: { session: area(), local: area() },
    runtime: {
      onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
      onConnect: event,
      onInstalled: event,
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    tabs: {
      query: async () => c.tabs,
      get: async () => undefined,
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

  const reply = await new Promise<Record<string, unknown>>((resolve) => {
    for (const listener of listeners)
      listener({ type: 'user-message', text: 'make it pop' }, {}, (value) =>
        resolve(value as Record<string, unknown>),
      );
  });
  const { MISSING_KEY_ERROR } = await import('@/agent/provider');
  expect(reply).toEqual({
    ok: false,
    error: c.error === 'MISSING_KEY' ? MISSING_KEY_ERROR : c.error,
  });
});
