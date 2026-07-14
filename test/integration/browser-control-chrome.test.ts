import { afterEach, describe, expect, it } from 'vitest';
import { type BrowserControlDriver, runFrames, runNav, runTabs } from '@/agent/browser-control';
import type { FramesResult, NavResult, TabsResult, ToolResult } from '@/shared/messages';

// Integration: `runNav`/`runTabs`/`runFrames` (src/agent/browser-control.ts) driven through a
// `chrome.tabs`/`chrome.webNavigation`-shaped driver — mirrors background.ts's real
// `chromeBrowserDriver` glue (background.ts can't be imported under Vitest; it pulls the WXT
// virtual `#imports` module — see readiness.test.ts for the same constraint), against a mocked
// `chrome.tabs` global instead of the injected fake driver test/unit/browser-control.test.ts uses.
// Proves the SW-orchestration layer actually calls the chrome primitives it's supposed to.

interface FakeTab {
  id: number;
  url: string;
  title: string;
  active: boolean;
  status: 'complete' | 'loading';
}

function installChromeTabsFake(initial: FakeTab[]): {
  tabs: FakeTab[];
  driver: BrowserControlDriver;
} {
  const tabs = [...initial];
  let nextId = Math.max(0, ...tabs.map((t) => t.id)) + 1;

  const fakeChromeTabs = {
    get: (id: number) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return Promise.reject(new Error(`No tab with id: ${id}`));
      return Promise.resolve({ ...tab });
    },
    query: (_info: unknown) => Promise.resolve(tabs.map((t) => ({ ...t }))),
    update: (id: number, props: { url?: string; active?: boolean }) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return Promise.reject(new Error(`No tab with id: ${id}`));
      if (props.url !== undefined) tab.url = props.url;
      if (props.active !== undefined) {
        for (const t of tabs) t.active = t.id === id ? props.active : false;
      }
      return Promise.resolve({ ...tab });
    },
    goBack: (id: number) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return Promise.reject(new Error(`No tab with id: ${id}`));
      tab.url = `${tab.url}#back`;
      return Promise.resolve();
    },
    reload: (id: number) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return Promise.reject(new Error(`No tab with id: ${id}`));
      return Promise.resolve();
    },
    create: ({ url }: { url: string }) => {
      const tab: FakeTab = { id: nextId++, url, title: '', active: true, status: 'complete' };
      tabs.push(tab);
      return Promise.resolve({ ...tab });
    },
    remove: (id: number) => {
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx === -1) return Promise.reject(new Error(`No tab with id: ${id}`));
      tabs.splice(idx, 1);
      return Promise.resolve();
    },
  };

  const fakeWebNavigation = {
    getAllFrames: ({ tabId }: { tabId: number }) => {
      if (!tabs.some((t) => t.id === tabId)) return Promise.resolve(null);
      return Promise.resolve([
        { frameId: 0, url: tabs.find((t) => t.id === tabId)?.url ?? '', parentFrameId: -1 },
        { frameId: 5, url: 'https://widget.other/embed', parentFrameId: 0 },
      ]);
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: fakeChromeTabs,
    webNavigation: fakeWebNavigation,
  };

  // The real background.ts `chromeBrowserDriver` (src/entrypoints/background.ts:588-609),
  // reproduced against this fake `chrome.tabs`/`chrome.webNavigation` global — `waitForLoad`
  // resolves immediately since the fake never enters a 'loading' state.
  const driver: BrowserControlDriver = {
    navigate: async (tabId, url) => {
      await fakeChromeTabs.update(tabId, { url });
    },
    goBack: (tabId) => fakeChromeTabs.goBack(tabId),
    reload: (tabId) => fakeChromeTabs.reload(tabId),
    waitForLoad: () => Promise.resolve(),
    getTab: (tabId) => fakeChromeTabs.get(tabId),
    listTabs: () => fakeChromeTabs.query({}),
    openTab: (url) => fakeChromeTabs.create({ url }),
    activateTab: async (tabId) =>
      (await fakeChromeTabs.update(tabId, { active: true })) ?? { id: tabId },
    closeTab: (tabId) => fakeChromeTabs.remove(tabId),
    listFrames: async (tabId) => {
      const frames = await fakeWebNavigation.getAllFrames({ tabId });
      return (frames ?? []).map((f) => ({
        frameId: f.frameId,
        url: f.url,
        parentFrameId: f.parentFrameId,
      }));
    },
  };

  return { tabs, driver };
}

