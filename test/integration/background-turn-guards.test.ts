import { afterEach, expect, it, vi } from 'vitest';

// The REAL background.ts (stubbed `chrome`, as background.test.ts boots it): a `user-message` its
// guards refuse must REJECT the ack. It used to post an unstamped stream error and ack
// `{ ok: true }` with no turnId; the panel, streaming for that send, kept send disabled forever.

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

it('a user-message with no web page to design rejects its ack with the reason', async () => {
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
      query: async () => [], // no active web page
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
  expect(reply).toEqual({ ok: false, error: 'Open a web page to start designing.' });
});
