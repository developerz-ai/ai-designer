// How the toolbar button opens the panel surface, per browser (#180) — the boot-time sibling of
// the BrowserControlDriver adapter (`browser-control.ts`): one module owns the divergence, the SW
// calls it once, and a future browser lands here instead of as another inline guard in
// background.ts.
//
// Chrome: `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` — a persisted setting,
// re-asserted every SW start so a fresh install/reset stays correct. Deliberately NO `onClicked`
// handler on this path: registering one suppresses Chrome's native toggle.
//
// Firefox: no `sidePanel`, and no native action→sidebar toggle either — without a handler the
// toolbar button is inert and the sidebar only opens from Firefox's own View → Sidebar menu. So
// ONLY here, `browserAction.onClicked` (the MV2 surface — `action` is MV3/Chrome) calls
// `sidebarAction.toggle()`, which must run synchronously inside the user-gesture handler (an
// await first voids the gesture). Older Firefoxes without `toggle` fall back to `open`.
//
// Everything is read structurally: chrome-types is MV3/Chrome and declares none of the Firefox
// half, and on a runtime missing an API the property access must select the other path instead
// of throwing synchronously and aborting SW boot.

/** The subset of the global surface this module reads — injectable so the unit test can hand in
 *  a fake Chrome, a fake Firefox, and a bare runtime without touching real globals. */
export interface PanelHost {
  chrome?: {
    sidePanel?: { setPanelBehavior: (b: { openPanelOnActionClick: boolean }) => Promise<void> };
    browserAction?: { onClicked?: { addListener: (fn: () => void) => void } };
  };
  browser?: {
    sidebarAction?: { toggle?: () => Promise<void>; open?: () => Promise<void> };
  };
}

/** Wire the toolbar button to the panel. Returns which mechanism was wired, for logging/tests:
 *  `sidePanel` (Chrome), `sidebarAction` (Firefox), or `none` (neither surface exists — the rest
 *  of the SW still boots; the panel is simply unreachable from the toolbar). */
export function wirePanelOpen(
  host: PanelHost = globalThis as PanelHost,
): 'sidePanel' | 'sidebarAction' | 'none' {
  const sidePanel = host.chrome?.sidePanel;
  if (sidePanel) {
    sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    return 'sidePanel';
  }
  const sidebar = host.browser?.sidebarAction;
  const toggle = sidebar?.toggle ?? sidebar?.open;
  const onClicked = host.chrome?.browserAction?.onClicked;
  if (sidebar && toggle && onClicked) {
    onClicked.addListener(() => {
      void toggle.call(sidebar).catch(() => {});
    });
    return 'sidebarAction';
  }
  return 'none';
}