const data = <T>(r: ToolResult): T => r.data as T;

describe('browser-control against a mocked chrome.tabs / chrome.webNavigation', () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('tabs: open creates a real chrome tab and it shows up in the registry', async () => {
    const { driver } = installChromeTabsFake([
      { id: 1, url: 'https://a.test/', title: 'A', active: true, status: 'complete' },
    ]);
    const res = await runTabs(driver, { type: 'tabs', action: 'open', url: 'https://ref.test/' });
    expect(res.ok).toBe(true);
    const { tabs } = data<TabsResult>(res);
    expect(tabs).toHaveLength(2);
    expect(tabs.find((t) => t.url === 'https://ref.test/')).toBeDefined();
  });

  it('tabs: activate flips the active flag on the real chrome tab registry', async () => {
    const { driver } = installChromeTabsFake([
      { id: 1, url: 'https://a.test/', title: 'A', active: true, status: 'complete' },
      { id: 2, url: 'https://b.test/', title: 'B', active: false, status: 'complete' },
    ]);
    const res = await runTabs(driver, { type: 'tabs', action: 'activate', tabId: 2 });
    expect(res.ok).toBe(true);
    const { tabs } = data<TabsResult>(res);
    expect(tabs.find((t) => t.tabId === 2)?.active).toBe(true);
    expect(tabs.find((t) => t.tabId === 1)?.active).toBe(false);
  });

  it('tabs: close removes the real chrome tab from the registry', async () => {
    const { driver, tabs: rawTabs } = installChromeTabsFake([
      { id: 1, url: 'https://a.test/', title: 'A', active: true, status: 'complete' },
      { id: 2, url: 'https://b.test/', title: 'B', active: false, status: 'complete' },
    ]);
    const res = await runTabs(driver, { type: 'tabs', action: 'close', tabId: 2 });
    expect(res.ok).toBe(true);
    expect(data<TabsResult>(res).tabs.map((t) => t.tabId)).toEqual([1]);
    expect(rawTabs).toHaveLength(1); // the underlying fake chrome.tabs registry actually shrank
  });

  it('tabs: close on a tabId chrome does not know degrades to an error ToolResult', async () => {
    const { driver } = installChromeTabsFake([
      { id: 1, url: 'https://a.test/', title: 'A', active: true, status: 'complete' },
    ]);
    const res = await runTabs(driver, { type: 'tabs', action: 'close', tabId: 999 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('999');
  });

  it('navigate: drives chrome.tabs.update and reports where the (fake) tab landed', async () => {
    const { driver } = installChromeTabsFake([
      { id: 1, url: 'https://a.test/', title: 'A', active: true, status: 'complete' },
    ]);
    const res = await runNav(driver, { type: 'navigate', url: 'https://a.test/next' }, 1);
    expect(res.ok).toBe(true);
    expect(data<NavResult>(res).url).toBe('https://a.test/next');
  });

  it('frames: lists the real chrome.webNavigation frame tree, main + cross-origin child', async () => {
    const { driver } = installChromeTabsFake([
      { id: 1, url: 'https://a.test/', title: 'A', active: true, status: 'complete' },
    ]);
    const res = await runFrames(driver, { type: 'frames', action: 'list' }, 1);
    expect(res.ok).toBe(true);
    const { frames } = data<FramesResult>(res);
    expect(frames).toEqual([
      { frameId: 0, url: 'https://a.test/', origin: 'https://a.test', isMain: true },
      {
        frameId: 5,
        url: 'https://widget.other/embed',
        origin: 'https://widget.other',
        isMain: false,
      },
    ]);
  });
});
