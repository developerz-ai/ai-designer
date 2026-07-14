import { describe, expect, it } from 'vitest';
import {
  type BrowserControlDriver,
  type FrameRef,
  originOf,
  runFrames,
  runNav,
  runTabs,
  type TabRef,
  toFrameInfo,
  toNavResult,
  toTabInfo,
} from '@/agent/browser-control';
import type { FramesResult, NavResult, TabsResult, ToolResult } from '@/shared/messages';

// browser-control unit: the SW-orchestration runners (navigate / tabs / frames) behind an injected
// driver — no chrome. We record driver calls and assert the runner drives the right primitives,
// defaults the target tab, maps chrome shapes to the typed payloads, and degrades a driver rejection
// to an error ToolResult (never a throw that kills the turn).

const TABS: TabRef[] = [
  { id: 1, url: 'https://a.test/', title: 'A', active: true },
  { id: 2, url: 'https://b.test/', title: 'B', active: false },
];
const FRAMES: FrameRef[] = [
  { frameId: 0, url: 'https://a.test/', parentFrameId: -1 },
  { frameId: 7, url: 'https://widget.other/embed', parentFrameId: 0 },
];

type Call = [string, ...unknown[]];

function harness(over: Partial<BrowserControlDriver> = {}) {
  const calls: Call[] = [];
  const rec =
    <T>(name: string, ret: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push([name, ...args]);
      return ret;
    };
  const driver: BrowserControlDriver = {
    navigate: rec('navigate', undefined),
    goBack: rec('goBack', undefined),
    reload: rec('reload', undefined),
    waitForLoad: rec('waitForLoad', undefined),
    getTab: rec('getTab', { id: 1, url: 'https://a.test/next', title: 'Next' }),
    listTabs: rec('listTabs', TABS),
    openTab: rec('openTab', { id: 3, url: 'https://c.test/', title: 'C', active: true }),
    closeTab: rec('closeTab', undefined),
    activateTab: rec('activateTab', { id: 2, url: 'https://b.test/', title: 'B', active: true }),
    listFrames: rec('listFrames', FRAMES),
    ...over,
  };
  return { calls, driver };
}

const names = (calls: Call[]): string[] => calls.map((c) => c[0]);
const data = <T>(r: ToolResult): T => r.data as T;

describe('runNav', () => {
  it('navigate drives update → waitForLoad → getTab and reports where it landed', async () => {
    const { calls, driver } = harness();
    const res = await runNav(driver, { type: 'navigate', url: 'https://a.test/next' }, 1);
    expect(res.ok).toBe(true);
    expect(data<NavResult>(res)).toEqual({ url: 'https://a.test/next', title: 'Next' });
    expect(names(calls)).toEqual(['navigate', 'waitForLoad', 'getTab']);
    expect(calls[0]).toEqual(['navigate', 1, 'https://a.test/next', undefined]);
  });

  it('navigateBack / reload drive the matching primitive', async () => {
    const back = harness();
    await runNav(back.driver, { type: 'navigateBack' }, 5);
    expect(names(back.calls)).toEqual(['goBack', 'waitForLoad', 'getTab']);

    const reload = harness();
    await runNav(reload.driver, { type: 'reload' }, 5);
    expect(names(reload.calls)).toEqual(['reload', 'waitForLoad', 'getTab']);
  });

  it('targets an explicit tabId, else the turn tab', async () => {
    const explicit = harness();
    await runNav(explicit.driver, { type: 'reload', tabId: 9 }, 1);
    expect(explicit.calls[0]).toEqual(['reload', 9, undefined]);

    const dflt = harness();
    await runNav(dflt.driver, { type: 'reload' }, 1);
    expect(dflt.calls[0]).toEqual(['reload', 1, undefined]);
  });

  it('degrades a driver rejection to an error ToolResult', async () => {
    const { driver } = harness({
      navigate: async () => {
        throw new Error('tab gone');
      },
    });
    const res = await runNav(driver, { type: 'navigate', url: 'https://a.test/' }, 1);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('tab gone');
  });
});

