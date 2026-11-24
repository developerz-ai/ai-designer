import { afterEach, expect, it, vi } from 'vitest';
import type { ReportInput } from '@/agent/report';

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
const mocks = vi.hoisted(() => ({ author: vi.fn(), route: vi.fn() }));
vi.mock('../../src/agent/report', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agent/report')>()),
  generateReport: mocks.author,
}));
vi.mock('../../src/mcp/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/mcp/backend')>()),
  routeHandoff: mocks.route,
}));
vi.mock('@/mcp/manager', () => ({
  McpManager: class {
    async hydrate() {}
    async list() {
      return [];
    }
    async toolsForShip() {
      return { test__task: { execute: async () => ({}) } };
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const draft = {
  summary: 'Test report',
  findings: [],
  problems: [],
  pros: [],
  cons: [],
  recommendations: [],
  identity: { colors: [], fonts: [], spacing: [] },
  links: [],
  images: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('isolates hydrated diagnostics across navigation and preserves them through failures and changeset-only ship', async () => {
  const gate = deferred<void>();
  const persisted: Record<string, unknown> = {
    'pendingDiagnostics:7': {
      signals: [{ kind: 'console', ts: 1, level: 'error', text: 'old persisted' }],
      dropped: 0,
    },
  };
  let sessionReads = 0;
  const area = (data: Record<string, unknown>, delayFirst = false) => ({
    get: async (key: string | string[] | null) => {
      if (delayFirst && key === null && ++sessionReads === 3) await gate.promise;
      if (key === null) return { ...data };
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(
        keys.filter((item) => item in data).map((item) => [item, data[item]]),
      );
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items);
    },
    remove: async (key: string | string[]) => {
      for (const item of Array.isArray(key) ? key : [key]) delete data[item];
    },
  });
  type MessageListener = (raw: unknown, sender: object, reply: (value: unknown) => void) => unknown;
  const messages: MessageListener[] = [];
  const commits: Array<(details: object) => void> = [];
  const removed: Array<(id: number) => void> = [];
  let url = 'https://old.example/';
  const event = { addListener: () => {} };
  vi.stubGlobal('chrome', {
    storage: { session: area(persisted, true), local: area({}) },
    runtime: {
      onMessage: { addListener: (listener: MessageListener) => messages.push(listener) },
      onConnect: event,
      onInstalled: event,
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    tabs: {
      query: async () => [{ id: 7, url }],
      get: async () => ({ id: 7, url }),
      sendMessage: async () => ({}),
      onRemoved: { addListener: (listener: (id: number) => void) => removed.push(listener) },
    },
    webNavigation: {
      onCommitted: { addListener: (listener: (details: object) => void) => commits.push(listener) },
    },
    sidePanel: {
      setPanelBehavior: async () => {},
      setOptions: async () => {},
      open: async () => {},
    },
    action: { onClicked: event },
  });
  const { default: start } = await import('@/entrypoints/background');
  (start as unknown as () => void)();
  const signal = (message: string, documentId: string) => {
    for (const listener of messages)
      listener(
        {
          type: 'diagnostics-signal',
          signal: { kind: 'console', ts: Date.now(), level: 'error', text: message },
        },
        { tab: { id: 7 }, frameId: 0, documentId },
        () => {},
      );
  };
  const commit = (documentId: string) => {
    url = `https://${documentId}.example/`;
    for (const listener of commits)
      listener({ frameId: 0, tabId: 7, url, documentId, transitionType: 'link' });
  };
  const rpc = (message: object) =>
    new Promise<Record<string, unknown>>((resolve) => {
      for (const listener of messages)
        listener(message, {}, (value) => resolve(value as Record<string, unknown>));
    });
  signal('old queued', 'old');
  commit('new');
  signal('new queued', 'new');
  gate.resolve();
  await vi.waitFor(() => expect(persisted['pendingDiagnostics:7']).toBeUndefined());
  mocks.author.mockRejectedValueOnce(new Error('report failed')).mockResolvedValue(draft);
  const failed = await rpc({ type: 'download-report' });
  expect(failed.ok).toBe(false);
  expect(failed.error).toContain('report failed');
  expect(JSON.stringify(mocks.author.mock.calls[0]?.[1])).toContain('new queued');
  expect(JSON.stringify(mocks.author.mock.calls[0]?.[1])).not.toContain('old queued');
  expect(JSON.stringify(mocks.author.mock.calls[0]?.[1])).not.toContain('old persisted');
  persisted['changeset:7'] = {
    changeset: {
      url,
      createdAt: new Date().toISOString(),
      sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      edits: [
        {
          intent: 'Change button',
          selector: { value: '#button', strategy: 'id' },
          changes: [{ prop: 'color', before: 'red', after: 'blue' }],
        },
      ],
      stylesheets: [],
    },
    redoStack: [],
  };
  expect((await rpc({ type: 'changeset-remove-edit', index: 99 })).ok).toBe(true);
  mocks.route.mockReturnValue({
    kind: 'tasks',
    backend: { id: 'test', label: 'test', taskToolName: 'test__task' },
    repo: 'org/repo',
  });
  const ship = await rpc({ type: 'ship', source: 'changeset' });
  expect(ship.error).toBeUndefined();
  expect(ship).toMatchObject({ ok: true, routed: 'tasks', taskCount: 1 });
  expect(mocks.author).toHaveBeenCalledTimes(1);
  const retried = await rpc({ type: 'download-report' });
  expect(retried.ok).toBe(true);
  expect(JSON.stringify(mocks.author.mock.calls[1]?.[1])).toContain('new queued');
  signal('during report', 'new');
  const authorGate = deferred<typeof draft>();
  mocks.author.mockReturnValueOnce(authorGate.promise);
  const running = rpc({ type: 'download-report' });
  await vi.waitFor(() => expect(mocks.author).toHaveBeenCalledTimes(3));
  commit('next');
  authorGate.resolve(draft);
  expect((await running).ok).toBe(false);
  signal('next page', 'next');
  await rpc({ type: 'download-report' });
  const input = mocks.author.mock.calls[3]?.[1] as ReportInput;
  expect(JSON.stringify(input)).toContain('next page');
  expect(JSON.stringify(input)).not.toContain('during report');
  for (const listener of removed) listener(7);
});
