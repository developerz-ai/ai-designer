import { defineContentScript } from '#imports';
import { DomTool, type ToolResult } from '@/shared/messages';

// Content script — the only world with DOM access. Executes DomTool calls from
// the service worker, runs the element picker overlay, and records accepted
// edits. All page mutations are EPHEMERAL and reversible (docs/idea/live-edit.md).

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // Injected stylesheet for reversible setStyle (never inline styles).
    let sheet: HTMLStyleElement | null = null;

    chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      const parsed = DomTool.safeParse(raw);
      if (!parsed.success) return;
      sendResponse(exec(parsed.data));
      return true;
    });

    function exec(tool: DomTool): ToolResult {
      switch (tool.type) {
        case 'query':
          // TODO: resolve elements + stable selectors (src/dom/selector.ts).
          return { type: 'tool-result', ok: true, data: [] };
        case 'getStyles':
          // TODO: return the changed subset of getComputedStyle.
          return { type: 'tool-result', ok: true, data: {} };
        case 'screenshot':
          // TODO: crop via chrome.tabs.captureVisibleTab (proxied through SW).
          return { type: 'tool-result', ok: true };
        case 'setStyle':
          // TODO: write rules into `sheet`, record edit to changeset recorder.
          ensureSheet();
          return { type: 'tool-result', ok: true };
        case 'setText':
          return { type: 'tool-result', ok: true };
        case 'undo':
          // TODO: pop + invert the recorder event log.
          return { type: 'tool-result', ok: true };
      }
    }

    function ensureSheet() {
      if (!sheet) {
        sheet = document.createElement('style');
        sheet.id = 'dz-designer-overrides';
        document.head.appendChild(sheet);
      }
      return sheet;
    }

    // TODO: element picker overlay (hover highlight + click to focus).
    // TODO: changeset recorder (event log -> undo/redo).
  },
});