describe('runTabs', () => {
  it('list returns the registry with no lifecycle call', async () => {
    const { calls, driver } = harness();
    const res = await runTabs(driver, { type: 'tabs', action: 'list' });
    expect(names(calls)).toEqual(['listTabs']);
    expect(data<TabsResult>(res).tabs).toEqual([
      { tabId: 1, url: 'https://a.test/', title: 'A', active: true },
      { tabId: 2, url: 'https://b.test/', title: 'B', active: false },
    ]);
  });

  it('open needs a url; close / activate need a tabId', async () => {
    const noUrl = await runTabs(harness().driver, { type: 'tabs', action: 'open' });
    expect(noUrl.ok).toBe(false);
    const noId = await runTabs(harness().driver, { type: 'tabs', action: 'close' });
    expect(noId.ok).toBe(false);
  });

  it('open / activate / close run their primitive then return the fresh registry', async () => {
    const open = harness();
    await runTabs(open.driver, { type: 'tabs', action: 'open', url: 'https://c.test/' });
    expect(names(open.calls)).toEqual(['openTab', 'listTabs']);
    expect(open.calls[0]).toEqual(['openTab', 'https://c.test/']);

    const act = harness();
    await runTabs(act.driver, { type: 'tabs', action: 'activate', tabId: 2 });
    expect(names(act.calls)).toEqual(['activateTab', 'listTabs']);

    const close = harness();
    await runTabs(close.driver, { type: 'tabs', action: 'close', tabId: 2 });
    expect(names(close.calls)).toEqual(['closeTab', 'listTabs']);
  });

  it('degrades a driver rejection to an error ToolResult', async () => {
    const { driver } = harness({
      closeTab: async () => {
        throw new Error('cannot close');
      },
    });
    const res = await runTabs(driver, { type: 'tabs', action: 'close', tabId: 2 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('cannot close');
  });
});

describe('runFrames', () => {
  it('maps the frame tree: main flag + cross-origin origin, defaults the tab', async () => {
    const { calls, driver } = harness();
    const res = await runFrames(driver, { type: 'frames', action: 'list' }, 4);
    expect(calls[0]).toEqual(['listFrames', 4]);
    expect(data<FramesResult>(res).frames).toEqual([
      { frameId: 0, url: 'https://a.test/', origin: 'https://a.test', isMain: true },
      {
        frameId: 7,
        url: 'https://widget.other/embed',
        origin: 'https://widget.other',
        isMain: false,
      },
    ]);
  });

  it('targets an explicit tabId when given', async () => {
    const { calls, driver } = harness();
    await runFrames(driver, { type: 'frames', action: 'list', tabId: 12 }, 4);
    expect(calls[0]).toEqual(['listFrames', 12]);
  });
});

describe('mappers', () => {
  it('toNavResult drops an empty title, bounds the url', () => {
    expect(toNavResult({ url: 'https://x.test/' })).toEqual({ url: 'https://x.test/' });
    expect(toNavResult({ url: 'https://x.test/', title: 'T' })).toEqual({
      url: 'https://x.test/',
      title: 'T',
    });
  });

  it('toTabInfo is null for a tab with no id (dropped from the registry)', () => {
    expect(toTabInfo({ url: 'https://x.test/' })).toBeNull();
    expect(toTabInfo({ id: 5 })).toEqual({ tabId: 5, url: '', title: '', active: false });
  });

  it('originOf tolerates a missing / opaque url', () => {
    expect(originOf('https://x.test/a?b#c')).toBe('https://x.test');
    expect(originOf('about:blank')).toBe('');
    expect(originOf(undefined)).toBe('');
  });

  it('toFrameInfo marks frame 0 as main', () => {
    expect(toFrameInfo({ frameId: 0, url: 'https://x.test/' }).isMain).toBe(true);
    expect(toFrameInfo({ frameId: 3, url: 'https://x.test/' }).isMain).toBe(false);
  });
});
