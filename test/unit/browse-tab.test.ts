import { describe, expect, it } from 'vitest';
import { type BrowseTabDriver, runBrowse } from '@/agent/browse-tab';
import type { HostAccess } from '@/shared/host-permissions';
import type { BrowseInput, DesignRead } from '@/shared/messages';

// browse-tab.ts unit: the chrome-free orchestration behind `browse(url)`. We inject a fake driver
// (no chrome.*) and assert the invariants the SW glue must uphold — validate the URL, gate on the
// host grant, and ALWAYS close the tab (even on read failure or abort) — without hitting a browser.

const READ: DesignRead = {
  url: 'https://ref.example/',
  title: 'Ref',
  palette: [],
  typography: { families: [], scale: [] },
  regions: [],
  components: [],
};

const input = (url: string): BrowseInput => ({ type: 'browse', url });

interface FakeOpts {
  access?: HostAccess;
  tabId?: number | undefined;
  waitForLoad?: () => Promise<void>;
  readDesign?: () => Promise<DesignRead>;
  closeThrows?: boolean;
}

function fakeDriver(opts: FakeOpts = {}) {
  const log = { opened: [] as string[], waited: 0, read: 0, closed: [] as number[] };
  const driver: BrowseTabDriver = {
    hostAccess: async () => opts.access ?? { ok: true },
    open: async (url) => {
      log.opened.push(url);
      return 'tabId' in opts ? opts.tabId : 7;
    },
    waitForLoad: async () => {
      log.waited += 1;
      if (opts.waitForLoad) await opts.waitForLoad();
    },
    readDesign: async () => {
      log.read += 1;
      return opts.readDesign ? opts.readDesign() : READ;
    },
    close: async (id) => {
      log.closed.push(id);
      if (opts.closeThrows) throw new Error('close failed');
    },
  };
  return { driver, log };
}

describe('runBrowse orchestration', () => {
  it('opens the tab, reads its design, and closes it on the happy path', async () => {
    const { driver, log } = fakeDriver();
    const result = await runBrowse(driver, input('https://ref.example'));
    expect(result).toEqual({ type: 'tool-result', ok: true, data: READ });
    expect(log.opened).toEqual(['https://ref.example']);
    expect(log.waited).toBe(1);
    expect(log.read).toBe(1);
    expect(log.closed).toEqual([7]); // tab always closed
  });

  it('short-circuits an already-aborted turn without opening a tab', async () => {
    const { driver, log } = fakeDriver();
    const controller = new AbortController();
    controller.abort();
    const result = await runBrowse(driver, input('https://ref.example'), controller.signal);
    expect(result).toEqual({ type: 'tool-result', ok: false, error: 'aborted' });
    expect(log.opened).toEqual([]);
  });

  it('rejects a non-http(s) URL before requesting any permission', async () => {
    const { driver, log } = fakeDriver();
    const result = await runBrowse(driver, input('ftp://nope.example'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid URL to browse');
    expect(log.opened).toEqual([]);
  });

  it('surfaces a denied host grant without opening a tab', async () => {
    const { driver, log } = fakeDriver({
      access: { ok: false, error: 'Host access denied for https://ref.example/*' },
    });
    const result = await runBrowse(driver, input('https://ref.example'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('denied');
    expect(log.opened).toEqual([]);
  });

  it('reports an unopenable tab and closes nothing', async () => {
    const { driver, log } = fakeDriver({ tabId: undefined });
    const result = await runBrowse(driver, input('https://ref.example'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('background tab');
    expect(log.waited).toBe(0);
    expect(log.read).toBe(0);
    expect(log.closed).toEqual([]); // no tab id → nothing to close
  });

  it('still closes the tab when the design read fails', async () => {
    const { driver, log } = fakeDriver({
      readDesign: () => Promise.reject(new Error('boom')),
    });
    const result = await runBrowse(driver, input('https://ref.example'));
    expect(result).toEqual({ type: 'tool-result', ok: false, error: 'Error: boom' });
    expect(log.closed).toEqual([7]); // finally-closed despite the failure
  });

  it('still closes the tab when the load wait rejects (tab closed underneath)', async () => {
    const { driver, log } = fakeDriver({
      waitForLoad: () => Promise.reject(new Error('The browse tab was closed before it loaded.')),
    });
    const result = await runBrowse(driver, input('https://ref.example'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('closed before it loaded');
    expect(log.read).toBe(0);
    expect(log.closed).toEqual([7]);
  });

  it('reports an abort that fires mid-read as aborted (not a raw error), and closes', async () => {
    const controller = new AbortController();
    const { driver, log } = fakeDriver({
      readDesign: () => {
        controller.abort();
        return Promise.reject(new Error('aborted'));
      },
    });
    const result = await runBrowse(driver, input('https://ref.example'), controller.signal);
    expect(result).toEqual({ type: 'tool-result', ok: false, error: 'aborted' });
    expect(log.closed).toEqual([7]);
  });

  it('swallows a close failure so it never masks a successful read', async () => {
    const { driver, log } = fakeDriver({ closeThrows: true });
    const result = await runBrowse(driver, input('https://ref.example'));
    expect(result.ok).toBe(true);
    expect(log.closed).toEqual([7]);
  });
});
