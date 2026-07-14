// Browser-control orchestration — the service worker's "own the tabs + frames" half (slice 13).
// Where the interaction engine (src/dom/interact.ts) drives ONE page's DOM from the content world,
// these tools need `chrome.tabs` / `chrome.webNavigation` — SW-only surfaces the content script
// can't touch. So navigation (update/back/reload + await load), the multi-tab manager, and frame
// enumeration run here, behind an injected `BrowserControlDriver` so this module stays chrome-free
// and unit-testable (the chrome glue lives in src/entrypoints/background.ts, coverage-excluded).
//
// Each runner returns a typed `ToolResult`: `data` is the tool's payload schema (`NavResult` /
// `TabsResult` / `FramesResult`), and any driver rejection (a closed tab, a denied permission)
// degrades to an error result the agent reacts to — never a throw that kills the turn.

import type {
  FrameInfo,
  FramesInput,
  FramesResult,
  NavIntent,
  NavResult,
  TabInfo,
  TabsCmd,
  TabsResult,
  ToolResult,
} from '@/shared/messages';

// Structural views of a `chrome.tabs.Tab` / `webNavigation` frame — only the fields these tools
// read, so a test driver satisfies them without constructing full chrome objects.
export interface TabRef {
  id?: number;
  url?: string;
  title?: string;
  active?: boolean;
}
export interface FrameRef {
  frameId: number;
  url?: string;
  parentFrameId?: number;
}

/** The SW-side primitives the browser-control tools stand on, injected so this module is chrome-free
 *  and testable. Implemented against `chrome.tabs` / `chrome.webNavigation` in background.ts. */
export interface BrowserControlDriver {
  navigate(tabId: number, url: string, signal?: AbortSignal): Promise<void>;
  goBack(tabId: number, signal?: AbortSignal): Promise<void>;
  reload(tabId: number, signal?: AbortSignal): Promise<void>;
  /** Resolve once the tab finishes (re)loading, or on a bounded timeout. */
  waitForLoad(tabId: number, signal?: AbortSignal): Promise<void>;
  getTab(tabId: number): Promise<TabRef>;
  listTabs(): Promise<TabRef[]>;
  openTab(url: string): Promise<TabRef>;
  closeTab(tabId: number): Promise<void>;
  activateTab(tabId: number): Promise<TabRef>;
  listFrames(tabId: number): Promise<FrameRef[]>;
}

const MAX_URL = 2048; // matches the URL bound on NavResult/TabInfo/FrameInfo
const MAX_TITLE = 300;
const MAX_TABS = 50; // TabsResult schema bound
const MAX_FRAMES = 100; // FramesResult schema bound

const ok = (data: unknown): ToolResult => ({ type: 'tool-result', ok: true, data });
const fail = (error: string): ToolResult => ({ type: 'tool-result', ok: false, error });

/** Where a navigation landed. */
export function toNavResult(tab: TabRef): NavResult {
  const title = tab.title?.slice(0, MAX_TITLE);
  return { url: (tab.url ?? '').slice(0, MAX_URL), ...(title ? { title } : {}) };
}

/** A registry entry for the `tabs` tool. `null` for a tab with no id (a devtools/pre-commit tab) so
 *  the caller can drop it — every real page tab has one. */
export function toTabInfo(tab: TabRef): TabInfo | null {
  if (tab.id === undefined) return null;
  return {
    tabId: tab.id,
    url: (tab.url ?? '').slice(0, MAX_URL),
    title: (tab.title ?? '').slice(0, MAX_TITLE),
    active: tab.active ?? false,
  };
}

/** The origin of a frame URL, or '' for an opaque / `about:blank` frame (whose `URL.origin` is the
 *  string "null") and for a missing / unparsable URL — never a throw. */
export function originOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? '' : origin;
  } catch {
    return '';
  }
}

/** One frame in the tree. `isMain` = the top document (frameId 0); child frames carry their own id
 *  so the agent can address them (`Target.frameId`). */
export function toFrameInfo(frame: FrameRef): FrameInfo {
  return {
    frameId: frame.frameId,
    url: (frame.url ?? '').slice(0, MAX_URL),
    origin: originOf(frame.url).slice(0, MAX_URL),
    isMain: frame.frameId === 0,
  };
}

/** Drive `navigate` / `navigateBack` / `reload` on the target tab, wait for the load, and report
 *  where it landed. Navigation tears down the content script, so it is SW-owned (not content-routed)
 *  and is NOT reversible via `undo` — the report flags it as an action, not a recorder mutation. */
export async function runNav(
  driver: BrowserControlDriver,
  intent: NavIntent,
  defaultTabId: number,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const tabId = intent.tabId ?? defaultTabId;
  try {
    if (intent.type === 'navigate') await driver.navigate(tabId, intent.url, signal);
    else if (intent.type === 'navigateBack') await driver.goBack(tabId, signal);
    else await driver.reload(tabId, signal);
    await driver.waitForLoad(tabId, signal);
    return ok(toNavResult(await driver.getTab(tabId)) satisfies NavResult);
  } catch (err) {
    return fail(String(err));
  }
}

/** The multi-tab manager. Every action returns the full registry after it runs, so the agent always
 *  sees current state (copy = the user's tab + a reference tab open at once, each addressed by id). */
export async function runTabs(driver: BrowserControlDriver, cmd: TabsCmd): Promise<ToolResult> {
  try {
    switch (cmd.action) {
      case 'open':
        if (!cmd.url) return fail('`tabs` open needs a `url`.');
        await driver.openTab(cmd.url);
        break;
      case 'close':
        if (cmd.tabId === undefined) return fail('`tabs` close needs a `tabId`.');
        await driver.closeTab(cmd.tabId);
        break;
      case 'activate':
        if (cmd.tabId === undefined) return fail('`tabs` activate needs a `tabId`.');
        await driver.activateTab(cmd.tabId);
        break;
      case 'list':
        break;
    }
    const tabs = (await driver.listTabs())
      .map(toTabInfo)
      .filter((t): t is TabInfo => t !== null)
      .slice(0, MAX_TABS);
    return ok({ tabs } satisfies TabsResult);
  } catch (err) {
    return fail(String(err));
  }
}

/** Enumerate the target tab's frame tree so the agent can target an iframe by `frameId`. */
export async function runFrames(
  driver: BrowserControlDriver,
  input: FramesInput,
  defaultTabId: number,
): Promise<ToolResult> {
  const tabId = input.tabId ?? defaultTabId;
  try {
    const frames = (await driver.listFrames(tabId)).map(toFrameInfo).slice(0, MAX_FRAMES);
    return ok({ frames } satisfies FramesResult);
  } catch (err) {
    return fail(String(err));
  }
}
