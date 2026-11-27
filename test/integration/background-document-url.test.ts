import { afterEach, expect, it, vi } from 'vitest';
import type { ReportInput } from '@/agent/report';

// The REAL background.ts (stubbed `chrome`, booted the way background.test.ts boots it). A tab whose
// SPA moved off its committed document URL (pushState / replaceState) before the first turn:
//   • the session record is keyed to the COMMITTED url — the one the changeset guards compare, so
//     the first turn is not a stale record whose every persist is refused;
//   • what leaves the extension (the report brief) carries the LIVE url — an OAuth `?code=` the SPA
//     replaceState'd away must not come back.

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
const mocks = vi.hoisted(() => ({ author: vi.fn() }));
vi.mock('../../src/agent/report', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agent/report')>()),
  generateReport: mocks.author,
}));
vi.mock('@/mcp/manager', () => ({
  McpManager: class {
    async hydrate() {}
    async list() {
      return [];
    }
    async toolsForShip() {
      return {};
    }
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const COMMITTED = 'https://shop.example/callback?code=SECRET-CODE';
const LIVE = 'https://shop.example/dashboard';

it('keys the session to the committed URL and ships the live URL', async () => {
  mocks.author.mockResolvedValue({
    summary: 'Test report',
    findings: [],
    problems: [],
    pros: [],
    cons: [],
    recommendations: [],
    identity: { colors: [], fonts: [], spacing: [] },
    links: [],
    images: [],
  });
  const session: Record<string, unknown> = { 'committedUrl:7': COMMITTED };
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
      query: async () => [{ id: 7, url: LIVE }],
      get: async () => ({ id: 7, url: LIVE }),
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
      listener({ type: 'download-report' }, {}, (value) =>
        resolve(value as Record<string, unknown>),
      );
  });
  expect(reply.ok).toBe(true);

  const record = session['session:7'] as { changeset: { url: string } } | undefined;
  expect(record?.changeset.url).toBe(COMMITTED); // the guards' document identity
  const input = mocks.author.mock.calls[0]?.[1] as ReportInput;
  expect(input.changeset.url).toBe(LIVE); // what leaves the extension
  expect(JSON.stringify(input)).not.toContain('SECRET-CODE');
  expect(String(reply.markdown)).not.toContain('SECRET-CODE');
});
